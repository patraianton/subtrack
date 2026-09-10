// Shared fetch wrapper that rides out the intermittent transport failures seen on real networks
// (undici CONNECT_TIMEOUT, ECONNRESET, DNS blips). Each poll gets a couple of quick retries before
// an account is shown as errored, so a ~7%/request failure rate stops surfacing as flickering cards.

export interface RetryOpts {
  retries?: number;                       // retries AFTER the first attempt (default 2 → 3 tries total)
  delayMs?: number;                       // base backoff; grows linearly per attempt (default 400)
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;  // injectable so tests don't actually wait
}

// undici/Node cause codes that mean "the request never completed — try again", not "the server said no".
const TRANSIENT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE',
]);

/** The undici cause code (e.g. "ECONNRESET") under a thrown fetch error, if any. */
export function causeCode(e: unknown): string | undefined {
  const err = e as { cause?: { code?: string }; code?: string } | undefined;
  return err?.cause?.code ?? err?.code;
}

/** True for transport-level failures worth retrying (connection reset/timeout/refused, DNS blip). */
export function isTransientFetchError(e: unknown): boolean {
  const code = causeCode(e);
  if (code) return TRANSIENT_CODES.has(code);
  const msg = e instanceof Error ? e.message : String(e ?? '');
  return /fetch failed|network|socket|timed? ?out/i.test(msg);
}

/**
 * `Retry-After` as an absolute epoch-ms instant, or null when the header is absent or unusable.
 * Accepts both wire forms: delta-seconds ("1961") and an HTTP date.
 *
 * Verified 2026-09-01 on a rate-limited Claude account: api.anthropic.com answers
 * /api/oauth/usage with 429 + `retry-after: 1961` (~33 min) — far longer than our own 5/10/15
 * ladder. Polling again before that lapses only re-hits a closed door and can extend the block,
 * so callers pass this through as `retryAt` and the poller honours it.
 */
export function retryAfterAt(res: { headers: { get(name: string): string | null } }, now: number = Date.now()): number | null {
  const raw = res.headers.get('retry-after');
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return now + Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : at;
}

/**
 * fetch() that retries transient transport failures and 5xx responses up to `retries` times.
 * 4xx responses (auth, rate-limit) return immediately — retrying those is wrong. When it finally
 * gives up on a transport failure, the thrown error's message carries the cause code, e.g.
 * "fetch failed (ECONNRESET)", so the dashboard/log says WHY.
 */
export async function fetchWithRetry(url: string, init: RequestInit, opts: RetryOpts = {}): Promise<Response> {
  const retries = opts.retries ?? 2;
  const delayMs = opts.delayMs ?? 400;
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await f(url, init);
      if (res.status >= 500 && attempt < retries) { await sleep(delayMs * (attempt + 1)); continue; }
      return res;
    } catch (e) {
      lastErr = e;
      if (!isTransientFetchError(e) || attempt >= retries) break;
      await sleep(delayMs * (attempt + 1));
    }
  }
  const code = causeCode(lastErr);
  const base = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(code ? `${base} (${code})` : base, { cause: lastErr });
}
