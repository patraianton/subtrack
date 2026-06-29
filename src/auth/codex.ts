import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function codexHomeDir(base: string, id: string): string {
  return join(base, 'codex-homes', id);
}

export function buildCodexLogin(home: string): { cmd: string; args: string[]; env: Record<string, string> } {
  return { cmd: 'codex', args: ['login'], env: { CODEX_HOME: home } };
}

export async function readCodexAuth(home: string): Promise<{ accessToken: string; accountId: string }> {
  const raw = await readFile(join(home, 'auth.json'), 'utf8');
  const j = JSON.parse(raw) as { tokens?: { access_token?: string; account_id?: string }; account_id?: string };
  const accessToken = j.tokens?.access_token;
  if (!accessToken) throw new Error(`No access_token in ${home}\\auth.json — run: codex login (CODEX_HOME=${home})`);
  return { accessToken, accountId: j.tokens?.account_id ?? j.account_id ?? '' };
}
