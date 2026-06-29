import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generatePkce, base64url } from '../src/pkce.ts';

test('base64url has no +, /, or = padding', () => {
  const out = base64url(Buffer.from([251, 252, 253, 254, 255]));
  assert.ok(!/[+/=]/.test(out));
});

test('generatePkce challenge is S256 of verifier', () => {
  const { verifier, challenge } = generatePkce();
  const expected = base64url(createHash('sha256').update(verifier).digest());
  assert.equal(challenge, expected);
  assert.ok(verifier.length >= 43); // 32 bytes base64url
});
