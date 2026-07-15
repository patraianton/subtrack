# Ops-Cockpit Phase 1 (Services) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live **Services** view to the subtrack dashboard that shows every must-run service and whether it is healthy right now, plus detects untracked long-runners — so a reboot becomes a non-event.

**Architecture:** Extend the existing subtrack HTTP server (`127.0.0.1:7777`) with a new `GET /api/services` endpoint backed by isolated code under `src/ops/`. All work runs **on demand per request** (with a ~10s cache), never in the always-on usage poller. A pure prober derives each service's status from a system snapshot gathered via one PowerShell call; the web layer adds a separate `/services.html` page linked from a shared nav.

**Tech Stack:** Node 24 + TypeScript executed by `tsx` (no build step), `node:test` + `node:assert/strict`, `node:child_process` (`powershell.exe`), vanilla HTML/CSS/JS. No new dependencies.

## Global Constraints

Every task's requirements implicitly include these (copied from the spec + repo CLAUDE.md):

- **No new runtime dependencies.** Only `@napi-rs/keyring` and `open` are allowed; use Node built-ins for everything else.
- **Explicit `.ts` import extensions** in all source imports (e.g. `import { probeService } from './probe.ts'`). `tsx` runs the sources directly; there is no compiled output.
- **Loopback only.** Any HTTP probe targets `127.0.0.1` (never `localhost` — on Windows it resolves to `::1` first).
- **On-demand, never in the poller.** Nothing in `src/ops/` may run inside `Poller`/`SnapshotStore`. The route handler is the only caller.
- **Read config fresh per request.** `services.json` is loaded on each `/api/services` call (unlike `accounts.json`, read once at startup) so UI edits take effect without a restart.
- **Dependency-inject exec, fs, clock.** Probing/gathering functions accept injected runners/fetch/`now` so tests never touch the real system. Tests mirror `src/` under `tests/` and use `node:test` + `assert/strict`.
- **Never fake unknown data.** When a probe can't determine a value, surface `unknown` / `null` — never a misleading placeholder (mirrors the repo's `resetsAt = null` discipline).
- **Static gate:** `npm run typecheck` (`tsc --noEmit`) must pass; there is no linter.
- **PowerShell invocation pattern:** spawn `powershell.exe` with `['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]` and `{ windowsHide: true }`, exactly as `src/install.ts` `runPwsh` does.

---

## File Structure

**New files (`src/ops/`):**
- `src/ops/types.ts` — all Phase-1 types (`ServiceDef`, `SystemState`, `ServiceHealth`, `UntrackedRunner`, `ServicesResponse`). One responsibility: the shared contract.
- `src/ops/probe.ts` — pure status derivation: `probeService(def, sys, httpOk)` → `ServiceHealth`. No I/O. The heavily-tested heart.
- `src/ops/windows.ts` — injectable `PwshRunner` + default `runPwsh`; `gatherSystemState(run, now)` runs one PowerShell script emitting JSON and parses it into `SystemState`.
- `src/ops/httpProbe.ts` — `probeHttp(port, path, timeoutMs, fetchImpl?)` → `boolean | undefined`.
- `src/ops/config.ts` — `servicesPath`, `loadServices`, `saveServices` (mirrors `src/config.ts`).
- `src/ops/seed.ts` — pure `seedServices(sys)` → `ServiceDef[]`; `ensureServices(base, sys)` writes the file if absent.
- `src/ops/services.ts` — `getServices(base, deps)` orchestrator with a ~10s cache.

**Modified files:**
- `src/server.ts` — add `GET /api/services` route + wire the real provider in `serve()`.
- `web/index.html` — add the shared nav (`Usage · Services · Projects`).
- `web/styles.css` — nav + service-status styles (reuse severity colors).

**New web files:**
- `web/services.html` — the Services page shell.
- `web/services.js` — fetches `/api/services`, exports a pure `renderServices(data, now)`.

**New test files:** `tests/ops/probe.test.ts`, `tests/ops/windows.test.ts`, `tests/ops/httpProbe.test.ts`, `tests/ops/config.test.ts`, `tests/ops/seed.test.ts`, `tests/ops/services.test.ts`, `tests/server.services.test.ts`, `tests/web/services.test.ts`.

---

## Task 1: Types + pure service prober

**Files:**
- Create: `src/ops/types.ts`
- Create: `src/ops/probe.ts`
- Test: `tests/ops/probe.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - Types in `src/ops/types.ts` (exact shapes below).
  - `probeService(def: ServiceDef, sys: SystemState, httpOk?: boolean): ServiceHealth`

- [ ] **Step 1: Create the types file**

Create `src/ops/types.ts`:

```ts
export type ServiceKind = 'task' | 'process' | 'port' | 'http';
export type ServiceStatus = 'up' | 'down' | 'degraded' | 'unknown';

export interface ServiceDef {
  id: string;
  label: string;
  kind: ServiceKind;
  taskName?: string;   // for kind 'task' + restart
  port?: number;       // for kind 'port' / 'http', or as a health signal for a 'task'
  httpPath?: string;   // for kind 'http'
  match?: string;      // JS regex source, tested against a process's name and cmd
  startCmd?: string;   // how to (re)start when unregistered (Phase 1: stored only)
  cwd?: string;
  alwaysOn: boolean;   // expected continuously up (red when down) vs periodic
  group?: string;
}

export interface TaskState {
  name: string;
  state: string;               // 'Running' | 'Ready' | 'Disabled' | ...
  lastResult: number | null;   // Get-ScheduledTaskInfo LastTaskResult (0 = ok)
  lastRun: string | null;
  nextRun: string | null;
}

export interface ProcInfo { pid: number; name: string; cmd: string }

export interface SystemState {
  tasks: TaskState[];
  ports: number[];       // listening loopback ports
  processes: ProcInfo[];
  now: number;           // ms epoch (injected clock)
}

export interface ServiceHealth extends ServiceDef {
  status: ServiceStatus;
  detail: string;              // one-line human reason
  pid: number | null;
  lastRun: string | null;
  nextRun: string | null;
}

export interface UntrackedRunner {
  kind: 'port' | 'process';
  port: number | null;
  pid: number;
  name: string;
  cmd: string;
}

export interface ServicesResponse {
  services: ServiceHealth[];
  untracked: UntrackedRunner[];
  generatedAt: string;         // ISO
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/ops/probe.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeService } from '../../src/ops/probe.ts';
import type { ServiceDef, SystemState } from '../../src/ops/types.ts';

const NOW = Date.parse('2026-07-15T09:00:00Z');
const emptySys: SystemState = { tasks: [], ports: [], processes: [], now: NOW };

function def(over: Partial<ServiceDef>): ServiceDef {
  return { id: 'x', label: 'X', kind: 'port', alwaysOn: true, ...over };
}

test('port kind: up when the port is listening', () => {
  const sys: SystemState = { ...emptySys, ports: [7777] };
  const h = probeService(def({ kind: 'port', port: 7777 }), sys);
  assert.equal(h.status, 'up');
});

test('port kind: down when the port is not listening', () => {
  const h = probeService(def({ kind: 'port', port: 7777 }), emptySys);
  assert.equal(h.status, 'down');
});

test('http kind: up when httpOk is true', () => {
  const sys: SystemState = { ...emptySys, ports: [7777] };
  const h = probeService(def({ kind: 'http', port: 7777, httpPath: '/api/health' }), sys, true);
  assert.equal(h.status, 'up');
});

test('http kind: degraded when port listens but http fails', () => {
  const sys: SystemState = { ...emptySys, ports: [7777] };
  const h = probeService(def({ kind: 'http', port: 7777, httpPath: '/api/health' }), sys, false);
  assert.equal(h.status, 'degraded');
});

test('http kind: down when neither port nor http answers', () => {
  const h = probeService(def({ kind: 'http', port: 7777, httpPath: '/api/health' }), emptySys, false);
  assert.equal(h.status, 'down');
});

test('http kind: unknown when the probe errored (httpOk undefined)', () => {
  const sys: SystemState = { ...emptySys, ports: [7777] };
  const h = probeService(def({ kind: 'http', port: 7777, httpPath: '/api/health' }), sys, undefined);
  assert.equal(h.status, 'unknown');
});

test('process kind: up with pid when a process matches (name or cmd)', () => {
  const sys: SystemState = { ...emptySys, processes: [{ pid: 42, name: 'pythonw', cmd: 'pythonw hermes gateway designbot' }] };
  const h = probeService(def({ kind: 'process', match: 'hermes.*designbot' }), sys);
  assert.equal(h.status, 'up');
  assert.equal(h.pid, 42);
});

test('process kind: down when nothing matches', () => {
  const h = probeService(def({ kind: 'process', match: 'nope' }), emptySys);
  assert.equal(h.status, 'down');
});

test('task kind: down when the task is not registered', () => {
  const h = probeService(def({ kind: 'task', taskName: 'ghost' }), emptySys);
  assert.equal(h.status, 'down');
  assert.match(h.detail, /not registered/);
});

test('task kind: down when the task is disabled', () => {
  const sys: SystemState = { ...emptySys, tasks: [{ name: 't', state: 'Disabled', lastResult: 0, lastRun: null, nextRun: null }] };
  const h = probeService(def({ kind: 'task', taskName: 't' }), sys);
  assert.equal(h.status, 'down');
});

test('task kind: degraded when the last run failed', () => {
  const sys: SystemState = { ...emptySys, tasks: [{ name: 't', state: 'Ready', lastResult: 1, lastRun: '2026-07-15', nextRun: null }] };
  const h = probeService(def({ kind: 'task', taskName: 't' }), sys);
  assert.equal(h.status, 'degraded');
});

test('always-on task with a port: up when the port listens, degraded when it does not', () => {
  const base = def({ kind: 'task', taskName: 't', port: 7777, alwaysOn: true });
  const t = { name: 't', state: 'Ready', lastResult: 0, lastRun: '2026-07-15', nextRun: null };
  assert.equal(probeService(base, { ...emptySys, tasks: [t], ports: [7777] }).status, 'up');
  assert.equal(probeService(base, { ...emptySys, tasks: [t], ports: [] }).status, 'degraded');
});

test('periodic task (alwaysOn=false): Ready + last ok is up, ignoring ports', () => {
  const sys: SystemState = { ...emptySys, tasks: [{ name: 'hc', state: 'Ready', lastResult: 0, lastRun: '2026-07-15', nextRun: '2026-07-16' }] };
  const h = probeService(def({ kind: 'task', taskName: 'hc', port: 9999, alwaysOn: false }), sys);
  assert.equal(h.status, 'up');
});

test('running task is up', () => {
  const sys: SystemState = { ...emptySys, tasks: [{ name: 't', state: 'Running', lastResult: 0, lastRun: '2026-07-15', nextRun: null }] };
  assert.equal(probeService(def({ kind: 'task', taskName: 't' }), sys).status, 'up');
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --import tsx --test tests/ops/probe.test.ts`
Expected: FAIL — `Cannot find module '../../src/ops/probe.ts'`.

- [ ] **Step 4: Implement the prober**

Create `src/ops/probe.ts`:

```ts
import type { ServiceDef, ServiceHealth, ServiceStatus, SystemState, TaskState, ProcInfo } from './types.ts';

function matchProc(match: string | undefined, processes: ProcInfo[]): ProcInfo | undefined {
  if (!match) return undefined;
  let re: RegExp;
  try { re = new RegExp(match, 'i'); } catch { return undefined; }
  return processes.find((p) => re.test(p.name) || re.test(p.cmd));
}

function health(def: ServiceDef, status: ServiceStatus, detail: string, extra: Partial<ServiceHealth> = {}): ServiceHealth {
  return { ...def, status, detail, pid: null, lastRun: null, nextRun: null, ...extra };
}

function probeTask(def: ServiceDef, sys: SystemState): ServiceHealth {
  const t: TaskState | undefined = sys.tasks.find((x) => x.name === def.taskName);
  if (!t) return health(def, 'down', `task "${def.taskName}" not registered`);
  const base = { lastRun: t.lastRun, nextRun: t.nextRun };
  if (t.state === 'Disabled') return health(def, 'down', 'task disabled', base);
  if (t.lastResult !== null && t.lastResult !== 0) {
    return health(def, 'degraded', `last run failed (0x${t.lastResult.toString(16).toUpperCase()})`, base);
  }
  if (def.alwaysOn && def.port !== undefined) {
    return sys.ports.includes(def.port)
      ? health(def, 'up', `task ${t.state}, listening :${def.port}`, base)
      : health(def, 'degraded', `task ${t.state} but nothing on :${def.port}`, base);
  }
  if (def.alwaysOn && def.match) {
    const p = matchProc(def.match, sys.processes);
    return p
      ? health(def, 'up', `task ${t.state}, process ${p.pid}`, { ...base, pid: p.pid })
      : health(def, 'degraded', `task ${t.state} but no matching process`, base);
  }
  return health(def, 'up', `task ${t.state}`, base);
}

export function probeService(def: ServiceDef, sys: SystemState, httpOk?: boolean): ServiceHealth {
  switch (def.kind) {
    case 'port': {
      const on = def.port !== undefined && sys.ports.includes(def.port);
      return on ? health(def, 'up', `listening :${def.port}`) : health(def, 'down', `nothing on :${def.port}`);
    }
    case 'http': {
      if (httpOk === true) return health(def, 'up', `http 2xx on :${def.port}${def.httpPath ?? ''}`);
      const listening = def.port !== undefined && sys.ports.includes(def.port);
      if (httpOk === undefined) return health(def, 'unknown', 'http probe errored');
      return listening
        ? health(def, 'degraded', `:${def.port} listening but ${def.httpPath ?? '/'} not 2xx`)
        : health(def, 'down', `no http on :${def.port}`);
    }
    case 'process': {
      const p = matchProc(def.match, sys.processes);
      return p ? health(def, 'up', `process ${p.pid} (${p.name})`, { pid: p.pid }) : health(def, 'down', 'no matching process');
    }
    case 'task':
      return probeTask(def, sys);
    default:
      return health(def, 'unknown', `unknown kind "${(def as ServiceDef).kind}"`);
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --import tsx --test tests/ops/probe.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/ops/types.ts src/ops/probe.ts tests/ops/probe.test.ts
git commit -m "feat(ops): pure service prober + shared types"
```

---

## Task 2: PowerShell system-state gatherer

**Files:**
- Create: `src/ops/windows.ts`
- Test: `tests/ops/windows.test.ts`

**Interfaces:**
- Consumes: `SystemState`, `TaskState`, `ProcInfo` from `./types.ts`.
- Produces:
  - `type PwshRunner = (script: string) => Promise<{ code: number; stdout: string; stderr: string }>`
  - `export const runPwsh: PwshRunner` (real spawn; used in `serve()`)
  - `export const SYSTEM_STATE_SCRIPT: string` (the PowerShell that emits one JSON blob)
  - `export function parseSystemState(stdout: string, now: number): SystemState`
  - `export async function gatherSystemState(run: PwshRunner, now: number): Promise<SystemState>`

- [ ] **Step 1: Write the failing tests**

Create `tests/ops/windows.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystemState, gatherSystemState } from '../../src/ops/windows.ts';

const NOW = Date.parse('2026-07-15T09:00:00Z');

const SAMPLE = JSON.stringify({
  tasks: [
    { name: 'subtrack-dashboard', state: 'Ready', lastResult: 0, lastRun: '2026-07-15T08:07:00', nextRun: null },
    { name: 'radar_healthcheck', state: 'Ready', lastResult: 267011, lastRun: '2026-07-15T08:00:00', nextRun: '2026-07-15T09:00:00' },
  ],
  ports: [7777, 11434],
  processes: [{ pid: 21240, name: 'node', cmd: 'node serve' }],
});

test('parseSystemState maps the JSON blob into SystemState', () => {
  const sys = parseSystemState(SAMPLE, NOW);
  assert.equal(sys.now, NOW);
  assert.equal(sys.tasks.length, 2);
  assert.equal(sys.tasks[0]!.name, 'subtrack-dashboard');
  assert.equal(sys.tasks[1]!.lastResult, 267011);
  assert.deepEqual(sys.ports, [7777, 11434]);
  assert.equal(sys.processes[0]!.pid, 21240);
});

test('parseSystemState tolerates a single-object (non-array) tasks field from ConvertTo-Json', () => {
  // PowerShell ConvertTo-Json emits a bare object (not a 1-element array) for single items.
  const one = JSON.stringify({ tasks: { name: 't', state: 'Ready', lastResult: 0, lastRun: null, nextRun: null }, ports: 7777, processes: {} });
  const sys = parseSystemState(one, NOW);
  assert.equal(sys.tasks.length, 1);
  assert.deepEqual(sys.ports, [7777]);
  assert.equal(sys.processes.length, 0); // empty object -> dropped
});

test('gatherSystemState feeds runner stdout through the parser', async () => {
  const run = async () => ({ code: 0, stdout: SAMPLE, stderr: '' });
  const sys = await gatherSystemState(run, NOW);
  assert.equal(sys.ports.length, 2);
});

test('gatherSystemState returns an empty snapshot when PowerShell fails', async () => {
  const run = async () => ({ code: 1, stdout: '', stderr: 'boom' });
  const sys = await gatherSystemState(run, NOW);
  assert.deepEqual(sys, { tasks: [], ports: [], processes: [], now: NOW });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test tests/ops/windows.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the gatherer**

Create `src/ops/windows.ts`:

```ts
import { spawn } from 'node:child_process';
import type { SystemState, TaskState, ProcInfo } from './types.ts';

export type PwshResult = { code: number; stdout: string; stderr: string };
export type PwshRunner = (script: string) => Promise<PwshResult>;

/** Real PowerShell runner — same invocation shape as src/install.ts. */
export const runPwsh: PwshRunner = (script) =>
  new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (c) => resolve({ code: c ?? 0, stdout, stderr }));
    child.on('error', (e) => resolve({ code: 1, stdout, stderr: String(e) }));
  });

/**
 * One PowerShell round-trip that emits a single JSON blob: user (non-Microsoft) scheduled tasks
 * with their run info, listening loopback ports, and running processes with command lines.
 * `-Compress` keeps it one line; `-Depth 4` is plenty for these flat shapes.
 */
export const SYSTEM_STATE_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$tasks = Get-ScheduledTask | Where-Object { $_.TaskPath -notlike '\\Microsoft\\*' } | ForEach-Object {
  $i = Get-ScheduledTaskInfo -TaskName $_.TaskName -TaskPath $_.TaskPath
  [pscustomobject]@{ name=$_.TaskName; state=[string]$_.State; lastResult=$i.LastTaskResult; lastRun=(($i.LastRunTime) -as [string]); nextRun=(($i.NextRunTime) -as [string]) }
}
$ports = Get-NetTCPConnection -State Listen |
  Where-Object { $_.LocalAddress -in '127.0.0.1','0.0.0.0','::1','::' -and $_.LocalPort -lt 50000 } |
  Select-Object -ExpandProperty LocalPort | Sort-Object -Unique
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='python.exe' OR Name='pythonw.exe'" |
  ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; name=($_.Name -replace '\\.exe$',''); cmd=[string]$_.CommandLine } }
[pscustomobject]@{ tasks=@($tasks); ports=@($ports); processes=@($procs) } | ConvertTo-Json -Depth 4 -Compress
`;

function asArray<T>(v: T | T[] | null | undefined): T[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export function parseSystemState(stdout: string, now: number): SystemState {
  let raw: { tasks?: unknown; ports?: unknown; processes?: unknown };
  try { raw = JSON.parse(stdout); } catch { return { tasks: [], ports: [], processes: [], now }; }
  const tasks = asArray(raw.tasks as TaskState | TaskState[])
    .filter((t): t is TaskState => !!t && typeof (t as TaskState).name === 'string')
    .map((t) => ({ name: t.name, state: t.state, lastResult: t.lastResult ?? null, lastRun: t.lastRun ?? null, nextRun: t.nextRun ?? null }));
  const ports = asArray(raw.ports as number | number[]).filter((n): n is number => typeof n === 'number');
  const processes = asArray(raw.processes as ProcInfo | ProcInfo[])
    .filter((p): p is ProcInfo => !!p && typeof (p as ProcInfo).pid === 'number')
    .map((p) => ({ pid: p.pid, name: p.name ?? '', cmd: p.cmd ?? '' }));
  return { tasks, ports, processes, now };
}

export async function gatherSystemState(run: PwshRunner, now: number): Promise<SystemState> {
  const r = await run(SYSTEM_STATE_SCRIPT);
  if (r.code !== 0) return { tasks: [], ports: [], processes: [], now };
  return parseSystemState(r.stdout, now);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test tests/ops/windows.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/ops/windows.ts tests/ops/windows.test.ts
git commit -m "feat(ops): PowerShell system-state gatherer (tasks/ports/processes -> JSON)"
```

---

## Task 3: HTTP health probe

**Files:**
- Create: `src/ops/httpProbe.ts`
- Test: `tests/ops/httpProbe.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `probeHttp(port: number, path: string, timeoutMs?: number, fetchImpl?: typeof fetch): Promise<boolean | undefined>` — `true` = 2xx, `false` = reached but non-2xx, `undefined` = transport error / timeout.

- [ ] **Step 1: Write the failing tests**

Create `tests/ops/httpProbe.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeHttp } from '../../src/ops/httpProbe.ts';

test('returns true on a 2xx response', async () => {
  const fake = async () => ({ ok: true, status: 200 }) as Response;
  assert.equal(await probeHttp(7777, '/api/health', 500, fake), true);
});

test('returns false on a non-2xx response', async () => {
  const fake = async () => ({ ok: false, status: 500 }) as Response;
  assert.equal(await probeHttp(7777, '/api/health', 500, fake), false);
});

test('returns undefined when the fetch throws (transport error/timeout)', async () => {
  const fake = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal(await probeHttp(7777, '/api/health', 500, fake), undefined);
});

test('targets 127.0.0.1 (never localhost)', async () => {
  let seen = '';
  const fake = async (url: string | URL) => { seen = String(url); return { ok: true, status: 204 } as Response; };
  await probeHttp(7777, '/api/health', 500, fake as typeof fetch);
  assert.match(seen, /^http:\/\/127\.0\.0\.1:7777\/api\/health$/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test tests/ops/httpProbe.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the probe**

Create `src/ops/httpProbe.ts`:

```ts
export async function probeHttp(
  port: number,
  path: string,
  timeoutMs = 1500,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean | undefined> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}${path}`, { signal: ctrl.signal });
    return res.ok; // 2xx
  } catch {
    return undefined; // transport error or timeout — genuinely unknown, not "down"
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test tests/ops/httpProbe.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/ops/httpProbe.ts tests/ops/httpProbe.test.ts
git commit -m "feat(ops): loopback http health probe with timeout"
```

---

## Task 4: Services config (load/save)

**Files:**
- Create: `src/ops/config.ts`
- Test: `tests/ops/config.test.ts`

**Interfaces:**
- Consumes: `ServiceDef` from `./types.ts`; reuses `configDir` from `../config.ts`.
- Produces:
  - `servicesPath(base?: string): string` → `<base>/.subtrack/services.json`
  - `loadServices(base?: string): Promise<ServiceDef[]>` (returns `[]` when the file is missing)
  - `saveServices(defs: ServiceDef[], base?: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `tests/ops/config.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { servicesPath, loadServices, saveServices } from '../../src/ops/config.ts';
import type { ServiceDef } from '../../src/ops/types.ts';

async function withTempBase(fn: (base: string) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), 'subtrack-ops-'));
  try { await fn(base); } finally { await rm(base, { recursive: true, force: true }); }
}

test('servicesPath lives under <base>/.subtrack/services.json', () => {
  assert.match(servicesPath('/home/x'), /[\\/]\.subtrack[\\/]services\.json$/);
});

test('loadServices returns [] when the file is missing', async () => {
  await withTempBase(async (base) => {
    assert.deepEqual(await loadServices(base), []);
  });
});

test('saveServices then loadServices round-trips', async () => {
  await withTempBase(async (base) => {
    const defs: ServiceDef[] = [{ id: 'subtrack', label: 'Dashboard', kind: 'http', port: 7777, httpPath: '/api/health', alwaysOn: true, group: 'subtrack' }];
    await saveServices(defs, base);
    const back = await loadServices(base);
    assert.equal(back.length, 1);
    assert.equal(back[0]!.port, 7777);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test tests/ops/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the config module**

Create `src/ops/config.ts`:

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { configDir } from '../config.ts';
import type { ServiceDef } from './types.ts';

export function servicesPath(base: string = homedir()): string {
  return join(configDir(base), 'services.json');
}

export async function loadServices(base: string = homedir()): Promise<ServiceDef[]> {
  try {
    const raw = await readFile(servicesPath(base), 'utf8');
    const parsed = JSON.parse(raw) as { services?: ServiceDef[] };
    return Array.isArray(parsed.services) ? parsed.services : [];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

export async function saveServices(defs: ServiceDef[], base: string = homedir()): Promise<void> {
  await mkdir(configDir(base), { recursive: true });
  await writeFile(servicesPath(base), JSON.stringify({ version: 1, services: defs }, null, 2), 'utf8');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test tests/ops/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/ops/config.ts tests/ops/config.test.ts
git commit -m "feat(ops): services.json load/save"
```

---

## Task 5: Auto-seed the manifest from the system snapshot

**Files:**
- Create: `src/ops/seed.ts`
- Test: `tests/ops/seed.test.ts`

**Interfaces:**
- Consumes: `SystemState`, `ServiceDef` from `./types.ts`; `loadServices`, `saveServices` from `./config.ts`.
- Produces:
  - `seedServices(sys: SystemState): ServiceDef[]` — pure.
  - `ensureServices(base: string, sys: SystemState): Promise<ServiceDef[]>` — returns existing defs if the file has any; otherwise seeds from `sys`, saves, and returns them.

- [ ] **Step 1: Write the failing tests**

Create `tests/ops/seed.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedServices, ensureServices } from '../../src/ops/seed.ts';
import { saveServices, loadServices } from '../../src/ops/config.ts';
import type { SystemState } from '../../src/ops/types.ts';

const NOW = Date.parse('2026-07-15T09:00:00Z');
const sys: SystemState = {
  now: NOW,
  tasks: [
    { name: 'subtrack-dashboard', state: 'Ready', lastResult: 0, lastRun: null, nextRun: null },
    { name: 'radar_healthcheck', state: 'Ready', lastResult: 0, lastRun: null, nextRun: '2026-07-15T10:00:00' },
  ],
  ports: [7777],
  processes: [{ pid: 1, name: 'node', cmd: 'node serve' }],
};

test('seedServices makes one task-kind def per scheduled task', () => {
  const defs = seedServices(sys);
  const ids = defs.map((d) => d.id);
  assert.ok(ids.includes('subtrack-dashboard'));
  assert.ok(ids.includes('radar_healthcheck'));
  assert.equal(defs.find((d) => d.id === 'subtrack-dashboard')!.kind, 'task');
});

test('seedServices marks *_healthcheck / *_summary tasks as periodic (alwaysOn=false)', () => {
  const defs = seedServices(sys);
  assert.equal(defs.find((d) => d.id === 'radar_healthcheck')!.alwaysOn, false);
  assert.equal(defs.find((d) => d.id === 'subtrack-dashboard')!.alwaysOn, true);
});

async function withTempBase(fn: (base: string) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), 'subtrack-seed-'));
  try { await fn(base); } finally { await rm(base, { recursive: true, force: true }); }
}

test('ensureServices seeds and persists when the file is absent', async () => {
  await withTempBase(async (base) => {
    const defs = await ensureServices(base, sys);
    assert.ok(defs.length >= 2);
    assert.ok((await loadServices(base)).length >= 2); // persisted
  });
});

test('ensureServices leaves an existing manifest untouched', async () => {
  await withTempBase(async (base) => {
    await saveServices([{ id: 'only', label: 'Only', kind: 'port', port: 1, alwaysOn: true }], base);
    const defs = await ensureServices(base, sys);
    assert.deepEqual(defs.map((d) => d.id), ['only']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test tests/ops/seed.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the seeder**

Create `src/ops/seed.ts`:

```ts
import type { ServiceDef, SystemState } from './types.ts';
import { loadServices, saveServices } from './config.ts';

const PERIODIC = /(_healthcheck|_summary|-summary|healthcheck|refresh)/i;

/** Build a first-pass manifest from what is already scheduled. One task -> one def. */
export function seedServices(sys: SystemState): ServiceDef[] {
  return sys.tasks.map((t) => ({
    id: t.name,
    label: t.name,
    kind: 'task' as const,
    taskName: t.name,
    alwaysOn: !PERIODIC.test(t.name),
    group: t.name.split(/[-_]/)[0] || undefined,
  }));
}

export async function ensureServices(base: string, sys: SystemState): Promise<ServiceDef[]> {
  const existing = await loadServices(base);
  if (existing.length > 0) return existing;
  const seeded = seedServices(sys);
  await saveServices(seeded, base);
  return seeded;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test tests/ops/seed.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/ops/seed.ts tests/ops/seed.test.ts
git commit -m "feat(ops): auto-seed services manifest from scheduled tasks"
```

---

## Task 6: Services orchestrator (with cache + untracked detection)

**Files:**
- Create: `src/ops/services.ts`
- Test: `tests/ops/services.test.ts`

**Interfaces:**
- Consumes: `gatherSystemState`/`PwshRunner` from `./windows.ts`, `probeHttp` from `./httpProbe.ts`, `probeService` from `./probe.ts`, `ensureServices` from `./seed.ts`, types from `./types.ts`.
- Produces:
  ```ts
  export interface ServicesDeps {
    base: string;
    run: PwshRunner;               // system-state gatherer input
    httpProbe?: typeof probeHttp;  // defaults to the real one
    now?: () => number;            // defaults to Date.now
    cacheMs?: number;              // defaults to 10_000
  }
  export function makeGetServices(deps: ServicesDeps): () => Promise<ServicesResponse>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/ops/services.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeGetServices } from '../../src/ops/services.ts';
import { saveServices } from '../../src/ops/config.ts';

const SAMPLE = JSON.stringify({
  tasks: [{ name: 'subtrack-dashboard', state: 'Ready', lastResult: 0, lastRun: null, nextRun: null }],
  ports: [7777, 9999],
  processes: [{ pid: 5, name: 'node', cmd: 'node ghost-runner.js' }],
});

async function withTempBase(fn: (base: string) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), 'subtrack-svc-'));
  try { await fn(base); } finally { await rm(base, { recursive: true, force: true }); }
}

test('probes each configured service and returns health', async () => {
  await withTempBase(async (base) => {
    await saveServices([{ id: 'dash', label: 'Dash', kind: 'http', port: 7777, httpPath: '/api/health', alwaysOn: true }], base);
    const get = makeGetServices({
      base,
      run: async () => ({ code: 0, stdout: SAMPLE, stderr: '' }),
      httpProbe: async () => true,
      now: () => 1,
    });
    const res = await get();
    assert.equal(res.services.length, 1);
    assert.equal(res.services[0]!.status, 'up');
  });
});

test('detects untracked runners (a listening port with no service claiming it)', async () => {
  await withTempBase(async (base) => {
    await saveServices([{ id: 'dash', label: 'Dash', kind: 'port', port: 7777, alwaysOn: true }], base);
    const get = makeGetServices({ base, run: async () => ({ code: 0, stdout: SAMPLE, stderr: '' }), httpProbe: async () => true, now: () => 1 });
    const res = await get();
    // :9999 is listening but no def references it -> untracked.
    assert.ok(res.untracked.some((u) => u.port === 9999));
  });
});

test('caches within cacheMs (the gatherer runs once for two quick calls)', async () => {
  await withTempBase(async (base) => {
    await saveServices([{ id: 'dash', label: 'Dash', kind: 'port', port: 7777, alwaysOn: true }], base);
    let runs = 0;
    const get = makeGetServices({
      base,
      run: async () => { runs++; return { code: 0, stdout: SAMPLE, stderr: '' }; },
      httpProbe: async () => true,
      now: () => 1000,      // constant clock -> both calls inside the window
      cacheMs: 10_000,
    });
    await get(); await get();
    assert.equal(runs, 1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test tests/ops/services.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the orchestrator**

Create `src/ops/services.ts`:

```ts
import type { ServiceDef, ServiceHealth, ServicesResponse, SystemState, UntrackedRunner } from './types.ts';
import { gatherSystemState, type PwshRunner } from './windows.ts';
import { probeHttp } from './httpProbe.ts';
import { probeService } from './probe.ts';
import { ensureServices } from './seed.ts';

export interface ServicesDeps {
  base: string;
  run: PwshRunner;
  httpProbe?: typeof probeHttp;
  now?: () => number;
  cacheMs?: number;
}

function untrackedRunners(defs: ServiceDef[], sys: SystemState): UntrackedRunner[] {
  const claimedPorts = new Set(defs.map((d) => d.port).filter((p): p is number => p !== undefined));
  const out: UntrackedRunner[] = [];
  for (const port of sys.ports) {
    if (claimedPorts.has(port)) continue;
    const owner = sys.processes.find((p) => p.cmd.includes(`:${port}`)); // best-effort
    out.push({ kind: 'port', port, pid: owner?.pid ?? -1, name: owner?.name ?? '', cmd: owner?.cmd ?? '' });
  }
  return out;
}

async function build(deps: ServicesDeps): Promise<ServicesResponse> {
  const now = (deps.now ?? Date.now)();
  const httpProbe = deps.httpProbe ?? probeHttp;
  const sys = await gatherSystemState(deps.run, now);
  const defs = await ensureServices(deps.base, sys);
  const services: ServiceHealth[] = [];
  for (const def of defs) {
    let httpOk: boolean | undefined;
    if (def.kind === 'http' && def.port !== undefined) httpOk = await httpProbe(def.port, def.httpPath ?? '/', 1500);
    services.push(probeService(def, sys, httpOk));
  }
  services.sort(byUrgency);
  return { services, untracked: untrackedRunners(defs, sys), generatedAt: new Date(now).toISOString() };
}

const RANK: Record<string, number> = { down: 0, degraded: 1, unknown: 2, up: 3 };
function byUrgency(a: ServiceHealth, b: ServiceHealth): number {
  const au = a.alwaysOn ? 0 : 1, bu = b.alwaysOn ? 0 : 1;   // always-on problems first
  if (au !== bu) return au - bu;
  return (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9);
}

/** Returns a cached provider: repeated calls within cacheMs reuse the last snapshot. */
export function makeGetServices(deps: ServicesDeps): () => Promise<ServicesResponse> {
  const cacheMs = deps.cacheMs ?? 10_000;
  const clock = deps.now ?? Date.now;
  let cached: ServicesResponse | null = null;
  let at = -Infinity;
  let inflight: Promise<ServicesResponse> | null = null;
  return async () => {
    const t = clock();
    if (cached && t - at < cacheMs) return cached;
    if (inflight) return inflight;
    inflight = build(deps).then((r) => { cached = r; at = clock(); inflight = null; return r; }, (e) => { inflight = null; throw e; });
    return inflight;
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test tests/ops/services.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/ops/services.ts tests/ops/services.test.ts
git commit -m "feat(ops): services orchestrator with cache + untracked detection"
```

---

## Task 7: Server route `GET /api/services`

**Files:**
- Modify: `src/server.ts` (add the route branch in `createApp`; wire the provider in `serve`)
- Test: `tests/server.services.test.ts`

**Interfaces:**
- Consumes: `ServicesResponse` from `./ops/types.ts`, `makeGetServices` from `./ops/services.ts`, `runPwsh` from `./ops/windows.ts`.
- Produces: `createApp(store, opts)` gains `opts.getServices?: () => Promise<ServicesResponse>`; when set, `GET /api/services` returns its JSON. When absent, the route returns `503 {error:'services unavailable'}`.

- [ ] **Step 1: Write the failing test**

Create `tests/server.services.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/server.ts';
import { SnapshotStore } from '../src/snapshotStore.ts';
import type { ServicesResponse } from '../src/ops/types.ts';

async function withServer(getServices: () => Promise<ServicesResponse>, fn: (base: string) => Promise<void>) {
  const app = createApp(new SnapshotStore(), { webDir: process.cwd(), uiRefreshSeconds: 30, pollIntervalSeconds: { claude: 180, codex: 60 }, getServices });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const { port } = app.address() as { port: number };
  try { await fn(`http://127.0.0.1:${port}`); } finally { app.close(); }
}

test('GET /api/services returns the provider payload', async () => {
  const payload: ServicesResponse = { services: [{ id: 'x', label: 'X', kind: 'port', port: 7777, alwaysOn: true, status: 'up', detail: 'ok', pid: null, lastRun: null, nextRun: null }], untracked: [], generatedAt: '2026-07-15T09:00:00.000Z' };
  await withServer(async () => payload, async (base) => {
    const res = await fetch(`${base}/api/services`);
    assert.equal(res.status, 200);
    const body = await res.json() as ServicesResponse;
    assert.equal(body.services[0]!.status, 'up');
  });
});

test('GET /api/services is 503 when no provider is wired', async () => {
  const app = createApp(new SnapshotStore(), { webDir: process.cwd(), uiRefreshSeconds: 30, pollIntervalSeconds: { claude: 180, codex: 60 } });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const { port } = app.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/services`);
    assert.equal(res.status, 503);
  } finally { app.close(); }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test tests/server.services.test.ts`
Expected: FAIL — `getServices` not in opts / route returns 404.

- [ ] **Step 3: Add the route to `createApp`**

In `src/server.ts`, extend the `createApp` options type and add the route. Change the signature block and insert the branch right after the `/api/health` line (around `src/server.ts:36`):

```ts
// add to imports at top:
import type { ServicesResponse } from './ops/types.ts';

export function createApp(store: SnapshotStore, opts: { webDir: string; uiRefreshSeconds: number; pollIntervalSeconds: { claude: number; codex: number }; getServices?: () => Promise<ServicesResponse> }): Server {
  return createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0]!;
    try {
      if (url === '/api/health') return json(res, { ok: true });
      if (url === '/api/services') {
        if (!opts.getServices) { res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'services unavailable' })); return; }
        return json(res, await opts.getServices());
      }
      if (url === '/api/usage') {
        const accounts = store.all().map(enrichUsage).sort(byTightest);
        return json(res, { accounts, uiRefreshSeconds: opts.uiRefreshSeconds, pollIntervalSeconds: opts.pollIntervalSeconds });
      }
      // ...unchanged static-file handling below...
```

Leave the static-file block (from `const file = ...` onward) exactly as-is.

- [ ] **Step 4: Wire the real provider in `serve()`**

In `src/server.ts` `serve()`, after `const webDir = ...` (around `src/server.ts:78`), build the provider and pass it to `createApp`:

```ts
// add to imports at top:
import { makeGetServices } from './ops/services.ts';
import { runPwsh } from './ops/windows.ts';

  const webDir = fileURLToPath(new URL('../web/', import.meta.url));
  const getServices = makeGetServices({ base, run: runPwsh });
  const server = createApp(store, { webDir, uiRefreshSeconds: cfg.uiRefreshSeconds, pollIntervalSeconds: cfg.pollIntervalSeconds, getServices });
```

(`base` is already the `serve()` parameter; `makeGetServices` reads `services.json` under it per request.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --import tsx --test tests/server.services.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full server suite to confirm no regressions**

Run: `node --import tsx --test tests/server.test.ts tests/server.services.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/server.ts tests/server.services.test.ts
git commit -m "feat(server): GET /api/services route + wire provider in serve()"
```

---

## Task 8: Web — shared nav + Services page

**Files:**
- Modify: `web/index.html` (add nav)
- Create: `web/services.html`
- Create: `web/services.js`
- Modify: `web/styles.css` (nav + status colors)
- Test: `tests/web/services.test.ts`

**Interfaces:**
- Consumes: `GET /api/services` → `ServicesResponse` (JSON).
- Produces: `renderServices(data, now)` in `web/services.js` — a pure function returning an HTML string, importable in tests (mirrors how `tests/web/format.test.ts` imports `web/format.js`).

- [ ] **Step 1: Write the failing test**

Create `tests/web/services.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderServices } from '../../web/services.js';

const data = {
  services: [
    { id: 'a', label: 'Dashboard', group: 'subtrack', kind: 'http', status: 'up', detail: 'http 2xx on :7777/api/health', alwaysOn: true, pid: null, lastRun: null, nextRun: null },
    { id: 'b', label: 'Radar throughput', group: 'radar', kind: 'task', status: 'down', detail: 'task not registered', alwaysOn: true, pid: null, lastRun: null, nextRun: null },
  ],
  untracked: [{ kind: 'port', port: 9999, pid: 5, name: 'node', cmd: 'node ghost.js' }],
  generatedAt: '2026-07-15T09:00:00.000Z',
};

test('renderServices shows each service label and status class', () => {
  const html = renderServices(data, Date.parse(data.generatedAt));
  assert.match(html, /Dashboard/);
  assert.match(html, /Radar throughput/);
  assert.match(html, /status-up/);
  assert.match(html, /status-down/);
});

test('renderServices lists untracked runners', () => {
  const html = renderServices(data, Date.parse(data.generatedAt));
  assert.match(html, /9999/);
  assert.match(html, /Untracked/i);
});

test('renderServices escapes service labels', () => {
  const evil = { ...data, services: [{ ...data.services[0], label: '<img src=x>' }], untracked: [] };
  const html = renderServices(evil, 0);
  assert.doesNotMatch(html, /<img src=x>/);
  assert.match(html, /&lt;img/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test tests/web/services.test.ts`
Expected: FAIL — cannot find `web/services.js`.

- [ ] **Step 3: Create `web/services.js`**

Create `web/services.js`:

```js
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function row(s) {
  const meta = s.kind === 'task'
    ? `last ${s.lastRun || '—'}${s.nextRun ? ` · next ${s.nextRun}` : ''}`
    : (s.pid ? `pid ${s.pid}` : s.detail);
  return `<div class="svc status-${esc(s.status)}">`
    + `<span class="svc-dot"></span>`
    + `<span class="svc-label">${esc(s.label)}</span>`
    + `<span class="svc-kind">${esc(s.kind)}</span>`
    + `<span class="svc-detail">${esc(s.detail)}</span>`
    + `<span class="svc-meta">${esc(meta)}</span>`
    + `</div>`;
}

function group(name, items) {
  return `<h2 class="svc-group">${esc(name || 'other')}</h2>` + items.map(row).join('');
}

export function renderServices(data, _now) {
  const byGroup = new Map();
  for (const s of data.services) {
    const g = s.group || 'other';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(s);
  }
  let html = '';
  for (const [name, items] of byGroup) html += group(name, items);
  if (data.untracked && data.untracked.length) {
    html += `<h2 class="svc-group untracked">Untracked runners</h2>`;
    html += data.untracked.map((u) =>
      `<div class="svc status-unknown"><span class="svc-dot"></span>`
      + `<span class="svc-label">:${esc(u.port ?? '')}</span>`
      + `<span class="svc-kind">${esc(u.name)}</span>`
      + `<span class="svc-detail">${esc(u.cmd)}</span>`
      + `<span class="svc-meta">${u.pid > 0 ? 'pid ' + u.pid : ''}</span></div>`).join('');
  }
  return html || '<p class="empty">No services configured yet.</p>';
}

// Browser bootstrap (skipped under node:test, which only imports renderServices).
if (typeof document !== 'undefined') {
  const el = document.getElementById('services');
  const updated = document.getElementById('updated');
  async function refresh() {
    try {
      const res = await fetch('/api/services');
      if (!res.ok) { updated.textContent = 'services unavailable'; return; }
      const data = await res.json();
      el.innerHTML = renderServices(data, Date.now());
      updated.textContent = `updated ${new Date().toLocaleTimeString()}`;
    } catch { updated.textContent = 'connection lost — retrying'; }
  }
  refresh();
  setInterval(refresh, 15000);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test tests/web/services.test.ts`
Expected: PASS.

- [ ] **Step 5: Create `web/services.html`**

Create `web/services.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>subtrack · services</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <header>
    <h1>subtrack</h1>
    <nav class="tabs"><a href="/">Usage</a><a href="/services.html" class="active">Services</a></nav>
    <span id="updated" class="updated"></span>
  </header>
  <main id="services" class="services"></main>
  <script type="module" src="/services.js"></script>
</body>
</html>
```

- [ ] **Step 6: Add the nav to the Usage page**

Modify `web/index.html` — replace the `<header>` line (`web/index.html:10`) with:

```html
  <header>
    <h1>subtrack</h1>
    <nav class="tabs"><a href="/" class="active">Usage</a><a href="/services.html">Services</a></nav>
    <span id="summary" class="summary"></span>
    <span id="updated" class="updated"></span>
  </header>
```

- [ ] **Step 7: Add styles**

Append to `web/styles.css`:

```css
.tabs { display: flex; gap: 12px; margin: 0 16px; }
.tabs a { color: inherit; text-decoration: none; opacity: 0.6; padding: 2px 6px; border-radius: 6px; }
.tabs a.active { opacity: 1; background: rgba(127,127,127,0.18); }
.services { padding: 8px 16px; display: flex; flex-direction: column; gap: 4px; }
.svc-group { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.6; margin: 14px 0 4px; }
.svc-group.untracked { color: #b58900; }
.svc { display: grid; grid-template-columns: 14px 1.4fr 60px 2fr 1fr; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 6px; background: rgba(127,127,127,0.06); }
.svc-dot { width: 10px; height: 10px; border-radius: 50%; background: #888; }
.status-up .svc-dot { background: #2ecc71; }
.status-degraded .svc-dot { background: #f1c40f; }
.status-down .svc-dot { background: #e74c3c; }
.status-unknown .svc-dot { background: #888; }
.svc-kind { font-size: 0.75rem; opacity: 0.6; }
.svc-detail, .svc-meta { font-size: 0.8rem; opacity: 0.75; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty { opacity: 0.6; padding: 16px; }
```

- [ ] **Step 8: Manual smoke check**

Run: `npm start` and open `http://localhost:7777/services.html`.
Expected: the Services page lists your scheduled tasks (subtrack-dashboard, the Hermes gateways, radar/rentu jobs) with green/red/amber dots, always-on problems on top, and an "Untracked runners" section for any listening port no service claims. Toggle between Usage and Services via the nav.

- [ ] **Step 9: Run the full test suite + typecheck, then commit**

Run: `npm test`
Expected: PASS (all files).
Run: `npm run typecheck`
Expected: no errors.

```bash
git add web/index.html web/services.html web/services.js web/styles.css tests/web/services.test.ts
git commit -m "feat(web): Services page + nav (live health, untracked runners)"
```

---

## Self-Review

**1. Spec coverage (Phase 1 = Services):**
- Live health of must-run services → Tasks 1, 6, 8. ✓
- Probe kinds task/port/http/process → Task 1 (all four, with tests per kind). ✓
- Status up/down/degraded/unknown → Task 1. ✓
- Auto-seed manifest from Task Scheduler + ports/processes → Tasks 2, 5. ✓
- Untracked-runner detection → Task 6. ✓
- Read `services.json` fresh per request → Task 6 (`ensureServices`/`loadServices` called inside `build`, which runs per cache-miss request). ✓
- On-demand, never in the poller → Task 6/7 (provider called only from the route). ✓
- Sort always-on problems first → Task 6 (`byUrgency`). ✓
- Web live page + nav, severity colors → Task 8. ✓
- **Deferred to later phases (not this plan):** `register`/`restart`/`stop` actions (`POST /api/services/action`), Projects index, cleanup. `startCmd`/`cwd` are stored on `ServiceDef` now but only consumed by the Phase-3 actions plan. Called out here so no reviewer expects them in Phase 1.

**2. Placeholder scan:** No TBD/TODO; every code step contains complete code; every test step contains real assertions. ✓

**3. Type consistency:** `ServiceDef`/`SystemState`/`ServiceHealth`/`UntrackedRunner`/`ServicesResponse` are defined once in Task 1 and consumed unchanged in Tasks 2–8. `probeService(def, sys, httpOk?)`, `gatherSystemState(run, now)`, `parseSystemState(stdout, now)`, `probeHttp(port, path, timeoutMs?, fetchImpl?)`, `makeGetServices(deps)`, and `renderServices(data, now)` names match across their definition and call sites (Task 6 calls exactly these signatures; Task 7 passes `getServices`; Task 8 imports `renderServices`). ✓

**Notes for the executor:**
- `createApp` is also called by `tests/server.test.ts` and `src/daemon.ts` health checks — the new `getServices` field is **optional**, so existing callers keep compiling (verified by Task 7 Step 6).
- The `SYSTEM_STATE_SCRIPT` uses `Get-CimInstance Win32_Process` for command lines (needed for `match`/untracked). It is Windows-only; this whole view is Windows-only by design, consistent with `src/install.ts`.
