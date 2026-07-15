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
