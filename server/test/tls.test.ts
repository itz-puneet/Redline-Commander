/**
 * Transport security policy.
 *
 * The failure this guards against is silent: a server that happily serves
 * plaintext to a remote client leaks that client's device secret on the
 * first frame, and nothing looks wrong. So the tests are mostly about what
 * must be REFUSED, and about not believing a header anyone can set.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  describePosture,
  isLoopback,
  judgeConnection,
  readTlsSettings,
  terminatesTls,
  tlsConfigError,
  type TlsSettings,
} from "../src/net/tls";

const DEFAULTS: TlsSettings = { trustProxy: false, allowInsecure: false };
const REMOTE = "203.0.113.7";

/* ---------------------------- settings ---------------------------- */

test("settings default to the strict posture", () => {
  const settings = readTlsSettings({});
  assert.equal(settings.trustProxy, false);
  assert.equal(settings.allowInsecure, false);
  assert.equal(terminatesTls(settings), false);
});

test("only an exact 1 enables the escape hatches", () => {
  assert.equal(readTlsSettings({ REDLINE_ALLOW_INSECURE: "true" }).allowInsecure, false);
  assert.equal(readTlsSettings({ REDLINE_ALLOW_INSECURE: "yes" }).allowInsecure, false);
  assert.equal(readTlsSettings({ REDLINE_ALLOW_INSECURE: "1" }).allowInsecure, true);
  assert.equal(readTlsSettings({ REDLINE_TRUST_PROXY: "0" }).trustProxy, false);
  // Every other proxy test builds settings literally, so without this a
  // broken read of this variable would never be noticed.
  assert.equal(readTlsSettings({ REDLINE_TRUST_PROXY: "1" }).trustProxy, true);
  assert.equal(readTlsSettings({ REDLINE_TRUST_PROXY: "true" }).trustProxy, false);
});

test("half a TLS configuration is refused rather than downgraded", () => {
  assert.ok(tlsConfigError({ ...DEFAULTS, certPath: "/c.pem" }));
  assert.ok(tlsConfigError({ ...DEFAULTS, keyPath: "/k.pem" }));
  assert.equal(tlsConfigError({ ...DEFAULTS, certPath: "/c.pem", keyPath: "/k.pem" }), null);
  assert.equal(tlsConfigError(DEFAULTS), null);
});

/* ---------------------------- loopback ---------------------------- */

test("loopback is recognised in its various spellings", () => {
  for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]) {
    assert.equal(isLoopback(address), true, address);
  }
  for (const address of [REMOTE, "10.0.0.5", "", undefined]) {
    assert.equal(isLoopback(address), false, String(address));
  }
});

/* ---------------------------- verdicts ---------------------------- */

test("a TLS connection is always acceptable", () => {
  const verdict = judgeConnection({ encrypted: true, remoteAddress: REMOTE }, DEFAULTS);
  assert.deepEqual(verdict, { ok: true, reason: "tls" });
});

test("plaintext from a remote host is refused by default", () => {
  const verdict = judgeConnection({ encrypted: false, remoteAddress: REMOTE }, DEFAULTS);
  assert.deepEqual(verdict, { ok: false, reason: "insecure_transport" });
});

test("plaintext on localhost still works, so development is unchanged", () => {
  const verdict = judgeConnection({ encrypted: false, remoteAddress: "127.0.0.1" }, DEFAULTS);
  assert.deepEqual(verdict, { ok: true, reason: "loopback" });
});

test("a connection with no known address is treated as remote", () => {
  const verdict = judgeConnection({ encrypted: false }, DEFAULTS);
  assert.equal(verdict.ok, false, "unknown provenance must not be given the benefit of the doubt");
});

/* ------------------------- the forwarded header ------------------- */

test("X-Forwarded-Proto is ignored unless this server was told to expect a proxy", () => {
  const verdict = judgeConnection(
    { encrypted: false, remoteAddress: REMOTE, forwardedProto: "https" },
    DEFAULTS,
  );
  assert.equal(verdict.ok, false, "anyone can set that header");
});

test("and is ignored even then, unless the proxy is local", () => {
  const proxied: TlsSettings = { ...DEFAULTS, trustProxy: true };
  const fromElsewhere = judgeConnection(
    { encrypted: false, remoteAddress: REMOTE, forwardedProto: "https" },
    proxied,
  );
  assert.equal(fromElsewhere.ok, false,
    "a remote peer claiming to be a proxy is just a remote peer");

  const fromProxy = judgeConnection(
    { encrypted: false, remoteAddress: "127.0.0.1", forwardedProto: "https" },
    proxied,
  );
  assert.deepEqual(fromProxy, { ok: true, reason: "forwarded_tls" });
});

test("a proxy reporting plain http is refused, not waved through as loopback", () => {
  const proxied: TlsSettings = { ...DEFAULTS, trustProxy: true };
  // The proxy sits on this machine, so its connections ARE loopback. If the
  // loopback allowance applied here, every forwarded connection would be
  // admitted whatever the proxy served - silent plaintext in the exact
  // deployment the docs recommend.
  assert.deepEqual(
    judgeConnection(
      { encrypted: false, remoteAddress: "127.0.0.1", forwardedProto: "http" }, proxied),
    { ok: false, reason: "insecure_transport" },
  );
  assert.deepEqual(
    judgeConnection({ encrypted: false, remoteAddress: "127.0.0.1" }, proxied),
    { ok: false, reason: "insecure_transport" },
    "a proxy that sets no header at all is not trusted either",
  );
});

test("proxy mode still honours the explicit escape hatch", () => {
  const loose: TlsSettings = { ...DEFAULTS, trustProxy: true, allowInsecure: true };
  assert.deepEqual(
    judgeConnection({ encrypted: false, remoteAddress: "127.0.0.1" }, loose),
    { ok: true, reason: "insecure_allowed" },
  );
});

test("a forwarded chain is read from its first hop", () => {
  const proxied: TlsSettings = { ...DEFAULTS, trustProxy: true };
  const verdict = judgeConnection(
    { encrypted: false, remoteAddress: "::1", forwardedProto: "https, http" },
    proxied,
  );
  assert.deepEqual(verdict, { ok: true, reason: "forwarded_tls" });
});

/* ---------------------------- escape hatch ------------------------ */

test("the escape hatch works, and is named as what it is", () => {
  const loose: TlsSettings = { ...DEFAULTS, allowInsecure: true };
  assert.deepEqual(
    judgeConnection({ encrypted: false, remoteAddress: REMOTE }, loose),
    { ok: true, reason: "insecure_allowed" },
  );
  assert.match(describePosture(loose), /INSECURE/);
});

test("each posture describes itself distinctly", () => {
  const postures = [
    describePosture(DEFAULTS),
    describePosture({ ...DEFAULTS, trustProxy: true }),
    describePosture({ ...DEFAULTS, allowInsecure: true }),
    describePosture({ ...DEFAULTS, certPath: "/c.pem", keyPath: "/k.pem" }),
  ];
  assert.equal(new Set(postures).size, postures.length, "postures must be distinguishable");
  assert.match(postures[3], /wss/);
});

/* ------------- action shape validation (review follow-up) --------- */

test("malformed actions are refused before they reach the engine", async () => {
  const { decode, isWellFormedAction } = await import("../src/net/protocol");

  // The engine promises never to throw on bad input; it can only keep that
  // promise if the shape was checked first.
  assert.equal(isWellFormedAction({ type: "move", unitId: "u1" }), false, "no path");
  assert.equal(isWellFormedAction({ type: "move", unitId: "u1", path: "north" }), false);
  assert.equal(
    isWellFormedAction({ type: "move", unitId: "u1", path: [{ x: 1 }] }), false, "no y");
  assert.equal(
    isWellFormedAction({ type: "move", unitId: "u1", path: [{ x: 1.5, y: 2 }] }), false,
    "fractional coordinates");
  assert.equal(isWellFormedAction({ type: "move", unitId: 7, path: [] }), false);
  assert.equal(isWellFormedAction({ type: "build", unitType: "recon" }), false, "no tile");
  assert.equal(isWellFormedAction({ type: "attack", unitId: "u1" }), false, "no target");
  assert.equal(isWellFormedAction({ type: "teleport", unitId: "u1" }), false);
  assert.equal(isWellFormedAction(null), false);
  assert.equal(isWellFormedAction("endTurn"), false);

  // A path long enough to be expensive to validate is refused outright.
  const huge = Array.from({ length: 500 }, (_, i) => ({ x: i, y: 0 }));
  assert.equal(isWellFormedAction({ type: "move", unitId: "u1", path: huge }), false);

  // Well-formed ones pass.
  assert.equal(
    isWellFormedAction({ type: "move", unitId: "u1", path: [{ x: 1, y: 2 }] }), true);
  assert.equal(isWellFormedAction({ type: "endTurn" }), true);
  assert.equal(isWellFormedAction({ type: "build", unitType: "recon", at: { x: 0, y: 0 } }), true);

  // And decode rejects the whole frame rather than passing it on.
  assert.equal(decode(JSON.stringify({ t: "action", matchId: "m", action: { type: "move" } })), null);
  assert.ok(decode(JSON.stringify({ t: "action", matchId: "m", action: { type: "endTurn" } })));
});
