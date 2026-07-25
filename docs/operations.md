# Operations runbook

This runbook covers the current Windows always-on implementation. It describes what the commands actually do, including their optimistic success messages and the current dirty working-tree lock behavior. For configuration fields and service-manifest schemas, see [Configuration](configuration.md). For local trust and credential boundaries, see [Security](security.md). For the source layout and verification workflow, see [Development](development.md).

Commands below assume PowerShell in the repository root. The source checkout has no installed `subtrack` binary, so the explicit form is used:

```powershell
npx tsx src/cli.ts <command>
```

The dashboard is loopback-only. Diagnose it with `127.0.0.1`, even though user-facing output opens or prints `localhost`.

## Prerequisites

The always-on path requires:

- Windows with Windows PowerShell (`powershell.exe`), WScript, and Task Scheduler available;
- an interactive current-user session; the task uses `LogonType Interactive` and never runs as SYSTEM;
- Node.js 24, npm dependencies installed with `npm ci`, and a stable repository path;
- a usable `~/.subtrack/accounts.json`; see [Configuration](configuration.md).

The VBS launcher records the current absolute Node executable, CLI path, and repository root. If Node moves, the checkout moves, or dependencies are reinstalled elsewhere, run `uninstall` and then `install` from the new location.

On a completely fresh profile, the current installer tries to write the VBS file before it creates `~/.subtrack`. If installation fails with a missing-directory error, create the directory and retry:

```powershell
New-Item -ItemType Directory -Force (Join-Path $env:USERPROFILE '.subtrack') | Out-Null
npx tsx src/cli.ts install
```

## Always-on topology

```text
Windows Scheduled Task: subtrack-dashboard
  at logon + best-effort 30-minute repetition
    -> wscript.exe ~/.subtrack/subtrack-daemon.vbs
       VBS exits immediately after a hidden detached launch
        -> node --import tsx src/cli.ts daemon
           owns daemon.lock and subtrack.log
           supervises one child
            -> node --import tsx src/cli.ts serve --no-open
               Usage poller + Sessions scanner + Services provider + HTTP server
                -> http://127.0.0.1:<configured-port>
```

The Scheduled Task, daemon, and dashboard are three different states:

| Layer | Evidence | What it does not prove |
| --- | --- | --- |
| Scheduled Task | `Get-ScheduledTask` finds `subtrack-dashboard` | That the daemon or dashboard is alive. The task normally becomes `Ready` after its short VBS action exits. |
| Daemon | `daemon.lock` contains a PID that currently exists | That the PID is still subtrack, that its child is healthy, or that the lock is current. Windows can recycle PIDs. |
| Dashboard | `GET /api/health` returns HTTP 200 with `{"ok":true}` | That Task Scheduler is installed or that a daemon owns the server; it may be a foreground instance. |

Common combinations are:

| Task | Daemon | Dashboard | Interpretation |
| --- | --- | --- | --- |
| Installed/Ready | Live lock PID | Healthy | Normal always-on state. |
| Installed/Ready | None | Down | The launch has not happened, was killed, or failed. A later repetition may retry. |
| Installed/Ready | Live lock PID | Down | Startup, a hung child, a port conflict, a stale/recycled PID, or overlapping supervisors. Inspect before killing anything. |
| Absent | None | Healthy | Usually a foreground `serve`, or an orphaned process after an incomplete uninstall. |
| Absent | None | Down | Fully stopped, assuming there is no untracked process. |

## Operational files

All default paths are under the current user's profile:

| Path | Purpose | Lifecycle |
| --- | --- | --- |
| `~/.subtrack/accounts.json` | Account, port, and polling configuration | Loaded once by each `serve` process. |
| `~/.subtrack/services.json` | Curated Services manifest | Loaded on each uncached Services rebuild. |
| `~/.claude/projects`, `~/.claude-accounts/*/projects`, configured Claude `readonly` homes | Provider-owned Claude work-session JSONL files | Read-only metadata source for Sessions; subtrack does not create or modify it. Owned Usage homes are excluded as resume targets. |
| `~/.codex/state_5.sqlite`, configured Codex homes | Provider-owned Codex thread database; optional adjacent `session_index.jsonl` | Opened read-only on each uncached Sessions rebuild. |
| `~/.subtrack/subtrack-daemon.vbs` | Hidden detached launcher with absolute source/runtime paths | Written by `install`; removed best-effort by `uninstall`. |
| `~/.subtrack/daemon.lock` | Plain-text daemon PID | Atomically created by the daemon; not a process-identity proof. |
| `~/.subtrack/logs/subtrack.log` | Daemon and child stdout/stderr | Appended while the daemon runs. |
| `~/.subtrack/logs/subtrack.log.1` | One rotated predecessor | Created when a new daemon starts and the current log is already over 5 MiB. |

Rotation is checked only when the daemon starts, not continuously. The `logs` command reads only `subtrack.log`, not `.1`.

## Install

Install dependencies, ensure configuration exists, then register and start the task:

```powershell
npm ci
npx tsx src/cli.ts install
```

`install` performs these operations:

1. writes `subtrack-daemon.vbs` with the current absolute Node, CLI, and repository paths;
2. registers `subtrack-dashboard` with `-Force` for the current `DOMAIN\USER`;
3. uses an at-logon trigger and attempts to add a 30-minute repetition; Windows builds that reject repetition on a logon trigger are silently accepted;
4. sets `StartWhenAvailable`, battery-friendly settings, `MultipleInstances IgnoreNew`, and no execution-time limit;
5. starts the Scheduled Task.

The command is asynchronous. Its success message proves that PowerShell returned the `INSTALLED` sentinel, not that the daemon acquired its lock or the dashboard became healthy. Verify after a few seconds:

```powershell
npx tsx src/cli.ts status
Invoke-RestMethod -Uri 'http://127.0.0.1:7777/api/health' -TimeoutSec 2
```

Replace `7777` with the configured port. `status` exits `0` only when the health probe succeeds; an installed task alone is not success.

## Start

Start an already installed Scheduled Task:

```powershell
npx tsx src/cli.ts start
```

`start` returns after Task Scheduler accepts `Start-ScheduledTask`. It does not wait for daemon or HTTP health. Follow it with `status`, the IPv4 health probe, and logs if the dashboard stays down.

If a healthy dashboard already answers on the configured port, a newly launched daemon exits as a no-op. Any service that returns HTTP 200 with JSON containing `"ok": true` can also be mistaken for subtrack; extra response fields do not prevent the false match.

## Status and health

```powershell
npx tsx src/cli.ts status
Invoke-RestMethod -Uri 'http://127.0.0.1:7777/api/health' -TimeoutSec 2
Get-ScheduledTask -TaskName 'subtrack-dashboard' -ErrorAction SilentlyContinue
Get-ScheduledTaskInfo -TaskName 'subtrack-dashboard' -ErrorAction SilentlyContinue
```

The CLI reports dashboard health, a live PID from the lock, the log path, and selected task data. Interpret it carefully:

- `Dashboard: up` is the strongest runtime signal and determines the command's exit code.
- `Daemon: running` means only that the lock's numeric PID currently exists.
- `Task: Ready` is normal after the VBS exits and is not the daemon state.
- a PowerShell task-query failure is currently presented like task absence;
- `NEXTRUN` is queried internally but not displayed, so `status` cannot confirm that the best-effort repetition was accepted.

Use `127.0.0.1`, not `localhost`, for diagnosis. The server binds only IPv4 loopback, while Windows may resolve `localhost` to IPv6 `::1` first.

## Logs

```powershell
npx tsx src/cli.ts logs
npx tsx src/cli.ts logs --lines 100
Get-Content (Join-Path $env:USERPROFILE '.subtrack\logs\subtrack.log.1') -Tail 100
```

The default is 40 lines. Supply a positive integer to `--lines`; the parser does not validate negative values and a bare `--lines` is interpreted as one line. The command reads the entire current file to retain its tail. Any read failure, including permission or I/O failure, is currently reported as “No log yet,” so verify the path directly when that message is surprising.

Useful daemon lines include child spawn, child exit code, restart delay, shutdown, and detection of another healthy instance. Provider and server output is appended to the same file.

## Stop

```powershell
npx tsx src/cli.ts stop
```

This is a temporary process stop, not a durable pause:

- it reads the lock PID and accepts any currently live process with that PID;
- it invokes `taskkill /PID <pid> /T /F` to kill the daemon tree;
- it does not inspect process identity or check `taskkill`'s result;
- it deletes the lock and prints success even if the kill failed;
- if the lock PID is absent or dead, it prints “not running” and leaves a stale lock in place;
- it leaves `subtrack-dashboard` installed and enabled, so the next repetition or logon can start it again.

Before using `stop` when the lock may be old, inspect the process as shown in [Safe diagnosis and recovery](#safe-diagnosis-and-recovery). PID reuse means a stale lock can otherwise target an unrelated process. For a durable stop through the current CLI, use `uninstall` and verify the resulting state.

## Uninstall

```powershell
npx tsx src/cli.ts uninstall
```

`uninstall` calls `stop`, unregisters the Scheduled Task, and removes the VBS file best-effort. Its success output is optimistic: it ignores the return from `stop`, suppresses unregister errors, uses a permissive sentinel check, and does not verify task absence or HTTP shutdown.

Always post-verify:

```powershell
Get-ScheduledTask -TaskName 'subtrack-dashboard' -ErrorAction SilentlyContinue
Invoke-RestMethod -Uri 'http://127.0.0.1:7777/api/health' -TimeoutSec 2
```

The first command should return nothing. The health request should fail after any foreground or orphaned server is also stopped. Uninstall does not remove `accounts.json`, `services.json`, credential homes, or logs.

## Restart after configuration or code changes

`serve` reads `accounts.json` exactly once. Restart after account addition, removal, rename, enablement changes, port changes, or polling/UI interval changes:

```powershell
npx tsx src/cli.ts stop
npx tsx src/cli.ts start
npx tsx src/cli.ts status
```

Apply the stop safety checks when the lock is suspect, and remember that both management success messages are optimistic. A code change also requires a child-process restart because Node has already loaded the TypeScript modules.

Static files under `web/` are read from disk per request, so a browser can observe a new UI while the old server API is still running. Restart after any coordinated UI/API change to avoid a mixed version.

Provider-owned session stores and `services.json` are different: they are reread on their next uncached rebuild and normally need no server restart. Sessions has a 15-second response cache and a 15-second browser refresh; Services has a 10-second provider cache plus a 15-second browser refresh. Account-label/home mapping still comes from startup-loaded `accounts.json` and therefore does require restart.

## Sessions refresh and diagnosis

Sessions is a read-only index over existing Claude/Codex local stores. It has no manifest, database, archival operation, or resume-execution endpoint of its own. The UI copies a quoted PowerShell command; it does not run it.

Inspect the response without executing any resume command:

```powershell
$sessions = Invoke-RestMethod -Uri 'http://127.0.0.1:7777/api/sessions' -TimeoutSec 10
$sessions | Select-Object generatedAt, recentHours, partial
$sessions.warnings
$sessions.windows | Select-Object pid, accountLabel, project, cwd, binding, sessionId
```

The raw response is sensitive because it contains exact paths, account/project titles, session IDs, PIDs, and resume commands. Do not paste it into a public issue or log.

Interpret state conservatively:

- `open` is emitted only when a Claude session UUID is tied to a live inspected Claude process;
- `launch` is the UUID used to launch the process and can be stale after `/clear`;
- `likely` is a unique home/cwd/start-time heuristic rather than authoritative process state;
- `recent` is timestamp activity within the response's `recentHours` (24 by default), not proof that any window is open; this is the only live-looking signal available for Codex history;
- `partial: true` means successful stores are still present but one or more Claude homes, Codex databases, or live-window probes produced warnings.

New provider activity normally appears after the 15-second response cache expires and the next 15-second UI request. Unchanged Claude file metadata is reused by path/size/mtime. If activity is absent after that window, inspect `warnings`, confirm the source store exists under the expected profile/configured home, and restart only if `accounts.json` labels/homes or server source changed.

Live Claude correlation is Windows-only and depends on observed x64 PEB offsets. A Windows/Claude update can therefore leave persistent session history working while `windows` is empty or a warning appears. Codex has no current live-process/thread correlation at all. Do not “fix” either case by deleting, copying, or editing provider transcripts/databases.

## Crash recovery, backoff, and self-heal

The daemon supervises process exit, not continuous health:

- it starts `serve --no-open` with the repository root as the working directory;
- a short-lived child restarts after 2, 4, 8, 16, 32, then at most 60 seconds;
- a child that lived at least 30 seconds resets the next delay to 2 seconds;
- after a child exit, the daemon checks whether another healthy dashboard took the port and exits if so;
- a child that remains alive but stops answering is not killed or restarted by the owning daemon;
- external recovery depends on a later Scheduled Task launch, and the 30-minute repetition is best-effort rather than guaranteed.

### Current dirty lock-takeover behavior

At the time this runbook was written, `src/daemon.ts` and `tests/daemon.test.ts` contain uncommitted user changes. In this current dirty working tree, after health has failed:

- a live-PID lock younger than 30 seconds is treated as another daemon booting, so the new daemon stands down;
- a lock at least 30 seconds old is removed even when its PID is alive, and a new daemon takes it over;
- the old process is not terminated before takeover.

This can bypass a stale or recycled-PID lock when no old listener remains. It does not terminate the old lock PID. If an old child still owns the configured port, the replacement child can enter an `EADDRINUSE` restart loop; if the port is free, a replacement may restore HTTP service but leaves overlapping supervisors to reconcile.

Takeover can also create overlapping supervisors when a legitimate startup takes more than 30 seconds or an old supervisor is still alive. Both supervisors retain unconditional lock cleanup paths, so the old supervisor can later delete the new supervisor's lock and permit a third start. The focused dirty tests cover only fresh-versus-old acquisition; they do not prove safe overlapping lifecycle or port ownership.

This is provisional working-tree behavior rather than the committed baseline. Because subtrack executes TypeScript source directly, it becomes runtime behavior as soon as a daemon loads the dirty source; a commit is not required for activation. Do not rely on it as an automatic recovery guarantee, and do not overwrite, reset, checkout, or “repair” these files as part of operations work; inspect and preserve the user's dirty diff.

## Port collisions

When an unrelated listener owns the configured port and does not return subtrack health, `serve` fails its bind with `EADDRINUSE`. Under the daemon this appears as repeated child exits and escalating restart delays. If the listener happens to return HTTP 200 with `{"ok":true}` at `/api/health`, the daemon falsely treats it as an existing dashboard and exits cleanly.

Identify the owner before changing anything:

```powershell
$port = 7777
Get-NetTCPConnection -State Listen -LocalPort $port |
  Select-Object LocalAddress, LocalPort, OwningProcess
```

Then inspect the owning PID with `Get-CimInstance` or `Get-Process`. Do not kill it solely because it owns the port. Either stop the known in-scope process or change `accounts.json` to a free port and restart subtrack.

## Services manifest: first run and cache

The first uncached request to `/api/services` gathers one Windows snapshot. If `~/.subtrack/services.json` does not exist, subtrack writes a version-1 manifest seeded from every captured non-Microsoft Scheduled Task. Current seeding does not add listening ports or processes.

Treat the seed as a first draft:

1. review labels, groups, `alwaysOn`, kinds, task names, ports, matches, and HTTP paths;
2. remove irrelevant tasks and add intended port, process, or HTTP definitions manually;
3. keep IDs unique and treat regexes and HTTP definitions as trusted local input; the current HTTP probe concatenates its port/path and follows redirects, so an `@host` path or redirect can leave loopback;
4. use the schema and examples in [Configuration](configuration.md).

An already existing empty manifest remains empty; it is never automatically reseeded. Successful responses are cached for 10 seconds and simultaneous cache misses share one build. The cache timestamp advances only on success. A failed rebuild does not serve an older cached response as stale; the API returns an error instead. PowerShell collection suppresses many individual errors, so missing rows can also reflect acquisition failure.

The Services UI requests every 15 seconds. Its action named `restart` currently calls only `Start-ScheduledTask`; it is not a stop-then-start sequence. `stop` calls `Stop-ScheduledTask`. Process adoption registers with `-Force`, a sanitized task name, simplified command-line parsing, and an executable-directory working-directory guess; a name collision can replace another accessible task, and captured arguments can persist secrets. It does not add a service definition, start the task, stop the source process, add the daemon's repetition trigger, or prove the original working directory. Actions do not invalidate the 10-second Services cache, so the immediate UI refresh can still show the pre-action snapshot. There is no configuration switch that enables these controls separately; review [Security](security.md) before using a state-changing action.

## Hermes fleet monitoring and recovery

When `~/.subtrack/hermes.json` is enabled, the `serve` child starts the Hermes monitor independently of browser/API traffic. The defaults are:

- authoritative gateway/process/platform checks every 120 seconds;
- a live OpenAI usage probe at most every 300 seconds per shared subscription;
- one sequential real-model canary every 6 hours per shared subscription, with a 30-minute failure retry;
- safe restart after two consecutive confirmed runtime failures, then a 30-minute per-profile cooldown and at most three attempts per rolling hour.

The runtime check compares the `gateway.pid` PID/kind/start time with one live Hermes Python command containing the exact profile and `gateway run`, detects duplicate matching gateways, then requires a matching `gateway_state.json`. It also requires the profile `.env` to name the assigned canonical store exactly; if `.env` is newer than the verified process, the row stays degraded until that gateway is restarted and has loaded the new binding. Telegram profiles require `platforms.telegram.state=connected`; a profile without Telegram may be healthy with `platforms={}`. `gateway_state.updated_at` is not an idle heartbeat and is never aged into a failure.

Auto-discovery rescans `profileRoot` each cycle. A newly installed profile bound through `HERMES_CODEX_AUTH_FILE` to a configured canonical store appears automatically. Every must-exist profile should also be pinned in `profileOverrides`, so deletion remains a visible outage instead of shrinking the denominator. Each store is read structurally, checked against its configured account pin and JWT claim, and probed live. Tokens are never written by subtrack. The real-model canary runs the configured Hermes executable only after the canonical pin, JWT account claim, refresh token, relogin flag, and selected profile binding prove Hermes is the correct sole owner.

Recovery is deliberately narrow:

- only a confirmed missing runtime increments the restart counter;
- failed/timed-out Windows acquisition, unavailable command metadata, stale/reused identity, duplicate gateways, unreadable monitor state, planned stop, Telegram retrying, 401/403, missing refresh token, account mismatch, or an inexact profile/store binding does not cause restart even when the gateway is also missing;
- restart and canary retry reservations are atomically saved before invoking Hermes, so a Subtrack/PC crash cannot erase the cooldown window;
- recovery invokes `hermes.exe --profile <name> gateway restart`; it does not call `Start-ScheduledTask` and never auto-runs login;
- Hermes owns planned-stop drain, bounded termination, duplicate avoidance, relaunch, and readiness verification.

Inspect the live public projection and local state with:

```powershell
$services = Invoke-RestMethod -Uri 'http://127.0.0.1:7777/api/services' -TimeoutSec 10
$services.services | Where-Object kind -eq 'hermes' |
  Select-Object label,status,detail,pid,subscription,checkedAt,autoHeal,consecutiveFailures

Get-Content "$env:USERPROFILE\.subtrack\hermes-monitor-state.json" -Raw
Get-Content "$env:USERPROFILE\.subtrack\logs\hermes-monitor.jsonl" -Tail 30
```

The state and JSONL log are sanitized but still reveal local profile/account labels and incident timing. A successful fleet row means the last background snapshot passed; its own `checkedAt` is authoritative, not the Services response `generatedAt`.

Optional `heartbeatUrl` and `alertWebhookUrl` POST compact JSON and are best-effort. Use an external VPS dead-man service if whole-PC power, sleep, network loss, or Subtrack death must be detected: a local monitor cannot notify while its host is offline. Protect webhook URLs as credentials and never expose the loopback dashboard directly to the VPS/LAN.

## Safe diagnosis and recovery

Start with evidence and avoid blind PID or lock cleanup:

```powershell
npx tsx src/cli.ts status
npx tsx src/cli.ts logs --lines 100

$healthUri = 'http://127.0.0.1:7777/api/health'
try { Invoke-RestMethod -Uri $healthUri -TimeoutSec 2 } catch { $_.Exception.Message }

$lock = Join-Path $env:USERPROFILE '.subtrack\daemon.lock'
$daemonPid = $null
if (Test-Path $lock) {
  $rawPid = (Get-Content $lock -Raw).Trim()
  [int]$parsedPid = 0
  if ([int]::TryParse($rawPid, [ref]$parsedPid)) { $daemonPid = $parsedPid }
  else { Write-Warning "Malformed daemon lock PID: $rawPid" }
}
if ($daemonPid) {
  Get-CimInstance Win32_Process -Filter "ProcessId = $daemonPid" |
    Select-Object ProcessId, ParentProcessId, Name, CommandLine
}

Get-ScheduledTask -TaskName 'subtrack-dashboard' -ErrorAction SilentlyContinue
Get-ScheduledTaskInfo -TaskName 'subtrack-dashboard' -ErrorAction SilentlyContinue
Get-NetTCPConnection -State Listen -LocalPort 7777 -ErrorAction SilentlyContinue |
  Select-Object LocalAddress, LocalPort, OwningProcess
```

Replace the port before running the probes. Confirm that a lock PID's command line is the expected Node/tsx `src/cli.ts daemon` process before allowing `stop` to kill its tree.

For a known subtrack daemon whose dashboard is down:

1. preserve `src/daemon.ts` and `tests/daemon.test.ts` if `git status` shows user changes;
2. save current status, health, task, port-owner, lock-owner, and log evidence;
3. if the lock owner is verified as subtrack, run `stop`, then confirm both the PID and child are gone;
4. run `start`, wait a few seconds, and verify `127.0.0.1` health;
5. if the child repeatedly exits, inspect the log for bind, config, module-resolution, or provider errors rather than repeating `start`;
6. if a durable pause is required, run `uninstall` and verify task absence and health failure;
7. reinstall after a checkout or Node path change.

Never delete `daemon.lock` while a legitimate daemon may still be running. Lock deletion alone does not stop it and can allow a second supervisor.

## Troubleshooting table

| Symptom | Likely explanation | Safe next action |
| --- | --- | --- |
| `localhost` fails but the process appears healthy | IPv6 `::1` was tried while subtrack listens on IPv4 only | Probe `http://127.0.0.1:<port>/api/health`. |
| `install` or `start` says success, but health is down | Both commands are asynchronous and do not wait for health | Wait briefly, then inspect `status`, logs, lock owner, and port owner. |
| Task is `Ready`, dashboard is up | Normal: the VBS launcher already exited | No recovery action is needed. |
| Task is installed, daemon is absent, dashboard is down | Launch failure, killed daemon, or best-effort repetition unavailable | Run `start`, then verify health and inspect logs. |
| Daemon is “running,” dashboard is down | Starting, hung child, stale/recycled PID, port conflict, or overlapping supervisors | Inspect the lock PID command line and port owner before stop/restart. |
| `stop` says stopped, but the dashboard remains or returns | Kill failure, foreground instance, orphan, or Scheduled Task repetition | Verify PID/port ownership; use `uninstall` for durable removal and post-verify. |
| `stop` says not running but `daemon.lock` exists | Dead/stale PID; current stop does not remove it | Do not delete blindly. Confirm no daemon process, then let a verified start path handle it or remove only after identity checks. |
| Logs show 2/4/8/16/32/60-second restarts | Child exits before the 30-second healthy-run threshold | Fix the first recurring startup error; do not loop `start`. |
| Logs show `EADDRINUSE` or repeated immediate exits | Configured port is occupied | Identify the owner, then stop that known process or choose another port and restart. |
| Config/account rename is not reflected | `accounts.json` was loaded at process start | Restart the `serve` child. |
| New web UI is visible but new API data is absent | Static files changed without restarting old server modules | Restart after coordinated UI/API changes. |
| Sessions history changed but the page is briefly stale | 15-second Sessions response cache plus 15-second UI polling | Wait for cache expiry and the next refresh; no restart is normally needed. |
| Sessions shows `recent` Codex work but no open window | `recent` is a database timestamp heuristic, not liveness | Use title/cwd/ID to identify the work; do not interpret it as a running Codex process. |
| Sessions reports `partial` or has no live Claude windows | A store read failed or the observed Windows PEB correlation no longer worked | Read `warnings`; verify paths/permissions and Claude version while preserving provider stores. |
| Services is empty on first visit | No non-Microsoft tasks were captured, or an empty manifest already existed | Inspect and curate `services.json`; current seed never adds ports/processes. |
| Services changes are not immediate | 10-second provider cache and 15-second UI polling | Wait for cache expiry and the next browser refresh; no server restart is normally needed. |
| Services intermittently disappears | Snapshot/manifest/probe build failed and no stale cache is served | Inspect server logs, JSON validity, PowerShell availability, regexes, and HTTP definitions. |
| Hermes fleet says `first check pending` | The daemon has just loaded or two sequential canaries are still running | Wait for the first cycle, then inspect `hermes-monitor.jsonl` and the daemon log. |
| Hermes fleet says initialization failed | `hermes.json` or initial monitor state could not be loaded | The dashboard remains available and retries every 60 seconds; fix the file, then confirm the fallback row is replaced. |
| Hermes fleet says automatic recovery is blocked | Monitor state was malformed/unreadable at process start | Inspect the incident log/state path, then restart Subtrack after the state file is valid; do not delete it casually. |
| Hermes profile is `down`, failures are `1` | First confirmed runtime miss; hysteresis intentionally suppressed recovery | Wait for the next 120-second independent check; do not start a duplicate manually. |
| Hermes profile says Telegram retrying/disconnected | Gateway process is alive but the required platform is not ready | Inspect that profile's `logs/gateway.log`; auto-restart is intentionally not triggered by platform state alone. |
| Hermes auth is `down` with 401/account mismatch | Canonical token chain or A/B binding is wrong | Do not restart gateways. Verify the configured canonical path/pin and use the owning Hermes login flow only if the shared refresh chain cannot recover. |
| All local Hermes rows disappear with the PC | Expected limitation: the monitor is on the same host | Configure an external heartbeat/dead-man endpoint. |
| `logs` says no log, but one should exist | Any log read error is collapsed into the same message | Check file existence and permissions directly, and inspect `.1`. |
| Task query appears “not installed” unexpectedly | Query errors are collapsed into absence | Run `Get-ScheduledTask` directly and inspect the PowerShell error. |

## Known operational limits

- The implementation has no durable pause command; `stop` can be undone by the installed self-heal trigger.
- Management commands do not provide transactional install/uninstall or verified postconditions.
- The daemon monitors child exit, not a live child's health.
- The PID lock has no executable identity, start time, or nonce and is vulnerable to PID reuse.
- Current dirty live-PID takeover can overlap supervisors, fail to recover a port-owning wedged child, and let an old supervisor remove a newer supervisor's lock during cleanup.
- Log rotation is one-deep and startup-only.
- The Scheduled Task repetition is best-effort and its presence is not surfaced by CLI status.
- A process already answering the minimal health shape can cause a false single-instance result.
- Sessions is a best-effort metadata index: live Claude mapping can drift with Windows/Claude internals, Codex liveness is unavailable, and copied resume commands are not preflighted or executed.
- Services collection and action handling are local best-effort Windows integrations, not a durable service manager.
- Hermes auto-heal covers only confirmed gateway runtime outages. It cannot repair revoked credentials/account mismatch, guarantee Telegram/provider availability, or detect whole-host outage without an external heartbeat receiver.
