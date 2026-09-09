/**
 * Credential tests.
 *
 * Auth is the one place where a bug is not a wrong pixel but someone else's
 * match, so these are deliberately unforgiving about the failure modes:
 * wrong secrets, malformed ids, and anything that would let a rejection be
 * used to learn what exists.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AuthService } from "../src/auth/AuthService";
import { FileCredentialStore, type CredentialStore } from "../src/auth/CredentialStore";
import {
  hashToken,
  isValidPlayerId,
  isValidToken,
  newSalt,
  tokenMatches,
  MIN_TOKEN_LENGTH,
} from "../src/auth/tokens";

const GOOD_TOKEN = "a".repeat(64);
const OTHER_TOKEN = "b".repeat(64);

function tempStore(): { store: CredentialStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redline-auth-"));
  return { store: new FileCredentialStore(dir), dir };
}

function service(): AuthService {
  return new AuthService(tempStore().store);
}

/* ---------------------------- hashing ----------------------------- */

test("a token hash depends on the salt", () => {
  const a = hashToken(GOOD_TOKEN, "salt-one");
  const b = hashToken(GOOD_TOKEN, "salt-two");
  assert.notEqual(a, b, "the same token under two salts must not collide");
  assert.equal(a, hashToken(GOOD_TOKEN, "salt-one"), "hashing must be deterministic");
});

test("the hash does not contain the token", () => {
  const salt = newSalt();
  const hash = hashToken(GOOD_TOKEN, salt);
  assert.ok(!hash.includes(GOOD_TOKEN));
  assert.match(hash, /^[a-f0-9]{64}$/);
});

test("a token matches its own hash and nothing else", () => {
  const salt = newSalt();
  const credential = {
    playerId: "player-one", salt, tokenHash: hashToken(GOOD_TOKEN, salt),
    createdAt: "", lastSeenAt: "",
  };
  assert.equal(tokenMatches(GOOD_TOKEN, credential), true);
  assert.equal(tokenMatches(OTHER_TOKEN, credential), false);
  // A near-miss must not fare any better than a wild guess.
  assert.equal(tokenMatches(GOOD_TOKEN.slice(0, -1) + "b", credential), false);
  assert.equal(tokenMatches("", credential), false);
});

/* --------------------------- validation --------------------------- */

test("player ids are restricted to what is safe in a filename", () => {
  assert.equal(isValidPlayerId("a1b2c3d4e5f60718"), true);
  assert.equal(isValidPlayerId("smoke-alice"), true);
  assert.equal(isValidPlayerId("dev_host"), true);

  assert.equal(isValidPlayerId("../../etc/passwd"), false, "path traversal");
  assert.equal(isValidPlayerId("has/slash"), false);
  assert.equal(isValidPlayerId("has space"), false);
  assert.equal(isValidPlayerId("short"), false, "too short to be random");
  assert.equal(isValidPlayerId("x".repeat(65)), false, "unbounded length");
  assert.equal(isValidPlayerId(""), false);
  assert.equal(isValidPlayerId(null), false);
  assert.equal(isValidPlayerId(42), false);
});

test("tokens must be long enough to be worth having", () => {
  assert.equal(isValidToken(GOOD_TOKEN), true);
  assert.equal(isValidToken("x".repeat(MIN_TOKEN_LENGTH)), true);
  assert.equal(isValidToken("x".repeat(MIN_TOKEN_LENGTH - 1)), false);
  assert.equal(isValidToken("dev"), false, "a placeholder secret is not a secret");
  assert.equal(isValidToken("x".repeat(257)), false);
  assert.equal(isValidToken(undefined), false);
});

/* -------------------------- trust on first use -------------------- */

test("the first connection to use an id registers it", async () => {
  const auth = service();
  const first = await auth.authenticate("brand-new-id", GOOD_TOKEN);
  assert.deepEqual(first, { ok: true, playerId: "brand-new-id", registered: true });

  const second = await auth.authenticate("brand-new-id", GOOD_TOKEN);
  assert.ok(second.ok);
  assert.equal(second.registered, false, "the second time is a login, not a registration");
});

test("a wrong token is refused", async () => {
  const auth = service();
  await auth.authenticate("taken-id-here", GOOD_TOKEN);

  const impostor = await auth.authenticate("taken-id-here", OTHER_TOKEN);
  assert.equal(impostor.ok, false);
  assert.equal(impostor.ok === false && impostor.reason, "auth_failed");
});

test("a rejection does not reveal whether the id exists", async () => {
  const auth = service();
  await auth.authenticate("registered-id", GOOD_TOKEN);

  const wrongToken = await auth.authenticate("registered-id", OTHER_TOKEN);
  const unregistered = await auth.authenticate("unregistered1", "x".repeat(4));

  // A known id with a bad token fails as auth_failed; an unknown id with a
  // *valid-looking* token would simply register, so the only way to probe is
  // with a malformed token - which fails on shape, before any lookup.
  assert.equal(wrongToken.ok === false && wrongToken.reason, "auth_failed");
  assert.equal(unregistered.ok === false && unregistered.reason, "invalid_token");
});

test("malformed identities are refused before anything is stored", async () => {
  const { store } = tempStore();
  const auth = new AuthService(store);

  const badId = await auth.authenticate("../escape", GOOD_TOKEN);
  assert.equal(badId.ok === false && badId.reason, "invalid_player_id");

  const badToken = await auth.authenticate("legitimate-id", "short");
  assert.equal(badToken.ok === false && badToken.reason, "invalid_token");

  assert.equal(await store.count(), 0, "a refused attempt must not create a credential");
});

test("two devices get separate credentials", async () => {
  const { store } = tempStore();
  const auth = new AuthService(store);

  await auth.authenticate("player-one-id", GOOD_TOKEN);
  await auth.authenticate("player-two-id", OTHER_TOKEN);
  assert.equal(await store.count(), 2);

  // Neither may use the other's secret.
  const crossed = await auth.authenticate("player-one-id", OTHER_TOKEN);
  assert.equal(crossed.ok, false);
});

/* ---------------------------- storage ----------------------------- */

test("the stored credential never contains the token", async () => {
  const { store, dir } = tempStore();
  await new AuthService(store).authenticate("stored-player", GOOD_TOKEN);

  const raw = fs.readFileSync(path.join(dir, "stored-player.json"), "utf8");
  assert.ok(!raw.includes(GOOD_TOKEN), "the secret itself must never be written");
  const parsed = JSON.parse(raw);
  assert.ok(parsed.salt && parsed.tokenHash);
  assert.equal(parsed.token, undefined);
});

test("credentials survive a restart", async () => {
  const { store, dir } = tempStore();
  await new AuthService(store).authenticate("returning-user", GOOD_TOKEN);

  // A brand new service over the same directory, as after a redeploy.
  const restarted = new AuthService(new FileCredentialStore(dir));
  const login = await restarted.authenticate("returning-user", GOOD_TOKEN);
  assert.ok(login.ok);
  assert.equal(login.registered, false);

  const impostor = await restarted.authenticate("returning-user", OTHER_TOKEN);
  assert.equal(impostor.ok, false);
});

test("the store refuses to build a path from a bad id", () => {
  const { dir } = tempStore();
  const store = new FileCredentialStore(dir);
  assert.rejects(() => store.find("../../etc/passwd"));
});

/* ---------------- registration budget (review follow-up) ---------- */

test("registering a new identity can be refused without touching the store", async () => {
  const { store } = tempStore();
  const auth = new AuthService(store);

  const refused = await auth.authenticate("brand-new-one", GOOD_TOKEN, () => false);
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.reason, "rate_limited");
  assert.equal(await store.count(), 0, "a refused registration must not write a file");
});

test("a returning player is never charged the registration budget", async () => {
  const { store } = tempStore();
  const auth = new AuthService(store);
  await auth.authenticate("already-here", GOOD_TOKEN);

  // canRegister returns false, but this id exists, so it is never consulted.
  let asked = false;
  const login = await auth.authenticate("already-here", GOOD_TOKEN, () => {
    asked = true;
    return false;
  });
  assert.ok(login.ok, "an existing player must log in regardless of the budget");
  assert.equal(asked, false, "the budget is only for identities that do not exist");
});

test("a wrong token on a known id is still auth_failed, not rate_limited", async () => {
  const { store } = tempStore();
  const auth = new AuthService(store);
  await auth.authenticate("known-player", GOOD_TOKEN);

  const impostor = await auth.authenticate("known-player", OTHER_TOKEN, () => false);
  assert.equal(impostor.ok === false && impostor.reason, "auth_failed",
    "the budget must not become a way to probe which ids exist");
});
