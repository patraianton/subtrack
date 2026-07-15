import { createServer, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, normalize, extname, sep } from 'node:path';
import { homedir } from 'node:os';
import open from 'open';
import type { NormalizedUsage, Severity, UsageWindow } from './types.ts';
import { severityFor } from './thresholds.ts';
import { SnapshotStore } from './snapshotStore.ts';
import { Poller } from './poller.ts';
import { loadConfig } from './config.ts';
import { makeFetchUsage } from './adapters/index.ts';
import type { ServicesResponse } from './ops/types.ts';
import { makeGetServices } from './ops/services.ts';
import { runPwsh } from './ops/windows.ts';

export interface ApiWindow extends UsageWindow { severity: Severity }
export interface EnrichedUsage extends Omit<NormalizedUsage, 'session' | 'weekly' | 'weeklyOpus' | 'fable'> {
  session: ApiWindow | null;
  weekly: ApiWindow | null;
  weeklyOpus: ApiWindow | null;
  fable: ApiWindow | null;
}

function enrichWindow(w: UsageWindow | null): ApiWindow | null {
  return w ? { ...w, severity: severityFor(w.utilization) } : null;
}

export function enrichUsage(u: NormalizedUsage): EnrichedUsage {
  return { ...u, session: enrichWindow(u.session), weekly: enrichWindow(u.weekly), weeklyOpus: enrichWindow(u.weeklyOpus), fable: enrichWindow(u.fable) };
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

export function createApp(store: SnapshotStore, opts: { webDir: string; uiRefreshSeconds: number; pollIntervalSeconds: { claude: number; codex: number }; getServices?: () => Promise<ServicesResponse> }): Server {
  return createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0]!;
    try {
      if (url === '/api/health') return json(res, { ok: true });
      if (url === '/api/services') {
        if (!opts.getServices) { res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'services unavailable' })); return; }
        try {
          return json(res, await opts.getServices());
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'services failed', detail: String((e as Error).message) }));
          return;
        }
      }
      if (url === '/api/usage') {
        const accounts = store.all().map(enrichUsage).sort(byTightest);
        return json(res, { accounts, uiRefreshSeconds: opts.uiRefreshSeconds, pollIntervalSeconds: opts.pollIntervalSeconds });
      }
      const file = url === '/' ? 'index.html' : url.replace(/^\//, '');
      const full = normalize(join(opts.webDir, file));
      // Exactly one trailing separator — webDir may arrive with or without one (serve() passes a
      // trailing-slash path); doubling the sep would 403 every request, an absent sep weakens the guard.
      const root = normalize(opts.webDir);
      const safeBase = root.endsWith(sep) ? root : root + sep;
      if (!full.startsWith(safeBase)) { res.writeHead(403).end('forbidden'); return; }
      const data = await readFile(full);
      res.writeHead(200, { 'content-type': MIME[extname(full)] ?? 'application/octet-stream' }).end(data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });
}

function maxUtil(u: EnrichedUsage): number {
  return Math.max(u.session?.utilization ?? -1, u.weekly?.utilization ?? -1, u.fable?.utilization ?? -1);
}
function byTightest(a: EnrichedUsage, b: EnrichedUsage): number {
  return maxUtil(b) - maxUtil(a);
}

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
}

/** Whether to auto-open a browser: explicit opts win, else honour SUBTRACK_NO_OPEN (set by the daemon). */
export function shouldOpenBrowser(opts: { open?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  return opts.open ?? env.SUBTRACK_NO_OPEN !== '1';
}

export async function serve(base: string = homedir(), opts: { open?: boolean } = {}): Promise<number> {
  const cfg = await loadConfig(base);
  const store = new SnapshotStore();
  const fetchUsage = makeFetchUsage();
  const poller = new Poller({ config: cfg, fetchUsage, store });
  poller.start();
  const webDir = fileURLToPath(new URL('../web/', import.meta.url)); // decode %20 etc — never use .pathname on Windows
  const getServices = makeGetServices({ base, run: runPwsh });
  const server = createApp(store, { webDir, uiRefreshSeconds: cfg.uiRefreshSeconds, pollIntervalSeconds: cfg.pollIntervalSeconds, getServices });
  // Reject (rather than hang) if the port is taken — the daemon supervisor reacts to the non-zero exit.
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(cfg.port, '127.0.0.1', () => { server.off('error', onError); resolve(); });
  });
  server.on('error', (err) => console.error(`server error: ${err.message}`));
  const dashUrl = `http://localhost:${cfg.port}`;
  console.log(`subtrack dashboard → ${dashUrl}  (polling ${cfg.accounts.filter((a) => a.enabled).length} accounts)`);
  if (shouldOpenBrowser(opts)) await open(dashUrl);
  return await new Promise<number>(() => { /* run until killed */ });
}
