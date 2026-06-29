import type { AccountConfig, NormalizedUsage } from '../types.ts';
import type { ClaudeAuth } from '../auth/claude.ts';
import { readCodexAuth } from '../auth/codex.ts';
import { fetchClaudeUsage } from './claude.ts';
import { fetchCodexUsage } from './codex.ts';

export interface FetchUsageDeps {
  claudeAuth: ClaudeAuth;
  readCodexAuth?: typeof readCodexAuth;
  clientVersion?: string;
  fetchImpl?: typeof fetch;
}

export function makeFetchUsage(deps: FetchUsageDeps): (account: AccountConfig) => Promise<NormalizedUsage> {
  const readAuth = deps.readCodexAuth ?? readCodexAuth;
  return (account) => {
    if (account.provider === 'codex') {
      return fetchCodexUsage(account, { readAuth, fetchImpl: deps.fetchImpl });
    }
    return fetchClaudeUsage(account, {
      getAccessToken: (id, opts) => deps.claudeAuth.getAccessToken(id, opts),
      fetchImpl: deps.fetchImpl,
      clientVersion: deps.clientVersion,
    });
  };
}
