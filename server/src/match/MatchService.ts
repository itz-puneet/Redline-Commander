/**
 * Match lifecycle: the seam between the transport layer and the pure rules
 * engine. It owns the live in-memory cache, writes committed turns through
 * to the MatchStore, and decides who gets told what.
 *
 * Note there is no "room" abstraction tying a match to a live connection.
 * A match is a persisted record; connections attach to and detach from it.
 * That is what makes reconnecting mid-match, and taking a turn a day later,
 * ordinary rather than special-cased.
 */

import { randomBytes } from "crypto";
import { addPlayer, applyAction, createMatch } from "../game/engine";
import { buildPlayerView, filterEventsFor, type PlayerView } from "../game/view";
import type { Action, GameEvent, MatchState } from "../game/types";
import type { MatchStore } from "./MatchStore";

export interface Delivery {
  playerId: string;
  events: GameEvent[];
  view: PlayerView;
}

export interface CommandResult {
  ok: boolean;
  reason?: string;
  deliveries: Delivery[];
  matchId?: string;
}

function newId(bytes = 6): string {
  return randomBytes(bytes).toString("hex");
}

export class MatchService {
  private readonly cache = new Map<string, MatchState>();

  constructor(private readonly store: MatchStore) {}

  private async get(matchId: string): Promise<MatchState | null> {
    const cached = this.cache.get(matchId);
    if (cached) return cached;
    const loaded = await this.store.load(matchId);
    if (loaded) this.cache.set(matchId, loaded);
    return loaded;
  }

  private async commit(state: MatchState): Promise<void> {
    this.cache.set(state.matchId, state);
    await this.store.save(state);
  }

  /** Fan the same authoritative state out as one fog-filtered payload each. */
  private deliveries(state: MatchState, events: GameEvent[]): Delivery[] {
    return state.players.map((player) => ({
      playerId: player.playerId,
      events: filterEventsFor(state, player.slot, events),
      view: buildPlayerView(state, player.slot),
    }));
  }

  async create(playerId: string, mapId: string, faction: string): Promise<CommandResult> {
    let state: MatchState;
    try {
      state = createMatch({ matchId: newId(), mapId });
    } catch (err) {
      return { ok: false, reason: `bad_map: ${(err as Error).message}`, deliveries: [] };
    }

    const joined = addPlayer(state, playerId, faction);
    if (!joined.ok) return { ok: false, reason: joined.reason, deliveries: [] };

    await this.commit(joined.state);
    return {
      ok: true,
      matchId: joined.state.matchId,
      deliveries: this.deliveries(joined.state, joined.events),
    };
  }

  async join(playerId: string, matchId: string, faction: string): Promise<CommandResult> {
    const state = await this.get(matchId);
    if (!state) return { ok: false, reason: "no_such_match", deliveries: [] };

    const joined = addPlayer(state, playerId, faction);
    if (!joined.ok) return { ok: false, reason: joined.reason, deliveries: [] };

    await this.commit(joined.state);
    return {
      ok: true,
      matchId,
      deliveries: this.deliveries(joined.state, joined.events),
    };
  }

  /** Resume a seat. The player's own view is rebuilt from scratch, so a
   *  client that was offline for ten turns needs no catch-up log. */
  async rejoin(playerId: string, matchId: string): Promise<CommandResult> {
    const state = await this.get(matchId);
    if (!state) return { ok: false, reason: "no_such_match", deliveries: [] };

    const player = state.players.find((p) => p.playerId === playerId);
    if (!player) return { ok: false, reason: "not_in_this_match", deliveries: [] };

    player.connected = true;
    await this.commit(state);
    return { ok: true, matchId, deliveries: this.deliveries(state, []) };
  }

  async setConnected(playerId: string, matchId: string, connected: boolean): Promise<void> {
    const state = await this.get(matchId);
    const player = state?.players.find((p) => p.playerId === playerId);
    if (!state || !player) return;
    player.connected = connected;
    await this.commit(state);
  }

  /**
   * Apply one action. Note the granularity: a single action, not a batch.
   * With fog of war and a server-side luck roll the client cannot know the
   * outcome of action N before it sees the result of action N-1, so a batch
   * submitted up front would either be guesswork or would leak information.
   */
  async act(playerId: string, matchId: string, action: Action): Promise<CommandResult> {
    const state = await this.get(matchId);
    if (!state) return { ok: false, reason: "no_such_match", deliveries: [] };

    const player = state.players.find((p) => p.playerId === playerId);
    if (!player) return { ok: false, reason: "not_in_this_match", deliveries: [] };

    const result = applyAction(state, player.slot, action);
    if (!result.ok) {
      // The rejection goes only to the offending client, along with a fresh
      // view so a desynced client is corrected rather than left guessing.
      return {
        ok: false,
        reason: result.reason,
        matchId,
        deliveries: [
          { playerId, events: [], view: buildPlayerView(state, player.slot) },
        ],
      };
    }

    await this.commit(result.state);
    return { ok: true, matchId, deliveries: this.deliveries(result.state, result.events) };
  }
}
