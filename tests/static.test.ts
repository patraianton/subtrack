import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createApp } from '../src/server.ts';
import { SnapshotStore } from '../src/snapshotStore.ts';

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

test('serves index.html at / and app.js with a js mime', async () => {
  const server = createApp(new SnapshotStore(), { webDir, uiRefreshSeconds: 30, pollIntervalSeconds: { claude: 180, codex: 60 } });
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const root = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get('content-type') ?? '', /text\/html/);
    const js = await fetch(`http://127.0.0.1:${port}/app.js`);
    assert.match(js.headers.get('content-type') ?? '', /javascript/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
