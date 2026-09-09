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

import { randomBytes, randomInt } from "crypto";
import { addPlayer, applyAction, createMatch } from "../game/engine";
import { buildPlayerView, filterEventsFor, type PlayerView } from "../game/view";
import type { Action, GameEvent, MatchState } from "../game/types";
import type { MatchStore } from "./MatchStore";

export interface Delivery {
  playerId: string;
  events: GameEvent[];
  view: PlayerView;
}

/** Who changed presence, and who has not been told yet. */
export interface PresenceChange {
  slot: number;
  connected: boolean;
  notify: string[];
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
  /**
   * One operation at a time per match.
   *
   * Serializing only the disk write is not enough: every operation here is a
   * read-modify-write, and `await get()` resolves with the state as of the
   * *call*. Two operations starting in the same tick - player A's action and
   * player B's socket closing, say - would both compute from the same
   * snapshot, and the later commit would write a stale state over the newer
   * one, erasing a turn that had already been acknowledged and animated.
   *
   * Messages from one connection are already ordered by the transport; this
   * is what orders them *between* connections.
   */
  private readonly operations = new Map<string, Promise<unknown>>();

  constructor(private readonly store: MatchStore) {}

  /**
   * Runs `work` with exclusive access to one match. Everything that reads
   * then writes a match goes through here.
   */
  private exclusive<T>(matchId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(matchId) ?? Promise.resolve();
    // A failed operation must not poison the queue behind it.
    const run = previous.then(work, work);
    this.operations.set(matchId, run);

    const release = () => {
      if (this.operations.get(matchId) === run) this.operations.delete(matchId);
    };
    run.then(release, release);
    return run;
  }

  /** Only ever called inside `exclusive`, so no read can race a write. */
  private async get(matchId: string): Promise<MatchState | null> {
    const cached = this.cache.get(matchId);
    if (cached) return cached;

    const loaded = await this.store.load(matchId);
    if (loaded) this.cache.set(matchId, loaded);
    return loaded;
  }

  /**
   * Persist first, then cache. Caching a state whose write failed would serve
   * everyone a turn that vanishes on the next restart, and tell only the
   * acting player it went wrong.
   */
  private async commit(state: MatchState): Promise<void> {
    await this.store.save(state);

    // A finished match is not coming back; keeping it cached forever is a
    // slow leak on a server that has hosted a lot of games.
    if (state.phase === "finished") {
      this.cache.delete(state.matchId);
      return;
    }
    this.cache.set(state.matchId, state);
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
      // The seed comes from here rather than the engine, so the engine stays
      // a pure function of its inputs and the seed is not guessable.
      state = createMatch({ matchId: newId(), mapId, rngSeed: randomInt(0, 0x7fffffff) });
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
    return this.exclusive(matchId, () => this.joinLocked(playerId, matchId, faction));
  }

  private async joinLocked(
    playerId: string, matchId: string, faction: string,
  ): Promise<CommandResult> {
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
    return this.exclusive(matchId, () => this.rejoinLocked(playerId, matchId));
  }

  private async rejoinLocked(playerId: string, matchId: string): Promise<CommandResult> {
    const state = await this.get(matchId);
    if (!state) return { ok: false, reason: "no_such_match", deliveries: [] };

    const player = state.players.find((p) => p.playerId === playerId);
    if (!player) return { ok: false, reason: "not_in_this_match", deliveries: [] };

    player.connected = true;
    await this.commit(state);
    return { ok: true, matchId, deliveries: this.deliveries(state, []) };
  }

  /**
   * Records presence and reports who should be told. Persisting it silently
   * left the opponent's UI showing a dropped player as present forever, and
   * the protocol has declared `opponentConnection` since the beginning.
   */
  async setConnected(
    playerId: string, matchId: string, connected: boolean,
  ): Promise<PresenceChange | null> {
    return this.exclusive(matchId, async () => {
      const state = await this.get(matchId);
      const player = state?.players.find((p) => p.playerId === playerId);
      if (!state || !player) return null;
      if (player.connected === connected) return null;

      player.connected = connected;
      await this.commit(state);

      return {
        slot: player.slot,
        connected,
        notify: state.players.filter((p) => p.playerId !== playerId).map((p) => p.playerId),
      };
    });
  }

  /**
   * Apply one action. Note the granularity: a single action, not a batch.
   * With fog of war and a server-side luck roll the client cannot know the
   * outcome of action N before it sees the result of action N-1, so a batch
   * submitted up front would either be guesswork or would leak information.
   */
  async act(playerId: string, matchId: string, action: Action): Promise<CommandResult> {
    return this.exclusive(matchId, () => this.actLocked(playerId, matchId, action));
  }

  private async actLocked(
    playerId: string, matchId: string, action: Action,
  ): Promise<CommandResult> {
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
