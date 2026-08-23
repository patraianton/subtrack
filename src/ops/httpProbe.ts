export async function probeHttp(
  port: number,
  path: string,
  timeoutMs = 1500,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean | undefined> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}${path}`, { signal: ctrl.signal });
    return res.ok; // 2xx
  } catch {
    return undefined; // transport error or timeout — genuinely unknown, not "down"
  } finally {
    clearTimeout(timer);
  }
}
