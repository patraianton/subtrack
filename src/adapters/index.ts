import type { AccountConfig, NormalizedUsage } from '../types.ts';
import { ClaudeAuth } from '../auth/claude.ts';
import { readCodexAuth } from '../auth/codex.ts';
import { fetchClaudeUsage } from './claude.ts';
import { fetchCodexUsage } from './codex.ts';

export interface FetchUsageDeps {
  claudeAuth?: ClaudeAuth;
  readCodexAuth?: typeof readCodexAuth;
  fetchImpl?: typeof fetch;
}

export function makeFetchUsage(deps: FetchUsageDeps = {}): (account: AccountConfig) => Promise<NormalizedUsage> {
  const readCodex = deps.readCodexAuth ?? readCodexAuth;
  const claudeAuth = deps.claudeAuth ?? new ClaudeAuth(deps.fetchImpl);
  return (account) => {
    if (account.provider === 'codex') {
      return fetchCodexUsage(account, { readAuth: readCodex, fetchImpl: deps.fetchImpl });
    }
    const home = account.credentialsHome ?? '';
    return fetchClaudeUsage(account, {
      getAccessToken: (_id, opts) => claudeAuth.getAccessToken(home, opts),
      fetchImpl: deps.fetchImpl,
    });
  };
}
