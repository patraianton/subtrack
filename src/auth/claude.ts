import type { SecretStore } from '../secrets.ts';

export const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const CLAUDE_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
export const CLAUDE_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
export const CLAUDE_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
export const CLAUDE_SCOPES = 'org:create_api_key user:profile user:inference';
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

export function buildAuthorizeUrl(challenge: string, state: string): string {
  const u = new URL(CLAUDE_AUTHORIZE_URL);
  u.searchParams.set('code', 'true');
  u.searchParams.set('client_id', CLAUDE_CLIENT_ID);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', CLAUDE_REDIRECT_URI);
  u.searchParams.set('scope', CLAUDE_SCOPES);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  return u.toString();
}

function parseTokenResponse(json: Record<string, unknown>, refreshFallback: string, clock: () => number): ClaudeCreds {
  return {
    accessToken: String(json['access_token']),
    refreshToken: typeof json['refresh_token'] === 'string' ? (json['refresh_token'] as string) : refreshFallback,
    expiresAt: clock() + (typeof json['expires_in'] === 'number' ? (json['expires_in'] as number) : DEFAULT_EXPIRES_IN) * 1000,
    scopes: typeof json['scope'] === 'string' ? (json['scope'] as string).split(' ') : undefined,
  };
}

export async function exchangeCode(
  code: string,
  verifier: string,
  deps: { fetchImpl?: typeof fetch; clock?: () => number } = {},
): Promise<ClaudeCreds> {
  const f = deps.fetchImpl ?? fetch;
  const clock = deps.clock ?? Date.now;
  // The manual-paste flow returns "<code>#<state>"; keep only the code part.
  const codeOnly = code.split('#')[0]!.trim();
  const res = await f(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: codeOnly,
      redirect_uri: CLAUDE_REDIRECT_URI,
      client_id: CLAUDE_CLIENT_ID,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`Claude code exchange failed: HTTP ${res.status}`);
  return parseTokenResponse((await res.json()) as Record<string, unknown>, '', clock);
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
