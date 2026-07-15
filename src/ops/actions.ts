import { dirname } from 'node:path';
import { loadServices } from './config.ts';
import { gatherSystemState, type PwshRunner } from './windows.ts';
import type { ActionRequest, ActionResult } from './types.ts';

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
