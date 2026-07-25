import type { PwshRunner } from '../ops/windows.ts';
import type { RawLiveClaudeWindow } from './types.ts';

/**
 * Read only the Claude process metadata needed by the Sessions view. The helper mirrors the
 * already-proven local `ccwindows` function, but deliberately does not read credentials, emails,
 * complete environments, or command lines into the HTTP response.
 *
 * The PEB offsets are an observed x64 Windows contract. If they stop working, callers surface a
 * partial-result warning and the persistent session history remains available.
 */
export const LIVE_CLAUDE_WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SubtrackSessionWin {
  [DllImport("ntdll.dll")] public static extern int NtQueryInformationProcess(IntPtr h,int c,ref PBI p,int l,out int r);
  [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr OpenProcess(int a,bool i,int pid);
  [DllImport("kernel32.dll",SetLastError=true)] public static extern bool ReadProcessMemory(IntPtr h,IntPtr a,byte[] b,int s,out int r);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct PBI { public IntPtr r1; public IntPtr Peb; public IntPtr r2a; public IntPtr r2b; public IntPtr Pid; public IntPtr r3; }
  static IntPtr RdPtr(IntPtr h,long a){ byte[] b=new byte[8]; int r; ReadProcessMemory(h,(IntPtr)a,b,8,out r); return (IntPtr)BitConverter.ToInt64(b,0); }
  static ushort RdU16(IntPtr h,long a){ byte[] b=new byte[2]; int r; ReadProcessMemory(h,(IntPtr)a,b,2,out r); return BitConverter.ToUInt16(b,0); }
  public static string[] Info(int pid){
    IntPtr h=OpenProcess(0x0400|0x0010,false,pid);
    if(h==IntPtr.Zero) return new string[]{null,null};
    try{
      PBI pbi=new PBI(); int r;
      if(NtQueryInformationProcess(h,0,ref pbi,Marshal.SizeOf(pbi),out r)!=0) return new string[]{null,null};
      long pp=(long)RdPtr(h,(long)pbi.Peb+0x20);
      string ccd=null; IntPtr env=RdPtr(h,pp+0x80); int sz=65536;
      while(sz>=4096){ byte[] buf=new byte[sz]; int rd;
        if(ReadProcessMemory(h,env,buf,sz,out rd)){ foreach(string ln in System.Text.Encoding.Unicode.GetString(buf,0,rd).Split('\0')){ if(ln.StartsWith("CLAUDE_CONFIG_DIR=")){ ccd=ln.Substring(18); break; } } break; } sz/=2; }
      string cwd=null; ushort ln2=RdU16(h,pp+0x38); IntPtr bp=RdPtr(h,pp+0x40);
      if(ln2>0 && ln2<2048){ byte[] cb=new byte[ln2]; int rd2; if(ReadProcessMemory(h,bp,cb,ln2,out rd2)) cwd=System.Text.Encoding.Unicode.GetString(cb,0,rd2); }
      return new string[]{ccd,cwd};
    } finally { CloseHandle(h); }
  }
}
"@
$cmdByPid=@{}
Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | ForEach-Object { $cmdByPid[[int]$_.ProcessId]=[string]$_.CommandLine }
$rows=@(Get-Process claude -ErrorAction SilentlyContinue | Sort-Object StartTime | ForEach-Object {
  $info=[SubtrackSessionWin]::Info($_.Id)
  $cmd=[string]$cmdByPid[$_.Id]
  $m=[regex]::Match($cmd,'(?i)(?:--resume(?:=|\s+)|-r\s+|--session-id(?:=|\s+))["'']?([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})')
  [pscustomobject]@{
    pid=[int]$_.Id
    startedAt=$_.StartTime.ToUniversalTime().ToString('o')
    configDir=$info[0]
    cwd=$info[1]
    launchSessionId=$(if($m.Success){$m.Groups[1].Value}else{$null})
  }
})
[pscustomobject]@{windows=$rows} | ConvertTo-Json -Depth 3 -Compress
`;

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function parseLiveClaudeWindows(stdout: string): RawLiveClaudeWindow[] {
  let parsed: { windows?: RawLiveClaudeWindow | RawLiveClaudeWindow[] };
  try { parsed = JSON.parse(stdout) as typeof parsed; } catch { throw new Error('Claude window snapshot returned malformed JSON'); }
  return asArray(parsed.windows)
    .filter((row) => row && row.pid !== null && row.pid !== undefined && Number.isInteger(Number(row.pid)) && Number(row.pid) > 0)
    .map((row) => ({
      pid: Number(row.pid),
      startedAt: typeof row.startedAt === 'string' ? row.startedAt : new Date(0).toISOString(),
      configDir: typeof row.configDir === 'string' && row.configDir ? row.configDir : null,
      cwd: typeof row.cwd === 'string' && row.cwd ? row.cwd : null,
      launchSessionId: typeof row.launchSessionId === 'string' && row.launchSessionId ? row.launchSessionId : null,
    }));
}

export async function gatherLiveClaudeWindows(run: PwshRunner): Promise<RawLiveClaudeWindow[]> {
  if (process.platform !== 'win32') return [];
  const result = await run(LIVE_CLAUDE_WINDOWS_SCRIPT);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `PowerShell exited ${result.code}`);
  return parseLiveClaudeWindows(result.stdout);
}
