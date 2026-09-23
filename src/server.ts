import { createServer, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, normalize, extname, sep } from 'node:path';
import { homedir } from 'node:os';
import open from 'open';
import type { NormalizedUsage, Severity, SubtrackConfig, UsageWindow } from './types.ts';
import { severityFor } from './thresholds.ts';
import { SnapshotStore } from './snapshotStore.ts';
import { Poller } from './poller.ts';
import { loadConfig } from './config.ts';
import { makeFetchUsage } from './adapters/index.ts';
import type { ServicesResponse, ActionRequest, ActionResult } from './ops/types.ts';
import { makeGetServices } from './ops/services.ts';
import { makeRunServiceAction } from './ops/actions.ts';
import { runPwsh } from './ops/windows.ts';
import type { SessionsResponse } from './sessions/types.ts';
import { makeGetSessions } from './sessions/scan.ts';
import type { BurnResponse } from './burn/types.ts';
import { makeGetBurn } from './burn/scan.ts';
import type { FleetResponse, SetModeRequest, SetModeResult } from './fleet/types.ts';
import { makeGetFleet, makeSetWindowMode } from './fleet/fleet.ts';
import { makeHerdrRunner } from './fleet/panes.ts';
import { makeRemoteScanner, makeSshRunner } from './burn/remote.ts';
import { HermesFleetMonitor } from './hermes/monitor.ts';
import { HermesMonitorSupervisor } from './hermes/supervisor.ts';

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

export function createApp(store: SnapshotStore, opts: { webDir: string; uiRefreshSeconds: number; pollIntervalSeconds: SubtrackConfig['pollIntervalSeconds']; getServices?: () => Promise<ServicesResponse>; runServiceAction?: (req: ActionRequest) => Promise<ActionResult>; getSessions?: () => Promise<SessionsResponse>; getBurn?: (accountId: string, resetsAt: string | null) => Promise<BurnResponse>; getFleet?: () => Promise<FleetResponse>; setWindowMode?: (req: SetModeRequest) => Promise<SetModeResult> }): Server {
  return createServer(async (req, res) => {
    const raw = req.url ?? '/';
    const url = raw.split('?')[0]!;
    try {
      if (req.method === 'POST' && url === '/api/services/action') {
        if (!opts.runServiceAction) { safeWrite(res, 503, { error: 'actions unavailable' }); return; }
        // CSRF defense: this endpoint changes system state. A cross-origin browser POST carries an
        // Origin that won't match our loopback origin; reject it. Non-browser clients send no Origin.
        if (!sameOrigin(req)) { safeWrite(res, 403, { error: 'forbidden (cross-origin)' }); return; }
        let bodyText: string;
        try { bodyText = await readBody(req); }
        catch (e) { safeWrite(res, (e as { tooLarge?: boolean }).tooLarge ? 413 : 400, { error: (e as { tooLarge?: boolean }).tooLarge ? 'payload too large' : 'bad request' }); return; }
        let parsed: ActionRequest;
        try { parsed = JSON.parse(bodyText || '{}') as ActionRequest; }
        catch { safeWrite(res, 400, { error: 'bad json' }); return; }
        try { return json(res, await opts.runServiceAction(parsed)); }
        catch (e) { safeWrite(res, 500, { error: 'action failed', detail: String((e as Error).message) }); return; }
      }
      if (req.method === 'POST' && url === '/api/fleet/mode') {
        const noStore = { 'cache-control': 'no-store' };
        if (!opts.setWindowMode) { safeWrite(res, 503, { error: 'fleet unavailable' }, noStore); return; }
        // Same CSRF defense as the services action: this writes a file other watchdogs obey.
        if (!sameOrigin(req)) { safeWrite(res, 403, { error: 'forbidden (cross-origin)' }, noStore); return; }
        let bodyText: string;
        try { bodyText = await readBody(req); }
        catch (e) { safeWrite(res, (e as { tooLarge?: boolean }).tooLarge ? 413 : 400, { error: (e as { tooLarge?: boolean }).tooLarge ? 'payload too large' : 'bad request' }, noStore); return; }
        let parsed: SetModeRequest;
        try { parsed = JSON.parse(bodyText || '{}') as SetModeRequest; }
        catch { safeWrite(res, 400, { error: 'bad json' }, noStore); return; }
        try { return json(res, await opts.setWindowMode(parsed), noStore); }
        catch (e) { safeWrite(res, 400, { error: String((e as Error).message) }, noStore); return; }
      }
      if (url === '/api/fleet') {
        const noStore = { 'cache-control': 'no-store' };
        if (req.method !== 'GET') { safeWrite(res, 405, { error: 'method not allowed' }, { ...noStore, allow: 'GET' }); return; }
        if (!opts.getFleet) { safeWrite(res, 503, { error: 'fleet unavailable' }, noStore); return; }
        try { return json(res, await opts.getFleet(), noStore); }
        catch (e) { safeWrite(res, 500, { error: 'fleet failed', detail: String((e as Error).message) }, noStore); return; }
      }
      if (url === '/api/health') return json(res, { ok: true });
      if (url === '/api/conveyor') {
        const noStore = { 'cache-control': 'no-store' };
        try {
          const raw = await readFile(join(homedir(), '.autopase-conveyor-status.json'), 'utf8');
          return json(res, JSON.parse(raw) as unknown, noStore);
        } catch {
          return json(res, { project: null, task: null, timeline: [] }, noStore);
        }
      }
      if (url === '/api/sessions') {
        const noStore = { 'cache-control': 'no-store' };
        if (req.method !== 'GET') { safeWrite(res, 405, { error: 'method not allowed' }, { ...noStore, allow: 'GET' }); return; }
        if (!opts.getSessions) { safeWrite(res, 503, { error: 'sessions unavailable' }, noStore); return; }
        try {
          return json(res, await opts.getSessions(), noStore);
        } catch (e) {
          safeWrite(res, 500, { error: 'sessions failed', detail: String((e as Error).message) }, noStore);
          return;
        }
      }
      if (url === '/api/burn') {
        const noStore = { 'cache-control': 'no-store' };
        if (req.method !== 'GET') { safeWrite(res, 405, { error: 'method not allowed' }, { ...noStore, allow: 'GET' }); return; }
        if (!opts.getBurn) { safeWrite(res, 503, { error: 'burn unavailable' }, noStore); return; }
        const accountId = new URL(raw, 'http://127.0.0.1').searchParams.get('account');
        if (!accountId) { safeWrite(res, 400, { error: 'account query parameter required' }, noStore); return; }
        // The window is anchored on the provider's own reset time from the latest snapshot; with no
        // snapshot the scan falls back to a rolling five hours rather than refusing to answer.
        const snapshot = store.all().find((usage) => usage.accountId === accountId);
        try {
          return json(res, await opts.getBurn(accountId, snapshot?.session?.resetsAt ?? null), noStore);
        } catch (e) {
          safeWrite(res, 500, { error: 'burn failed', detail: String((e as Error).message) }, noStore);
          return;
        }
      }
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

/**
 * Claude accounts with no room left for a compaction run: a /compact prices the whole conversation
 * through the model, so on an exhausted account it just fails. Mirrors the watchdog's own check.
 */
export function blockedAccounts(store: SnapshotStore): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of store.all()) {
    if (a.provider !== 'claude') continue;
    if (a.status !== 'ok') { out.set(a.accountId, a.status); continue; }
    const worst = Math.max(a.weekly?.utilization ?? 0, a.session?.utilization ?? 0);
    if (worst >= 99) out.set(a.accountId, 'limit spent');
  }
  return out;
}

function maxUtil(u: EnrichedUsage): number {
  return Math.max(u.session?.utilization ?? -1, u.weekly?.utilization ?? -1, u.fable?.utilization ?? -1);
}
function byTightest(a: EnrichedUsage, b: EnrichedUsage): number {
  return maxUtil(b) - maxUtil(a);
}

/**
 * CSRF defense for state-changing endpoints: a cross-origin browser POST carries an Origin that
 * won't match our loopback origin. Non-browser clients send no Origin and are allowed through.
 */
function sameOrigin(req: import('node:http').IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host ?? '';
  return !origin || origin === `http://${host}` || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin);
}

function json(res: ServerResponse, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...headers }).end(JSON.stringify(body));
}

function safeWrite(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.writableEnded || res.headersSent) return;
  try { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers }).end(JSON.stringify(body)); } catch { /* socket gone */ }
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''; let done = false;
    req.on('data', (c) => {
      if (done) return;
      data += c;
      if (data.length > 1_000_000) { done = true; const e = new Error('payload too large') as Error & { tooLarge?: boolean }; e.tooLarge = true; reject(e); }
    });
    req.on('end', () => { if (!done) resolve(data); });
    req.on('error', (err) => { if (!done) { done = true; reject(err); } });
  });
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
  const hermesSupervisor = new HermesMonitorSupervisor({
    create: () => HermesFleetMonitor.create({ base, runPwsh }),
    onError: (error) => console.error(`Hermes monitor initialization failed: ${error.message}`),
  });
  const getServices = makeGetServices({ base, run: runPwsh, additionalServices: () => hermesSupervisor.serviceRows() });
  const runServiceAction = makeRunServiceAction({ base, run: runPwsh });
  const getSessions = makeGetSessions({ base, accounts: cfg.accounts, run: runPwsh });
  // Codex runs on the Mac and Hetzner, so most Codex windows are burned by sessions that are not on
  // this machine; the scanner reaches them over ssh only while a card is expanded.
  const codexRemotes = cfg.codexRemotes ?? [];
  const getBurn = makeGetBurn({
    base,
    accounts: cfg.accounts,
    remotes: codexRemotes,
    scanRemote: codexRemotes.length > 0 ? makeRemoteScanner(makeSshRunner()) : undefined,
  });
  // The window fleet surface: herdr owns the pane list, subtrack owns activity and quota, and the
  // marks file is shared with the `ccmode` shell function. Subtrack still compacts nothing itself.
  const getFleet = makeGetFleet({ base, run: makeHerdrRunner(base), getSessions, blockedAccounts: () => blockedAccounts(store) });
  const setWindowMode = makeSetWindowMode({ base });
  const server = createApp(store, { webDir, uiRefreshSeconds: cfg.uiRefreshSeconds, pollIntervalSeconds: cfg.pollIntervalSeconds, getServices, runServiceAction, getSessions, getBurn, getFleet, setWindowMode });
  // Reject (rather than hang) if the port is taken — the daemon supervisor reacts to the non-zero exit.
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(cfg.port, '127.0.0.1', () => { server.off('error', onError); resolve(); });
  });
  server.on('error', (err) => console.error(`server error: ${err.message}`));
  server.once('close', () => hermesSupervisor.stop());
  // The monitor may invoke credential-owner canaries or gateway recovery, so
  // it must never start in a contender that failed the exclusive port bind.
  await hermesSupervisor.start();
  const dashUrl = `http://localhost:${cfg.port}`;
  console.log(`subtrack dashboard → ${dashUrl}  (polling ${cfg.accounts.filter((a) => a.enabled).length} accounts)`);
  if (shouldOpenBrowser(opts)) await open(dashUrl);
  return await new Promise<number>(() => { /* run until killed */ });
}
