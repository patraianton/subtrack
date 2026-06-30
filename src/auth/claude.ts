import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// Token refresh endpoint + form-encoded body verified against the installed Claude Code binary
// (2026-06-30): the OAuth token endpoint is application/x-www-form-urlencoded, NOT JSON (a JSON body
// returns HTTP 400). subtrack refreshes each account's token in its own isolated CLAUDE_CONFIG_DIR,
// so nothing else rotates it — true set-and-forget.
export const CLAUDE_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const EXPIRY_SKEW_MS = 60_000;
const DEFAULT_EXPIRES_IN = 28800; // 8h fallback if the server omits expires_in

/** The `claudeAiOauth` object Claude Code stores in <CLAUDE_CONFIG_DIR>/.credentials.json. */
export interface ClaudeAiOauth {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
  scopes?: string[];
}

/** Per-account isolated Claude config dir: <base>/claude-homes/<id>. */
export function claudeHomeDir(base: string, id: string): string {
  return join(base, 'claude-homes', id);
}

export function claudeCredentialsPath(home: string): string {
  return join(home, '.credentials.json');
}

/** Spawn spec to log Claude Code in against an isolated config dir (stdio inherited). */
export function buildClaudeLogin(home: string): { cmd: string; args: string[]; env: Record<string, string> } {
  return { cmd: 'claude', args: [], env: { CLAUDE_CONFIG_DIR: home } };
}

/** Read the claudeAiOauth object from an isolated home, or undefined if absent/unreadable. */
export async function readClaudeOauth(home: string): Promise<ClaudeAiOauth | undefined> {
  try {
    const raw = await readFile(claudeCredentialsPath(home), 'utf8');
    return (JSON.parse(raw) as { claudeAiOauth?: ClaudeAiOauth }).claudeAiOauth;
  } catch {
    return undefined;
  }
}

export class ClaudeAuth {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {}

  /**
   * Return a valid access token for the account's isolated home, refreshing (and persisting the
   * rotated token back to that home's .credentials.json) when it is at/near expiry.
   */
  async getAccessToken(home: string, opts: { force?: boolean } = {}): Promise<string> {
    const path = claudeCredentialsPath(home);
    let file: { claudeAiOauth?: ClaudeAiOauth };
    try {
      file = JSON.parse(await readFile(path, 'utf8')) as { claudeAiOauth?: ClaudeAiOauth };
    } catch {
      throw new Error(`No Claude credentials in ${path} — run add-account`);
    }
    const oauth = file.claudeAiOauth;
    if (!oauth?.accessToken) throw new Error(`No Claude login token in ${path} — run add-account`);

    const fresh = !opts.force && (oauth.expiresAt ?? 0) - this.clock() > EXPIRY_SKEW_MS;
    if (fresh || !oauth.refreshToken) {
      // Either still valid, or we can't refresh (no refresh token) — return what we have and let
      // a genuine 401 on the usage call surface as auth_error.
      return oauth.accessToken;
    }

    const refreshed = await this.refresh(oauth.refreshToken);
    file.claudeAiOauth = { ...oauth, ...refreshed };
    await writeFile(path, JSON.stringify(file, null, 2), 'utf8');
    return refreshed.accessToken;
  }

  private async refresh(refreshToken: string): Promise<ClaudeAiOauth> {
    const res = await this.fetchImpl(CLAUDE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLAUDE_CLIENT_ID,
      }).toString(),
    });
    if (!res.ok) throw new Error(`Claude token refresh failed: HTTP ${res.status}`);
    const j = (await res.json()) as Record<string, unknown>;
    return {
      accessToken: String(j['access_token']),
      refreshToken: typeof j['refresh_token'] === 'string' ? (j['refresh_token'] as string) : refreshToken,
      expiresAt: this.clock() + (typeof j['expires_in'] === 'number' ? (j['expires_in'] as number) : DEFAULT_EXPIRES_IN) * 1000,
      scopes: typeof j['scope'] === 'string' ? (j['scope'] as string).split(' ') : undefined,
    };
  }
}
