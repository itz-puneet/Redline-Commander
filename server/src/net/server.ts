/**
 * WebSocket transport. Deliberately thin: parse a frame, hand it to
 * MatchService, write the resulting per-player payloads back out. It holds
 * no game rules whatsoever, which is why the rules can be tested without it.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer } from "http";
import { decode, encode, PROTOCOL_VERSION, type ServerMessage } from "./protocol";
import type { MatchService, Delivery } from "../match/MatchService";
import type { AuthService } from "../auth/AuthService";
import { judgeConnection, type TlsSettings } from "./tls";

const SERVER_VERSION = "0.2.0";
const HEARTBEAT_MS = 30_000;

interface Session {
  socket: WebSocket;
  playerId: string | null;
  matchId: string | null;
  alive: boolean;
  /** A connection gets a couple of tries before it is shown the door. */
  authAttempts: number;
  /**
   * Messages from one connection are handled strictly in order.
   *
   * `ws` calls the message handler again as soon as the previous call
   * *returns*, not when its promise settles - so the moment any handler
   * awaits (authentication, a store write), a later message can overtake an
   * earlier one. Clients legitimately send `hello` and then immediately
   * `rejoinMatch`, which would race and be rejected as unauthenticated.
   * Chaining onto this promise restores the ordering the protocol assumes.
   */
  queue: Promise<void>;
}

/** Close codes, so the client can tell "wrong secret" from "network died". */
const CLOSE_REPLACED = 4000;
const CLOSE_AUTH_FAILED = 4001;
const CLOSE_INSECURE = 4002;
const MAX_AUTH_ATTEMPTS = 3;

export function attachGameServer(
  httpServer: HttpServer,
  matches: MatchService,
  auth: AuthService,
  tls: TlsSettings,
): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: "/play" });
  /** playerId -> session. One live connection per player; a second login
   *  displaces the first rather than duplicating a seat. */
  const sessions = new Map<string, Session>();

  function send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(encode(message));
  }

  function dispatch(deliveries: Delivery[], asRejection?: string): void {
    for (const delivery of deliveries) {
      const target = sessions.get(delivery.playerId);
      if (!target) continue; // Offline player: their state is persisted, they resync on rejoin.
      send(
        target.socket,
        asRejection
          ? { t: "actionRejected", reason: asRejection, view: delivery.view }
          : { t: "update", events: delivery.events, view: delivery.view },
      );
    }
  }

  wss.on("connection", (socket, request) => {
    // Refuse before a single frame is read. The client's first message
    // carries its secret, so an insecure connection must never get far
    // enough to send one.
    const verdict = judgeConnection(
      {
        encrypted: (request.socket as { encrypted?: boolean }).encrypted === true,
        forwardedProto: request.headers["x-forwarded-proto"] as string | undefined,
        remoteAddress: request.socket.remoteAddress,
      },
      tls,
    );
    if (!verdict.ok) {
      console.warn(
        `[net] refused insecure connection from ${request.socket.remoteAddress ?? "unknown"}`,
      );
      send(socket, { t: "error", code: "insecure_transport" });
      socket.close(CLOSE_INSECURE, "insecure_transport");
      return;
    }

    const session: Session = {
      socket, playerId: null, matchId: null, alive: true, authAttempts: 0,
      queue: Promise.resolve(),
    };

    socket.on("pong", () => {
      session.alive = true;
    });

    socket.on("message", (raw) => {
      // Queue rather than handle: see Session.queue.
      session.queue = session.queue.then(() => handleMessage(raw.toString()));
    });

    async function handleMessage(raw: string): Promise<void> {
      const message = decode(raw);
      if (!message) return send(socket, { t: "error", code: "malformed_message" });

      // Identity must be established before anything else touches a match.
      if (message.t !== "hello" && !session.playerId) {
        return send(socket, { t: "error", code: "not_authenticated" });
      }

      try {
        switch (message.t) {
          case "hello": {
            // Nothing is trusted until this passes: not the id, and not the
            // seat it would claim. The token never reaches a log.
            session.authAttempts += 1;
            const result = await auth.authenticate(message.playerId, message.token);

            if (!result.ok) {
              send(socket, { t: "error", code: result.reason });
              if (session.authAttempts >= MAX_AUTH_ATTEMPTS) {
                socket.close(CLOSE_AUTH_FAILED, "auth_failed");
              }
              return;
            }

            // Only now may this connection take over the id. A second device
            // logging in displaces the first rather than sharing the seat.
            const previous = sessions.get(result.playerId);
            if (previous !== undefined && previous !== session) {
              previous.socket.close(CLOSE_REPLACED, "replaced_by_new_connection");
            }
            session.playerId = result.playerId;
            sessions.set(result.playerId, session);

            return send(socket, {
              t: "welcome",
              playerId: result.playerId,
              serverVersion: SERVER_VERSION,
              protocolVersion: PROTOCOL_VERSION,
            });
          }

          case "createMatch": {
            const result = await matches.create(session.playerId!, message.mapId, message.faction);
            if (!result.ok) return send(socket, { t: "error", code: result.reason! });
            session.matchId = result.matchId!;
            send(socket, { t: "matchCreated", matchId: result.matchId!, joinCode: result.matchId! });
            return dispatch(result.deliveries);
          }

          case "joinMatch": {
            const result = await matches.join(session.playerId!, message.matchId, message.faction);
            if (!result.ok) return send(socket, { t: "error", code: result.reason! });
            session.matchId = message.matchId;
            return dispatch(result.deliveries);
          }

          case "rejoinMatch": {
            const result = await matches.rejoin(session.playerId!, message.matchId);
            if (!result.ok) return send(socket, { t: "error", code: result.reason! });
            session.matchId = message.matchId;
            for (const delivery of result.deliveries) {
              const target = sessions.get(delivery.playerId);
              if (!target) continue;
              send(target.socket, { t: "state", view: delivery.view });
            }
            return;
          }

          case "action": {
            const result = await matches.act(session.playerId!, message.matchId, message.action);
            return dispatch(result.deliveries, result.ok ? undefined : result.reason);
          }

          case "ping":
            return send(socket, { t: "pong" });

          default:
            return send(socket, { t: "error", code: "unknown_message_type" });
        }
      } catch (err) {
        console.error("[net] handler failed", err);
        send(socket, { t: "error", code: "internal_error" });
      }
    }

    socket.on("close", async () => {
      if (!session.playerId) return;
      if (sessions.get(session.playerId) === session) sessions.delete(session.playerId);
      if (session.matchId) {
        // Disconnecting never forfeits: the match is persisted and waiting.
        await matches.setConnected(session.playerId, session.matchId, false);
      }
    });
  });

  // Drop half-open connections so a player's seat is not held by a dead socket.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const session = [...sessions.values()].find((s) => s.socket === socket);
      if (session && !session.alive) {
        socket.terminate();
        continue;
      }
      if (session) session.alive = false;
      socket.ping();
    }
  }, HEARTBEAT_MS);
  wss.on("close", () => clearInterval(heartbeat));

  return wss;
}
