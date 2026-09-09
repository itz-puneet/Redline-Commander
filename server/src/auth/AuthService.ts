/**
 * Trust on first use: the first connection to claim a player id registers
 * it, and every later connection must present the same secret.
 *
 * This is the right trade for a game played with friends - no accounts, no
 * email, no password reset, and a device that keeps its identity across
 * reinstalls of the *server*. What it does not survive is losing the device
 * or clearing app data: the client generates a new id and starts fresh, and
 * any match the old id was in is unreachable. That is a deliberate v1
 * limitation, not an oversight - see docs/ROADMAP.md.
 *
 * The window it leaves open is small but real: whoever claims an
 * unregistered id first owns it. Ids are 128 bits of client-generated
 * randomness, so guessing one that is about to be used is not a practical
 * attack, but this is the reason a public deployment eventually wants real
 * accounts rather than trust-on-first-use.
 */

import type { CredentialStore } from "./CredentialStore";
import {
  hashToken,
  isValidPlayerId,
  isValidToken,
  newSalt,
  tokenMatches,
  type Credential,
} from "./tokens";

export type AuthFailure =
  | "invalid_player_id"
  | "invalid_token"
  | "auth_failed"
  | "rate_limited";

export type AuthResult =
  | { ok: true; playerId: string; registered: boolean }
  | { ok: false; reason: AuthFailure };

export class AuthService {
  /**
   * One authentication at a time per player id. Registration is a
   * find-then-save, so two `hello` frames for the same unregistered id could
   * both find nothing, both register, and leave the first device permanently
   * locked out with a secret the store no longer holds.
   */
  private readonly inFlight = new Map<string, Promise<AuthResult>>();

  constructor(private readonly store: CredentialStore) {}

  /**
   * `canRegister` gates creating a NEW identity, which writes a file. It is
   * asked only when the id is actually unknown, so a returning player is
   * never turned away by a registration budget they are not spending.
   */
  async authenticate(
    playerId: unknown,
    token: unknown,
    canRegister: () => boolean = () => true,
  ): Promise<AuthResult> {
    if (!isValidPlayerId(playerId)) return { ok: false, reason: "invalid_player_id" };
    if (!isValidToken(token)) return { ok: false, reason: "invalid_token" };

    const id = playerId;
    const previous = this.inFlight.get(id) ?? Promise.resolve<AuthResult | null>(null);
    const run = previous
      .catch(() => null)
      .then(() => this.check(id, token, canRegister));
    this.inFlight.set(id, run);

    const release = () => {
      if (this.inFlight.get(id) === run) this.inFlight.delete(id);
    };
    run.then(release, release);
    return run;
  }

  private async check(
    playerId: string,
    token: string,
    canRegister: () => boolean,
  ): Promise<AuthResult> {

    const existing = await this.store.find(playerId);

    if (existing === null) {
      if (!canRegister()) return { ok: false, reason: "rate_limited" };
      const salt = newSalt();
      await this.store.save({
        playerId,
        salt,
        tokenHash: hashToken(token, salt),
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      });
      return { ok: true, playerId, registered: true };
    }

    // One rejection reason for a wrong token, so a failed attempt cannot be
    // used to learn whether an id exists.
    if (!tokenMatches(token, existing)) return { ok: false, reason: "auth_failed" };

    await this.store.save({ ...existing, lastSeenAt: new Date().toISOString() } as Credential);
    return { ok: true, playerId, registered: false };
  }
}
