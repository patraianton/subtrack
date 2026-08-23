# Ops-Cockpit Phase 1b (Services Actions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Services tab actionable — `restart` / `stop` a scheduled service, and `register` an untracked runner as an at-logon task so it survives the next reboot — all from the dashboard, behind explicit confirmation.

**Architecture:** Add a `POST /api/services/action` endpoint to the existing subtrack server, backed by a new `src/ops/actions.ts` (pure PowerShell command builders + a validated executor). The executor **never runs a command supplied by the client**: `restart`/`stop` look up a service by `id` in `services.json` and use its stored `taskName`; `register` looks up an untracked runner by `pid` in a fresh system snapshot and rebuilds the command from the detected process. The web layer adds buttons behind an in-page confirm.

**Tech Stack:** Node 24 + TypeScript via `tsx` (no build step), `node:test` + `node:assert/strict`, `node:child_process` (`powershell.exe`), vanilla HTML/CSS/JS. No new dependencies.

## Global Constraints

- **No new runtime dependencies.** Node built-ins only.
- **Explicit `.ts` import extensions** in all source imports.
- **No command execution from the request.** The client sends an intent (`action` + `id`/`pid`/`label`), never a command line, task name, or script. The server resolves the target from trusted state (`services.json` for `restart`/`stop`, the live process table for `register`) and builds the PowerShell itself. `label` is used only as a task name and MUST be sanitized to `[A-Za-z0-9._-]`.
- **PowerShell string escaping is mandatory.** Every value interpolated into a PowerShell single-quoted string is escaped by doubling single quotes (`'` → `''`), exactly as `src/install.ts` does. Task names are additionally restricted to a safe charset before use.
- **PowerShell invocation pattern** reuses the existing shape: spawn `powershell.exe` with `['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command', script]`, `{ windowsHide: true }` (the exported `runPwsh` from `src/ops/windows.ts`).
- **On-demand only.** Actions run only in response to the POST handler — nothing in the poller.
- **Loopback only.** The endpoint is served on `127.0.0.1` like the rest.
- **Windows-only** actions (Task Scheduler). On other platforms the executor returns a clear "Windows-only" error rather than throwing.
- **DI everything** (the pwsh runner, the clock): tests assert the exact command strings built and never spawn a real shell or touch Task Scheduler.
- **Static gate:** `npm run typecheck` must pass; there is no linter.

## Reused, already-committed code (do not reimplement)
- `src/ops/windows.ts` — `runPwsh: PwshRunner`, `gatherSystemState(run, now)`; `PwshRunner`/`PwshResult` types, `SystemState`/`ProcInfo`.
- `src/ops/config.ts` — `loadServices(base)`.
- `src/ops/types.ts` — `ServiceDef` (has optional `taskName`), `UntrackedRunner`.
- `src/server.ts` — `createApp(store, opts)` (opts already has `getServices?`), `serve(base, opts)`, the `json(res, body)` helper.
- `src/install.ts` — the canonical scheduled-task registration parameters (at-logon trigger, hidden, `LogonType Interactive`, `RunLevel Limited`, `StartWhenAvailable`, `MultipleInstances IgnoreNew`). `register` mirrors these.
- `web/services.js` — `renderServices(data, now)` + the browser bootstrap.

---

## File Structure

**New files:**
- `src/ops/actions.ts` — action types, pure PowerShell builders (`restartTaskScript`, `stopTaskScript`, `registerScript`), `splitCommandLine`, `sanitizeTaskName`, and the executor factory `makeRunServiceAction`.
- Tests: `tests/ops/actions.test.ts`, and additions to `tests/server.services.test.ts`, `tests/web/services.test.ts`.

**Modified files:**
- `src/ops/types.ts` — add `ActionRequest` + `ActionResult`.
- `src/server.ts` — add the `POST /api/services/action` route + a small JSON-body reader; wire the real executor in `serve()`.
- `web/services.js` — action buttons + an in-page confirm + POST; export a pure `renderServiceActions`/updated `renderServices` for testing.
- `web/styles.css` — button + confirm styles (append only).

---

## Task 1: Action types + pure command builders

**Files:**
- Modify: `src/ops/types.ts` (add `ActionRequest`, `ActionResult`)
- Create: `src/ops/actions.ts` (builders + helpers only in this task)
- Test: `tests/ops/actions.test.ts`

**Interfaces:**
- Consumes: nothing (leaf).
- Produces:
  - `ActionRequest = { action: 'restart' | 'stop' | 'register'; id?: string; pid?: number; label?: string }`
  - `ActionResult = { ok: boolean; ran: string; output?: string; error?: string; taskName?: string }`
  - `psEscape(s: string): string`
  - `sanitizeTaskName(s: string): string`
  - `splitCommandLine(cmd: string): { exe: string; args: string }`
  - `restartTaskScript(taskName: string): string`
  - `stopTaskScript(taskName: string): string`
  - `registerScript(taskName: string, exe: string, args: string, workingDir: string): string`

- [ ] **Step 1: Add the action types**

Append to `src/ops/types.ts`:

```ts
export interface ActionRequest {
  action: 'restart' | 'stop' | 'register';
  id?: string;    // for restart/stop: the ServiceDef.id
  pid?: number;   // for register: the untracked runner's pid
  label?: string; // for register: desired task name (sanitized server-side)
}

export interface ActionResult {
  ok: boolean;
  ran: string;          // short human description of what was attempted
  output?: string;      // trimmed stdout/stderr tail, for display
  error?: string;       // set when ok is false
  taskName?: string;    // for register: the created task's name
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/ops/actions.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { psEscape, sanitizeTaskName, splitCommandLine, restartTaskScript, stopTaskScript, registerScript } from '../../src/ops/actions.ts';

test('psEscape doubles single quotes', () => {
  assert.equal(psEscape("a'b"), "a''b");
  assert.equal(psEscape('plain'), 'plain');
});

test('sanitizeTaskName keeps only safe chars', () => {
  assert.equal(sanitizeTaskName('my task/#1'), 'my-task--1');
  assert.equal(sanitizeTaskName('radar_healthcheck'), 'radar_healthcheck');
  assert.match(sanitizeTaskName(''), /^subtrack-adopted$/);
});

test('splitCommandLine handles a quoted exe path with args', () => {
  const { exe, args } = splitCommandLine('"C:\\\\Program Files\\\\nodejs\\\\node.exe" server.js --port 3000');
  assert.equal(exe, 'C:\\\\Program Files\\\\nodejs\\\\node.exe');
  assert.equal(args, 'server.js --port 3000');
});

test('splitCommandLine handles an unquoted exe', () => {
  const { exe, args } = splitCommandLine('pythonw.exe bot.py');
  assert.equal(exe, 'pythonw.exe');
  assert.equal(args, 'bot.py');
});

test('splitCommandLine on empty input yields empty exe', () => {
  assert.deepEqual(splitCommandLine('   '), { exe: '', args: '' });
});

test('restartTaskScript / stopTaskScript build escaped Start/Stop commands', () => {
  assert.match(restartTaskScript("rad'ar"), /Start-ScheduledTask -TaskName 'rad''ar'/);
  assert.match(restartTaskScript('x'), /'STARTED'/);
  assert.match(stopTaskScript('x'), /Stop-ScheduledTask -TaskName 'x'/);
  assert.match(stopTaskScript('x'), /'STOPPED'/);
});

test('registerScript builds an at-logon task with escaped values and prints REGISTERED', () => {
  const s = registerScript('subtrack-adopted-node-42', 'C:\\\\node.exe', 'app.js', 'C:\\\\app');
  assert.match(s, /New-ScheduledTaskAction -Execute 'C:\\\\node\.exe' -Argument 'app\.js' -WorkingDirectory 'C:\\\\app'/);
  assert.match(s, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(s, /LogonType Interactive/);
  assert.match(s, /Register-ScheduledTask -TaskName 'subtrack-adopted-node-42'/);
  assert.match(s, /'REGISTERED'/);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --import tsx --test tests/ops/actions.test.ts`
Expected: FAIL — `Cannot find module '../../src/ops/actions.ts'`.

- [ ] **Step 4: Implement the builders**

Create `src/ops/actions.ts` (builders + helpers only; the executor is Task 2):

```ts
export function psEscape(s: string): string {
  return s.replace(/'/g, "''"); // single-quote escaping for a PS single-quoted string
}

/** Task Scheduler name restricted to a safe charset (defends the one client-influenced value). */
export function sanitizeTaskName(s: string): string {
  const cleaned = (s ?? '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'subtrack-adopted';
}

/** Split a Windows command line into { exe, args }. Handles a leading quoted path. */
export function splitCommandLine(cmd: string): { exe: string; args: string } {
  const s = (cmd ?? '').trim();
  if (!s) return { exe: '', args: '' };
  if (s[0] === '"') {
    const end = s.indexOf('"', 1);
    if (end === -1) return { exe: s.slice(1), args: '' };
    return { exe: s.slice(1, end), args: s.slice(end + 1).trim() };
  }
  const sp = s.indexOf(' ');
  if (sp === -1) return { exe: s, args: '' };
  return { exe: s.slice(0, sp), args: s.slice(sp + 1).trim() };
}

export function restartTaskScript(taskName: string): string {
  return `Start-ScheduledTask -TaskName '${psEscape(taskName)}' -ErrorAction Stop; 'STARTED'`;
}

export function stopTaskScript(taskName: string): string {
  return `Stop-ScheduledTask -TaskName '${psEscape(taskName)}' -ErrorAction Stop; 'STOPPED'`;
}

/**
 * Register an at-logon Scheduled Task from an adopted process, mirroring src/install.ts's
 * task parameters (hidden, runs as the user, survives reboot). WorkingDirectory is best-effort.
 */
export function registerScript(taskName: string, exe: string, args: string, workingDir: string): string {
  const t = psEscape(taskName), e = psEscape(exe), a = psEscape(args), w = psEscape(workingDir);
  return [
    `$ErrorActionPreference='Stop'`,
    `$action = New-ScheduledTaskAction -Execute '${e}' -Argument '${a}' -WorkingDirectory '${w}'`,
    `$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME`,
    `$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)`,
    `$principal = New-ScheduledTaskPrincipal -UserId ("$env:USERDOMAIN\\$env:USERNAME") -LogonType Interactive -RunLevel Limited`,
    `Register-ScheduledTask -TaskName '${t}' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null`,
    `'REGISTERED'`,
  ].join('\n');
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --import tsx --test tests/ops/actions.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/ops/types.ts src/ops/actions.ts tests/ops/actions.test.ts
git commit -m "feat(ops): action types + pure PowerShell command builders"
```

---

## Task 2: Validated action executor

**Files:**
- Modify: `src/ops/actions.ts` (add the executor factory)
- Test: `tests/ops/actions.test.ts` (add executor tests)

**Interfaces:**
- Consumes: `loadServices` from `./config.ts`; `gatherSystemState`, `PwshRunner` from `./windows.ts`; the builders from Task 1; `ActionRequest`/`ActionResult`, `SystemState` from `./types.ts`.
- Produces:
  - `interface ActionDeps { base: string; run: PwshRunner; now?: () => number }`
  - `makeRunServiceAction(deps: ActionDeps): (req: ActionRequest) => Promise<ActionResult>`

The executor resolves the target from trusted state and never uses a request-supplied command:
- `restart`/`stop`: find `ServiceDef` by `req.id` in `loadServices(base)`; require `taskName`; run `restartTaskScript`/`stopTaskScript`.
- `register`: gather a fresh `SystemState`; find the process by `req.pid`; `splitCommandLine` its `cmd`; register a task named `sanitizeTaskName(req.label || 'subtrack-adopted-<name>-<pid>')` with WorkingDirectory = the exe's parent dir.
- Non-win32: return `{ ok:false, ran:'', error:'Actions are Windows-only.' }`.
- On PowerShell failure (non-zero exit or missing sentinel): `ok:false` with the stderr/stdout tail in `error`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/ops/actions.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { makeRunServiceAction } from '../../src/ops/actions.ts';
import { saveServices } from '../../src/ops/config.ts';

async function withTempBase(fn: (base: string) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), 'subtrack-act-'));
  try { await fn(base); } finally { await rm(base, { recursive: true, force: true }); }
}

// A fake runner that records the script it was handed and returns a canned result.
function recorder(result: { code: number; stdout: string; stderr: string }) {
  const calls: string[] = [];
  const run = async (script: string) => { calls.push(script); return result; };
  return { run, calls };
}

const OK = { code: 0, stdout: 'STARTED\n', stderr: '' };

test('restart runs Start-ScheduledTask for the service’s taskName', async () => {
  await withTempBase(async (base) => {
    await saveServices([{ id: 'radar', label: 'Radar', kind: 'task', taskName: 'Radar-Spike8', alwaysOn: true }], base);
    const rec = recorder(OK);
    const run = makeRunServiceAction({ base, run: rec.run });
    const res = await run({ action: 'restart', id: 'radar' });
    assert.equal(res.ok, true);
    assert.match(rec.calls[0]!, /Start-ScheduledTask -TaskName 'Radar-Spike8'/);
  });
});

test('restart on an unknown id returns an error, runs nothing', async () => {
  await withTempBase(async (base) => {
    await saveServices([], base);
    const rec = recorder(OK);
    const res = await makeRunServiceAction({ base, run: rec.run })({ action: 'restart', id: 'ghost' });
    assert.equal(res.ok, false);
    assert.match(res.error!, /unknown service/);
    assert.equal(rec.calls.length, 0);
  });
});

test('restart on a service with no taskName errors, runs nothing', async () => {
  await withTempBase(async (base) => {
    await saveServices([{ id: 'web', label: 'Web', kind: 'http', port: 8080, alwaysOn: true }], base);
    const rec = recorder(OK);
    const res = await makeRunServiceAction({ base, run: rec.run })({ action: 'restart', id: 'web' });
    assert.equal(res.ok, false);
    assert.match(res.error!, /no task/);
    assert.equal(rec.calls.length, 0);
  });
});

test('register rebuilds the task from the live process, never from the request', async () => {
  await withTempBase(async (base) => {
    // system-state gather returns one process for pid 4242
    const sys = JSON.stringify({ tasks: [], ports: [], processes: [{ pid: 4242, name: 'node', cmd: '"C:\\\\Program Files\\\\nodejs\\\\node.exe" bot.js' }] });
    const rec = recorder({ code: 0, stdout: 'REGISTERED\n', stderr: '' });
    const res = await makeRunServiceAction({ base, run: rec.run, now: () => 1 })({ action: 'register', pid: 4242, label: 'my bot!!' });
    assert.equal(res.ok, true);
    assert.equal(res.taskName, 'my-bot'); // sanitized
    // the register script used the DETECTED exe/args, and the system-state gather ran first
    const registerCall = rec.calls.find((c) => c.includes('Register-ScheduledTask'))!;
    assert.match(registerCall, /-Execute 'C:\\\\Program Files\\\\nodejs\\\\node\.exe'/);
    assert.match(registerCall, /-Argument 'bot\.js'/);
  });
});

test('register on an absent pid errors, registers nothing', async () => {
  await withTempBase(async (base) => {
    const rec = recorder({ code: 0, stdout: '{"tasks":[],"ports":[],"processes":[]}', stderr: '' });
    const res = await makeRunServiceAction({ base, run: rec.run })({ action: 'register', pid: 999 });
    assert.equal(res.ok, false);
    assert.match(res.error!, /no running process/);
    assert.ok(!rec.calls.some((c) => c.includes('Register-ScheduledTask')));
  });
});

test('a PowerShell failure surfaces as ok:false with the error tail', async () => {
  await withTempBase(async (base) => {
    await saveServices([{ id: 'radar', label: 'Radar', kind: 'task', taskName: 'Radar', alwaysOn: true }], base);
    const rec = recorder({ code: 1, stdout: '', stderr: 'Access is denied.' });
    const res = await makeRunServiceAction({ base, run: rec.run })({ action: 'restart', id: 'radar' });
    assert.equal(res.ok, false);
    assert.match(res.error!, /Access is denied/);
  });
});
```

> Note: the `register` test drives the gatherer through the injected `run` (the fake returns the JSON snapshot). The FIRST `run` call in a `register` is the system-state gather; the register script is a LATER call — assert on the call that contains `Register-ScheduledTask`, not on `calls[0]`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test tests/ops/actions.test.ts`
Expected: FAIL — `makeRunServiceAction` is not exported.

- [ ] **Step 3: Implement the executor**

Append to `src/ops/actions.ts`:

```ts
import { dirname } from 'node:path';
import { loadServices } from './config.ts';
import { gatherSystemState, type PwshRunner } from './windows.ts';
import type { ActionRequest, ActionResult } from './types.ts';

export interface ActionDeps {
  base: string;
  run: PwshRunner;
  now?: () => number;
}

function tail(s: string, n = 300): string {
  const t = s.trim();
  return t.length > n ? t.slice(-n) : t;
}

function resultFrom(ran: string, r: { code: number; stdout: string; stderr: string }, sentinel: string, extra: Partial<ActionResult> = {}): ActionResult {
  const ok = r.code === 0 && r.stdout.includes(sentinel);
  return ok
    ? { ok: true, ran, output: tail(r.stdout), ...extra }
    : { ok: false, ran, error: tail(r.stderr || r.stdout) || `exit ${r.code}`, ...extra };
}

export function makeRunServiceAction(deps: ActionDeps): (req: ActionRequest) => Promise<ActionResult> {
  return async (req) => {
    if (process.platform !== 'win32') return { ok: false, ran: req.action, error: 'Actions are Windows-only (Task Scheduler).' };

    if (req.action === 'restart' || req.action === 'stop') {
      const svc = (await loadServices(deps.base)).find((d) => d.id === req.id);
      if (!svc) return { ok: false, ran: req.action, error: `unknown service "${req.id ?? ''}"` };
      if (!svc.taskName) return { ok: false, ran: req.action, error: `service "${svc.id}" has no task to ${req.action}` };
      const script = req.action === 'restart' ? restartTaskScript(svc.taskName) : stopTaskScript(svc.taskName);
      const r = await deps.run(script);
      return resultFrom(`${req.action} ${svc.taskName}`, r, req.action === 'restart' ? 'STARTED' : 'STOPPED');
    }

    if (req.action === 'register') {
      const sys = await gatherSystemState(deps.run, (deps.now ?? Date.now)());
      const proc = sys.processes.find((p) => p.pid === req.pid);
      if (!proc) return { ok: false, ran: 'register', error: `no running process with pid ${req.pid ?? ''}` };
      const { exe, args } = splitCommandLine(proc.cmd);
      if (!exe) return { ok: false, ran: 'register', error: 'could not parse the process command line' };
      const taskName = sanitizeTaskName(req.label || `subtrack-adopted-${proc.name}-${proc.pid}`);
      const workingDir = exe.includes('\\') ? dirname(exe) : '';
      const r = await deps.run(registerScript(taskName, exe, args, workingDir));
      return resultFrom(`register ${taskName}`, r, 'REGISTERED', { taskName });
    }

    return { ok: false, ran: String((req as ActionRequest).action), error: `unknown action "${(req as ActionRequest).action}"` };
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test tests/ops/actions.test.ts`
Expected: PASS (all builder + executor tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/ops/actions.ts tests/ops/actions.test.ts
git commit -m "feat(ops): validated service-action executor (restart/stop/register)"
```

---

## Task 3: `POST /api/services/action` route

**Files:**
- Modify: `src/server.ts`
- Test: `tests/server.services.test.ts` (add action-route tests)

**Interfaces:**
- Consumes: `ActionRequest`/`ActionResult` from `./ops/types.ts`, `makeRunServiceAction` from `./ops/actions.ts`, `runPwsh` from `./ops/windows.ts`.
- Produces: `createApp` opts gains `runServiceAction?: (req: ActionRequest) => Promise<ActionResult>`. `POST /api/services/action` parses a JSON body, calls the executor, returns its JSON. `503` when unwired, `400` on malformed JSON, `500` on executor throw.

- [ ] **Step 1: Write the failing tests**

Add to `tests/server.services.test.ts`:

```ts
import type { ActionRequest, ActionResult } from '../src/ops/types.ts';

async function withActionServer(runServiceAction: (r: ActionRequest) => Promise<ActionResult>, fn: (base: string) => Promise<void>) {
  const app = createApp(new SnapshotStore(), { webDir: process.cwd(), uiRefreshSeconds: 30, pollIntervalSeconds: { claude: 180, codex: 60 }, runServiceAction });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const { port } = app.address() as { port: number };
  try { await fn(`http://127.0.0.1:${port}`); } finally { app.close(); }
}

test('POST /api/services/action returns the executor result', async () => {
  const result: ActionResult = { ok: true, ran: 'restart Radar', output: 'STARTED' };
  await withActionServer(async () => result, async (base) => {
    const res = await fetch(`${base}/api/services/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'restart', id: 'radar' }) });
    assert.equal(res.status, 200);
    const body = await res.json() as ActionResult;
    assert.equal(body.ok, true);
  });
});

test('POST /api/services/action is 400 on malformed JSON', async () => {
  await withActionServer(async () => ({ ok: true, ran: 'x' }), async (base) => {
    const res = await fetch(`${base}/api/services/action`, { method: 'POST', body: '{not json' });
    assert.equal(res.status, 400);
  });
});

test('POST /api/services/action is 503 when no executor is wired', async () => {
  const app = createApp(new SnapshotStore(), { webDir: process.cwd(), uiRefreshSeconds: 30, pollIntervalSeconds: { claude: 180, codex: 60 } });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const { port } = app.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/services/action`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 503);
  } finally { app.close(); }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test tests/server.services.test.ts`
Expected: FAIL — route 404s / opts field missing.

- [ ] **Step 3: Add a JSON-body reader and the route**

In `src/server.ts`:

Add to imports at top:
```ts
import type { ServicesResponse, ActionRequest, ActionResult } from './ops/types.ts';
```
(extend the existing `./ops/types.ts` import if one is already present.)

Add a body reader near the other helpers (e.g. beside `json`):
```ts
function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1_000_000) { req.destroy(); reject(new Error('body too large')); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
```

Extend `createApp`'s opts type with `runServiceAction?: (req: ActionRequest) => Promise<ActionResult>` and add the POST branch at the TOP of the handler's `try` (before the GET `url` checks), so method routing is unambiguous:
```ts
      if (req.method === 'POST' && url === '/api/services/action') {
        if (!opts.runServiceAction) { res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'actions unavailable' })); return; }
        let parsed: ActionRequest;
        try { parsed = JSON.parse((await readBody(req)) || '{}') as ActionRequest; }
        catch { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'bad json' })); return; }
        try { return json(res, await opts.runServiceAction(parsed)); }
        catch (e) { res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'action failed', detail: String((e as Error).message) })); return; }
      }
```
Leave all existing GET handling and the static-file block unchanged.

- [ ] **Step 4: Wire the real executor in `serve()`**

Add to imports:
```ts
import { makeRunServiceAction } from './ops/actions.ts';
```
In `serve()`, alongside the existing `getServices` wiring:
```ts
  const getServices = makeGetServices({ base, run: runPwsh });
  const runServiceAction = makeRunServiceAction({ base, run: runPwsh });
  const server = createApp(store, { webDir, uiRefreshSeconds: cfg.uiRefreshSeconds, pollIntervalSeconds: cfg.pollIntervalSeconds, getServices, runServiceAction });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --import tsx --test tests/server.services.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the existing server suite for no regression**

Run: `node --import tsx --test tests/server.test.ts tests/server.services.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/server.ts tests/server.services.test.ts
git commit -m "feat(server): POST /api/services/action route + wire executor"
```

---

## Task 4: Web action buttons + in-page confirm

**Files:**
- Modify: `web/services.js`
- Modify: `web/styles.css` (append only)
- Test: `tests/web/services.test.ts` (add button-render tests)

**Interfaces:**
- Consumes: `POST /api/services/action`.
- Produces: `renderServices(data, now)` now emits action buttons — `restart`/`stop` on services that have a `taskName`, `register` on untracked runners — each carrying `data-action` / `data-id` / `data-pid` attributes. A single delegated click handler (browser-only) shows an in-page confirm, POSTs, shows the inline result, and refreshes. Keep `renderServices` pure and testable.

- [ ] **Step 1: Write the failing test**

Add to `tests/web/services.test.ts`:

```ts
test('renderServices adds restart/stop buttons for services with a taskName', () => {
  const data = {
    services: [
      { id: 'radar', label: 'Radar', group: 'radar', kind: 'task', taskName: 'Radar-Spike8', status: 'down', detail: '...', alwaysOn: true, pid: null, lastRun: null, nextRun: null },
      { id: 'web', label: 'Web', group: 'web', kind: 'http', status: 'up', detail: '...', alwaysOn: true, pid: null, lastRun: null, nextRun: null },
    ],
    untracked: [],
    generatedAt: '2026-07-15T09:00:00.000Z',
  };
  const html = renderServices(data, 0);
  assert.match(html, /data-action="restart"[^>]*data-id="radar"/);
  assert.match(html, /data-action="stop"[^>]*data-id="radar"/);
  // a service with no taskName gets no restart button
  assert.doesNotMatch(html, /data-action="restart"[^>]*data-id="web"/);
});

test('renderServices adds a register button for untracked runners', () => {
  const data = { services: [], untracked: [{ kind: 'port', port: 9999, pid: 5, name: 'node', cmd: 'node ghost.js' }], generatedAt: '2026-07-15T09:00:00.000Z' };
  const html = renderServices(data, 0);
  assert.match(html, /data-action="register"[^>]*data-pid="5"/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test tests/web/services.test.ts`
Expected: FAIL — no `data-action` attributes yet.

- [ ] **Step 3: Add buttons to `renderServices` and a delegated handler**

In `web/services.js`, update the service `row` to append action buttons when `s.taskName` is set, update the untracked block to add a register button, and add a browser-only click handler. Replace the `row` function and the untracked block, and extend the bootstrap:

```js
function actionBtn(action, attrs, text) {
  return `<button class="svc-act" data-action="${esc(action)}" ${attrs}>${esc(text)}</button>`;
}

function row(s) {
  const meta = s.kind === 'task'
    ? `last ${s.lastRun || '—'}${s.nextRun ? ` · next ${s.nextRun}` : ''}`
    : (s.pid ? `pid ${s.pid}` : s.detail);
  const acts = s.taskName
    ? actionBtn('restart', `data-id="${esc(s.id)}"`, 'restart') + actionBtn('stop', `data-id="${esc(s.id)}"`, 'stop')
    : '';
  return `<div class="svc status-${esc(s.status)}">`
    + `<span class="svc-dot"></span>`
    + `<span class="svc-label">${esc(s.label)}</span>`
    + `<span class="svc-kind">${esc(s.kind)}</span>`
    + `<span class="svc-detail">${esc(s.detail)}</span>`
    + `<span class="svc-meta">${esc(meta)}</span>`
    + `<span class="svc-acts">${acts}</span>`
    + `</div>`;
}
```

Replace the untracked runner line in `renderServices` to include a register button:
```js
    html += data.untracked.map((u) =>
      `<div class="svc status-unknown"><span class="svc-dot"></span>`
      + `<span class="svc-label">:${esc(u.port ?? '')}</span>`
      + `<span class="svc-kind">${esc(u.name)}</span>`
      + `<span class="svc-detail">${esc(u.cmd)}</span>`
      + `<span class="svc-meta">${u.pid > 0 ? 'pid ' + esc(u.pid) : ''}</span>`
      + `<span class="svc-acts">${u.pid > 0 ? actionBtn('register', `data-pid="${esc(u.pid)}"`, 'register') : ''}</span>`
      + `</div>`).join('');
```

Extend the browser bootstrap (inside the existing `if (typeof document !== 'undefined')`) with a delegated click handler:
```js
  async function runAction(action, payload, btn) {
    if (!window.confirm(`${action} this service?`)) return;
    btn.disabled = true;
    try {
      const res = await fetch('/api/services/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...payload }) });
      const r = await res.json();
      if (!r.ok) alert(`${action} failed: ${r.error || res.status}`);
    } catch (e) { alert(`${action} failed: ${e}`); }
    finally { btn.disabled = false; refresh(); }
  }
  el.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.svc-act');
    if (!btn) return;
    const action = btn.dataset.action;
    const payload = btn.dataset.id ? { id: btn.dataset.id } : { pid: Number(btn.dataset.pid) };
    runAction(action, payload, btn);
  });
```

> Note: `window.confirm` is a deliberate exception to the project's "avoid dialogs" guidance — it runs in the user's own browser (not the automation harness) and is the simplest correct confirm for a destructive action. If a non-blocking confirm is preferred later, swap it for an in-page element; the test only asserts the buttons render.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test tests/web/services.test.ts`
Expected: PASS.

- [ ] **Step 5: Append styles**

Append to `web/styles.css`:
```css
.svc { grid-template-columns: 14px 1.4fr 60px 2fr 1fr auto; }
.svc-acts { display: flex; gap: 6px; }
.svc-act { font-size: 0.72rem; padding: 2px 8px; border-radius: 5px; border: 1px solid rgba(127,127,127,0.4); background: transparent; color: inherit; cursor: pointer; }
.svc-act:hover { background: rgba(127,127,127,0.15); }
.svc-act:disabled { opacity: 0.5; cursor: default; }
```

- [ ] **Step 6: Full suite + typecheck, then commit**

Run: `npm test`
Expected: PASS (all files).
Run: `npm run typecheck`
Expected: no errors.

```bash
git add web/services.js web/styles.css tests/web/services.test.ts
git commit -m "feat(web): restart/stop/register action buttons on the Services tab"
```

- [ ] **Step 7: Manual smoke check (skip if headless)**

`npm start`, open `/services.html`, confirm restart/stop appear on task services and register appears on untracked runners; click restart on a known task and confirm the inline refresh reflects it.

---

## Self-Review

**1. Spec coverage (Services actions):**
- `restart` (Start-ScheduledTask) → Tasks 1–4. ✓
- `stop` (Stop-ScheduledTask) → Tasks 1–4. ✓
- `register` untracked runner as at-logon task (survives reboot), reusing install.ts params → Tasks 1–4. ✓
- Explicit confirmation before acting → Task 4 (`window.confirm`). ✓
- No arbitrary command from the client (resolve target from trusted state) → Task 2 (id→manifest, pid→live process; command rebuilt server-side). ✓
- **Deferred (noted, not in this plan):** hiding a console window for an adopted task (install.ts's VBS shim) — a registered exe may flash a console at logon; follow-up. `WorkingDirectory` for an adopted process is best-effort (exe's dir), since the original cwd isn't recoverable from the process table.

**2. Placeholder scan:** No TBD/TODO; every code step has complete code; every test step has real assertions. ✓

**3. Type consistency:** `ActionRequest`/`ActionResult` defined in Task 1 (`types.ts`), consumed unchanged in Tasks 2–4. `makeRunServiceAction(deps)`, `restartTaskScript`/`stopTaskScript`/`registerScript`, `splitCommandLine`, `sanitizeTaskName`, `psEscape` names match across definition (Task 1/2) and call sites. `createApp` opts gains `runServiceAction?` (optional — existing callers keep compiling, mirroring the `getServices?` precedent). ✓

**Notes for the executor:**
- The action route is added at the TOP of the handler `try` and gated on `req.method === 'POST'`, so it can't shadow the GET routes or the static handler.
- `register`'s first `run` call is the system-state gather; the register script is a later call — tests assert on the `Register-ScheduledTask` call, not `calls[0]`.
- Windows-only: the executor returns a clear error off-Windows rather than throwing, so the route stays 200-with-`ok:false` there.
