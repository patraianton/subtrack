import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithRetry, isTransientFetchError, causeCode } from '../../src/adapters/http.ts';

const noSleep = async () => {};
/** A fetch error shaped like undici's: message "fetch failed" with a coded `cause`. */
function transportError(code: string): Error {
  return new Error('fetch failed', { cause: Object.assign(new Error('boom'), { code }) });
}

test('isTransientFetchError: true for transport cause codes, false for a plain TypeError', () => {
  assert.equal(isTransientFetchError(transportError('ECONNRESET')), true);
  assert.equal(isTransientFetchError(transportError('UND_ERR_CONNECT_TIMEOUT')), true);
  assert.equal(isTransientFetchError(new TypeError('URL is not a constructor')), false);
});

test('causeCode digs the code out of the cause', () => {
  assert.equal(causeCode(transportError('ETIMEDOUT')), 'ETIMEDOUT');
  assert.equal(causeCode(new Error('nope')), undefined);
});

test('fetchWithRetry retries a transient failure then succeeds', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls < 3) throw transportError('ECONNRESET');
    return new Response('ok', { status: 200 });
  }) as unknown as typeof fetch;
  const res = await fetchWithRetry('https://x', {}, { fetchImpl, sleep: noSleep });
  assert.equal(res.status, 200);
  assert.equal(calls, 3); // 1 initial + 2 retries
});

test('fetchWithRetry gives up after retries and tags the error with the cause code', async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; throw transportError('ECONNRESET'); }) as unknown as typeof fetch;
  await assert.rejects(
    fetchWithRetry('https://x', {}, { fetchImpl, sleep: noSleep, retries: 2 }),
    /fetch failed \(ECONNRESET\)/,
  );
  assert.equal(calls, 3);
});

test('fetchWithRetry does NOT retry a 4xx (auth/rate-limit) — returns immediately', async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; return new Response('', { status: 429 }); }) as unknown as typeof fetch;
  const res = await fetchWithRetry('https://x', {}, { fetchImpl, sleep: noSleep });
  assert.equal(res.status, 429);
  assert.equal(calls, 1);
});

test('fetchWithRetry retries 5xx then returns the last response without throwing', async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; return new Response('', { status: 503 }); }) as unknown as typeof fetch;
  const res = await fetchWithRetry('https://x', {}, { fetchImpl, sleep: noSleep, retries: 2 });
  assert.equal(res.status, 503);
  assert.equal(calls, 3); // retried, then gave back the 5xx for the adapter to classify
});

test('fetchWithRetry does not retry a non-transient throw', async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; throw new TypeError('bad url'); }) as unknown as typeof fetch;
  await assert.rejects(fetchWithRetry('https://x', {}, { fetchImpl, sleep: noSleep }), /bad url/);
  assert.equal(calls, 1);
});
