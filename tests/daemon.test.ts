import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { nextBackoff, checkHealth, pidAlive, logFilePath, lockFilePath, vbsPath, TASK_NAME, acquireLock } from '../src/daemon.ts';
import { vbsContent, installScript, uninstallScript } from '../src/install.ts';
import { shouldOpenBrowser, createApp } from '../src/server.ts';
import { SnapshotStore } from '../src/snapshotStore.ts';

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

test('nextBackoff escalates on fast crashes and doubles up to the 60s cap', () => {
  assert.equal(nextBackoff(2000, 0), 4000);
  assert.equal(nextBackoff(4000, 0), 8000);
  assert.equal(nextBackoff(40000, 0), 60000); // capped
  assert.equal(nextBackoff(60000, 0), 60000);
});

test('nextBackoff resets to base after a healthy run', () => {
  assert.equal(nextBackoff(60000, 45000), 2000);
});

test('checkHealth is true for a live dashboard and false for a dead port', async () => {
  const server = createApp(new SnapshotStore(), { webDir, uiRefreshSeconds: 30, pollIntervalSeconds: { claude: 180, codex: 60, grok: 60 } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    assert.equal(await checkHealth(port), true);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  assert.equal(await checkHealth(port, 500), false); // nothing listening now
});

test('pidAlive reports the current process alive and a bogus pid dead', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(2 ** 30), false);
});

test('path helpers live under <base>/.subtrack', () => {
  const base = process.platform === 'win32' ? 'C:\\tmp\\home' : '/tmp/home';
  assert.match(logFilePath(base), /[\\/]\.subtrack[\\/]logs[\\/]subtrack\.log$/);
  assert.match(lockFilePath(base), /[\\/]\.subtrack[\\/]daemon\.lock$/);
  assert.match(vbsPath(base), /[\\/]\.subtrack[\\/]subtrack-daemon\.vbs$/);
});

test('vbsContent launches the daemon hidden with quoted paths', () => {
  const vbs = vbsContent('C:\\Program Files\\nodejs\\node.exe', 'C:\\proj\\src\\cli.ts', 'C:\\proj');
  assert.match(vbs, /WScript\.Shell/);
  assert.match(vbs, /sh\.CurrentDirectory = "C:\\proj"/);
  assert.match(vbs, /node\.exe/);
  assert.match(vbs, /src\\cli\.ts/);
  assert.match(vbs, /daemon/);
  assert.match(vbs, /sh\.Run cmd, 0, False/); // window style 0 = hidden, no wait
});

test('installScript registers an at-logon interactive task via the wscript shim', () => {
  const s = installScript('C:\\Users\\me\\.subtrack\\subtrack-daemon.vbs');
  assert.match(s, new RegExp(`TaskName '${TASK_NAME}'`));
  assert.match(s, /-AtLogOn/);
  assert.match(s, /LogonType Interactive/);       // runs as the user → DPAPI/Credential-Manager works
  assert.match(s, /wscript\.exe/);
  assert.match(s, /subtrack-daemon\.vbs/);
  assert.match(s, /Start-ScheduledTask/);          // kicks off immediately
});

test('installScript escapes single quotes in the vbs path', () => {
  const s = installScript("C:\\a'b\\shim.vbs");
  assert.match(s, /\$vbs = 'C:\\a''b\\shim\.vbs'/);
});

test('uninstallScript removes the task non-interactively', () => {
  const s = uninstallScript();
  assert.match(s, new RegExp(`Unregister-ScheduledTask -TaskName '${TASK_NAME}'`));
  assert.match(s, /-Confirm:\$false/);
});

test('shouldOpenBrowser: explicit opts win, else SUBTRACK_NO_OPEN gates it', () => {
  assert.equal(shouldOpenBrowser({ open: true }, { SUBTRACK_NO_OPEN: '1' }), true);  // explicit wins
  assert.equal(shouldOpenBrowser({ open: false }, {}), false);
  assert.equal(shouldOpenBrowser({}, { SUBTRACK_NO_OPEN: '1' }), false);              // daemon → silent
  assert.equal(shouldOpenBrowser({}, {}), true);                                      // interactive default
});

async function withLockTmp(fn: (base: string) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), 'subtrack-daemon-'));
  try { await mkdir(join(base, '.subtrack'), { recursive: true }); await fn(base); }
  finally { await rm(base, { recursive: true, force: true }); }
}

test('acquireLock takes over a STALE lock (old mtime) even if its pid is a live/recycled pid', async () => {
  await withLockTmp(async (base) => {
    const lock = lockFilePath(base);
    await writeFile(lock, String(process.pid), 'utf8');   // our own pid → pidAlive() is true
    const old = new Date(Date.now() - 5 * 60_000);        // but backdate the lock 5 minutes
    await utimes(lock, old, old);
    // runDaemon only calls acquireLock once the dashboard is already down, so an OLD lock whose pid
    // is "alive" is a recycled pid / wedged daemon and must be taken over — not stood down on, which
    // is exactly the bug that left the dashboard dead with the self-heal unable to recover.
    assert.equal(await acquireLock(base), true);
    assert.equal((await readFile(lock, 'utf8')).trim(), String(process.pid));
  });
});

test('acquireLock stands down for a FRESH lock held by a live pid (real double-start race)', async () => {
  await withLockTmp(async (base) => {
    const lock = lockFilePath(base);
    await writeFile(lock, String(process.pid), 'utf8');   // fresh mtime = now, pid alive → real owner
    assert.equal(await acquireLock(base), false);
  });
});
