/**
 * Device credentials.
 *
 * A player is a device holding a secret, not an account with a password.
 * The client generates both on first launch (see client/scripts/net/
 * player_identity.gd) and stores them in user://; the server records a hash
 * of the secret the first time it sees the id, and checks it thereafter.
 *
 * Why a plain salted SHA-256 rather than scrypt/argon2: the secret here is
 * 256 bits of machine-generated randomness, not something a human chose.
 * Slow KDFs exist to make guessing *low-entropy* secrets expensive; against
 * a random 256-bit token, guessing is already hopeless, and a slow hash on
 * every connection would only add latency. DO NOT reuse this module for
 * human-chosen passwords - it is the wrong tool for those.
 */

import { createHash, randomBytes, timingSafeEqual } from "crypto";

/**
 * Ids end up in filenames, so the character set is restricted rather than
 * escaped - there is no reason for a legitimate id to contain anything else,
 * and this closes path traversal at the door instead of downstream.
 */
export const PLAYER_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Long enough that guessing is pointless. The real client sends 64 hex. */
export const MIN_TOKEN_LENGTH = 16;
export const MAX_TOKEN_LENGTH = 256;

export interface Credential {
  playerId: string;
  salt: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
}

export function isValidPlayerId(playerId: unknown): playerId is string {
  return typeof playerId === "string" && PLAYER_ID_PATTERN.test(playerId);
}

export function isValidToken(token: unknown): token is string {
  return (
    typeof token === "string" &&
    token.length >= MIN_TOKEN_LENGTH &&
    token.length <= MAX_TOKEN_LENGTH
  );
}

export function newSalt(): string {
  return randomBytes(16).toString("hex");
}

export function hashToken(token: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${token}`).digest("hex");
}

/**
 * Constant-time comparison. Both sides are SHA-256 hex digests, so they are
 * always the same length and timingSafeEqual cannot throw - which also means
 * the comparison never leaks how much of a wrong token was right.
 */
export function tokenMatches(token: string, credential: Credential): boolean {
  const presented = Buffer.from(hashToken(token, credential.salt), "hex");
  const stored = Buffer.from(credential.tokenHash, "hex");
  if (presented.length !== stored.length) return false;
  return timingSafeEqual(presented, stored);
}
