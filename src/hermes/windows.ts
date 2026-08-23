import type { PwshRunner } from '../ops/windows.ts';
import type { HermesProcessInfo, HermesProcessSnapshot } from './types.ts';

export const HERMES_PROCESS_SCRIPT = `
$ErrorActionPreference='Stop'
$processes = Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe'" | ForEach-Object {
  $cmd = [string]$_.CommandLine
  $started = $null
  try { $started = $_.CreationDate.ToUniversalTime().ToString('o') } catch {}
  # Windows PowerShell 5.1 ConvertTo-Json leaves some C0 control characters
  # unescaped. Base64 keeps an arbitrary command line valid JSON while the
  # TypeScript side still performs the exact profile/argv checks.
  $cmdB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($cmd))
  [pscustomobject]@{ pid=[int]$_.ProcessId; name=[string]$_.Name; cmdB64=$cmdB64; startedAt=$started }
}
[pscustomobject]@{ processes=@($processes) } | ConvertTo-Json -Depth 3 -Compress
`;

interface RawHermesProcessInfo {
  pid?: unknown;
  name?: unknown;
  cmd?: unknown;
  cmdB64?: unknown;
  startedAt?: unknown;
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function parseHermesProcesses(stdout: string): HermesProcessSnapshot {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) as unknown; }
  catch { return { ok: false, processes: [], error: 'invalid process snapshot' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.hasOwn(parsed, 'processes')) {
    return { ok: false, processes: [], error: 'incomplete process snapshot' };
  }
  const value = (parsed as { processes: unknown }).processes;
  if (!Array.isArray(value) && (value === null || typeof value !== 'object')) {
    return { ok: false, processes: [], error: 'incomplete process snapshot' };
  }
  const rawProcesses = asArray(value as RawHermesProcessInfo | RawHermesProcessInfo[]);
  const decoded = rawProcesses.map((item) => {
    if (!item || typeof item.pid !== 'number' || !Number.isInteger(item.pid) || item.pid <= 0) return null;
    if (typeof item.cmd === 'string') return { item, cmd: item.cmd };
    if (typeof item.cmdB64 !== 'string' || item.cmdB64.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.cmdB64)) return null;
    try { return { item, cmd: Buffer.from(item.cmdB64, 'base64').toString('utf8') }; }
    catch { return null; }
  });
  if (decoded.some((item) => item === null)) {
    return { ok: false, processes: [], error: 'malformed process snapshot rows' };
  }
  const processes = decoded
    .filter((entry): entry is { item: RawHermesProcessInfo & { pid: number }; cmd: string } => entry !== null)
    .map(({ item, cmd }) => ({
      pid: item.pid,
      name: typeof item.name === 'string' ? item.name : '',
      cmd,
      startedAt: typeof item.startedAt === 'string' ? item.startedAt : null,
    }));
  return { ok: true, processes };
}

export async function listHermesProcesses(run: PwshRunner): Promise<HermesProcessSnapshot> {
  const result = await run(HERMES_PROCESS_SCRIPT);
  if (result.code !== 0) return { ok: false, processes: [], error: 'process snapshot failed' };
  return parseHermesProcesses(result.stdout);
}
