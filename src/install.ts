import { spawn } from 'node:child_process';
import { writeFile, rm, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { loadConfig } from './config.ts';
import { TASK_NAME, vbsPath, cliEntry, repoRoot, logFilePath, lockFilePath, checkHealth, pidAlive } from './daemon.ts';

interface PwshResult { code: number; stdout: string; stderr: string }

function runPwsh(script: string): Promise<PwshResult> {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (c) => resolve({ code: c ?? 0, stdout, stderr }));
    child.on('error', (e) => resolve({ code: 1, stdout, stderr: String(e) }));
  });
}

/**
 * VBS shim launched by the Scheduled Task. It starts the daemon with WScript.Run(..., 0, False)
 * so there is never a console window, then exits immediately (the daemon keeps running detached).
 * Paths are wrapped in Chr(34) quotes so spaces (e.g. "Program Files") are handled.
 */
export function vbsContent(node: string = process.execPath, cli: string = cliEntry(), root: string = repoRoot()): string {
  return [
    `' subtrack always-on launcher — starts the daemon with no visible window.`,
    `Set sh = CreateObject("WScript.Shell")`,
    `sh.CurrentDirectory = "${root}"`,
    `cmd = Chr(34) & "${node}" & Chr(34) & " --import tsx " & Chr(34) & "${cli}" & Chr(34) & " daemon"`,
    `sh.Run cmd, 0, False`,
    ``,
  ].join('\r\n');
}

/** PowerShell that registers the at-logon (+ self-heal) Scheduled Task and kicks it off now. */
export function installScript(vbs: string): string {
  const q = vbs.replace(/'/g, "''"); // escape single quotes for a PS single-quoted string
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$vbs = '${q}'`,
    `$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"')`,
    `$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME`,
    // Self-heal: also re-check every 30 min so it revives even if the supervisor itself is killed.
    // Best-effort — some Windows builds reject repetition on a logon trigger; ignore if so.
    `try { $trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 30)).Repetition } catch {}`,
    `$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)`,
    `$principal = New-ScheduledTaskPrincipal -UserId ("$env:USERDOMAIN\\$env:USERNAME") -LogonType Interactive -RunLevel Limited`,
    `Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null`,
    `Start-ScheduledTask -TaskName '${TASK_NAME}'`,
    `'INSTALLED'`,
  ].join('\n');
}

export function uninstallScript(): string {
  return `Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue; 'UNINSTALLED'`;
}

export function statusScript(): string {
  return [
    `$t = Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue`,
    `if ($null -eq $t) { 'TASK=absent' } else {`,
    `  $i = Get-ScheduledTaskInfo -TaskName '${TASK_NAME}'`,
    `  'TASK=' + $t.State`,
    `  'LASTRUN=' + $i.LastRunTime`,
    `  'LASTRESULT=' + ('0x{0:X}' -f $i.LastTaskResult)`,
    `  'NEXTRUN=' + $i.NextRunTime`,
    `}`,
  ].join('\n');
}

function requireWindows(): boolean {
  if (process.platform === 'win32') return true;
  console.error('The always-on installer is Windows-only (uses Task Scheduler). Run `subtrack serve` to start it in the foreground on this platform.');
  return false;
}

async function readLockPid(base: string): Promise<number | null> {
  const pid = Number((await readFile(lockFilePath(base), 'utf8').catch(() => '')).trim());
  return pid && pidAlive(pid) ? pid : null;
}

export async function installDaemon(base: string = homedir()): Promise<number> {
  if (!requireWindows()) return 1;
  await writeFile(vbsPath(base), vbsContent(), 'utf8');
  const r = await runPwsh(installScript(vbsPath(base)));
  if (r.code !== 0 || !r.stdout.includes('INSTALLED')) {
    console.error(`Install failed.\n${r.stderr || r.stdout}`.trim());
    return 1;
  }
  const { port } = await loadConfig(base);
  console.log(`Installed always-on task "${TASK_NAME}" (starts at logon, restarts on crash).`);
  console.log(`Dashboard will be at http://localhost:${port} — it starts within a few seconds.`);
  console.log(`Manage it with:  subtrack status | subtrack logs | subtrack stop | subtrack uninstall`);
  return 0;
}

export async function uninstallDaemon(base: string = homedir()): Promise<number> {
  if (!requireWindows()) return 1;
  await stopDaemon(base); // kill the running supervisor + serve child first
  const r = await runPwsh(uninstallScript());
  await rm(vbsPath(base), { force: true }).catch(() => {});
  if (r.code !== 0 && !r.stdout.includes('UNINSTALLED')) {
    console.error(`Uninstall reported an error.\n${r.stderr || r.stdout}`.trim());
    return 1;
  }
  console.log(`Removed always-on task "${TASK_NAME}". The dashboard will no longer start automatically.`);
  return 0;
}

export async function startDaemon(base: string = homedir()): Promise<number> {
  if (!requireWindows()) return 1;
  const r = await runPwsh(`Start-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction Stop; 'STARTED'`);
  if (!r.stdout.includes('STARTED')) {
    console.error(`Could not start — is it installed? Run \`subtrack install\` first.\n${r.stderr}`.trim());
    return 1;
  }
  console.log('Started. Dashboard comes up within a few seconds.');
  return 0;
}

export async function stopDaemon(base: string = homedir()): Promise<number> {
  if (!requireWindows()) return 1;
  const pid = await readLockPid(base);
  if (!pid) { console.log('Daemon is not running.'); return 0; }
  await new Promise<void>((resolve) => {
    const k = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    k.on('exit', () => resolve());
    k.on('error', () => resolve());
  });
  await rm(lockFilePath(base), { force: true }).catch(() => {});
  console.log(`Stopped daemon (pid ${pid}).`);
  return 0;
}

export async function daemonStatus(base: string = homedir()): Promise<number> {
  const cfg = await loadConfig(base);
  const healthy = await checkHealth(cfg.port);
  const pid = await readLockPid(base);
  console.log(`Dashboard:  ${healthy ? `● up   http://localhost:${cfg.port}` : '○ down'}`);
  console.log(`Daemon:     ${pid ? `running (pid ${pid})` : 'not running'}`);
  console.log(`Log:        ${logFilePath(base)}`);
  if (process.platform === 'win32') {
    const r = await runPwsh(statusScript());
    const info = Object.fromEntries(r.stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => {
      const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)];
    }));
    if (info.TASK === 'absent' || !info.TASK) {
      console.log(`Task:       not installed — run \`subtrack install\``);
    } else {
      console.log(`Task:       ${info.TASK}  (last run ${info.LASTRUN || '—'}, result ${info.LASTRESULT || '—'})`);
    }
  }
  return healthy ? 0 : 1;
}

export async function showLogs(base: string = homedir(), lines = 40): Promise<number> {
  const path = logFilePath(base);
  const tail: string[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const rl = createInterface({ input: createReadStream(path, 'utf8') });
      rl.on('line', (l) => { tail.push(l); if (tail.length > lines) tail.shift(); });
      rl.on('close', resolve);
      rl.on('error', reject);
    });
  } catch {
    console.log(`No log yet at ${path} (nothing has run).`);
    return 0;
  }
  console.log(`── ${path} (last ${Math.min(lines, tail.length)} lines) ──`);
  console.log(tail.join('\n'));
  return 0;
}
