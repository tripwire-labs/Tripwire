import { createHmac, timingSafeEqual } from "node:crypto";

export type LiveSessionToken = {
  visitorId: string;
  ip: string;
  jobId: string;
  sellerKey: string;
  evidenceHash: `0x${string}`;
  createdAt: number;
};

function signingKey(): string {
  const key = process.env.BUYER_PRIVATE_KEY;
  if (!key) throw new Error("BUYER_PRIVATE_KEY is not configured");
  return key;
}

export function createSessionToken(value: Omit<LiveSessionToken, "createdAt">): string {
  const payload = Buffer.from(JSON.stringify({ ...value, createdAt: Date.now() })).toString("base64url");
  const signature = createHmac("sha256", signingKey()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifySessionToken(token: string, visitorId: string, ip: string): LiveSessionToken | undefined {
  const [payload, supplied] = token.split(".");
  if (!payload || !supplied) return undefined;
  const expected = createHmac("sha256", signingKey()).update(payload).digest();
  const actual = Buffer.from(supplied, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as LiveSessionToken;
    if (value.visitorId !== visitorId || value.ip !== ip || Date.now() - value.createdAt > 6 * 60 * 60_000) return undefined;
    return value;
  } catch { return undefined; }
}

type Tour = { visitorId: string; startedAt: number; sellers: Set<string> };
const toursByIp = new Map<string, Tour>();
const globalStarts: number[] = [];

/** One three-seller tour per IP per five minutes, twenty new tours per hour globally. */
export function claimTour(ip: string, visitorId: string, sellerKey: string) {
  const now = Date.now();
  while (globalStarts.length && now - globalStarts[0] > 60 * 60_000) globalStarts.shift();
  const existing = toursByIp.get(ip);
  if (existing && now - existing.startedAt < 5 * 60_000) {
    if (existing.visitorId !== visitorId) return { allowed: false, retryAfter: Math.ceil((5 * 60_000 - (now - existing.startedAt)) / 1000) };
    if (existing.sellers.has(sellerKey)) return { allowed: false, retryAfter: 0, duplicate: true };
    existing.sellers.add(sellerKey);
    return { allowed: true, retryAfter: 0 };
  }
  if (globalStarts.length >= 20) return { allowed: false, retryAfter: Math.ceil((60 * 60_000 - (now - globalStarts[0])) / 1000) };
  toursByIp.set(ip, { visitorId, startedAt: now, sellers: new Set([sellerKey]) });
  globalStarts.push(now);
  return { allowed: true, retryAfter: 0 };
}
