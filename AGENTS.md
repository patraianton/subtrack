# AGENTS.md

This file guides Codex agents working in this repository. Preserve any surrounding CLEO injection block if one is added by the local environment.

## Project contract

`subtrack` is an always-on local dashboard with three current surfaces:

- **Usage** shows live five-hour and weekly limits across multiple Claude and Codex accounts.
- **Sessions** reads existing local Claude/Codex session metadata and, on Windows, correlates live Claude processes with accounts, projects, working directories, and resume commands.
- **Services** shows a live Windows Task Scheduler, listener, and selected-process snapshot and offers explicit local task actions.

Usage and Services response snapshots are process-local and live-only. Sessions reads provider-owned history already on disk but keeps only metadata caches of its own; it does not persist transcripts, prompts, messages, tool output, command lines, or environments. There is no subtrack usage/session history database, trends database, Projects/Cleanup view, or interactive-window watchdog. Configuration, provider-owned session stores, credential files, the Services manifest, and daemon logs do persist locally. Historical specs under `docs/superpowers/` are context, not current behavior. Use [Architecture](docs/architecture.md) and [HTTP API](docs/api.md) as the canonical implementation guides.

The project runs Node 24 TypeScript directly through `tsx`; there is no build output. Imports intentionally include `.ts` extensions. Runtime dependencies are `@napi-rs/keyring` and `open`.

## Commands

```powershell
npm start
npx tsx src/cli.ts serve --no-open
npm run check
npm run typecheck
npm test

# Focused tests
node --import tsx --test tests/poller.test.ts
node --import tsx --test --test-name-pattern "backoff" tests/poller.test.ts

# Account configuration in ~/.subtrack/accounts.json
npx tsx src/cli.ts add-account <id> --provider claude|codex --label "Name"
npx tsx src/cli.ts add-account <id> --provider claude --readonly-home <dir>
claude setup-token | npx tsx src/cli.ts add-account <id> --provider claude --static-token
npx tsx src/cli.ts list
npx tsx src/cli.ts rename <id> "New name"
npx tsx src/cli.ts remove-account <id>

# Windows always-on dashboard
npx tsx src/cli.ts install
npx tsx src/cli.ts uninstall
npx tsx src/cli.ts start
npx tsx src/cli.ts stop
npx tsx src/cli.ts status
npx tsx src/cli.ts logs --lines 80
```

`npm start` is `tsx src/cli.ts serve`. All product commands route through `src/cli.ts`; `daemon` is an internal supervisor entry used by the installer, not a normal operator command. The server reads `accounts.json` once at startup, so account add/rename/remove changes require a restart. Session stores and Services definitions are rescanned on their respective cache rebuilds and do not require one.

The normal verification gates are `npm run typecheck` and `npm test`; no linter is configured. Use focused tests while iterating, then run gates proportionate to the change.

## Usage pipeline invariants

The dependency direction is:

```text
Poller -> injected makeFetchUsage() result -> provider adapter/auth
       -> NormalizedUsage -> SnapshotStore -> /api/usage -> web/app.js
```

- `src/types.ts` owns the cross-provider contract. `NormalizedUsage` includes `session`, `weekly`, Claude-only `weeklyOpus`, Claude-only `fable`, independent `fableAccess`, `status`, `lastUpdated`, `error`, and `retryAt`. Never replace an unknown `resetsAt` with epoch zero.
- Providers and paths are lowercase everywhere: `claude` and `codex`; `src/auth/claude.ts`, `src/adapters/claude.ts`, `~/.subtrack/claude-homes`; `src/auth/codex.ts`, `src/adapters/codex.ts`, `~/.subtrack/codex-homes`.
- `SnapshotStore` is a process-local last-value-wins `Map`. It has no persistence, history, eviction, or defensive object copying.
- `src/poller.ts` owns scheduling, not fetching. Initial account polls are staggered seven seconds; normal TTL defaults are Claude 180 seconds and Codex 60 seconds.
- `throttled` backs off 5, 10, then 15 minutes. `auth_error` pauses 15 minutes. `stale` and generic `error` use the normal provider TTL.
- Every non-`ok` attempt carries forward prior `session`, `weekly`, `weeklyOpus`, `fable`, and `fableAccess`, while keeping the current attempt's status, error, timestamps, and retry metadata.
- Severity is added in `server.ts`: `warn` begins at 70 percent and `crit` at 90 percent. Keep this policy in `src/thresholds.ts`, not the browser.
- The upstream Claude and Codex usage endpoints are unofficial observed contracts. Preserve load-bearing headers, encodings, response handling, and retry behavior unless verified against tests and current traffic.

## Credential ownership

Claude refresh tokens are single-use; never introduce two refresh owners.

- Claude `owned` credentials (also the legacy default when `credentialsMode` is absent) live under `~/.subtrack/claude-homes/<id>`. `ClaudeAuth` may refresh near expiry, force-refresh after the first usage 401, and write the rotated token only inside its lexical owned root.
- Claude `readonly` credentials belong to an external CLI home or static setup-token workflow. `makeReadOnlyTokenSource` rereads the file each poll, never refreshes or writes, and reports a known expired file token as `stale` before any usage request.
- Codex uses isolated `CODEX_HOME=~/.subtrack/codex-homes/<id>` and rereads `auth.json`. Subtrack does not refresh or persist Codex credentials; 401 recovery is a new `codex login` for that home.
- Codex onboarding must verify `auth.json` before saving a new account. Re-running the same `add-account` command repairs a configured Codex account whose login is missing; never restore the old save-after-cancel behavior.
- `src/secrets.ts` provides a tested Windows Credential Manager wrapper, but it is not wired into live adapters. Do not claim keyring or DPAPI protection for current provider credential files.

## Sessions invariants

Sessions is independent of the Usage Poller and `SnapshotStore`:

```text
Claude projects/*/*.jsonl + Codex state_5.sqlite + live Claude process metadata
  -> metadata scan/deduplication/correlation -> 15 s cache -> /api/sessions -> web/sessions.js
```

- Scan only direct Claude `projects/<encoded-cwd>/*.jsonl` files; never treat nested session subagents as top-level work sessions. Extract only bounded metadata (`cwd`, title, branch, timestamps, and UUID) for the response.
- Discover configured Claude homes only in `readonly` mode. Never turn subtrack-owned Usage credential homes or their probe transcripts into interactive resume targets.
- Open Codex databases read-only and include interactive `vscode` / `cli` threads. `recent` defaults to activity within 24 hours and is not evidence that a Codex window is open.
- Live `open` state is Claude-only. `src/sessions/windows.ts` reads the minimum Windows process data needed to correlate PID/start time, `CLAUDE_CONFIG_DIR`, cwd, and a launch `--resume` UUID. The observed x64 PEB offsets can fail; return persistent history with `partial: true` and warnings.
- A `launch` binding is the UUID on the process command line and may be stale after `/clear`; `likely` is a unique home/cwd/start-time correlation. Do not present either as stronger evidence than it is.
- Resume commands are returned for copy-only UI. There is no session mutation or launch endpoint. Treat account labels, titles, cwd/project paths, IDs, and commands as sensitive local data; never add prompt/message/tool content, full command lines, or complete environments.
- The successful-response cache defaults to 15 seconds and coalesces concurrent misses. Store/file changes become visible after cache expiry and the next browser refresh; configured account labels/homes still require restart because `accounts.json` is startup-only.
- `/api/sessions` is GET-only and every response sends `Cache-Control: no-store`; preserve the distinction between browser no-store and the 15-second server scan cache.

## Server, Sessions, and Services invariants

The production server binds plain HTTP to `127.0.0.1` only. Use `127.0.0.1` for health probes; `localhost` can resolve to IPv6 first on Windows. Loopback is not authentication, and the mutating endpoint accepts non-browser requests without `Origin`.

Current HTTP routes are:

- `/api/health`
- `/api/usage`
- `/api/sessions`
- `/api/services`
- `POST /api/services/action`

Do not duplicate or casually broaden the method, Origin, body-limit, schema, error, sorting, or cache contract here; update [HTTP API](docs/api.md) with any route change.

Services is independent of the Usage Poller and store:

```text
PowerShell snapshot -> load/seed services.json -> probe -> sort/untracked
                    -> 10 s in-memory cache -> /api/services -> web/services.js
```

- `~/.subtrack/services.json` is seeded only when absent, and current seeding uses observed scheduled tasks only. It is not seeded from ports or processes.
- The Windows snapshot includes non-Microsoft tasks, loopback/wildcard listeners below port 50000, and `node`/`python` processes with full command lines. Acquisition failure can collapse to an empty snapshot and misleading `down` state.
- The Services provider coalesces concurrent cache misses. HTTP checks are sequential and currently return only 2xx/non-2xx/unknown.
- Treat `services.json` as trusted local configuration. The HTTP probe concatenates an unvalidated port/path and follows redirects; `@host` paths or redirects can escape loopback.
- Action semantics are intentionally documented exactly: `restart` only calls `Start-ScheduledTask`; `stop` stops the current task instance without disabling/unregistering it; `register` creates an at-logon current-user Limited task with `-Force` but does not start it now, stop the source process, or persist a `ServiceDef`.
- Task actions identify tasks by name without `TaskPath`. Registration uses a simplified command-line parser and guessed executable-directory working directory. `/api/services` and the Services UI already expose full command lines for heuristic untracked rows, while action results can return unredacted PowerShell output tails. Treat both as sensitive and do not add further logging or exposure without redaction review.
- Browser confirmation is UX, not authorization. State-changing protection must be enforced server-side.

## Windows supervision and path care

`install` writes a hidden VBS launcher and registers `subtrack-dashboard` at logon with a best-effort 30-minute repetition. It runs as the current `Interactive` / `Limited` user, never SYSTEM. The VBS exits after launching a detached daemon, so Scheduled Task state is not daemon liveness.

The committed daemon checks `/api/health`, uses `~/.subtrack/daemon.lock`, supervises `serve --no-open`, rotates `~/.subtrack/logs/subtrack.log` at daemon startup when it is already above 5 MiB, and restarts crashed children with 2-to-60-second backoff. In committed `HEAD`, any live lock PID makes a second daemon stand down.

This checkout currently has an uncommitted user diff that instead permits takeover when health is down and a live-PID lock is at least 30 seconds old. Preserve that diff, but do not treat it as released or proven-safe behavior: it does not terminate the old owner, can create overlapping supervisors or port conflicts, and an old cleanup path can remove a newer lock. A live but wedged serve child is not continuously health-checked. See [Operations](docs/operations.md) before changing lock or recovery behavior.

Preserve these Windows-specific choices:

- Use `pathToFileURL(process.argv[1])` for entry-point comparisons; do not build `file://` strings from backslashed paths.
- Resolve `web/` with `fileURLToPath(new URL('../web/', import.meta.url))`; do not use `URL.pathname`.
- Let the CLI set `process.exitCode` and drain; avoid abrupt `process.exit()` around native keyring handles.
- Keep child processes hidden unless a login flow explicitly needs inherited interactive I/O.

## Working-tree discipline

- Inspect `git status --short` and relevant diffs before editing. Existing modifications and untracked files belong to the user unless the task says otherwise.
- Do not reset, overwrite, reformat, stage, or delete unrelated work. Work around overlapping dirty files; ask if that is impossible.
- Use `apply_patch` for targeted edits and keep source comments that document verified provider headers, token rotation, Windows paths, or lifecycle hazards.
- Keep tests dependency-injected: clocks, fetch, timers, PowerShell runners, live-window sources, and filesystem/base paths already form the main seams.
- When behavior changes, update tests and the canonical docs in the same task. Do not turn historical Projects/Cleanup/watchdog designs into promises without implementation.

## Further reading

- [README](README.md) — user setup and commands.
- [Usage guide](docs/usage.md) — account modes, CLI behavior, Sessions semantics, statuses, and UI behavior.
- [Configuration](docs/configuration.md) — exact files, schemas, defaults, and reload behavior.
- [Architecture](docs/architecture.md) — current data flows, module ownership, lifecycle, and boundaries.
- [HTTP API](docs/api.md) — exact routes, schemas, actions, errors, and security limitations.
- [Operations](docs/operations.md) — Windows supervision, dirty-worktree note, recovery, and safe commands.
- [Security](docs/security.md) — credential, Sessions metadata, browser, Services, and action trust boundaries.
- [Development](docs/development.md) — source workflow, tests, and change discipline.
- [Project history](docs/project-history.md) — verified lineage, historical reports, and design-only backlog.
- `tests/` mirrors source contracts; `tests/fixtures/` contains captured provider response shapes.
