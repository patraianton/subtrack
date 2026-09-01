# CLAUDE.md

This file guides Claude Code when working in this repository. Preserve any surrounding CLEO injection block if one is added by the local environment.

## Project contract

`subtrack` is an always-on local dashboard with three implemented surfaces:

- **Usage** shows live five-hour and weekly limits for multiple Claude and Codex accounts, plus Grok (SuperGrok) two-hour model windows and its weekly SuperGrok allowance.
- **Sessions** reads existing local Claude/Codex session metadata and, on Windows, correlates live Claude processes with accounts, projects, working directories, and resume commands.
- **Services** shows a live Windows Task Scheduler, listener, and selected-process snapshot with explicit task actions.

The browser tab bar shows **Usage**, **Commands** (a static cheat sheet in `web/commands.js`; no API) and **Conveyor** (`/api/conveyor` serves `~/.autopase-conveyor-status.json` as-is). The Sessions and Services pages stay served at `/sessions.html` and `/services.html` but are not linked from the tab bar. The UI is English-only.

Usage and Services response snapshots are process-local and live-only. Sessions reads provider-owned history already on disk but keeps only metadata caches of its own; it does not persist transcripts, prompts, messages, tool output, command lines, or environments. There is no subtrack usage/session history database, trends database, Projects/Cleanup view, or interactive-window watchdog. Configuration, provider-owned session stores, credential files, the Services manifest, and daemon logs do persist locally. Historical specs under `docs/superpowers/` are context, not promises. Current behavior is canonical in [Architecture](docs/architecture.md) and [HTTP API](docs/api.md).

Node 24 runs TypeScript directly through `tsx`; there is no build output, and imports intentionally include `.ts` extensions. Runtime dependencies are `@napi-rs/keyring` and `open`.

## Commands

```powershell
npm start
npx tsx src/cli.ts serve --no-open
npm run check
npm run typecheck
npm test

node --import tsx --test tests/poller.test.ts
node --import tsx --test --test-name-pattern "backoff" tests/poller.test.ts

npx tsx src/cli.ts add-account <id> --provider claude|codex|grok --label "Name"
npx tsx src/cli.ts add-account <id> --provider claude --readonly-home <dir>
claude setup-token | npx tsx src/cli.ts add-account <id> --provider claude --static-token
npx tsx src/cli.ts list
npx tsx src/cli.ts rename <id> "New name"
npx tsx src/cli.ts remove-account <id>

npx tsx src/cli.ts install
npx tsx src/cli.ts uninstall
npx tsx src/cli.ts start
npx tsx src/cli.ts stop
npx tsx src/cli.ts status
npx tsx src/cli.ts logs --lines 80
```

`npm start` is `tsx src/cli.ts serve`; all commands route through `src/cli.ts`. `daemon` is an internal supervisor entry used by the installer, not a normal operator command. `accounts.json` is read once at startup, so account edits require a restart. Session stores and Services definitions are rescanned on their respective cache rebuilds. Normal verification is `npm run typecheck` plus `npm test`; no linter is configured.

## Usage invariants

```text
Poller -> injected makeFetchUsage() result -> provider adapter/auth
       -> NormalizedUsage -> SnapshotStore -> /api/usage -> web/app.js
```

- `src/types.ts` owns `NormalizedUsage`: `session`, `weekly`, Claude-only `weeklyOpus`, Claude-only `fable`, independent `fableAccess`, `status`, `lastUpdated`, `error`, and `retryAt`. Preserve unknown `resetsAt` as `null`; never fake epoch zero.
- Provider identifiers, modules, and owned homes are lowercase: `claude` / `codex` / `grok`, `src/auth/<provider>.ts`, and `~/.subtrack/<provider>-homes`.
- `SnapshotStore` is a process-local, last-value-wins mutable map with no history, persistence, TTL, eviction, or defensive object copying.
- Polls start seven seconds apart. Normal defaults are Claude 180 seconds, Codex and Grok 60 seconds. `throttled` backs off 5, 10, then 15 minutes, or until the provider's `Retry-After` when that is later (capped at 60 minutes); `auth_error` pauses 15 minutes; `stale` and `error` use normal TTL.
- Every non-`ok` attempt carries prior `session`, `weekly`, `weeklyOpus`, `fable`, and `fableAccess` forward but keeps the current attempt's status, diagnostics, and retry metadata.
- `src/thresholds.ts` is the severity policy: `warn` starts at 70 percent and `crit` at 90 percent. The server enriches windows; do not move policy into the UI.
- Provider usage endpoints are unofficial observed contracts. Treat verified headers, form encoding, response shapes, and retry behavior as load-bearing.

## Credentials

Anthropic refresh tokens are single-use, so Claude credentials must have one refresh owner.

- `owned` is also the legacy default when `credentialsMode` is absent. In `~/.subtrack/claude-homes/<id>`, `ClaudeAuth` may refresh near expiry, force-refresh after the first usage 401, and persist only under its lexical owned root.
- `readonly` represents an external Claude CLI home or static setup-token. Its source rereads on every poll, has no refresh/write path, and returns `stale` for known expiry before calling usage.
- Codex uses isolated `CODEX_HOME=~/.subtrack/codex-homes/<id>` and rereads `<CODEX_HOME>/auth.json`; subtrack has no Codex refresh or persistence path. Recover 401 with `codex login` for that home.
- Codex onboarding verifies `auth.json` before registration. Re-running the same `add-account` command repairs an existing Codex entry whose login is absent; a cancelled login must not create another broken card.
- Grok has no CLI or refresh flow: the credential is the browser Cookie header pasted by the operator into `~/.subtrack/grok-homes/<id>/cookie.txt` (readonly by construction, reread every poll). Onboarding probes the live `grok.com/rest/rate-limits` endpoint before registering; the tracked session window is grok-4 DEFAULT (2 h), and its `resetsAt` is anchored only from an exhausted window's `waitTimeSeconds`. `weekly` comes from a second, advisory call: the gRPC-Web service `grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig` (the "Weekly SuperGrok Heavy Limit" shown in grok.com Settings, which also covers the `grok` CLI as the "Grok Build" product). It must be gRPC-Web framed — Connect/JSON is refused with grpc-status 13. Any failure there leaves `weekly` null and never changes the card's status.
- `src/secrets.ts` is a tested Windows Credential Manager wrapper but is not on the live adapter path. Do not claim keyring or DPAPI protection for provider credential JSON.

## Sessions invariants

```text
Claude projects/*/*.jsonl + Codex state_5.sqlite + live Claude process metadata
  -> metadata scan/deduplication/correlation -> 15 s cache -> /api/sessions -> web/sessions.js
```

- Scan only direct Claude `projects/<encoded-cwd>/*.jsonl` files. Extract bounded metadata for the response; nested session subagents are not top-level work sessions.
- Discover configured Claude homes only in `readonly` mode. Subtrack-owned Usage credential homes can contain probe transcripts and must not become interactive resume targets.
- Codex databases are opened read-only and only interactive `vscode` / `cli` rows are included. A `recent` Codex row is the 24-hour activity heuristic, not proof of an open window.
- Live `open` state is Claude-only. Windows correlation reads PID/start time, `CLAUDE_CONFIG_DIR`, cwd, and a launch resume UUID using observed x64 PEB offsets. Failure is partial: persistent history remains and warnings explain unavailable stores or window inspection.
- A `launch` binding can be stale after `/clear`; `likely` means only a unique home/cwd/start-time match. Resume commands are copy-only, with no session launch/mutation endpoint.
- Treat titles, account labels, cwd/project paths, IDs, and resume commands as sensitive. Do not expose transcript prompts/messages/tools, complete process command lines, or complete environments.
- The provider cache defaults to 15 seconds and coalesces misses. Store changes need only cache/UI refresh; configured account metadata still needs restart because config is startup-only.
- `/api/sessions` is GET-only and returns `Cache-Control: no-store` on success and errors; this does not disable the 15-second server scan cache.

## Server, Sessions, and Services invariants

The server binds plain HTTP to IPv4 `127.0.0.1` only. Probe that address rather than `localhost`, which can resolve to `::1` first on Windows. Loopback is not authentication.

Current routes are `/api/health`, `/api/usage`, `/api/sessions`, `/api/services`, and `POST /api/services/action`. Route methods, Origin behavior, body limits, errors, schemas, sorting, and cache behavior belong in [HTTP API](docs/api.md); update it with any route change.

```text
PowerShell snapshot -> load/seed services.json -> probe -> sort/untracked
                    -> 10 s in-memory cache -> /api/services -> web/services.js
```

- `~/.subtrack/services.json` is seeded only when absent, from observed scheduled tasks only. Ports and processes do not become definitions automatically.
- The snapshot includes non-Microsoft tasks, loopback/wildcard listeners below port 50000, and `node`/`python` processes with full command lines. A PowerShell failure can collapse to empty state and misleading `down` results.
- Concurrent cache misses are coalesced. HTTP probes are sequential and expose only 2xx/non-2xx/unknown.
- Treat `services.json` as trusted local configuration. Current HTTP target concatenation is unvalidated and redirects are followed; an `@host` path or redirect can escape loopback.
- `restart` only runs `Start-ScheduledTask`. `stop` affects the current task instance without disabling/unregistering it. `register` creates an at-logon current-user Limited task with `-Force`; it does not start it now, stop the source process, or persist a `ServiceDef`.
- Task identity omits `TaskPath`. Registration uses simplified command parsing and an executable-directory cwd guess. `/api/services` and the Services UI already expose full command lines for heuristic untracked rows, while action results can return unredacted PowerShell output tails. Treat both as sensitive and do not add further logging or exposure without redaction review.
- Browser confirmation is UX only. The action endpoint is unauthenticated and permits non-browser callers without `Origin`; security controls must be server-side.

## Windows supervision and path care

`install` creates a hidden VBS launcher and the `subtrack-dashboard` at-logon task with best-effort 30-minute repetition. It runs as the current `Interactive` / `Limited` user, never SYSTEM. The VBS launches a detached daemon and exits, so Scheduled Task state does not prove daemon liveness.

The committed daemon checks `/api/health`, owns `~/.subtrack/daemon.lock`, supervises `serve --no-open`, rotates its log at daemon startup when it is already above 5 MiB, and uses 2-to-60-second crash backoff. In committed `HEAD`, any live lock PID makes a second daemon stand down.

A variant that permits takeover when health is down and a live-PID lock is at least 30 seconds old has been trialled but is not released or proven safe: it does not terminate the old owner, can create overlapping supervisors or port conflicts, and an old cleanup path can remove a newer lock. A still-live wedged child is not continuously health-checked. See [Operations](docs/operations.md) before changing lock or recovery behavior.

Do not simplify these Windows-specific choices:

- compare entry points with `pathToFileURL(process.argv[1])`, never hand-built `file://` URLs;
- resolve `web/` with `fileURLToPath(new URL('../web/', import.meta.url))`, never `URL.pathname`;
- set `process.exitCode` and let the loop drain rather than calling `process.exit()` around native keyring handles;
- hide child processes unless an interactive login explicitly needs inherited I/O.

## Working-tree discipline

- Inspect `git status --short` and relevant diffs before editing. Preserve all unrelated modified and untracked user work.
- Never reset, overwrite, reformat, stage, or delete unrelated files. Ask if overlapping work cannot be preserved.
- Use `apply_patch` for focused edits. Keep comments that record verified provider traffic, single-use token hazards, and Windows path/lifecycle constraints.
- Keep clock, fetch, timer, PowerShell runner, live-window source, filesystem, and base-path seams injectable and testable.
- Update tests and canonical docs with behavior changes. Do not document historical Projects/Cleanup/watchdog designs as implemented.

## Further reading

- [README](README.md) — user setup and commands.
- [Usage guide](docs/usage.md) — account modes, CLI behavior, Sessions semantics, statuses, and UI behavior.
- [Configuration](docs/configuration.md) — exact files, schemas, defaults, and reload behavior.
- [Architecture](docs/architecture.md) — current system boundaries and module ownership.
- [HTTP API](docs/api.md) — exact routes, schemas, actions, errors, and security limitations.
- [Operations](docs/operations.md) — Windows supervision, dirty-worktree note, recovery, and safe commands.
- [Security](docs/security.md) — credential, Sessions metadata, browser, Services, and action trust boundaries.
- [Development](docs/development.md) — source workflow, tests, and change discipline.
- [Project history](docs/project-history.md) — verified lineage, historical reports, and design-only backlog.
- `tests/` mirrors source contracts; `tests/fixtures/` contains captured provider responses.
