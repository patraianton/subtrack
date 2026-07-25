# Development guide

This guide covers the current source-based Node.js and TypeScript workflow. The implementation under `src/`, `web/`, and `scripts/` is the runtime authority; plans and historical specifications describe intent, not necessarily shipped behavior.

Start with [Architecture](architecture.md) for the system boundaries and [HTTP API](api.md) for endpoint contracts. Operational changes must also be checked against [Operations](operations.md), [Configuration](configuration.md), and [Security](security.md).

## Toolchain and setup

The project targets Node.js 24 and runs TypeScript directly through `tsx`. `package.json` does not declare an `engines` constraint, so the package manager will not enforce the target version for you.

From PowerShell in the repository root:

```powershell
node --version
npm ci
```

`package-lock.json` is committed, so `npm ci` is the reproducible clean-install path. The only runtime packages are `@napi-rs/keyring` and `open`; TypeScript, `tsx`, and Node types are development dependencies.

There is no build step and no compiled output directory. Source files are executed in place. `tsconfig.json` uses `NodeNext`, targets ES2022, enables strict mode and `noUncheckedIndexedAccess`, permits explicit TypeScript extensions, and has `noEmit` enabled.

## npm scripts

| Command | Actual script | Purpose |
| --- | --- | --- |
| `npm start` | `tsx src/cli.ts serve` | Run the production composition in the foreground and normally open a browser. |
| `npm run dev -- <args>` | `tsx src/cli.ts <args>` | Invoke the source CLI, for example `npm run dev -- list`. |
| `npm run check` | `tsx src/cli.ts check` | Make real provider requests for all enabled accounts and print a one-shot table. |
| `npm run typecheck` | `tsc --noEmit` | Run the only configured static gate. |
| `npm test` | `node --import tsx --test "tests/**/*.test.ts"` | Run the full Node test suite. |

No linter or formatter is configured. There is also no `build` script. Do not claim that lint, format, or production-build gates ran unless you add and run them explicitly.

`npm run typecheck` includes only `src/**/*.ts` and `tests/**/*.ts`. It does not include `scripts/dev-serve.ts` or browser JavaScript under `web/`; those surfaces require targeted tests and manual review.

### Real-credential warning

`npm start`, `npm run check`, and their direct `serve` / `check` CLI equivalents use the production `makeFetchUsage()` composition. They read real account homes, call real provider endpoints, and an owned Claude account can refresh and persist a rotating single-use refresh token. Do not run any of these production compositions concurrently with the installed daemon against the same owned Claude homes. A refresh race can orphan one process's credentials.

For most development, use injected unit tests. Use the read-only diagnostic server described below only when a real-network check is deliberately required.

## Tests and targeted commands

The test runner is Node's built-in runner with `tsx` import support. Run one file or one named case with:

```powershell
node --import tsx --test tests/poller.test.ts
node --import tsx --test --test-name-pattern "backoff" tests/poller.test.ts
```

Useful bounded test groups are:

```powershell
# Configuration and CLI
node --import tsx --test tests/config.test.ts tests/cli.test.ts

# Polling and snapshot contracts
node --import tsx --test tests/poller.test.ts tests/snapshotStore.test.ts tests/thresholds.test.ts

# Provider HTTP, adapters, and auth
node --import tsx --test tests/adapters/http.test.ts tests/adapters/index.test.ts tests/adapters/claude.test.ts tests/adapters/codex.test.ts
node --import tsx --test tests/auth/claude.test.ts tests/auth/codex.test.ts

# HTTP server and static assets
node --import tsx --test tests/server.test.ts tests/server.sessions.test.ts tests/server.services.test.ts tests/static.test.ts tests/smoke.test.ts

# Sessions store scanning, Windows correlation, and browser rendering
node --import tsx --test tests/sessions/scan.test.ts tests/sessions/windows.test.ts tests/web.sessions.test.ts

# Windows Services and actions
node --import tsx --test tests/ops/config.test.ts tests/ops/windows.test.ts tests/ops/probe.test.ts tests/ops/httpProbe.test.ts tests/ops/seed.test.ts tests/ops/services.test.ts tests/ops/actions.test.ts

# Daemon and installer helpers
node --import tsx --test tests/daemon.test.ts

# Browser rendering helpers and Services shell
node --import tsx --test tests/web/format.test.ts tests/web/services.test.ts
```

Run `npm test` before handing off a broad or cross-module change. Tests that exercise Windows script builders are mostly deterministic unit tests; passing them does not prove that the current machine accepted a Scheduled Task registration or that a live provider contract has not drifted.

## Runtime module map

The production data flow is intentionally one-directional, with composition at the server/CLI edge:

```text
accounts.json
  -> Poller
     -> injected fetchUsage from makeFetchUsage
        -> auth + provider adapter + fetchWithRetry
           -> NormalizedUsage
              -> SnapshotStore
                 -> createApp /api/usage
                    -> web/app.js

Windows snapshot + services.json
  -> makeGetServices
     -> probes + latest background Hermes rows + cache
        -> createApp /api/services
           -> web/services.js

hermes.json + Hermes profile/auth/runtime files
  -> HermesFleetMonitor immediate + interval checks
     -> safe canary/recovery + bounded state/events
        -> sanitized ServiceHealth rows

Claude projects/*/*.jsonl + Codex state_5.sqlite
  + live Claude process metadata on Windows
    -> makeGetSessions
       -> metadata scan + deduplication/correlation + cache
          -> createApp /api/sessions
             -> web/sessions.js
```

| Module | Primary ownership | Main tests |
| --- | --- | --- |
| `src/types.ts` | Account config, usage windows, normalized usage, and statuses | Compile-time consumers plus poller/adapters/server tests |
| `src/config.ts` | `accounts.json` defaults, load, save, and account transformations | `tests/config.test.ts` |
| `src/poller.ts` | Per-account due times, stagger, retry scheduling, and carry-forward | `tests/poller.test.ts` |
| `src/adapters/index.ts` | Provider and credential-mode dispatch | `tests/adapters/index.test.ts` |
| `src/auth/claude.ts` | Owned Claude token reads, refresh, and persistence | `tests/auth/claude.test.ts` |
| `src/auth/codex.ts` | CLI and external-Hermes `auth.json` reads, owner-aware diagnostics, and login command construction | `tests/auth/codex.test.ts` |
| `src/adapters/claude.ts`, `codex.ts` | Provider HTTP calls, response normalization, and status mapping | Provider adapter tests and fixtures |
| `src/adapters/http.ts` | Shared transient/5xx retry wrapper | `tests/adapters/http.test.ts` |
| `src/adapters/shell.ts` | Base error-shaped usage object; despite its name, it runs no shell | Snapshot/provider tests |
| `src/snapshotStore.ts` | Mutable process-local last-value map | `tests/snapshotStore.test.ts` |
| `src/thresholds.ts` | Hard-coded utilization severity policy | `tests/thresholds.test.ts` |
| `src/server.ts` | Composition, loopback HTTP routing, static files, API enrichment | Server, static, smoke, Sessions server, and Services server tests |
| `src/sessions/types.ts` | Work-session, live-window, activity, and binding contracts | Sessions scanner/server/browser tests |
| `src/sessions/scan.ts` | Provider-store discovery, metadata extraction, deduplication, correlation, resume commands, cache | `tests/sessions/scan.test.ts` |
| `src/sessions/windows.ts` | Minimal live Claude process metadata from Windows | `tests/sessions/windows.test.ts` |
| `src/ops/windows.ts` | One PowerShell system-state snapshot | `tests/ops/windows.test.ts` |
| `src/ops/config.ts`, `seed.ts` | Services manifest persistence and first-run task seed | Ops config and seed tests |
| `src/ops/probe.ts`, `httpProbe.ts` | Health derivation and loopback HTTP checks | Ops probe tests |
| `src/ops/services.ts` | Services build, sorting, untracked ports, cache | `tests/ops/services.test.ts` |
| `src/ops/actions.ts` | Allowlisted Task Scheduler mutations | `tests/ops/actions.test.ts` |
| `src/hermes/config.ts` | Validated optional monitor configuration | Hermes config/probe tests |
| `src/hermes/probe.ts`, `windows.ts` | Shared-auth inspection, profile discovery, PID/state/platform verification, live auth probe | `tests/hermes/probe.test.ts` |
| `src/hermes/monitor.ts` | Background loop, canary/restart hysteresis, persistent counters/events, sanitized Services projection | `tests/hermes/monitor.test.ts` |
| `src/hermes/supervisor.ts` | Post-bind initialization retry and visible fallback health row | `tests/hermes/supervisor.test.ts` |
| `src/daemon.ts`, `install.ts` | Windows task installation and child supervision | `tests/daemon.test.ts` |
| `src/cli.ts` | Argument parsing and all command dispatch | `tests/cli.test.ts` plus subsystem tests |
| `web/` | Vanilla browser shell, Usage cards, Sessions copy/filter controls, and Services controls | Static, `tests/web.sessions.test.ts`, `tests/web/*`, and manual browser QA |
| `scripts/dev-serve.ts` | Maintainer-only read-only-token real-network server | Manual only; excluded from `tsconfig.json` |

The exact runtime flow, retry semantics, Services behavior, and current limitations are documented in [Architecture](architecture.md).

## Dependency-injection and test seams

Preserve these seams when changing behavior:

- `Poller` receives config, a fetcher, store, clock, tick interval, and timer implementations. Tests can advance time and run `tick()` without network or real timers.
- `makeFetchUsage()` accepts fetch, clock, and auth collaborators, then returns the account fetch function injected into the Poller.
- provider adapters accept token/auth readers and fetch dependencies; `fetchWithRetry()` accepts fetch, sleep, retry count, and delay.
- Claude auth accepts fetch and clock. Read-only token ownership is composed separately and has no refresh or write dependency.
- `createApp()` accepts Sessions/Services and action functions, so HTTP tests do not scan the real profile or invoke PowerShell.
- `scanSessions()` accepts a base home, account list, clock, recent threshold, and live-window source. `makeGetSessions()` additionally accepts a cache TTL; tests can use temporary stores without touching the user's provider history.
- live Claude parsing and PowerShell acquisition are separated. Keep the response contract limited to PID/start time, home, cwd, and launch UUID; do not expose the complete process command line/environment used internally for extraction.
- `makeGetServices()` accepts the base home, PowerShell runner, HTTP probe, clock, and cache TTL. Concurrent misses are testable without Windows.
- `HermesFleetMonitor` accepts config/base, filesystem readers, clock, timer functions, PowerShell/fetch, canary, and restart collaborators. Tests must prove checks run without `/api/services`, do not overlap, bound a hung process snapshot, persist owner-action reservations before execution, and never mutate on ambiguous auth/process evidence. `HermesMonitorSupervisor` separately proves initialization retry and stop races.
- `makeRunServiceAction()` accepts the base home, PowerShell runner, and clock.
- most configuration/auth helpers accept a base home so tests can use isolated temporary directories.
- `probeService()`, parsing helpers, severity classification, and command-script builders are deterministic units.

`src/install.ts` and the main daemon loop still have concrete process and filesystem calls. Prefer testing their exported pure path/script/backoff/lock helpers. Treat a real install/uninstall exercise as an explicit machine mutation, not a routine unit-test step.

## Source conventions

### ES modules and imports

- The package uses `"type": "module"`, `NodeNext`, and explicit `.ts` extensions in relative imports.
- Use `node:` prefixes for Node built-ins.
- Use `import type` when an import is type-only; `verbatimModuleSyntax` preserves the distinction.
- Do not introduce compiled `.js` import paths or a build-output assumption. `tsx` executes source directly.

### Windows paths and entry points

Several choices are load-bearing:

- Compare the CLI entry with `pathToFileURL(process.argv[1])`; a string-built `file://` URL does not reliably match a backslashed Windows drive path.
- Resolve filesystem paths from module URLs with `fileURLToPath()`. Do not use `URL.pathname`; it can retain `%20` and a leading slash on Windows.
- Resolve the web directory with `fileURLToPath(new URL('../web/', import.meta.url))` so checkout paths with spaces work.
- The daemon child must run with the repository root as its working directory so `--import tsx` resolves the local dependency.
- Prefer path APIs over manual slash concatenation.

### Process exit and PowerShell

- Set `process.exitCode` and let the event loop drain. Do not replace this with abrupt `process.exit()`; the native keyring module has previously triggered a libuv assertion during abrupt exit.
- Windows automation intentionally uses hidden, non-interactive `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass` and WScript. Changing that invocation changes the operational and security boundary.
- Escape PowerShell single-quoted values by doubling `'`; reuse existing helpers and script builders.
- Write PowerShell environment assignments as `$env:NAME = 'value'`. POSIX `NAME=value command` syntax is not valid in PowerShell.
- Inspect the user's existing dirty work before changing daemon/install code. Never reset or overwrite unrelated modifications.

### Contract discipline

- `src/types.ts` is the cross-provider contract. Update producers, Poller carry-forward, server enrichment, browser consumers, fixtures, tests, and docs together when it changes.
- `resetsAt: null` means the provider did not anchor a reset. Never replace it with epoch zero.
- Keep utilization as percent used and preserve inclusive severity thresholds at 70 and 90 unless the policy change is deliberate and tested.
- Keep provider network/auth behavior in adapters and auth modules; keep scheduling and resilience in the Poller.
- Keep the web layer presentational. Severity is assigned server-side.
- Services and Usage are independent pipelines; do not route Services through `SnapshotStore` or the Usage Poller.
- Sessions is a third independent read-only pipeline. Do not route it through provider auth/polling, persist transcript content, treat `recent` as open, or add command execution to the copy-only resume control without a new security design.

## Read-only-token real-network server

`scripts/dev-serve.ts` is a maintainer diagnostic for exercising the real Usage pipeline and web assets on a port other than the normal `7777`. It is not an offline, mocked, or isolated test, and it does not provide Sessions or Services backend parity.

Run it from the repository root in PowerShell:

```powershell
$env:PORT = '7788'
node --import tsx scripts/dev-serve.ts
```

It defaults to `127.0.0.1:7788` when `PORT` is absent and does not open a browser. Stop it with Ctrl+C, then optionally clear the temporary variable:

```powershell
Remove-Item Env:PORT -ErrorAction SilentlyContinue
```

Important limits:

- it loads the real `~/.subtrack/accounts.json`, starts a real Poller, serves the real web assets, and calls real Claude and Codex endpoints;
- it constructs `createApp()` without Sessions/Services providers or an action handler, so `/api/sessions` and `/api/services` return 503 and those pages cannot exercise their backends;
- it rereads Claude's on-disk access token but never refreshes or writes it, preventing refresh-token rotation by this process;
- Codex uses the normal read-only `auth.json` reader and has no refresh path;
- it sends real access tokens to providers and adds polling load, so it can still contribute to rate limits;
- it bypasses `makeFetchUsage()`, including the production owned-token refresh path and the Claude read-only expiry preflight;
- an expired Claude token commonly appears as `auth_error`, even where production read-only composition would report `stale` before a request;
- it does not validate `PORT`, has no friendly address-in-use handling, no browser launch, and no explicit graceful-shutdown path;
- it has no npm script and is excluded from the configured TypeScript gate.

Do not use `npm start` as a substitute while the installed daemon owns the same Claude credentials. The diagnostic script exists specifically to avoid a second refresh owner, but it is still a real-network operation and should be opt-in.

## Safe verification workflow

### Before editing

```powershell
git status --short
git diff -- src/daemon.ts tests/daemon.test.ts
```

Identify user changes and work around them. Current `git status` shows uncommitted lock-takeover work in the daemon source and tests. Because TypeScript executes in place, a restarted daemon can run those changes before they are committed; preserve and review the diff as active working-tree behavior. Do not use destructive reset or checkout commands.

### During implementation

1. Change the smallest owning module; avoid duplicating policy across adapters, server, and browser.
2. Add or update the nearest deterministic test first.
3. Run that test file directly.
4. Run `npm run typecheck` after TypeScript changes.
5. Run broader neighboring tests when a shared contract or composition seam changed.
6. Run `npm test` before handoff for cross-cutting or production-path changes.
7. Review `git diff` to confirm that generated credentials, logs, local manifests, and unrelated user work are absent.

### Change-to-gate checklist

| Change area | Minimum focused verification | Additional review |
| --- | --- | --- |
| Config or CLI parsing | `tests/config.test.ts`, `tests/cli.test.ts`, typecheck | Restart semantics and [Configuration](configuration.md) |
| Poller/store/thresholds | Corresponding core tests, typecheck | Carry-forward fields, timer determinism, severity boundaries |
| Auth or provider adapters | Relevant auth/adapter tests, HTTP retry tests, typecheck | Fixture drift, token ownership, no secret output |
| HTTP server/API | Server and static tests, typecheck | [HTTP API](api.md), loopback and method/origin behavior |
| Sessions scan/cache/UI | `tests/sessions/*.test.ts`, `tests/server.sessions.test.ts`, `tests/web.sessions.test.ts`, typecheck | Temporary-store isolation, direct-file boundary, partial warnings, 15-second cache/refresh, `recent` versus `open`, metadata/command escaping, GET/no-store contract |
| Services probes/cache/actions | Relevant `tests/ops/*`, server Services tests, typecheck | PowerShell failures, cache timing, state-changing scope |
| Hermes monitor/auth/recovery | `tests/hermes/*`, Services/UI tests, typecheck | Token redaction, expected inventory, PID reuse/start time/duplicates, snapshot timeout, false-down suppression, atomic hysteresis/cooldown, post-bind initialization, no ambiguous auth/process mutation |
| Daemon/install | `tests/daemon.test.ts`, typecheck | Dirty diff preservation, PID identity, Task Scheduler postconditions |
| Browser Usage/Sessions/Services | Static and `tests/web/*`, relevant server tests | Manual desktop and narrow-window QA, keyboard/focus/error states, clipboard-only resume behavior |
| Documentation only | Relative-link and command review | CommonMark spacing, current-vs-planned wording, privacy scrub |

### Optional local smoke checks

Only run production composition when the configured port is free and no live daemon shares owned Claude credentials. A no-browser foreground launch is:

```powershell
npm run dev -- serve --no-open
```

In another PowerShell window:

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:7777/api/health'
Invoke-RestMethod -Uri 'http://127.0.0.1:7777/api/usage'
Invoke-RestMethod -Uri 'http://127.0.0.1:7777/api/sessions'
Invoke-RestMethod -Uri 'http://127.0.0.1:7777/api/services'
```

These requests may expose local account/session titles, exact paths, IDs, resume commands, process command lines, and operational state. Do not paste raw responses into public issues or documentation. Do not exercise `/api/services/action` merely as a smoke test because it changes Task Scheduler state.

## Documentation conventions

Canonical current-state documentation lives under `docs/`:

- [Architecture](architecture.md) for module ownership, flows, and implemented boundaries;
- [HTTP API](api.md) for routes and payloads;
- [Usage](usage.md) for normalized windows and user-facing usage behavior;
- [Configuration](configuration.md) for account/Services schemas and Sessions source discovery;
- [Security](security.md) for credentials, loopback, and action trust boundaries;
- [Operations](operations.md) for the Windows runbook;
- [Project history](project-history.md) for chronology and incident context.

Keep documentation changes reviewable:

- use relative links between repository documents;
- use PowerShell syntax for Windows commands and label any POSIX alternative explicitly;
- distinguish current source behavior, current uncommitted working-tree behavior, historical design, and proposed follow-up;
- use concrete defaults and units, but link to the owning configuration section rather than duplicating large schemas;
- never include access tokens, refresh tokens, credential JSON, personal emails, or raw process command lines;
- keep CommonMark blank lines around headings, lists, tables, and fenced blocks;
- update canonical docs when a contract changes; `claudedocs/agent-outputs/` audit artifacts are evidence and handoff material, not the primary user contract;
- verify every relative link and command manually when no documentation linter is configured.

## Current development limits

- No build, lint, format, browser typecheck, or documentation-link-check script is configured.
- `scripts/dev-serve.ts` is outside TypeScript compilation and automated tests.
- Provider endpoints are unofficial and unit fixtures cannot prove live compatibility.
- Windows Task Scheduler, WScript, PowerShell policy, sleep/resume, and PID reuse need explicit machine testing when changed.
- Browser UI tests do not replace accessibility, responsive-layout, and signed-in real-browser review.
- Live Claude correlation depends on observed x64 Windows PEB offsets; deterministic parser tests cannot prove those offsets still match a running Claude process, and Codex `recent` is never proof of an open thread.
- Real-network verification can mutate owned Claude credentials unless the read-only diagnostic composition is used.
