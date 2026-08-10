/**
 * Rate limiting for the unauthenticated 402 path.
 *
 * Why this exists: returning a 402 is not a read-only operation here. It registers an
 * ERC-8004 validation request, which is a real on-chain transaction signed by the seller's
 * wallet and awaited to receipt (lib/validationRegistry.ts). Gas on Arc is paid in USDC out
 * of that same wallet, so before this existed, an unauthenticated caller running
 *
 *     while true; do curl -s localhost:3000/api/premium/quote >/dev/null; done
 *
 * would drain the seller's balance outright — and because each request holds a server
 * connection open for a full block confirmation, it starved the route of capacity at the
 * same time. There is no authentication concept anywhere in this app to hang a per-user
 * limit off, so the limit is per source IP plus a global ceiling.
 *
 * MVP-level, and disclosed as such alongside the single-arbiter and WITHDRAW_API_KEY
 * disclosures: the state is in-process, so it resets on restart and does not coordinate
 * across instances if this is ever deployed to more than one. That is genuinely sufficient
 * for a single-node demo deployment and genuinely not sufficient for production, where this
 * belongs in Redis or the database. The global ceiling is the backstop that bounds total
 * loss even if the per-IP limit is evaded by rotating addresses.
 */

/** Per-IP allowance: how many 402s one source may trigger per window. */
const PER_IP_LIMIT = 5;
/** Sliding window length, in milliseconds. */
const WINDOW_MS = 60_000;
/**
 * Ceiling across all callers in one window, regardless of how many distinct IPs they use.
 * Deliberately far above PER_IP_LIMIT so legitimate concurrent buyers are never affected,
 * but low enough to bound the seller's worst-case gas spend per minute.
 */
const GLOBAL_LIMIT = 60;

/** Timestamps of recent requests, per key. Trimmed on read rather than on a timer. */
const hits = new Map<string, number[]>();
const GLOBAL_KEY = "__global__";

/**
 * Drops timestamps outside the current window and returns what remains. Trimming lazily on
 * access is what keeps this from needing a background sweep — a key nobody touches simply
 * stops mattering, and stale keys are evicted below.
 */
function recentHits(key: string, now: number): number[] {
  const timestamps = hits.get(key) ?? [];
  const fresh = timestamps.filter((t) => now - t < WINDOW_MS);
  if (fresh.length === 0) {
    // Evict rather than storing an empty array, so a long-running process does not
    // accumulate one map entry per IP that ever hit it.
    hits.delete(key);
  } else {
    hits.set(key, fresh);
  }
  return fresh;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the caller may retry — fed straight into a Retry-After header. */
  retryAfterSeconds: number;
  reason?: "per-ip" | "global";
}

/**
 * Records an attempt from `ip` and reports whether it may proceed. Checks the per-IP
 * allowance and the global ceiling independently, and only records the hit if the request
 * is actually allowed through — a rejected request must not extend its own cooldown.
 */
export function checkRateLimit(ip: string): RateLimitResult {
  const now = Date.now();

  const ipHits = recentHits(ip, now);
  if (ipHits.length >= PER_IP_LIMIT) {
    const oldest = ipHits[0];
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000)),
      reason: "per-ip",
    };
  }

  const globalHits = recentHits(GLOBAL_KEY, now);
  if (globalHits.length >= GLOBAL_LIMIT) {
    const oldest = globalHits[0];
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000)),
      reason: "global",
    };
  }

  hits.set(ip, [...ipHits, now]);
  hits.set(GLOBAL_KEY, [...globalHits, now]);
  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Best-effort client IP. Behind a proxy Next.js does not populate a request IP directly, so
 * this reads the standard forwarded headers. Spoofable by design — which is exactly why the
 * global ceiling above exists and does not depend on this value being honest.
 */
export function clientIpFrom(headers: Headers): string {
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    // Left-most entry is the original client; the rest are proxies that appended themselves.
    return forwardedFor.split(",")[0].trim();
  }
  return headers.get("x-real-ip") ?? "unknown";
}
