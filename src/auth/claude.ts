import type { SecretStore } from '../secrets.ts';

export const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// subtrack does NOT run an OAuth web flow — Claude Code mints the token (`claude setup-token`)
// and the user pastes the bare `sk-ant-oat01-…` access token. This refresh endpoint is only used
// if we ever hold a refresh token (sk-ant-ort01-…); bare setup-tokens have none and are treated
// as long-lived. (Endpoint per Aperant's reference impl.)
export const CLAUDE_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const DEFAULT_EXPIRES_IN = 28800; // 8h fallback if server omits expires_in
const EXPIRY_SKEW_MS = 60_000;

export interface ClaudeCreds {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  scopes?: string[];
}

export function claudeCredKey(id: string): string {
  return `subtrack/${id}`;
}

function parseTokenResponse(json: Record<string, unknown>, refreshFallback: string, clock: () => number): ClaudeCreds {
  return {
    accessToken: String(json['access_token']),
    refreshToken: typeof json['refresh_token'] === 'string' ? (json['refresh_token'] as string) : refreshFallback,
    expiresAt: clock() + (typeof json['expires_in'] === 'number' ? (json['expires_in'] as number) : DEFAULT_EXPIRES_IN) * 1000,
    scopes: typeof json['scope'] === 'string' ? (json['scope'] as string).split(' ') : undefined,
  };
}

export class ClaudeAuth {
  constructor(
    private readonly secrets: SecretStore,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {}

  async getAccessToken(id: string, opts: { force?: boolean } = {}): Promise<string> {
    const key = claudeCredKey(id);
    const creds = await this.readCreds(key);
    if (!opts.force && creds.expiresAt - this.clock() > EXPIRY_SKEW_MS) {
      return creds.accessToken;
    }
    const refreshed = await this.refresh(creds.refreshToken);
    await this.secrets.set(key, JSON.stringify(refreshed));
    return refreshed.accessToken;
  }

  private async refresh(refreshToken: string): Promise<ClaudeCreds> {
    const res = await this.fetchImpl(CLAUDE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLAUDE_CLIENT_ID }),
    });
    if (!res.ok) throw new Error(`Claude token refresh failed: HTTP ${res.status}`);
    return parseTokenResponse((await res.json()) as Record<string, unknown>, refreshToken, this.clock);
  }

  private async readCreds(key: string): Promise<ClaudeCreds> {
    const raw = await this.secrets.get(key);
    if (!raw) throw new Error(`No stored Claude credentials for ${key} — run add-account`);
    return JSON.parse(raw) as ClaudeCreds;
  }
}
