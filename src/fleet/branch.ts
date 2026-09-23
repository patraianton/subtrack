import { readFile } from 'node:fs/promises';
import { join, isAbsolute, resolve, dirname } from 'node:path';

/**
 * The checked-out branch of a folder, read straight from `.git` — no `git` process per window,
 * which matters when the page lists sixty of them. A linked worktree has a `.git` *file* pointing
 * at the real git dir, which is exactly the case this surface is full of.
 *
 * Returns the branch name, a short commit id for a detached head, or null when the folder is not
 * a checkout. Never throws: a missing or unreadable repo is simply an unknown branch.
 */
export async function readBranch(cwd: string): Promise<string | null> {
  if (!cwd) return null;
  try {
    const gitDir = await resolveGitDir(cwd);
    if (!gitDir) return null;
    const head = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (ref) return ref[1]!.trim();
    return /^[0-9a-f]{7,40}$/i.test(head) ? head.slice(0, 7) : null;
  } catch {
    return null;
  }
}

async function resolveGitDir(cwd: string): Promise<string | null> {
  const dotGit = join(cwd, '.git');
  let raw: string;
  try {
    raw = await readFile(dotGit, 'utf8');   // a file only in a linked worktree or a submodule
  } catch (e) {
    // EISDIR means the ordinary case: .git is the directory itself.
    return (e as NodeJS.ErrnoException).code === 'EISDIR' ? dotGit : null;
  }
  const pointer = /^gitdir:\s*(.+)$/m.exec(raw);
  if (!pointer) return null;
  const target = pointer[1]!.trim();
  return isAbsolute(target) ? target : resolve(dirname(dotGit), target);
}
