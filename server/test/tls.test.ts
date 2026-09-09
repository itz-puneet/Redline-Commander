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

test("a proxy reporting plain http is not treated as secure", () => {
  const proxied: TlsSettings = { ...DEFAULTS, trustProxy: true };
  const verdict = judgeConnection(
    { encrypted: false, remoteAddress: "127.0.0.1", forwardedProto: "http" },
    proxied,
  );
  // Still accepted, but as loopback rather than as TLS - the distinction
  // matters because it is the reason, not the outcome, that is audited.
  assert.deepEqual(verdict, { ok: true, reason: "loopback" });
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
