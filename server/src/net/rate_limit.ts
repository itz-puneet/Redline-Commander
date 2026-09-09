/**
 * Rate limiting.
 *
 * Four things are worth bounding, for different reasons:
 *
 *   messages per connection   a flood of actions costs validation and disk
 *   new connections per IP    each handshake costs a TLS negotiation
 *   concurrent sockets per IP a slow drip of open sockets exhausts fds
 *   matches created           FileMatchStore writes a file per match
 *
 * A fifth is handled by `ws` itself via maxPayload: an enormous frame is a
 * memory attack that never reaches this module.
 *
 * The tricky part is that a limiter keyed by address is *itself* a memory
 * attack - a map that grows one entry per distinct IP is exactly what an
 * attacker with a botnet wants. So the registry below is bounded, sweeps
 * idle keys, and fails closed when full rather than growing.
 *
 * Pure and clock-injected: `now` is passed in, so the behaviour over time is
 * tested directly instead of with sleeps.
 */

export interface RateLimitSettings {
  enabled: boolean;
  /** Sustained message rate per connection, and how much burst is tolerated. */
  messagesPerSecond: number;
  messageBurst: number;
  /** Refused messages a connection may rack up before it is closed. */
  maxMessageViolations: number;
  /** Concurrent sockets from one address. */
  connectionsPerIp: number;
  /** New sockets per minute from one address. */
  newConnectionsPerMinute: number;
  /** Matches one player may create per minute. */
  matchesPerMinute: number;
  /** Largest frame `ws` will accept at all. */
  maxPayloadBytes: number;
  /** Distinct keys any one registry will track before refusing new ones. */
  maxTrackedKeys: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitSettings = {
  enabled: true,
  // A player taps a handful of times per second at most; 10/s sustained with
  // 30 in hand covers a fast turn without letting a script hammer the disk.
  messagesPerSecond: 10,
  messageBurst: 30,
  maxMessageViolations: 20,
  connectionsPerIp: 12,
  newConnectionsPerMinute: 60,
  matchesPerMinute: 10,
  maxPayloadBytes: 64 * 1024,
  maxTrackedKeys: 10_000,
};

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function readRateLimits(env: NodeJS.ProcessEnv = process.env): RateLimitSettings {
  return {
    ...DEFAULT_RATE_LIMITS,
    // Disabling is explicit and total - there is no half-limited mode to
    // reason about.
    enabled: env.REDLINE_DISABLE_RATE_LIMIT !== "1",
    messagesPerSecond: positiveInt(
      env.REDLINE_MESSAGES_PER_SECOND, DEFAULT_RATE_LIMITS.messagesPerSecond),
    connectionsPerIp: positiveInt(
      env.REDLINE_CONNECTIONS_PER_IP, DEFAULT_RATE_LIMITS.connectionsPerIp),
    maxPayloadBytes: positiveInt(
      env.REDLINE_MAX_PAYLOAD_BYTES, DEFAULT_RATE_LIMITS.maxPayloadBytes),
  };
}

/**
 * A token bucket. Capacity is the burst; tokens refill continuously, so a
 * client that pauses banks a little headroom rather than being metered into
 * a fixed grid.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    now: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = now;
  }

  private refill(now: number): void {
    // A clock that jumps backwards must not mint tokens.
    const elapsed = Math.max(0, now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    this.lastRefill = now;
  }

  tryConsume(now: number, cost = 1): boolean {
    this.refill(now);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  available(now: number): number {
    this.refill(now);
    return this.tokens;
  }
}

interface TrackedBucket {
  bucket: TokenBucket;
  lastSeen: number;
}

/**
 * Token buckets keyed by something an attacker controls, with a hard cap on
 * how many are kept.
 *
 * When full, new keys are REFUSED rather than evicting existing ones. The
 * alternative - evicting least-recently-used - would let an attacker reset
 * their own limit by churning keys, which is the thing being limited. The
 * cost is that a genuine new client can be turned away during a flood; that
 * is the correct failure for a limiter, and the cap is set high enough that
 * it takes an actual attack to reach.
 */
export class BucketRegistry {
  private readonly buckets = new Map<string, TrackedBucket>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly maxKeys: number,
    /** How long a key must be untouched before it can be swept. */
    private readonly idleMs: number = 5 * 60_000,
  ) {}

  tryConsume(key: string, now: number, cost = 1): boolean {
    let tracked = this.buckets.get(key);

    if (tracked === undefined) {
      if (this.buckets.size >= this.maxKeys) {
        this.sweep(now);
        if (this.buckets.size >= this.maxKeys) return false;
      }
      tracked = { bucket: new TokenBucket(this.capacity, this.refillPerSecond, now), lastSeen: now };
      this.buckets.set(key, tracked);
    }

    tracked.lastSeen = now;
    return tracked.bucket.tryConsume(now, cost);
  }

  /** Drops keys untouched for longer than idleMs. */
  sweep(now: number): number {
    let removed = 0;
    for (const [key, tracked] of this.buckets) {
      if (now - tracked.lastSeen >= this.idleMs) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.buckets.size;
  }
}

/**
 * Concurrent sockets per key. Same bounding discipline as the registry: an
 * entry is dropped the moment its count reaches zero, so idle addresses cost
 * nothing and the map cannot grow without live connections behind it.
 */
export class ConnectionCounter {
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly limit: number,
    private readonly maxKeys: number,
  ) {}

  /** True if the connection is allowed; it is counted only when allowed. */
  tryAcquire(key: string): boolean {
    const current = this.counts.get(key) ?? 0;
    if (current >= this.limit) return false;
    if (current === 0 && this.counts.size >= this.maxKeys) return false;
    this.counts.set(key, current + 1);
    return true;
  }

  release(key: string): void {
    const current = this.counts.get(key);
    if (current === undefined) return;
    if (current <= 1) {
      this.counts.delete(key);
      return;
    }
    this.counts.set(key, current - 1);
  }

  countFor(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  get size(): number {
    return this.counts.size;
  }
}

/** Everything the transport layer needs, built from one settings object. */
export class RateLimiter {
  readonly messages: BucketRegistry;
  readonly newConnections: BucketRegistry;
  readonly matchCreation: BucketRegistry;
  readonly concurrent: ConnectionCounter;

  constructor(readonly settings: RateLimitSettings) {
    this.messages = new BucketRegistry(
      settings.messageBurst, settings.messagesPerSecond, settings.maxTrackedKeys);
    this.newConnections = new BucketRegistry(
      settings.newConnectionsPerMinute, settings.newConnectionsPerMinute / 60,
      settings.maxTrackedKeys);
    this.matchCreation = new BucketRegistry(
      settings.matchesPerMinute, settings.matchesPerMinute / 60, settings.maxTrackedKeys);
    this.concurrent = new ConnectionCounter(settings.connectionsPerIp, settings.maxTrackedKeys);
  }

  /** Disabled limiting is a straight yes, so tests and local runs are unmetered. */
  private allow(check: () => boolean): boolean {
    return this.settings.enabled ? check() : true;
  }

  allowNewConnection(address: string, now: number): boolean {
    return this.allow(() => this.newConnections.tryConsume(address, now));
  }

  acquireSocket(address: string): boolean {
    return this.allow(() => this.concurrent.tryAcquire(address));
  }

  releaseSocket(address: string): void {
    if (this.settings.enabled) this.concurrent.release(address);
  }

  allowMessage(sessionKey: string, now: number): boolean {
    return this.allow(() => this.messages.tryConsume(sessionKey, now));
  }

  allowMatchCreation(playerId: string, now: number): boolean {
    return this.allow(() => this.matchCreation.tryConsume(playerId, now));
  }

  /** Called periodically so idle keys do not accumulate on a quiet server. */
  sweep(now: number): void {
    this.messages.sweep(now);
    this.newConnections.sweep(now);
    this.matchCreation.sweep(now);
  }

  describe(): string {
    if (!this.settings.enabled) return "DISABLED - no limits on messages or connections";
    return `${this.settings.messagesPerSecond}/s messages, `
      + `${this.settings.connectionsPerIp} sockets per address, `
      + `${Math.floor(this.settings.maxPayloadBytes / 1024)} KiB max frame`;
  }
}
