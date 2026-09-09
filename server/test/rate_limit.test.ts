/**
 * Rate limiting.
 *
 * The clock is injected, so behaviour over time is asserted directly rather
 * than with sleeps - which keeps these fast and, more importantly, exact.
 *
 * A recurring theme: the limiter must not itself become the attack. A map
 * keyed by something the attacker chooses is a memory exhaustion vector, so
 * the bounding and eviction get as much attention as the counting.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BucketRegistry,
  ConnectionCounter,
  DEFAULT_RATE_LIMITS,
  RateLimiter,
  TokenBucket,
  readRateLimits,
  type RateLimitSettings,
} from "../src/net/rate_limit";

const T0 = 1_000_000;

/* --------------------------- token bucket ------------------------- */

test("a bucket starts full and empties one token at a time", () => {
  const bucket = new TokenBucket(3, 1, T0);
  assert.equal(bucket.tryConsume(T0), true);
  assert.equal(bucket.tryConsume(T0), true);
  assert.equal(bucket.tryConsume(T0), true);
  assert.equal(bucket.tryConsume(T0), false, "the fourth in the same instant is refused");
});

test("tokens refill continuously, not in steps", () => {
  const bucket = new TokenBucket(10, 10, T0);
  for (let i = 0; i < 10; i++) bucket.tryConsume(T0);
  assert.equal(bucket.tryConsume(T0), false);

  // Half a second at 10/s is five tokens.
  assert.equal(Math.floor(bucket.available(T0 + 500)), 5);
  assert.equal(bucket.tryConsume(T0 + 500), true);
});

test("refill is capped at the burst size, so idling does not bank forever", () => {
  const bucket = new TokenBucket(5, 10, T0);
  bucket.tryConsume(T0, 5);
  assert.equal(bucket.available(T0 + 60_000), 5, "an hour idle still yields one burst");
});

test("a clock that jumps backwards does not mint tokens", () => {
  const bucket = new TokenBucket(2, 1, T0);
  assert.equal(bucket.tryConsume(T0), true);
  assert.equal(bucket.tryConsume(T0), true);
  assert.equal(bucket.tryConsume(T0 - 60_000), false, "going back in time is not a refill");
});

test("a sustained rate is allowed indefinitely", () => {
  const bucket = new TokenBucket(5, 10, T0);
  let allowed = 0;
  // 100ms apart is exactly 10/s.
  for (let i = 0; i < 50; i++) {
    if (bucket.tryConsume(T0 + i * 100)) allowed += 1;
  }
  assert.equal(allowed, 50, "a client at the limit is never refused");
});

test("a burst beyond the budget is refused, then recovers", () => {
  const bucket = new TokenBucket(5, 10, T0);
  let refused = 0;
  for (let i = 0; i < 20; i++) {
    if (!bucket.tryConsume(T0)) refused += 1;
  }
  assert.equal(refused, 15);
  assert.equal(bucket.tryConsume(T0 + 1000), true, "a second later it is usable again");
});

/* --------------------------- the registry ------------------------- */

test("each key gets its own budget", () => {
  const registry = new BucketRegistry(2, 1, 100);
  assert.equal(registry.tryConsume("a", T0), true);
  assert.equal(registry.tryConsume("a", T0), true);
  assert.equal(registry.tryConsume("a", T0), false);
  assert.equal(registry.tryConsume("b", T0), true, "one noisy key must not limit another");
});

test("idle keys are swept, so a quiet server does not accumulate them", () => {
  const registry = new BucketRegistry(2, 1, 100, 60_000);
  registry.tryConsume("gone", T0);
  registry.tryConsume("here", T0);
  assert.equal(registry.size, 2);

  registry.tryConsume("here", T0 + 59_000);
  assert.equal(registry.sweep(T0 + 61_000), 1, "only the untouched key goes");
  assert.equal(registry.size, 1);
});

test("the registry is bounded, and fails closed rather than growing", () => {
  const registry = new BucketRegistry(5, 1, 3, 60_000);
  for (const key of ["a", "b", "c"]) {
    assert.equal(registry.tryConsume(key, T0), true);
  }
  assert.equal(registry.size, 3);

  // A fourth distinct key while all three are live: refused, not admitted.
  assert.equal(registry.tryConsume("d", T0), false, "memory must stay bounded under a flood");
  assert.equal(registry.size, 3);

  // Known keys keep working - existing players are not collateral damage.
  assert.equal(registry.tryConsume("a", T0), true);
});

test("a full registry admits new keys again once old ones go idle", () => {
  const registry = new BucketRegistry(5, 1, 2, 60_000);
  registry.tryConsume("old1", T0);
  registry.tryConsume("old2", T0);
  assert.equal(registry.tryConsume("new", T0), false);

  // Later, with the old keys untouched, the sweep inside tryConsume frees room.
  assert.equal(registry.tryConsume("new", T0 + 120_000), true);
});

/* ------------------------ concurrent sockets ---------------------- */

test("concurrent sockets per address are capped", () => {
  const counter = new ConnectionCounter(2, 100);
  assert.equal(counter.tryAcquire("1.2.3.4"), true);
  assert.equal(counter.tryAcquire("1.2.3.4"), true);
  assert.equal(counter.tryAcquire("1.2.3.4"), false);
  assert.equal(counter.tryAcquire("5.6.7.8"), true, "a different address is unaffected");
});

test("releasing frees a slot, and a drained address costs no memory", () => {
  const counter = new ConnectionCounter(1, 100);
  assert.equal(counter.tryAcquire("1.2.3.4"), true);
  assert.equal(counter.size, 1);

  counter.release("1.2.3.4");
  assert.equal(counter.size, 0, "an address with no sockets must not linger");
  assert.equal(counter.tryAcquire("1.2.3.4"), true);
});

test("a refused connection is not counted", () => {
  const counter = new ConnectionCounter(1, 100);
  counter.tryAcquire("1.2.3.4");
  counter.tryAcquire("1.2.3.4");
  counter.release("1.2.3.4");
  assert.equal(counter.countFor("1.2.3.4"), 0, "the refusal must not leak a slot");
});

test("releasing something never acquired is harmless", () => {
  const counter = new ConnectionCounter(2, 100);
  counter.release("never-seen");
  assert.equal(counter.size, 0);
});

test("the address map is bounded too", () => {
  const counter = new ConnectionCounter(5, 2);
  assert.equal(counter.tryAcquire("a"), true);
  assert.equal(counter.tryAcquire("b"), true);
  assert.equal(counter.tryAcquire("c"), false, "a third distinct address is refused when full");
  assert.equal(counter.tryAcquire("a"), true, "but a known one may open another socket");
});

/* ---------------------------- settings ---------------------------- */

test("limits are on by default and disabled only explicitly", () => {
  assert.equal(readRateLimits({}).enabled, true);
  assert.equal(readRateLimits({ REDLINE_DISABLE_RATE_LIMIT: "true" }).enabled, true);
  assert.equal(readRateLimits({ REDLINE_DISABLE_RATE_LIMIT: "1" }).enabled, false);
});

test("nonsense overrides fall back to the defaults rather than to zero", () => {
  for (const raw of ["0", "-5", "abc", ""]) {
    assert.equal(
      readRateLimits({ REDLINE_MESSAGES_PER_SECOND: raw }).messagesPerSecond,
      DEFAULT_RATE_LIMITS.messagesPerSecond,
      `"${raw}" must not disable limiting`,
    );
  }
  assert.equal(readRateLimits({ REDLINE_MESSAGES_PER_SECOND: "25" }).messagesPerSecond, 25);
});

/* --------------------------- the limiter -------------------------- */

function limiter(overrides: Partial<RateLimitSettings> = {}): RateLimiter {
  return new RateLimiter({ ...DEFAULT_RATE_LIMITS, ...overrides });
}

test("a normal turn is nowhere near the message limit", () => {
  const rl = limiter();
  // Twenty actions over ten seconds - a brisk turn.
  for (let i = 0; i < 20; i++) {
    assert.equal(rl.allowMessage("player", T0 + i * 500), true, `message ${i}`);
  }
});

test("a flood is refused", () => {
  const rl = limiter();
  let refused = 0;
  for (let i = 0; i < 200; i++) {
    if (!rl.allowMessage("player", T0)) refused += 1;
  }
  assert.ok(refused > 150, `only ${refused} of 200 instant messages refused`);
});

test("match creation has its own budget, separate from messages", () => {
  const rl = limiter({ matchesPerMinute: 3 });
  for (let i = 0; i < 3; i++) {
    assert.equal(rl.allowMatchCreation("player", T0), true);
  }
  assert.equal(rl.allowMatchCreation("player", T0), false, "the fourth in a minute is refused");
  assert.equal(rl.allowMessage("player", T0), true, "ordinary messages still flow");
});

test("disabling turns every check into a yes", () => {
  const rl = limiter({ enabled: false, messagesPerSecond: 1, messageBurst: 1 });
  for (let i = 0; i < 500; i++) {
    assert.equal(rl.allowMessage("player", T0), true);
  }
  assert.equal(rl.acquireSocket("addr"), true);
  assert.match(rl.describe(), /DISABLED/);
});

test("sweeping clears idle keys across every registry", () => {
  const rl = limiter();
  rl.allowMessage("a", T0);
  rl.allowMatchCreation("b", T0);
  rl.allowNewConnection("c", T0);
  assert.equal(rl.messages.size + rl.matchCreation.size + rl.newConnections.size, 3);

  rl.sweep(T0 + 10 * 60_000);
  assert.equal(rl.messages.size + rl.matchCreation.size + rl.newConnections.size, 0);
});

test("the posture describes the actual numbers", () => {
  const description = limiter({ messagesPerSecond: 7, connectionsPerIp: 3 }).describe();
  assert.match(description, /7\/s/);
  assert.match(description, /3 sockets/);
});

/* ------------------ settings coverage (review follow-up) ---------- */

test("every setting is readable from the environment", () => {
  const settings = readRateLimits({
    REDLINE_MESSAGES_PER_SECOND: "5",
    REDLINE_MESSAGE_BURST: "7",
    REDLINE_MAX_MESSAGE_VIOLATIONS: "3",
    REDLINE_CONNECTIONS_PER_IP: "4",
    REDLINE_NEW_CONNECTIONS_PER_MINUTE: "11",
    REDLINE_MATCHES_PER_MINUTE: "2",
    REDLINE_REGISTRATIONS_PER_MINUTE: "6",
    REDLINE_MAX_PAYLOAD_BYTES: "1234",
    REDLINE_MAX_TRACKED_KEYS: "99",
    REDLINE_HANDSHAKE_BURST: "3",
    REDLINE_AUTH_DEADLINE_MS: "5000",
  });
  assert.deepEqual(settings, {
    enabled: true,
    messagesPerSecond: 5,
    messageBurst: 7,
    maxMessageViolations: 3,
    connectionsPerIp: 4,
    newConnectionsPerMinute: 11,
    matchesPerMinute: 2,
    registrationsPerMinute: 6,
    maxPayloadBytes: 1234,
    maxTrackedKeys: 99,
    handshakeBurst: 3,
    authDeadlineMs: 5000,
  });
});

test("lowering the rate lowers the burst with it", () => {
  // Otherwise a lowered rate still lets through a burst of the old size,
  // which is exactly the flood it was set to prevent.
  const strict = readRateLimits({ REDLINE_MESSAGES_PER_SECOND: "2" });
  assert.equal(strict.messagesPerSecond, 2);
  assert.ok(strict.messageBurst <= 6, `burst was ${strict.messageBurst}`);

  // Unless it is set outright.
  const explicit = readRateLimits({
    REDLINE_MESSAGES_PER_SECOND: "2", REDLINE_MESSAGE_BURST: "50",
  });
  assert.equal(explicit.messageBurst, 50);
});

test("registration has a budget of its own", () => {
  const rl = limiter({ registrationsPerMinute: 3 });
  for (let i = 0; i < 3; i++) {
    assert.equal(rl.allowRegistration("1.2.3.4", T0), true);
  }
  assert.equal(rl.allowRegistration("1.2.3.4", T0), false,
    "an unbounded registration rate fills the credential store");
  assert.equal(rl.allowRegistration("5.6.7.8", T0), true, "keyed per address");
  assert.equal(rl.allowMessage("1.2.3.4", T0), true, "ordinary messages are unaffected");
});

test("a handshake budget belongs to one socket, not one address", () => {
  const rl = limiter({ handshakeBurst: 2 });
  // Two sockets from the same address each get their own - behind a proxy
  // they all look like loopback, and a shared budget would let one client's
  // handshake burst strand everyone else.
  const first = rl.newHandshakeBucket(T0);
  const second = rl.newHandshakeBucket(T0);

  assert.equal(first.tryConsume(T0), true);
  assert.equal(first.tryConsume(T0), true);
  assert.equal(first.tryConsume(T0), false);
  assert.equal(second.tryConsume(T0), true, "a second socket is unaffected");
});
