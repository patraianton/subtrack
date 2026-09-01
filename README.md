# subtrack

`subtrack` is a local, Windows-first dashboard for people who run several Claude, Codex and Grok subscriptions at once. It shows how much of every five-hour and weekly limit is left, keeps a cheat sheet of the commands you use to drive those accounts, and gives a long-running local job a place on the screen.

The tab bar has three views:

- **Usage** shows the current 5-hour session and 7-day limits for every enabled account, plus Claude-only Opus and Fable windows when the provider reports them. Cards are grouped by provider and sorted by the nearest weekly reset. A rate-limited account waits exactly as long as the provider's `Retry-After` asks and says so on the card, keeping the last real numbers visible.
- **Commands** is a searchable cheat sheet of the shell commands behind the panel: the subtrack CLI out of the box, plus whatever launcher verbs you add to `web/commands.js`. Click a row to copy it; the "quiz me" switch hides the explanations so you can drill them.
- **Conveyor** renders `~/.autopase-conveyor-status.json`, a small JSON status file an external pipeline can write (task, phase, timeline, links), so a long-running local job is visible next to the limits it burns.

Two more pages are served but kept out of the tab bar: `/sessions.html` lists existing local Claude and Codex work sessions by account, project, working directory, title, ID and activity, with live Claude windows correlated on Windows (resume buttons copy a PowerShell command; they never launch or mutate a session), and `/services.html` is a local Ops Cockpit for configured Windows Scheduled Tasks, processes, ports and HTTP health checks, showing the always-on Hermes fleet/auth monitor when `~/.subtrack/hermes.json` is present.

## Boundaries

- The HTTP server binds to IPv4 loopback only: `127.0.0.1` on port `7777` by default.
- Usage is a **live in-memory snapshot**. Sessions reads provider-owned history already present in Claude homes and Codex databases, but subtrack creates no session-history database and persists no prompts, messages, tool output, full command lines, or process environments. Configuration, provider-owned session stores, credential files, the Services manifest, daemon logs, and the small Hermes monitor state/transition log do persist independently on disk.
- Claude and Codex credentials live in per-account files under `%USERPROFILE%\.subtrack\` unless you explicitly register an external read-only Claude home. The Windows keyring component in the repository is not on the live authentication path.
- Access tokens are sent over HTTPS to the providers' usage endpoints. The endpoints and response schemas are unofficial, observed contracts and can change without notice.
- Loopback binding is not authentication. Other software running locally as you may be able to read the dashboard/API. Sessions exposes local account labels, titles, project paths, session IDs, and resume commands; Services can expose task/process metadata and command lines and can trigger state-changing actions.

## Requirements

- Windows 10/11 for live Claude-window correlation, the Services Ops Cockpit, and always-on Task Scheduler integration.
- Node.js 24 and npm.
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) for an interactive Claude-owned login, or a Claude setup token for static-token mode.
- [Codex CLI](https://developers.openai.com/codex/cli/) for Codex accounts.
- For Grok (SuperGrok) accounts: no CLI needed, only a logged-in grok.com browser tab to copy the session cookie from.
- A modern browser with JavaScript modules enabled.

The foreground dashboard can run without the Windows installer. Persistent Sessions discovery still works where the local stores are readable, but live Claude-window correlation, Services collection/actions, and always-on integration are Windows-specific.

## PowerShell quick start

Run from the repository checkout:

```powershell
Set-Location C:\path\to\sub-tracking
npm install

npx tsx src/cli.ts add-account claude-main --provider claude --label "Claude main"
npx tsx src/cli.ts add-account codex-main --provider codex --label "Codex main"

npm start
```

For the Claude command, complete `/login` in the isolated Claude Code window, then use `/exit` to return. The Codex command launches `codex login` in its own isolated `CODEX_HOME`.

Open [http://127.0.0.1:7777](http://127.0.0.1:7777). To keep it running across logons and crashes on Windows:

```powershell
npx tsx src/cli.ts install
npx tsx src/cli.ts status
```

Configuration is read once when the server starts. Restart a running dashboard after adding, renaming, or removing an account.

## Account examples

Register an existing Claude home without letting subtrack refresh or write it:

```powershell
npx tsx src/cli.ts add-account claude-work --provider claude --readonly-home 'C:\Users\you\.claude-work' --label "Claude work"
```

Pipe a Claude setup token through stdin so it does not appear in the command line or shell history:

```powershell
claude setup-token | npx tsx src/cli.ts add-account claude-static --provider claude --static-token --label "Claude static"
```

Add a Grok (SuperGrok) account — grok.com has no CLI login, so the credential is the browser session cookie:

```powershell
npx tsx src/cli.ts add-account grok-main --provider grok --label "Grok main"
```

The first run prints where to paste the cookie (`~\.subtrack\grok-homes\<id>\cookie.txt`): in a logged-in grok.com tab press F12 → Network → refresh → click any grok.com request → copy the `cookie` request header value into that file, then re-run the same command. Subtrack only ever reads the file; when grok.com rejects the cookie the card shows `auth_error` until you re-copy it.

See the [user guide](docs/usage.md) before choosing between owned, read-only, and static-token credentials. In particular, Claude refresh tokens rotate and must have only one writer.

## Optional Hermes fleet monitor

`~/.subtrack/hermes.json` enables a background monitor that runs even when the Services tab is closed. It auto-discovers installed profiles whose `.env` points at one of the configured shared Codex stores; names listed in `profileOverrides` form an explicit expected inventory and remain visible if a directory disappears. The monitor validates authoritative gateway PID/start-time/process identity, duplicate gateways, gateway state, required Telegram connectivity, shared account pin/JWT identity, and a live OpenAI usage probe. A small real-model canary is run on the configured representative profile for each subscription only after fail-closed ownership checks.

Only a confirmed missing runtime can trigger auto-heal. It requires two failed checks, atomically reserves the attempt before invoking Hermes, uses Hermes's own profile-scoped `gateway restart`, and observes a cooldown and hourly cap. Conflicting or incomplete Windows evidence, authentication rejection, account mismatch, or unreadable monitor state never triggers a restart, token rewrite, or automatic login. Configure optional `heartbeatUrl` and `alertWebhookUrl` for an external VPS/dead-man service; a local process cannot report that the whole PC is asleep or offline.

## Command overview

| Task | Command |
|---|---|
| Foreground dashboard | `npm start` |
| Foreground without opening a browser | `npx tsx src/cli.ts serve --no-open` |
| One-shot account table | `npm run check` |
| List accounts | `npx tsx src/cli.ts list` |
| Add an account | `npx tsx src/cli.ts add-account <id> --provider claude\|codex\|grok` |
| Rename a label | `npx tsx src/cli.ts rename <id> "<new label>"` |
| Remove account metadata | `npx tsx src/cli.ts remove-account <id>` |
| Install/remove always-on mode | `npx tsx src/cli.ts install` / `npx tsx src/cli.ts uninstall` |
| Start/stop/status/logs | `npx tsx src/cli.ts start` / `npx tsx src/cli.ts stop` / `npx tsx src/cli.ts status` / `npx tsx src/cli.ts logs` |
| Static checks | `npm run typecheck` and `npm test` |

`remove-account` changes configuration only; it does not delete credential homes. `stop` stops the current daemon process but leaves the Scheduled Task installed, so its self-heal trigger may start it again. Use `uninstall` when automatic startup must be removed, then verify with `status`.

## Current limitations

- Provider usage endpoints, headers, and response shapes are private/unofficial. Schema drift, policy changes, or account restrictions can break collection.
- Codex credentials are read from either the normal CLI `auth.json` shape or an explicitly configured externally-owned Hermes shared-store shape; subtrack does not refresh or rewrite either. The Hermes monitor's real-model canary invokes Hermes itself, keeping Hermes as the sole refresh owner.
- The browser currently refreshes Usage every 30 seconds even if `uiRefreshSeconds` is changed. Provider polling remains separately configured (Claude 180 seconds and Codex 60 seconds by default).
- Failed polls keep the last-known windows visible with a current error status; this is not history, and window freshness can differ from the latest-attempt timestamp.
- Sessions scans existing Claude transcript metadata and read-only Codex thread databases. It does not display prompt/message/tool content. A `recent` Codex row means its database timestamp is within the current 24-hour heuristic; it does not prove that a Codex window is open.
- Configured Claude homes are added to Sessions discovery only in `readonly` mode. Subtrack-owned Usage homes are excluded because their probe transcripts are not interactive work sessions or safe resume targets.
- Live `open` detection is Claude-only and depends on observed x64 Windows PEB offsets. A partial scan remains usable and reports warnings when a home, Codex database, or live-window probe cannot be read.
- Services discovery is heuristic and Windows-specific. Its untracked list is not an exhaustive process inventory, and command lines may contain sensitive arguments.
- Services HTTP definitions are trusted local configuration: the current probe concatenates an unvalidated port/path and follows redirects, so an `@host` path or redirect can send a request outside loopback.
- The Services buttons have narrower semantics than their labels suggest: `restart` only triggers a Scheduled Task, `stop` stops only its current run, and `register` creates an at-logon task without starting it or adding a Services definition.
- The Services grid is desktop-oriented, and the current UI has known accessibility and narrow-screen gaps.
- Projects, Cleanup, and a general-purpose uptime watchdog are not implemented product features. The shipped watchdog is deliberately limited to configured Hermes gateways.

## Documentation

- [Usage and CLI guide](docs/usage.md)
- [Configuration reference](docs/configuration.md)
- [Architecture](docs/architecture.md)
- [HTTP API](docs/api.md)
- [Operations and troubleshooting](docs/operations.md)
- [Security and privacy](docs/security.md)
- [Development guide](docs/development.md)
- [Project history](docs/project-history.md)
