import type { AccountConfig, NormalizedUsage } from '../types.ts';
import { baseUsage } from './shell.ts';
import { fetchWithRetry, retryAfterAt } from './http.ts';

const RATE_LIMITS_URL = 'https://grok.com/rest/rate-limits';
const GET_USER_URL = 'https://grok.com/rest/auth/get-user';
// The weekly allowance shown in grok.com Settings -> Usage as "Weekly SuperGrok Heavy Limit"
// with a "Grok Build" row. It is NOT a REST route: the web app calls the gRPC-Web service
// grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig (verified live 2026-08-26 — the same call
// with an empty request body returned credit_usage_percent=3 and a WEEKLY period ending
// 2026-08-28T12:24:22Z, matching the browser UI exactly). Plain Connect/JSON is rejected
// (grpc-status 13), so the request must be gRPC-Web framed.
const CREDITS_URL = 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig';
// The tracked allowance: grok-4 DEFAULT is the main per-model 2-hour window on SuperGrok
// (verified live 2026-08-21: {"windowSizeSeconds":7200,"remainingQueries":90,"totalQueries":90};
// grok-3 and grok-4-heavy have their own windows we don't currently surface).
const REQUEST_BODY = JSON.stringify({ requestKind: 'DEFAULT', modelName: 'grok-4' });
// Cloudflare fronts grok.com but answers plain non-browser clients with clean JSON (verified
// 2026-08-21: cookieless POST → JSON 401, no challenge). Send a browser-like UA anyway so the
// request matches the browser session the cookie came from.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

// Verified live response shape. waitTimeSeconds is reported only for an exhausted window
// (observed community contract; absent while queries remain).
interface RawRateLimits { windowSizeSeconds?: number; remainingQueries?: number; totalQueries?: number; waitTimeSeconds?: number }

export function normalizeGrokUsage(snapshot: unknown, account: AccountConfig, now: Date = new Date()): NormalizedUsage {
  const shell = baseUsage(account, 'grok', now);
  const r = snapshot as RawRateLimits | null;
  const total = r?.totalQueries;
  const remaining = r?.remainingQueries;
  if (typeof total !== 'number' || typeof remaining !== 'number' || total <= 0) {
    return { ...shell, status: 'error', error: 'Unexpected rate-limits response (no remaining/total queries found)' };
  }
  const used = Math.min(Math.max(total - remaining, 0), total);
  // The API anchors no reset time while queries remain — keep resetsAt null rather than faking
  // one from windowSizeSeconds (the window is rolling, not aligned to "now").
  const resetsAt = typeof r?.waitTimeSeconds === 'number' && r.waitTimeSeconds > 0
    ? new Date(now.getTime() + r.waitTimeSeconds * 1000).toISOString()
    : null;
  return {
    ...shell,
    session: { utilization: (used / total) * 100, resetsAt },
    status: 'ok',
  };
}

// --- Minimal gRPC-Web / protobuf reader ------------------------------------------------------
// Only what the credits response needs: length-delimited submessages, varints, and one float.
// Field numbers come from the descriptor embedded in grok.com's own bundle (grok_api_v2.proto):
//   GrokCreditsConfig { 1: float credit_usage_percent, 5: Timestamp billing_period_end (deprecated),
//                       8: UsagePeriod current_period }
//   UsagePeriod       { 1: enum type (2 = WEEKLY), 2: Timestamp start, 3: Timestamp end }
//   Timestamp         { 1: int64 seconds, 2: int32 nanos }
interface PbField { field: number; wire: number; varint?: bigint; float?: number; bytes?: Uint8Array }

function readVarint(b: Uint8Array, i: number): [bigint, number] {
  let result = 0n, shift = 0n;
  while (i < b.length) {
    const byte = b[i++] ?? 0;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, i];
    shift += 7n;
    if (shift > 70n) throw new Error('varint too long');
  }
  throw new Error('truncated varint');
}

function readMessage(b: Uint8Array, start = 0, end = b.length): PbField[] {
  const out: PbField[] = [];
  let i = start;
  while (i < end) {
    let key: bigint;
    [key, i] = readVarint(b, i);
    const field = Number(key >> 3n), wire = Number(key & 7n);
    if (wire === 0) { let v: bigint; [v, i] = readVarint(b, i); out.push({ field, wire, varint: v }); }
    else if (wire === 5) {
      if (i + 4 > end) throw new Error('truncated fixed32');
      out.push({ field, wire, float: new DataView(b.buffer, b.byteOffset + i, 4).getFloat32(0, true) });
      i += 4;
    } else if (wire === 1) { i += 8; out.push({ field, wire }); }
    else if (wire === 2) {
      let len: bigint;
      [len, i] = readVarint(b, i);
      const l = Number(len);
      if (i + l > end) throw new Error('truncated length-delimited field');
      out.push({ field, wire, bytes: b.subarray(i, i + l) });
      i += l;
    } else throw new Error(`unsupported wire type ${wire}`);
  }
  return out;
}

/** Unwrap gRPC-Web frames, returning the first data message (trailer frames have the 0x80 flag). */
function unframeGrpcWeb(b: Uint8Array): Uint8Array | null {
  let off = 0;
  while (off + 5 <= b.length) {
    const flag = b[off] ?? 0;
    const len = new DataView(b.buffer, b.byteOffset + off + 1, 4).getUint32(0, false);
    const body = b.subarray(off + 5, off + 5 + len);
    if ((flag & 0x80) === 0) return body;
    off += 5 + len;
  }
  return null;
}

function timestampToIso(bytes: Uint8Array): string | null {
  let seconds: bigint | null = null, nanos = 0n;
  for (const f of readMessage(bytes)) {
    if (f.field === 1 && f.varint !== undefined) seconds = f.varint;
    if (f.field === 2 && f.varint !== undefined) nanos = f.varint;
  }
  if (seconds === null) return null;
  return new Date(Number(seconds) * 1000 + Math.floor(Number(nanos) / 1e6)).toISOString();
}

/** Parse a GetGrokCreditsConfigResponse body into the weekly window, or null if it isn't there. */
export function parseGrokCredits(frame: Uint8Array): { utilization: number; resetsAt: string | null } | null {
  const message = unframeGrpcWeb(frame);
  if (!message) return null;
  const config = readMessage(message).find(f => f.field === 1 && f.bytes)?.bytes;
  if (!config) return null;
  let percent: number | null = null, resetsAt: string | null = null, legacyEnd: string | null = null;
  for (const f of readMessage(config)) {
    if (f.field === 1 && f.float !== undefined) percent = f.float;
    else if (f.field === 5 && f.bytes) legacyEnd = timestampToIso(f.bytes);
    else if (f.field === 8 && f.bytes) {
      for (const p of readMessage(f.bytes)) if (p.field === 3 && p.bytes) resetsAt = timestampToIso(p.bytes);
    }
  }
  if (percent === null || !Number.isFinite(percent)) return null;
  return { utilization: Math.min(Math.max(percent, 0), 100), resetsAt: resetsAt ?? legacyEnd };
}

/**
 * Best-effort weekly window. Never throws and never fails the card: the two-hour session window
 * is the primary signal, so any credits-call problem just leaves `weekly` null.
 */
export async function fetchGrokWeekly(cookie: string, fetchImpl: typeof fetch = fetch): Promise<{ utilization: number; resetsAt: string | null } | null> {
  try {
    const res = await fetchImpl(CREDITS_URL, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/grpc-web+proto',
        'x-grpc-web': '1',
        'user-agent': USER_AGENT,
      },
      // An empty GetGrokCreditsConfigRequest: one gRPC-Web frame, no flags, zero-length payload.
      body: new Uint8Array([0, 0, 0, 0, 0]),
    });
    if (!res.ok) return null;
    return parseGrokCredits(new Uint8Array(await res.arrayBuffer()));
  } catch {
    return null;
  }
}

export interface GrokFetchDeps {
  readCookie(home: string): Promise<string>;
  fetchImpl?: typeof fetch;
}

export async function fetchGrokUsage(account: AccountConfig, deps: GrokFetchDeps, now: Date = new Date()): Promise<NormalizedUsage> {
  const shell = baseUsage(account, 'grok', now);
  if (!account.credentialsHome) {
    return { ...shell, status: 'auth_error', error: 'No credentialsHome configured — run add-account' };
  }
  let cookie: string;
  try {
    cookie = await deps.readCookie(account.credentialsHome);
  } catch (e) {
    return { ...shell, status: 'auth_error', error: e instanceof Error ? e.message : String(e) };
  }
  try {
    const res = await fetchWithRetry(RATE_LIMITS_URL, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: REQUEST_BODY,
    }, { fetchImpl: deps.fetchImpl });
    if (res.status === 401 || res.status === 403) {
      return { ...shell, status: 'auth_error', error: `Grok cookie rejected (HTTP ${res.status}) — re-copy the Cookie header from a logged-in grok.com tab into cookie.txt` };
    }
    if (res.status === 429) {
      const at = retryAfterAt(res, now.getTime());
      return { ...shell, status: 'throttled', error: 'Rate limited (HTTP 429)', retryAt: at ? new Date(at).toISOString() : null };
    }
    if (!res.ok) {
      return { ...shell, status: 'error', error: `HTTP ${res.status}` };
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ...shell, status: 'error', error: 'Non-JSON rate-limits response' };
    }
    const normalized = normalizeGrokUsage(parsed, account, now);
    if (normalized.status === 'error') {
      console.error(`[grok ${account.id}] unexpected rate-limits body: ${text.slice(0, 500)}`);
      return normalized;
    }
    // The weekly SuperGrok limit lives behind a separate gRPC-Web call and covers the CLI
    // ("Grok Build") too. It is advisory here: a failure leaves weekly null, never downgrades status.
    const weekly = await fetchGrokWeekly(cookie, deps.fetchImpl ?? fetch);
    return weekly ? { ...normalized, weekly } : normalized;
  } catch (e) {
    return { ...shell, status: 'error', error: e instanceof Error ? e.message : String(e) };
  }
}

/** Best-effort account email for default labels (registration-time only). Empty string on any failure. */
export async function fetchGrokEmail(cookie: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  try {
    const res = await fetchImpl(GET_USER_URL, { headers: { cookie, 'user-agent': USER_AGENT } });
    if (!res.ok) return '';
    const parsed = await res.json() as { email?: string };
    return typeof parsed.email === 'string' ? parsed.email : '';
  } catch {
    return '';
  }
}
