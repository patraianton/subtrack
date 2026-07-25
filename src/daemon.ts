import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { stat, rename, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { get } from 'node:http';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir, loadConfig } from './config.ts';

/** Windows Scheduled Task name that keeps the dashboard always-on. */
export const TASK_NAME = 'subtrack-dashboard';

const LOG_MAX_BYTES = 5 * 1024 * 1024; // rotate once past 5 MB
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
const HEALTHY_RUN_MS = 30_000; // a serve child that lived this long resets the backoff
const LOCK_FRESH_MS = 30_000;  // a lock held by a live pid this recently = a daemon still booting;
                               // older than this (with the dashboard down) = a stale/recycled-pid lock

/** Repo root (parent of src/) — where `node_modules` lives so `--import tsx` resolves. */
export function repoRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}
/** Absolute path to the CLI entry the supervisor (re)spawns. */
export function cliEntry(): string {
  return fileURLToPath(new URL('./cli.ts', import.meta.url));
}
export function logDir(base: string = homedir()): string {
  return join(configDir(base), 'logs');
}
export function logFilePath(base: string = homedir()): string {
  return join(logDir(base), 'subtrack.log');
}
export function lockFilePath(base: string = homedir()): string {
  return join(configDir(base), 'daemon.lock');
}
export function vbsPath(base: string = homedir()): string {
  return join(configDir(base), 'subtrack-daemon.vbs');
}

/** How long to wait before the next restart, and whether a healthy run should reset it. */
export function nextBackoff(current: number, ranMs: number): number {
  if (ranMs >= HEALTHY_RUN_MS) return BACKOFF_BASE_MS;
  return Math.min(current * 2, BACKOFF_MAX_MS);
}

/** Resolve true iff a subtrack dashboard is already answering on this port. */
export function checkHealth(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(res.statusCode === 200 && (JSON.parse(body) as { ok?: boolean }).ok === true); }
        catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** True if a process with this pid exists (signal 0 probe; EPERM still means "alive"). */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function rotateLog(path: string): Promise<void> {
  try {
    const s = await stat(path);
    if (s.size > LOG_MAX_BYTES) await rename(path, `${path}.1`);
  } catch { /* no log yet — nothing to rotate */ }
}

/** Exclusive PID lock so a second daemon (e.g. from the self-heal trigger) is a no-op. */
export async function acquireLock(base: string): Promise<boolean> {
  const p = lockFilePath(base);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(p, String(process.pid), { flag: 'wx' }); // atomic create-or-fail
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number((await readFile(p, 'utf8').catch(() => '')).trim());
      // runDaemon only calls us after checkHealth already failed, so nothing is serving. A live pid
      // is a real owner ONLY if the lock is FRESH — a daemon that just wrote it and is still booting.
      // An OLD lock whose pid happens to be "alive" is a recycled pid (Windows reuses them) or a
      // wedged daemon; a healthy one would be answering by now. Standing down there leaves the
      // dashboard dead and the self-heal unable to recover — so take the lock over instead.
      const ageMs = await stat(p).then((s) => Date.now() - s.mtimeMs).catch(() => Infinity);
      if (pid && pidAlive(pid) && ageMs < LOCK_FRESH_MS) return false; // another daemon is booting
      await rm(p, { force: true }).catch(() => {});        // stale/recycled lock → clear, then retry
    }
  }
  return false;
}

/** Supervisor: keep the dashboard alive forever, restarting `serve` when it dies. */
export async function runDaemon(base: string = homedir()): Promise<number> {
  const cfg = await loadConfig(base);
  const { port } = cfg;

  // Single-instance: if the dashboard already answers, or a live daemon holds the lock, do nothing.
  if (await checkHealth(port)) return 0;
  await mkdir(logDir(base), { recursive: true });
  if (!(await acquireLock(base))) return 0;

  await rotateLog(logFilePath(base));
  const log: WriteStream = createWriteStream(logFilePath(base), { flags: 'a' });
  const write = (line: string) => { log.write(`[${new Date().toISOString()}] ${line}\n`); };
  write(`daemon start pid=${process.pid} node=${process.version} port=${port} cwd=${repoRoot()}`);

  let child: ChildProcess | null = null;
  let shuttingDown = false;

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    write('shutdown signal — stopping child');
    child?.kill();
    rm(lockFilePath(base), { force: true }).catch(() => {});
    log.end(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);

  let backoff = BACKOFF_BASE_MS;
  while (!shuttingDown) {
    const startedAt = Date.now();
    write('spawning serve (subtrack dashboard)');
    const code = await new Promise<number>((resolve) => {
      child = spawn(process.execPath, ['--import', 'tsx', cliEntry(), 'serve', '--no-open'], {
        cwd: repoRoot(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, SUBTRACK_NO_OPEN: '1' },
      });
      child.stdout?.on('data', (d: Buffer) => log.write(d));
      child.stderr?.on('data', (d: Buffer) => log.write(d));
      child.on('exit', (c) => resolve(c ?? 0));
      child.on('error', (err) => { write(`spawn error: ${(err as Error).message}`); resolve(1); });
    });
    child = null;
    if (shuttingDown) break;
    write(`serve exited code=${code}`);

    // Another instance may have grabbed the port while we were down — defer to it.
    if (await checkHealth(port)) { write('another instance is serving — exiting'); break; }

    const ranMs = Date.now() - startedAt;
    const waitMs = ranMs >= HEALTHY_RUN_MS ? BACKOFF_BASE_MS : backoff;
    write(`restarting in ${Math.round(waitMs / 1000)}s`);
    await new Promise((r) => setTimeout(r, waitMs));
    backoff = nextBackoff(backoff, ranMs); // reset after a healthy run, else escalate
  }

  // On a signal, shutdown() already removed the lock, ended the log, and will process.exit — don't
  // touch the stream again (a second end() would throw write-after-end). Only clean up on the
  // "another instance is serving" break, where shuttingDown is still false.
  if (!shuttingDown) {
    rm(lockFilePath(base), { force: true }).catch(() => {});
    await new Promise<void>((r) => log.end(() => r())); // flush the final line before returning
  }
  return 0;
}
