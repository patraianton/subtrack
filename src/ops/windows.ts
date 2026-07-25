import { spawn } from 'node:child_process';
import type { SystemState, TaskState, ProcInfo } from './types.ts';

export type PwshResult = { code: number; stdout: string; stderr: string };
export type PwshRunner = (script: string) => Promise<PwshResult>;

const PWSH_TIMEOUT_MS = 30_000;

/** Real PowerShell runner — same invocation shape as src/install.ts. */
export const runPwsh: PwshRunner = (script) =>
  new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
    let stdout = '', stderr = '';
    let settled = false;
    let timedOut = false;
    const finish = (result: PwshResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, PWSH_TIMEOUT_MS);
    timer.unref();
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code, signal) => finish({
      code: code ?? 1,
      stdout,
      stderr: timedOut ? 'PowerShell timed out' : (stderr || (signal ? `PowerShell stopped (${signal})` : '')),
    }));
    child.on('error', (error) => finish({ code: 1, stdout, stderr: String(error) }));
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
