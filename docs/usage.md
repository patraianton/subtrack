# Usage and CLI guide

This guide covers installing and running subtrack, managing Claude and Codex accounts, reading the Usage, Sessions, and Services pages, and interpreting command results. Configuration-file fields belong in the [configuration reference](configuration.md); discovery and recovery procedures belong in [operations](operations.md).

## Requirements

- Node.js 24 and npm.
- A local checkout of this repository. There is no compiled distribution; TypeScript runs directly through `tsx`.
- Claude Code on `PATH` for an interactive Claude login, or a Claude setup token for static-token mode.
- Codex CLI on `PATH` for Codex login.
- Windows for live Claude-window correlation, always-on Task Scheduler commands, and the Services collector/actions.
- A modern JavaScript-enabled browser.

All examples below use PowerShell and assume the current directory is the repository root:

```powershell
Set-Location C:\path\to\sub-tracking
```

## Install dependencies

```powershell
npm install
```

Optional verification:

```powershell
npm run typecheck
npm test
```

## Choose an account credential mode

Claude supports three onboarding modes. Codex uses its own isolated login flow.

| Provider and mode | Use when | Credential owner | Refresh/write behavior | Command |
|---|---|---|---|---|
| Claude `owned` | You want a new, dedicated subtrack login | subtrack | Refreshes near expiry and writes rotated tokens back to its isolated home | `add-account <id> --provider claude` |
| Claude `readonly-home` | A separate Claude Code installation already owns and refreshes the home | External Claude Code process | Rereads the access token every poll; never refreshes or writes | `add-account <id> --provider claude --readonly-home <dir>` |
| Claude `static-token` | You have a `claude setup-token` and do not want an interactive subtrack login | Static credential supplied by you | Stores the token in an isolated home as read-only; never refreshes it | `add-account <id> --provider claude --static-token`, token on stdin |
| Codex isolated login | You want a separate Codex account | Codex CLI login in the isolated home | subtrack reads `auth.json`; it does not implement Codex refresh | `add-account <id> --provider codex` |
| Grok cookie | You track a SuperGrok subscription (grok.com has no CLI login) | Browser session cookie pasted by you into `cookie.txt` | Rereads the cookie every poll; never refreshes or writes it | `add-account <id> --provider grok` |

Choose exactly one Claude mode. Do not combine `--readonly-home` and `--static-token`. Use simple unique IDs such as `claude-work` or `codex-personal`; IDs become configuration keys and directory names, and the CLI does not fully validate path-like IDs.

### Claude owned mode

```powershell
npx tsx src/cli.ts add-account claude-work --provider claude --label "Claude work"
```

The command creates `%USERPROFILE%\.subtrack\claude-homes\claude-work`, launches Claude Code with that directory as `CLAUDE_CONFIG_DIR`, and prints the onboarding steps:

1. Run `/login` inside Claude Code.
2. Sign in with the intended account.
3. Run `/exit` to return to subtrack.

Use `/exit`, not Ctrl+C. If onboarding was interrupted after credentials were written but before the account was registered, run the same command again. It detects the existing token in that isolated home and completes registration without another login.

Owned mode is the only mode in which subtrack may refresh Claude credentials. Do not point two subtrack processes at the same owned home and do not reuse a live external Claude home as owned; Claude refresh tokens rotate and are single-use.

### Claude read-only external home

Use this for a home already managed by another Claude Code process:

```powershell
$claudeHome = 'C:\Users\you\.claude-accounts\work'
npx tsx src/cli.ts add-account claude-external --provider claude --readonly-home $claudeHome --label "Claude external"
```

The directory must contain `.credentials.json` with `claudeAiOauth.accessToken`. subtrack records the path, rereads the file on every poll, and has no refresh or write capability in this mode.

If the file has a known expired `expiresAt`, the account becomes `stale` without calling the usage API. Refresh or log in through the external owner; subtrack will notice the updated file on a later normal poll.

### Claude static setup token

Pipe the token directly into stdin:

```powershell
claude setup-token | npx tsx src/cli.ts add-account claude-static --provider claude --static-token --label "Claude static"
```

Do not put the token in an argument, environment-variable assignment saved in a script, or pasted command that can enter shell history. subtrack stores it in `%USERPROFILE%\.subtrack\claude-homes\claude-static\.credentials.json` without a refresh token or local expiry and marks the account read-only. The provider can still revoke or reject it; “static” means subtrack will not rotate it, not that access is guaranteed forever.

Current code can use a setup token for usage reads. Older project notes claiming setup tokens are categorically unsupported are historical and must not be used as current guidance.

### Codex isolated login

```powershell
npx tsx src/cli.ts add-account codex-work --provider codex --label "Codex work"
```

The command creates `%USERPROFILE%\.subtrack\codex-homes\codex-work`, launches `codex login` with that directory as `CODEX_HOME`, and registers the account only after a readable `auth.json` contains an access token. A cancelled login returns an error without registering a broken card. subtrack reads `auth.json` on each usage request but does not refresh Codex credentials.

If login was cancelled, an older checkout already saved a broken entry, or the login file later disappears, re-run the same command. It reuses the account's configured home, launches the isolated login, verifies the result, and preserves the existing label:

```powershell
npx tsx src/cli.ts add-account codex-work --provider codex --label "Codex work"
```

For an existing Codex ID, the repeated command intentionally relaunches login even when an old `auth.json` remains, because a present token can still be expired or revoked. A cancelled repair preserves the existing configuration and reports failure rather than claiming success. Removal still does not delete an isolated home, so protect or remove obsolete credential directories separately and deliberately.

### Grok cookie account

```powershell
npx tsx src/cli.ts add-account grok-main --provider grok --label "Grok main"
```

The first run creates `%USERPROFILE%\.subtrack\grok-homes\grok-main` and prints paste instructions: in a logged-in grok.com browser tab, open DevTools → Network → refresh → click any grok.com request → copy the `cookie` request-header value into `cookie.txt` in that directory, then re-run the same command. Registration probes the live rate-limits endpoint first, so a rejected cookie registers nothing. The card's session bar is the grok-4 two-hour allowance; its reset countdown appears only once the window is exhausted, because the endpoint reports no reset time before that. When grok.com rejects the cookie, the card shows `auth_error` until you re-copy the value — subtrack has no way to refresh it.

An externally owned Hermes shared Codex store is a manual advanced configuration, not an `add-account` mode. Point `credentialsHome` at the directory containing the canonical `auth.json`, set `credentialsMode: readonly`, and configure the same path/account pin in `hermes.json`. Subtrack then reads Usage but refuses to launch `codex login` in that directory; refresh and re-login remain exclusively with Hermes.

## Inspect and maintain accounts

### List

```powershell
npx tsx src/cli.ts list
```

Each row shows enabled (`●`) or disabled (`○`), ID, provider, a best-effort email read from the isolated home, and label. There is no CLI enable/disable command; see [configuration](configuration.md) for the `enabled` field.

### Rename

```powershell
npx tsx src/cli.ts rename claude-work "Claude consulting"
```

The equivalent flag form is:

```powershell
npx tsx src/cli.ts rename claude-work --label "Claude consulting"
```

Rename changes only the display label. It does not move credentials or change the account ID.

### Remove

```powershell
npx tsx src/cli.ts remove-account claude-work
```

This removes matching account metadata from `%USERPROFILE%\.subtrack\accounts.json`. It does **not** delete the credential home or revoke provider credentials. The current command also reports success for an unknown ID, so run `list` afterward when confirmation matters.

### Restart after configuration changes

The server loads `accounts.json`, the port, and polling settings once at startup. A running dashboard will not notice add, rename, remove, enable/disable, port, or interval changes until restarted.

For a foreground server, press Ctrl+C and run `npm start` again. For always-on mode:

```powershell
npx tsx src/cli.ts stop
npx tsx src/cli.ts start
npx tsx src/cli.ts status
```

`start` is asynchronous, so wait a few seconds and use `status` or `logs` to verify health. `stop` is not a durable disable: the Scheduled Task remains installed and its best-effort self-heal trigger may start the daemon later.

## Run the dashboard

### Foreground

```powershell
npm start
```

This is equivalent to:

```powershell
npx tsx src/cli.ts serve
```

It starts the poller and HTTP server, binds only to `127.0.0.1`, and opens `http://localhost:<configured-port>` in the default browser. For direct access and health checks, the default IPv4 URL is [http://127.0.0.1:7777](http://127.0.0.1:7777).

To suppress browser launch:

```powershell
npx tsx src/cli.ts serve --no-open
```

or:

```powershell
$env:SUBTRACK_NO_OPEN = '1'
npm start
```

Use `127.0.0.1`, rather than `localhost`, for health troubleshooting on Windows because `localhost` can resolve to IPv6 while subtrack listens on IPv4 only.

Do not start a foreground server while the always-on dashboard is active. Even though the second process will eventually fail to bind the port, its poller starts first and could race an owned Claude credential refresh. Check `status` and stop the daemon first.

### One-shot check

```powershell
npm run check
```

Equivalent direct command:

```powershell
npx tsx src/cli.ts check
```

`check` fetches every enabled account once and prints session, weekly, and Fable percentages plus any non-`ok` status. It exits `1` if at least one result is `auth_error`. `throttled`, `stale`, and generic `error` results currently do not make the command fail, so inspect the table rather than relying only on `$LASTEXITCODE`.

### Always-on Windows mode

```powershell
npx tsx src/cli.ts install
npx tsx src/cli.ts status
```

`install` registers the `subtrack-dashboard` Scheduled Task for the current interactive user and starts it. A hidden VBS launcher detaches the daemon; the daemon supervises the foreground server and writes `%USERPROFILE%\.subtrack\logs\subtrack.log`.

Management commands:

```powershell
npx tsx src/cli.ts status
npx tsx src/cli.ts logs
npx tsx src/cli.ts logs --lines 100
npx tsx src/cli.ts stop
npx tsx src/cli.ts start
npx tsx src/cli.ts uninstall
```

Important operational semantics:

- `install` and `start` report that Windows accepted the task operation; they do not wait for `/api/health`.
- `status` separates dashboard health, daemon PID, task state, and log path, but its exit code is based only on dashboard health.
- `stop` force-stops the PID tree referenced by the daemon lock, leaves the Scheduled Task installed, and currently does not verify that termination succeeded.
- `uninstall` is the command intended to remove automatic startup, but its current verification is best-effort. Run `status` afterward.
- The Task Scheduler state may show `Ready` while the detached daemon is running; that is expected for the short-lived VBS launcher.
- The installed task embeds absolute Node, repository, and CLI paths. Run `uninstall` and `install` again after moving the checkout or changing the Node installation used by subtrack.

## Usage page

The Usage tab reads the server's current in-memory snapshot. Refreshing the browser does not trigger a provider request; provider polling runs independently.

### Windows and gauges

Each account can show:

- `session`: approximately five hours (on a Grok card this gauge is labeled `2h · grok-4` and shows the two-hour grok-4 allowance instead);
- `weekly`: approximately seven days (for Grok, the weekly SuperGrok allowance, which includes the `grok` CLI's spend; the row is hidden when that call fails);
- `weekly · opus`: a Claude-only weekly Opus window when present;
- `weekly · fable`: a Claude-only Fable window when present.

Fable access and a Fable window are separate signals. A Claude account with reported access but no usable current window shows a Fable row with an em dash. A Claude account with no reported Fable entitlement shows `no access`. Codex and Grok accounts omit Fable.

The server assigns gauge severity by utilization:

| Utilization | Severity |
|---:|---|
| Below 70% | `ok` |
| 70% through 89.999…% | `warn` |
| 90% or higher | `crit` |

Provider values are not clamped, so unexpected percentages outside 0–100 can still appear if an unofficial response changes.

### Reset times

`resetsAt` is either an ISO timestamp or `null`. `null` means the provider has not anchored a reset, which is common for a fresh 0% window; the UI shows an em dash instead of inventing epoch zero. A reset at or before the browser clock shows `now`.

Countdowns and visible times use the browser's local clock and time zone. They are display aids, not authoritative provider timers.

### Ordering, refresh, and last-known values

- Cards are grouped Claude first, then Codex, then Grok. Within each group, the account whose weekly-class reset (weekly, Opus, or Fable) is nearest comes first; accounts with no known reset sort last, ties break by label. Session resets do not affect ordering.
- The `Tightest` summary selects the highest utilization among the available session, weekly, Opus, and Fable windows.
- The page's `updated` time is the browser receipt/render time, not a provider timestamp.
- The current browser implementation refreshes `/api/usage` every 30 seconds even if `uiRefreshSeconds` is configured differently.
- On connection, parse, or render failure, existing cards stay visible and the page reports `connection lost — retrying`.
- Usage is not persisted. Preserved cards and poller carry-forward are last-known live values, not history.

### Poll and retry behavior

Default provider polling intervals are 180 seconds per Claude account and 60 seconds per Codex or Grok account. Initial accounts are staggered seven seconds apart, and a five-second heartbeat checks which account is due. Due accounts are fetched sequentially, with no overlapping poller tick.

Within one provider attempt, transient transport errors and HTTP 5xx responses are retried up to three total attempts with approximately 400 ms and 800 ms delays. HTTP 4xx responses return immediately. `Retry-After` is not currently honored. Claude also performs one extra credential read/refresh attempt after a 401 when its credential mode permits it.

After normalization, the poller applies these schedules:

| Status | Meaning | Next scheduled poll | What stays visible |
|---|---|---|---|
| `ok` | Current provider request normalized successfully | Normal provider interval | Current windows |
| `throttled` | Provider returned 429 | 5, then 10, then 15 minutes for consecutive throttles (15 thereafter), or the provider's `Retry-After` when it asks for longer, capped at 60 minutes | Last-known windows, plus retry/error metadata |
| `auth_error` | Credentials are missing, refresh failed, or the provider rejected them (`401`; Claude also maps `403` here) | 15 minutes | Last-known windows and current auth error |
| `stale` | A read-only Claude file has a known expired access token | Normal provider interval; no provider call or refresh | Last-known windows and stale-credential error |
| `error` | Transport, parsing, unexpected response, Codex `403`, or other failure | Normal provider interval | Last-known windows and current error |

Any non-`ok` result carries forward the previous session, weekly, Opus, Fable, and Fable-access values. Its status, error, retry time, and `lastUpdated` describe the **new attempt**, so the carried windows may be older than that timestamp.

The UI may also dim a card when its timestamp is older than twice the provider interval. That visual age heuristic is separate from the `stale` credential status.

## Sessions page

The Sessions tab answers “which account, project, folder, and session am I working in?” from local provider-owned history. It is separate from Services: it does not inventory arbitrary programs or act as a Task Manager.

Each session row can include:

- provider, account label/launcher, session UUID, and title;
- inferred Git project, cwd leaf, exact working directory, and branch;
- last activity and one of `open`, `recent`, `idle`, or `archived`;
- live Claude PID when correlated;
- a button that copies a quoted PowerShell resume command.

The page also lists inspected live Claude windows separately. A process without a confident session UUID still appears with its account/project/cwd/PID where available, but it has no resume command. Copying a command does not execute it, launch a window, alter provider state, or validate that credentials and paths still work.

Session history defaults to **Working: open + recent**. The page also provides client-side title/project/folder/account/ID search, a Claude/Codex provider filter, and an **All sessions** scope that includes idle and archived rows.

### Sources and privacy boundary

Sessions reads existing local sources:

- direct `projects/<encoded-cwd>/*.jsonl` session files in the default, numbered, and configured read-only Claude homes; subtrack-owned Usage homes are intentionally excluded as non-interactive resume targets;
- interactive `vscode` / `cli` rows from read-only Codex `state_5.sqlite` databases, with optional local index titles;
- on Windows, minimal live Claude process metadata used to correlate account home, cwd, PID/start time, and a launch resume UUID.

Subtrack creates no session-history database and does not return or persist prompts, user/assistant messages, tool calls/output, full transcripts, full process command lines, or complete environments. It does expose account/project titles, exact local paths, IDs, branches, PIDs, timestamps, and resume commands. Treat the page, copied commands, API responses, and screenshots as sensitive.

### Activity and binding semantics

| Label | Meaning |
|---|---|
| `open` | A Claude session ID is tied to an inspected live Claude process. Codex cannot currently receive this label from process correlation. |
| `recent` | Non-archived transcript/database activity falls within `recentHours`, currently 24 by default. This is activity, not proof of an open window. |
| `idle` | Non-archived activity is older than the recent threshold. |
| `archived` | The Codex database marks the thread archived. |

Live Claude window bindings are deliberately qualified:

- `launch`: the UUID appeared in the process's `--resume` / `-r` launch command. It may be stale after Claude `/clear`.
- `likely`: no launch UUID was available, but exactly one session in the same home and cwd had activity around or after process start.
- `ambiguous`: multiple sessions fit; no session/resume command is asserted.
- `unknown`: no session ID could be inferred.

The live probe depends on observed x64 Windows process-layout offsets. Persistent history remains usable if that probe fails, but the response/page reports a partial warning. There is no live Codex desktop/CLI thread mapping; `recent` Codex work must never be read as “open.”

### Refresh, deduplication, and resume commands

The page requests `/api/sessions` with browser caching disabled immediately and every 15 seconds. Every API response also sends `Cache-Control: no-store`; separately, successful server scans are cached in-process for 15 seconds, with concurrent misses coalesced. New provider activity therefore needs no restart, but can remain briefly cached. Account label/home changes still require restart because `accounts.json` is loaded once. A refresh failure leaves the prior rows visible and reports that Sessions is unavailable/retrying.

Repeated copies of the same provider UUID become one history row, with available Claude launchers retained. Rows sort `open`, `recent`, `idle`, then `archived`, and newest activity first within a status.

The copied commands use the exact stored cwd and session ID:

```powershell
Set-Location -LiteralPath '<cwd>'; ccN --resume '<claude-session-uuid>'
$env:CODEX_HOME='<codex-home>'; codex resume -C '<cwd>' '<codex-session-uuid>'
```

PowerShell single quotes are doubled when needed. Review the account/home/cwd before running a copied command. Sessions does not preflight the launcher, home, credential validity, directory existence, or whether another window is already using the session.

## Services page

The Services tab is the Windows Ops Cockpit. It refreshes `/api/services` every 15 seconds; successful server snapshots are cached for 10 seconds. A refresh error leaves the previous rows in place and reports a generic unavailable/connection message.

### What it inspects

The current collector reads, with the permissions of the subtrack user:

- non-Microsoft-path Windows Scheduled Tasks;
- listening TCP ports below 50000 on IPv4/IPv6 loopback and wildcard addresses;
- command lines for visible `node.exe`, `python.exe`, and `pythonw.exe` processes;
- configured plain-HTTP health paths.

When `~/.subtrack/hermes.json` is enabled, the page also receives the latest independent Hermes fleet snapshot. That background loop keeps running with the tab closed, keeps every `profileOverrides` name as explicit expected inventory, and auto-discovers newly installed profiles bound to a configured shared store.

Treat `services.json` as trusted local configuration. The current HTTP probe concatenates its port and path without validation and follows redirects, so an `@host` path or redirect can send a request outside loopback.

On the first request, if `%USERPROFILE%\.subtrack\services.json` does not exist, subtrack seeds it once from the observed Scheduled Tasks. It does not reconcile later task changes automatically. See [operations](operations.md) before editing or regenerating the manifest.

Rows are grouped by the configured group. All `alwaysOn` services are placed before periodic services, then statuses are ordered `down`, `degraded`, `unknown`, `up`.

### Health status

Normal task/port/process/HTTP rows use the manifest snapshot rules below. Hermes rows use stronger profile-specific evidence:

- the fleet row summarizes healthy profiles and shared subscriptions;
- one auth row per subscription validates the canonical store, pinned account/JWT identity, a live OpenAI request, and the most recent real-model canary;
- one profile row validates PID/start time/exact command, gateway state, required Telegram state, exact canonical-store assignment, and whether the live process started after the current `.env` binding;
- Taras-style CLI-only profiles can be healthy without Telegram when no token/platform is configured;
- `checkedAt` is the background check time. `gateway_state.updated_at` is intentionally not used as an idle heartbeat.

`up` means all required evidence passed. `degraded` means a live runtime has a recoverable/platform/upstream warning, duplicate/stale metadata, or just completed auto-heal. `down` means a confirmed missing runtime or confirmed auth/account failure. `unknown` means required evidence could not be read reliably. Two consecutive confirmed missing-runtime observations trigger the configured safe Hermes restart; ambiguous process evidence, 401/account mismatch, unsafe owner binding, or corrupt monitor state never triggers restart, canary mutation, or login.

| Status | User meaning |
|---|---|
| `up` | The configured task/process/port or HTTP check matched its positive condition |
| `down` | Expected evidence is absent or a task is missing/disabled |
| `degraded` | Partial evidence exists, such as a listening port with a failing HTTP path or an always-on task without its expected runtime signal |
| `unknown` | The probe could not form a confident result, for example an invalid process pattern or HTTP probe error |

These are best-effort classifications, not authoritative service-manager state. Snapshot failures can currently look like empty evidence, task names lose their TaskPath, process matching selects the first regex match, and port ownership is heuristic.

The `untracked` section is specifically unclaimed listening-port discovery, not a complete inventory of running tasks or processes. It may show full local command lines without redaction. Treat the page and API response as sensitive local diagnostics.

### Actions

The browser asks for confirmation and sends actions to the same-origin loopback API. Confirmation is a UX guard, not authorization. Exact current behavior is:

| UI action | Actual effect |
|---|---|
| `restart` | Calls `Start-ScheduledTask` for the configured task name. It does not stop, wait, restart, or verify health. |
| `stop` | Calls `Stop-ScheduledTask` for the current instance. The task remains registered and enabled for future triggers. |
| `register` | Creates/replaces an at-logon Scheduled Task for the selected process under the current Interactive Limited user. It does not start it now, stop the current process, or add a definition to `services.json`. |

Actions use the server process user's privileges. Task-name ambiguity, `-Force` name collisions, PID reuse, simplified command parsing, guessed working directories, and unredacted command arguments are known limitations. Do not use `register` on a process whose command line contains credentials, and inspect the task in Task Scheduler afterward. The [operations](operations.md), [API reference](api.md), and [security guide](security.md) own the detailed action contract.

Hermes rows have no browser restart/stop buttons. Their `auto-heal on` label describes the guarded background policy, not a generic Task Scheduler action. Use the documented Hermes CLI manually only after inspecting the monitor reason; never restart gateways to repair a 401 or account mismatch.

## Complete CLI reference

The canonical form is `npx tsx src/cli.ts <command>`. `npm start` wraps `serve`; `npm run check` wraps `check`; `npm run dev -- <command>` invokes the same CLI entry.

| Command | Purpose and important options | Meaningful exit behavior |
|---|---|---|
| *(no command)* | Print command summary | `0` |
| unknown command | Print command summary | `1` |
| `serve [--no-open]` | Run poller and dashboard in foreground; `SUBTRACK_NO_OPEN=1` also suppresses browser launch | Stays running; startup/config/bind errors become `1` |
| `check` | Fetch all enabled accounts once and print a table | `1` if any result is `auth_error`; other normalized failure statuses do not fail it; thrown errors are `1` |
| `list` | List every configured account | `0`; config/read failures become `1` |
| `add-account <id> --provider claude\|codex [--label <text>] [--readonly-home <dir>] [--static-token]` | Add/login an account; the last two modes are Claude-only and static token is read from stdin | `2` for usage, duplicate ID, invalid mode/provider, missing Claude credentials, incomplete Claude login, or empty static-token stdin; unexpected errors are `1` |
| `rename <id> "<label>"` | Change display label; `--label <text>` is also accepted | `2` for missing arguments or unknown ID; `0` on save; unexpected errors are `1` |
| `remove-account <id>` | Remove account metadata only | `0` after save even if ID was absent; unexpected errors are `1` |
| `install` | Windows: register/start always-on Scheduled Task | `0` when registration reports success; `1` for platform or reported install failure; does not wait for health |
| `uninstall` | Windows: stop best-effort and remove task/launcher | `0`/`1` by its best-effort marker checks; verify afterward |
| `start` | Windows: trigger installed Scheduled Task | `0` if accepted, `1` otherwise; asynchronous |
| `stop` | Windows: force-stop live daemon PID tree if a live lock is found | Currently returns `0` even when no daemon is found and does not verify `taskkill` success |
| `status` | Show dashboard, daemon, task, and log state | `0` only when dashboard health responds; `1` when dashboard is down, regardless of daemon/task state |
| `logs [--lines N]` | Print the last N daemon-log lines; default 40 | `0`; missing or unreadable log currently collapses to a “no log yet” message |
| `daemon` | Internal supervisor entry used by the installed VBS launcher | Not a normal user command; use `install`/`start` instead |

All thrown config, filesystem, PowerShell, spawn, and bind errors are caught at the CLI boundary, printed as a one-line `subtrack <command>: <message>`, and normally exit `1`. The CLI sets `process.exitCode` and lets Node drain instead of forcing an abrupt exit.

## Safe secret handling

- Treat `.credentials.json`, `auth.json`, setup tokens, daemon logs, Sessions/Services responses, copied resume commands, and command-line inventory as sensitive.
- Keep setup tokens on stdin. Never place them in `--static-token <value>`; that flag is boolean and the value would leak into process/shell records without being used as intended.
- Do not commit `%USERPROFILE%\.subtrack\`, copy credential JSON into issue reports, or paste provider response bodies without redaction.
- Read-only Claude mode must remain externally owned. Let the external Claude Code process refresh it; subtrack will only reread the file.
- Avoid concurrent foreground and daemon processes for owned Claude homes. One writer must own each rotating refresh token.
- Removing account metadata does not revoke or erase credentials. Clean up only after confirming which process owns the home and whether it is shared.
- The dashboard has no login screen. Keep it bound to loopback and do not proxy or expose it to a LAN/Internet without adding authentication and a reviewed security boundary.
- Avoid secrets in process arguments. The Services collector and UI may capture and display full Node/Python command lines.
- Review Sessions titles, IDs, paths, branches, PIDs, and commands before sharing; omitted transcript bodies do not make the index public-safe.

## Troubleshooting quick reference

| Symptom | First checks |
|---|---|
| Browser cannot connect | Use `http://127.0.0.1:7777`, then run `status` and `logs --lines 100` |
| Added/renamed account is absent | Restart the foreground server or `stop` then `start`; config is startup-only |
| Claude onboarding was interrupted | Re-run the identical owned `add-account` command; existing isolated credentials are reused |
| Read-only Claude shows `stale` | Refresh/login through the external home owner; wait for the next normal Claude poll |
| Codex login is missing or shows `auth_error` | Re-run the identical `add-account` command to repair the configured home, then restart the dashboard |
| Usage cards remain during an error | Expected last-known carry-forward; read the status/error text and retry schedule |
| Sessions activity is not immediate | Wait for the 15-second server cache and next 15-second page refresh; restart only for config/code changes |
| Sessions shows `recent` Codex work | This is database activity, not a detected open Codex window |
| Sessions is partial or open Claude windows are absent | Read the page/API warnings; persistent stores can still work when Windows PEB correlation fails |
| Services page is blank after code update | Restart the running daemon so its server routes match the static files |
| Hermes row is red with a runtime reason | Wait for the second independent check; guarded auto-heal will use the profile-scoped Hermes restart if the outage is confirmed |
| Hermes auth row is red | Verify canonical A/B binding and shared login; auto-heal intentionally will not restart or log in |
| `stop` succeeded but dashboard returned later | The Scheduled Task is still installed; use `uninstall` for removal of automatic startup and verify with `status` |
| Task state is `Ready` while dashboard is up | Expected: Task Scheduler launched a short-lived detached VBS, while the daemon continues separately |

For deeper diagnosis, continue with [operations](operations.md) and [security](security.md).
