import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { HerdrPane, HerdrWorkspace } from './types.ts';

export type HerdrResult = { code: number; stdout: string; stderr: string };
export type HerdrRunner = (args: string[]) => Promise<HerdrResult>;

const HERDR_TIMEOUT_MS = 15_000;

/** Installed launcher first, bare name second, so a herdr on PATH still works. */
export function herdrCandidates(base: string): string[] {
  const installed = join(base, 'AppData', 'Local', 'Programs', 'Herdr', 'bin', 'herdr.exe');
  return [process.env.HERDR_BIN || installed, 'herdr'];
}

export function makeHerdrRunner(base: string): HerdrRunner {
  const candidates = herdrCandidates(base);
  return async (args) => {
    let last: HerdrResult = { code: 1, stdout: '', stderr: 'herdr not run' };
    for (const bin of candidates) {
      last = await runOnce(bin, args);
      if (last.code === 0 || !/ENOENT/i.test(last.stderr)) return last;
    }
    return last;
  };
}

function runOnce(bin: string, args: string[]): Promise<HerdrResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = '', stderr = '', settled = false, timedOut = false;
    const finish = (r: HerdrResult): void => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, HERDR_TIMEOUT_MS);
    timer.unref();
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => finish({ code: code ?? 1, stdout, stderr: timedOut ? 'herdr timed out' : stderr }));
    child.on('error', (e) => finish({ code: 1, stdout, stderr: String(e) }));
  });
}

/**
 * `herdr pane list` prints one JSON envelope, but older builds put banner lines in front of it,
 * so the payload is located by its envelope id rather than by parsing the whole stream.
 */
export function parsePanes(stdout: string): HerdrPane[] {
  const at = stdout.indexOf('{"id":"cli:pane:list"');
  if (at < 0) return [];
  let parsed: { result?: { panes?: unknown[] } };
  try { parsed = JSON.parse(stdout.slice(at).replace(/\r?\n/g, '')); } catch { return []; }
  const panes = Array.isArray(parsed.result?.panes) ? parsed.result!.panes! : [];
  const out: HerdrPane[] = [];
  for (const p of panes) {
    if (!p || typeof p !== 'object') continue;
    const r = p as Record<string, unknown>;
    const paneId = typeof r.pane_id === 'string' ? r.pane_id : '';
    if (!paneId) continue;
    const session = r.agent_session as { value?: unknown } | undefined;
    out.push({
      paneId,
      workspaceId: typeof r.workspace_id === 'string' ? r.workspace_id : null,
      tabId: typeof r.tab_id === 'string' ? r.tab_id : null,
      agent: typeof r.agent === 'string' ? r.agent : '',
      agentStatus: typeof r.agent_status === 'string' ? r.agent_status : 'unknown',
      cwd: typeof r.cwd === 'string' ? r.cwd : '',
      sessionId: typeof session?.value === 'string' ? session.value : null,
      title: typeof r.terminal_title_stripped === 'string' ? r.terminal_title_stripped : null,
      focused: r.focused === true,
    });
  }
  return out;
}

/**
 * `herdr workspace list` carries what the pane list does not: the sidebar order (`number`), the
 * name the operator reads, and the worktree block that ties linked checkouts to their repo.
 * Windows paths come back in the extended `\\?\` form, which is stripped so they compare.
 */
export function parseWorkspaces(stdout: string): HerdrWorkspace[] {
  const at = stdout.indexOf('{"id":"cli:workspace:list"');
  if (at < 0) return [];
  let parsed: { result?: { workspaces?: unknown[] } };
  try { parsed = JSON.parse(stdout.slice(at).replace(/\r?\n/g, '')); } catch { return []; }
  const rows = Array.isArray(parsed.result?.workspaces) ? parsed.result!.workspaces! : [];
  const out: HerdrWorkspace[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const workspaceId = typeof r.workspace_id === 'string' ? r.workspace_id : '';
    if (!workspaceId) continue;
    const tree = (r.worktree ?? null) as Record<string, unknown> | null;
    const key = typeof tree?.repo_key === 'string' ? tree.repo_key
      : typeof tree?.repo_root === 'string' ? tree.repo_root : null;
    out.push({
      workspaceId,
      number: typeof r.number === 'number' ? r.number : Number.MAX_SAFE_INTEGER,
      label: typeof r.label === 'string' ? r.label : '',
      focused: r.focused === true,
      repoKey: key ? key.replace(/^\\\\\?\\/, '').toLowerCase() : null,
      repoName: typeof tree?.repo_name === 'string' ? tree.repo_name : null,
      isWorktree: tree?.is_linked_worktree === true,
    });
  }
  return out;
}

export async function listWorkspaces(run: HerdrRunner): Promise<HerdrWorkspace[]> {
  const r = await run(['workspace', 'list']);
  return r.code === 0 ? parseWorkspaces(r.stdout) : [];
}

export async function listPanes(run: HerdrRunner): Promise<{ panes: HerdrPane[]; warning: string | null }> {
  const r = await run(['pane', 'list']);
  if (r.code !== 0) return { panes: [], warning: `herdr pane list failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}` };
  const panes = parsePanes(r.stdout);
  if (panes.length === 0) return { panes, warning: 'herdr returned no panes' };
  return { panes, warning: null };
}
