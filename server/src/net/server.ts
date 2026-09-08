/**
 * WebSocket transport. Deliberately thin: parse a frame, hand it to
 * MatchService, write the resulting per-player payloads back out. It holds
 * no game rules whatsoever, which is why the rules can be tested without it.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer } from "http";
import { decode, encode, PROTOCOL_VERSION, type ServerMessage } from "./protocol";
import type { MatchService, Delivery } from "../match/MatchService";

const SERVER_VERSION = "0.2.0";
const HEARTBEAT_MS = 30_000;

interface Session {
  socket: WebSocket;
  playerId: string | null;
  matchId: string | null;
  alive: boolean;
}

export function attachGameServer(httpServer: HttpServer, matches: MatchService): WebSocketServer {
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

  wss.on("connection", (socket) => {
    const session: Session = { socket, playerId: null, matchId: null, alive: true };

    socket.on("pong", () => {
      session.alive = true;
    });

    socket.on("message", async (raw) => {
      const message = decode(raw.toString());
      if (!message) return send(socket, { t: "error", code: "malformed_message" });

      // Identity must be established before anything else touches a match.
      if (message.t !== "hello" && !session.playerId) {
        return send(socket, { t: "error", code: "not_authenticated" });
      }

      try {
        switch (message.t) {
          case "hello": {
            // TODO(auth): verify `token` against a real account/device record
            // before trusting playerId. Until then a client can claim any
            // seat, so do not run this open to the internet as-is.
            if (!message.playerId) {
              return send(socket, { t: "error", code: "missing_player_id" });
            }
            sessions.get(message.playerId)?.socket.close(4000, "replaced_by_new_connection");
            session.playerId = message.playerId;
            sessions.set(message.playerId, session);
            return send(socket, {
              t: "welcome",
              playerId: message.playerId,
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
    });

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
