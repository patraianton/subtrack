import { listPanes, type HerdrRunner } from './panes.ts';
import type { PwshRunner } from '../ops/windows.ts';
import type { FocusRequest, FocusResult } from './types.ts';

/**
 * herdr pane ids are `<workspace>:<pane>` (`w62:p1`). Nothing outside that shape ever reaches a
 * child process: the id is looked up in the live pane list first, so an unknown one is a 400,
 * not a command.
 */
const PANE_ID = /^[A-Za-z0-9_-]{1,32}:[A-Za-z0-9_-]{1,32}$/;

/**
 * Focusing a workspace only changes what the herdr client shows. The click came from a browser,
 * so the terminal window hosting herdr is still behind it — raising that window is a second,
 * best-effort step. Windows only grants foreground rights to the process that owns the current
 * input, so the thread-attach dance is what makes SetForegroundWindow actually take.
 *
 * The window is found by herdr's own title first (`HUB: <workspace>`), then by falling back to
 * Windows Terminal. A herdr client hosted by some other terminal simply does not get raised;
 * the workspace switch already happened, so the caller reports `raised: false` and nothing else.
 */
export const RAISE_HERDR_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
Add-Type @"
using System;using System.Runtime.InteropServices;
public class SubtrackRaise {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a,uint b,bool attach);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,IntPtr pid);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public static bool Focus(IntPtr h){
    if(IsIconic(h)) ShowWindow(h,9);
    uint fg=GetWindowThreadProcessId(GetForegroundWindow(),IntPtr.Zero); uint me=GetCurrentThreadId();
    AttachThreadInput(fg,me,true); BringWindowToTop(h); bool ok=SetForegroundWindow(h); AttachThreadInput(fg,me,false);
    return ok; }
}
"@
$w = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like 'HUB:*' } | Select-Object -First 1
if (-not $w) { $w = Get-Process -Name WindowsTerminal | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1 }
if (-not $w) { 'no-window' } elseif ([SubtrackRaise]::Focus($w.MainWindowHandle)) { 'raised' } else { 'refused' }
`;

/**
 * Open a window: switch the herdr client to the pane's workspace and tab, then bring the terminal
 * to the front. This is the one thing subtrack does *to* a window — it still never types into it,
 * compacts it, or clears it.
 */
export function makeFocusWindow(deps: { run: HerdrRunner; pwsh?: PwshRunner }): (req: FocusRequest) => Promise<FocusResult> {
  return async (req) => {
    const pane = String(req?.pane ?? '').trim();
    if (!PANE_ID.test(pane)) throw new Error('pane required, e.g. w62:p1');
    const { panes, warning } = await listPanes(deps.run);
    const found = panes.find((p) => p.paneId === pane);
    if (!found) throw new Error(warning ?? `herdr has no pane ${pane}`);

    const warnings: string[] = [];
    if (found.workspaceId) {
      const r = await deps.run(['workspace', 'focus', found.workspaceId]);
      if (r.code !== 0) throw new Error(`herdr could not focus ${found.workspaceId}: ${(r.stderr || r.stdout).trim().slice(0, 160)}`);
    }
    // A workspace can hold several tabs; the pane's own tab has to win, but a failure here still
    // leaves the operator on the right workspace, so it is a warning rather than an error.
    if (found.tabId) {
      const r = await deps.run(['tab', 'focus', found.tabId]);
      if (r.code !== 0) warnings.push(`tab ${found.tabId} not focused`);
    }

    let raised = false;
    if (deps.pwsh) {
      const r = await deps.pwsh(RAISE_HERDR_SCRIPT);
      raised = /raised/.test(r.stdout);
      if (!raised) warnings.push('herdr window not brought to the front');
    }
    return { ok: true, pane, workspaceId: found.workspaceId, raised, warning: warnings.join(' · ') || null };
  };
}
