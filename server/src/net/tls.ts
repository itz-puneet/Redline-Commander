/**
 * Transport security policy.
 *
 * The device secret travels in the `hello` frame, so a plaintext connection
 * hands it to anyone on the path. The point of this module is that
 * forgetting TLS fails loudly instead of quietly leaking credentials.
 *
 * The default is: refuse anything that is not either encrypted or local.
 * Development on localhost keeps working untouched; the moment a real client
 * connects across a network without TLS, it is turned away with a reason
 * rather than silently served.
 *
 * Pure decision logic, no sockets - so the policy can be tested directly
 * rather than by standing up servers with certificates.
 */

export interface TlsSettings {
  /** Paths to a certificate and key, when this process terminates TLS itself. */
  certPath?: string;
  keyPath?: string;
  /** Trust X-Forwarded-Proto, for running behind a terminating reverse proxy. */
  trustProxy: boolean;
  /** Escape hatch: serve plaintext to anyone. Logged loudly at startup. */
  allowInsecure: boolean;
}

export function readTlsSettings(env: NodeJS.ProcessEnv = process.env): TlsSettings {
  return {
    certPath: env.REDLINE_TLS_CERT || undefined,
    keyPath: env.REDLINE_TLS_KEY || undefined,
    trustProxy: env.REDLINE_TRUST_PROXY === "1",
    allowInsecure: env.REDLINE_ALLOW_INSECURE === "1",
  };
}

/** True when this process should stand up an HTTPS server of its own. */
export function terminatesTls(settings: TlsSettings): boolean {
  return Boolean(settings.certPath && settings.keyPath);
}

/**
 * A cert with no key (or the reverse) is a misconfiguration that would
 * otherwise silently fall back to plaintext.
 */
export function tlsConfigError(settings: TlsSettings): string | null {
  if (Boolean(settings.certPath) !== Boolean(settings.keyPath)) {
    return "REDLINE_TLS_CERT and REDLINE_TLS_KEY must be set together";
  }
  return null;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return LOOPBACK.has(address);
}

export interface ConnectionFacts {
  /** The socket itself is TLS - this process terminated it. */
  encrypted: boolean;
  /** Value of X-Forwarded-Proto, if any. */
  forwardedProto?: string;
  /** The immediate peer, which behind a proxy is the proxy. */
  remoteAddress?: string;
}

export type ConnectionVerdict =
  | { ok: true; reason: "tls" | "forwarded_tls" | "loopback" | "insecure_allowed" }
  | { ok: false; reason: "insecure_transport" };

/**
 * X-Forwarded-Proto is a client-settable header, so it is only believed when
 * this process was told it sits behind a proxy AND the request came from
 * loopback - which is where a terminating proxy normally lives. Without both,
 * anyone could claim their plaintext connection was secure.
 */
export function judgeConnection(
  facts: ConnectionFacts,
  settings: TlsSettings,
): ConnectionVerdict {
  if (facts.encrypted) return { ok: true, reason: "tls" };

  if (
    settings.trustProxy &&
    isLoopback(facts.remoteAddress) &&
    facts.forwardedProto?.split(",")[0].trim().toLowerCase() === "https"
  ) {
    return { ok: true, reason: "forwarded_tls" };
  }

  // Plain development on the same machine: nothing crosses a wire.
  if (isLoopback(facts.remoteAddress)) return { ok: true, reason: "loopback" };

  if (settings.allowInsecure) return { ok: true, reason: "insecure_allowed" };

  return { ok: false, reason: "insecure_transport" };
}

/** What to print at startup, so the operator can see the posture in one line. */
export function describePosture(settings: TlsSettings): string {
  if (terminatesTls(settings)) return "TLS terminated here (wss://)";
  if (settings.trustProxy) return "plaintext behind a trusted proxy (expects X-Forwarded-Proto)";
  if (settings.allowInsecure) {
    return "INSECURE: serving plaintext to any host - device secrets are exposed";
  }
  return "plaintext, loopback only - remote clients will be refused";
}
