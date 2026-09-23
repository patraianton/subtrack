import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBranch } from '../src/fleet/branch.ts';

async function withTemp(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'subtrack-branch-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('reads the branch of an ordinary checkout', async () => {
  await withTemp(async (dir) => {
    await mkdir(join(dir, '.git'), { recursive: true });
    await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/feat/2385\n', 'utf8');
    assert.equal(await readBranch(dir), 'feat/2385');
  });
});

// Half the fleet is linked worktrees, where .git is a file pointing at the real git dir.
test('follows a worktree .git pointer, absolute or relative', async () => {
  await withTemp(async (dir) => {
    const gitDir = join(dir, 'repo', '.git', 'worktrees', 'lane-1');
    await mkdir(gitDir, { recursive: true });
    await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/lane\n', 'utf8');

    const absolute = join(dir, 'abs');
    await mkdir(absolute, { recursive: true });
    await writeFile(join(absolute, '.git'), `gitdir: ${gitDir}\n`, 'utf8');
    assert.equal(await readBranch(absolute), 'lane');

    const relative = join(dir, 'rel');
    await mkdir(relative, { recursive: true });
    await writeFile(join(relative, '.git'), 'gitdir: ../repo/.git/worktrees/lane-1\n', 'utf8');
    assert.equal(await readBranch(relative), 'lane');
  });
});

test('a detached head shows the short commit, and a non-repo is simply unknown', async () => {
  await withTemp(async (dir) => {
    await mkdir(join(dir, '.git'), { recursive: true });
    await writeFile(join(dir, '.git', 'HEAD'), '3f7a1c2d9e8b4a5c6d7e8f9a0b1c2d3e4f5a6b7c\n', 'utf8');
    assert.equal(await readBranch(dir), '3f7a1c2');

    assert.equal(await readBranch(join(dir, 'nothing-here')), null);
    assert.equal(await readBranch(''), null);
  });
});
