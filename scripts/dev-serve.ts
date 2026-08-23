// Dev-only server for verifying the Fable bucket end-to-end WITHOUT disturbing the live :7777
// instance. Binds a DIFFERENT port and NEVER refreshes/writes tokens: it serves the on-disk access
// token verbatim, so it can neither rewrite the shared ~/.subtrack token files nor rotate them
// server-side (an OAuth refresh from a second process orphans the live poller's on-disk refresh
// token → auth_error). If a token is already expired, that account simply surfaces auth_error here;
// the live instance is the sole token owner. Run manually: PORT=7788 node --import tsx scripts/dev-serve.ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';
import { SnapshotStore } from '../src/snapshotStore.ts';
import { Poller } from '../src/poller.ts';
import { createApp } from '../src/server.ts';
import { fetchClaudeUsage } from '../src/adapters/claude.ts';
import { fetchCodexUsage } from '../src/adapters/codex.ts';
import { readCodexAuth } from '../src/auth/codex.ts';
import type { AccountConfig, NormalizedUsage } from '../src/types.ts';

const PORT = Number(process.env.PORT ?? 7788);

// Read the on-disk access token verbatim — NO refresh, NO write. Never touches the live token state.
async function readOnlyToken(home: string): Promise<string> {
  const raw = JSON.parse(await readFile(join(home, '.credentials.json'), 'utf8')) as { claudeAiOauth?: { accessToken?: string } };
  const token = raw.claudeAiOauth?.accessToken;
  if (!token) throw new Error(`no accessToken in ${home}`);
  return token;
}

function fetchUsage(account: AccountConfig): Promise<NormalizedUsage> {
  if (account.provider === 'codex') return fetchCodexUsage(account, { readAuth: readCodexAuth });
  const home = account.credentialsHome ?? '';
  return fetchClaudeUsage(account, { getAccessToken: () => readOnlyToken(home) /* read-only: no refresh */ });
}

const cfg = await loadConfig();
const store = new SnapshotStore();
const poller = new Poller({ config: cfg, fetchUsage, store });
poller.start();
const webDir = fileURLToPath(new URL('../web/', import.meta.url));
const server = createApp(store, { webDir, uiRefreshSeconds: cfg.uiRefreshSeconds, pollIntervalSeconds: cfg.pollIntervalSeconds });
server.listen(PORT, '127.0.0.1', () => console.log(`dev subtrack (READ-ONLY tokens) → http://127.0.0.1:${PORT}  polling ${cfg.accounts.filter((a) => a.enabled).length} accounts`));
