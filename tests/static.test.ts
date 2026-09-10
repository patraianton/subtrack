import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';
import { createApp } from '../src/server.ts';
import { SnapshotStore } from '../src/snapshotStore.ts';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

async function withServer(dir: string, fn: (port: number) => Promise<void>) {
  const server = createApp(new SnapshotStore(), { webDir: dir, uiRefreshSeconds: 30, pollIntervalSeconds: { claude: 180, codex: 60, grok: 60 } });
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try { await fn(port); } finally { await new Promise<void>((r) => server.close(() => r())); }
}

test('serves index.html at / and app.js with a js mime', async () => {
  await withServer(webDir, async (port) => {
    const root = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get('content-type') ?? '', /text\/html/);
    const js = await fetch(`http://127.0.0.1:${port}/app.js`);
    assert.match(js.headers.get('content-type') ?? '', /javascript/);
  });
});

test('serves the Sessions page and module with the expected MIME types', async () => {
  await withServer(webDir, async (port) => {
    const page = await fetch(`http://127.0.0.1:${port}/sessions.html`);
    const js = await fetch(`http://127.0.0.1:${port}/sessions.js`);

    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') ?? '', /javascript/);
  });
});

// Regression: serve() passes webDir WITH a trailing separator; the guard must not double the sep
// and 403 every request (this exact bug shipped the dashboard as a blank "forbidden" page).
test('serves index.html when webDir has a trailing separator', async () => {
  await withServer(webDir + sep, async (port) => {
    const root = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get('content-type') ?? '', /text\/html/);
  });
});

test('serve starts Hermes owner actions only after the exclusive HTTP bind succeeds', async () => {
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.ts'), 'utf8');
  const listen = source.indexOf("server.listen(cfg.port, '127.0.0.1'");
  const startHermes = source.indexOf('await hermesSupervisor.start()');
  assert.ok(listen >= 0 && startHermes > listen);
});

test('serves the Commands cheat-sheet page and module with the expected MIME types', async () => {
  await withServer(webDir, async (port) => {
    const page = await fetch(`http://127.0.0.1:${port}/commands.html`);
    const js = await fetch(`http://127.0.0.1:${port}/commands.js`);

    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') ?? '', /javascript/);
  });
});

test('every page links to the Commands tab', async () => {
  for (const name of ['index.html', 'sessions.html', 'services.html', 'conveyor.html', 'commands.html']) {
    const html = await readFile(join(webDir, name), 'utf8');
    assert.ok(html.includes('href="/commands.html"'), `${name} has no Commands tab link`);
  }
});

// Anti-drift: the cheat sheet is hand-written, so a launcher renamed or dropped in
// launchers.ps1 would leave the page teaching a command that no longer exists.
test('every cc/cx/cg/hz command on the cheat sheet still exists in launchers.ps1', async (t) => {
  // The launchers live only in the private checkout; a public clone has no scripts/claude-accounts.
  const launchersPath = join(webDir, '..', 'scripts', 'claude-accounts', 'launchers.ps1');
  if (!existsSync(launchersPath)) { t.skip('no launchers.ps1 in this checkout'); return; }
  const page = await readFile(join(webDir, 'commands.js'), 'utf8');
  const launchers = await readFile(launchersPath, 'utf8');
  const verbs = [...page.matchAll(/cmd: '([^']+)'/g)]
    .map((m) => (m[1] ?? '').split(/\s+/)[0] ?? '')
    .filter((v) => /^(cc|cx|cg|hz)[a-z0-9]*$/.test(v));

  assert.ok(verbs.length > 25, `expected the cheat sheet to list the launchers, found ${verbs.length}`);
  for (const verb of new Set(verbs)) {
    assert.match(launchers, new RegExp(`^function ${verb} `, 'm'), `launchers.ps1 has no function ${verb}`);
  }
});
