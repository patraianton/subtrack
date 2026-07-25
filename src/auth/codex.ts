import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function codexHomeDir(base: string, id: string): string {
  return join(base, 'codex-homes', id);
}

export function buildCodexLogin(home: string): { cmd: string; args: string[]; env: Record<string, string> } {
  return { cmd: 'codex', args: ['login'], env: { CODEX_HOME: home } };
}

export interface CodexReadOptions { externalOwner?: boolean }

export async function readCodexAuth(home: string, opts: CodexReadOptions = {}): Promise<{ accessToken: string; accountId: string }> {
  let raw: string;
  try {
    raw = await readFile(join(home, 'auth.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (opts.externalOwner) {
        throw new Error(`Externally-owned Codex auth missing in ${home} — repair it with the owning Hermes login; subtrack will not run codex login here`);
      }
      const quotedHome = `'${home.replace(/'/g, "''")}'`;
      throw new Error(`Codex login missing — run: $env:CODEX_HOME=${quotedHome}; codex login`);
    }
    throw error;
  }
  const j = JSON.parse(raw) as {
    tokens?: { access_token?: string; account_id?: string };
    account_id?: string;
    providers?: { 'openai-codex'?: { tokens?: { access_token?: string; account_id?: string }; account_id?: string } };
  };
  // Hermes shared stores intentionally remain externally owned. Supporting their nested
  // shape here only lets Usage reread the live access token; subtrack never refreshes or writes it.
  const shared = j.providers?.['openai-codex'];
  const tokens = j.tokens ?? shared?.tokens;
  const accessToken = tokens?.access_token;
  if (!accessToken) {
    if (opts.externalOwner || shared) throw new Error(`No access_token in externally-owned Hermes shared auth under ${home} — repair it with the owning Hermes login`);
    throw new Error(`No access_token in ${home}\\auth.json — run: codex login (CODEX_HOME=${home})`);
  }
  return { accessToken, accountId: tokens?.account_id ?? shared?.account_id ?? j.account_id ?? '' };
}
