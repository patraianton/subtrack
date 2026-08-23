import type { AccountConfig, NormalizedUsage } from '../types.ts';
import { ClaudeAuth, makeReadOnlyTokenSource } from '../auth/claude.ts';
import { readCodexAuth } from '../auth/codex.ts';
import { readGrokCookie } from '../auth/grok.ts';
import { fetchClaudeUsage } from './claude.ts';
import { fetchCodexUsage } from './codex.ts';
import { fetchGrokUsage } from './grok.ts';

export interface FetchUsageDeps {
  claudeAuth?: ClaudeAuth;
  readCodexAuth?: typeof readCodexAuth;
  readGrokCookie?: typeof readGrokCookie;
  fetchImpl?: typeof fetch;
  clock?: () => number;
}

export function makeFetchUsage(deps: FetchUsageDeps = {}): (account: AccountConfig) => Promise<NormalizedUsage> {
  const readCodex = deps.readCodexAuth ?? readCodexAuth;
  const readGrok = deps.readGrokCookie ?? readGrokCookie;
  const claudeAuth = deps.claudeAuth ?? new ClaudeAuth(deps.fetchImpl);
  return (account) => {
    if (account.provider === 'codex') {
      return fetchCodexUsage(account, { readAuth: readCodex, fetchImpl: deps.fetchImpl });
    }
    if (account.provider === 'grok') {
      // Cookie-only credential, reread every poll like the other read-only sources; there is no
      // refresh or write path at all — an expired cookie surfaces as auth_error until re-copied.
      return fetchGrokUsage(account, { readCookie: readGrok, fetchImpl: deps.fetchImpl });
    }
    const home = account.credentialsHome ?? '';
    if (account.credentialsMode === 'readonly') {
      // Externally-owned credentials (CLI home / static setup-token): route through the read-only
      // source, which cannot refresh or write by construction — ClaudeAuth is never in this path,
      // so the single-use refresh token stays exclusively with its owner (incident 2026-07-08).
      const source = makeReadOnlyTokenSource(home, deps.clock);
      return fetchClaudeUsage(account, {
        // `force` needs no special handling: every call re-reads the file, which is all a
        // read-only source can do anyway (the owner may have rotated it moments ago).
        getAccessToken: () => source.getAccessToken(),
        fetchImpl: deps.fetchImpl,
      });
    }
    return fetchClaudeUsage(account, {
      getAccessToken: (_id, opts) => claudeAuth.getAccessToken(home, opts),
      fetchImpl: deps.fetchImpl,
    });
  };
}
