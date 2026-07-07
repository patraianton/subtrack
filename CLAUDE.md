# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`subtrack` is an always-on **local** web dashboard (loopback only) that shows the 5-hour
session + 7-day weekly usage limits across several Claude and Codex accounts at once. It holds a
**live snapshot only** — no history, no database. Node 24 + TypeScript run directly through `tsx`
(no build step); runtime deps are only `@napi-rs/keyring` and `open`.

## Commands

```bash
npm start                      # serve dashboard + poller in foreground (opens a browser) → http://localhost:7777
npm run check                  # one-shot table of all accounts, then exit
npm run typecheck              # tsc --noEmit — the only static gate (no linter is configured)
npm test                       # node --import tsx --test "tests/**/*.test.ts"

# run one test file / one test by name:
node --import tsx --test tests/poller.test.ts
node --import tsx --test --test-name-pattern "backoff" tests/poller.test.ts

# account management (config lives in ~/.subtrack/accounts.json):
npx tsx src/cli.ts add-account <id> --provider claude|codex [--label "..."]
npx tsx src/cli.ts list | rename <id> "<name>" | remove-account <id>

# always-on background dashboard (Windows Task Scheduler):
npx tsx src/cli.ts install | uninstall | start | stop | status | logs [--lines N]
```

Everything routes through the single CLI entry `src/cli.ts` (`main()` → command switch). `npm start`
is just `tsx src/cli.ts serve`. There is no compiled output; `tsx` executes the `.ts` sources
(note imports use explicit `.ts` extensions).

### Gotchas that will bite you
- **The server reads config once at startup.** After `add-account` / `rename`, a running dashboard
  will not pick up the change until you `stop` then `start` (or restart `serve`).
- **Bind is `127.0.0.1` only.** Probe health with `127.0.0.1`, not `localhost` — on Windows
  `localhost` resolves to `::1` (IPv6) first and the check will spuriously fail.
- **`add-account` is idempotent.** If a login window is closed with Ctrl-C instead of `/exit`, the
  creds land in the isolated home but the account never registers. Re-run the *same* command — it
  detects the existing login and registers non-interactively (no second browser).

## Architecture (the big picture)

Data flows one direction, and every seam is dependency-injected so it can be tested without network,
clock, or timers:

```
Poller (staggered, per-account TTL)
  → makeFetchUsage()  → adapters/claude.ts | adapters/codex.ts   (provider-specific fetch + normalize)
    → SnapshotStore   (in-memory Map<accountId, NormalizedUsage>, last value wins)
      → server.ts /api/usage  (enriches each window with a severity, sorts accounts by tightest)
        → web/ (vanilla HTML/CSS/JS, polls /api/usage every uiRefreshSeconds)
```

- **`src/types.ts` is the contract.** `NormalizedUsage` (with `session` / `weekly` / `weeklyOpus`
  `UsageWindow`s, a `status`, and error/retry fields) is the single shape both providers normalize
  into and everything downstream consumes. `weeklyOpus` is Claude-only. `resetsAt` is deliberately
  `null` when the API hasn't anchored a reset (a fresh 0% window) — **never fake epoch 0**, it renders
  as a misleading "resets now".
- **`src/poller.ts`** owns scheduling and resilience, not fetching. Each account has its own next-due
  time; polls are staggered 7s apart and spaced by a per-provider TTL (`pollIntervalSeconds`: Claude
  180s for sticky-429 safety, Codex 60s). On `throttled` it backs off 5→10→15 min; on `auth_error` it
  pauses 15 min (a known-bad token isn't worth hammering). Crucially, **on any non-`ok` result it
  carries forward the last-known windows from the store** so the dashboard never blanks a card.
- **`src/adapters/index.ts` (`makeFetchUsage`)** is the provider dispatch. It hands Claude a
  `getAccessToken` closure bound to the account's isolated home; Codex reads its own auth file. Both
  adapters call **`src/adapters/http.ts` `fetchWithRetry`**, which retries transient transport
  failures (ECONNRESET, undici timeouts, DNS blips) and 5xx a couple of times but returns 4xx
  immediately, and tags the final error with its cause code (e.g. `fetch failed (ECONNRESET)`).
- **`src/thresholds.ts`** is the only place utilization → severity is decided (`≥90` crit, `≥70`
  warn). The server enriches windows with this; the web layer only styles by it.

### The two providers differ mainly in auth
Each account gets its **own isolated credential home** under `~/.subtrack/`, so subtrack never
touches (or is touched by) your primary `~/.claude` or `~/.codex`:

- **Claude** (`src/auth/claude.ts`, `src/adapters/claude.ts`): login runs Claude Code with
  `CLAUDE_CONFIG_DIR=~/.subtrack/claude-homes/<id>`; the token lands in that home's
  `.credentials.json`. subtrack **owns and auto-refreshes** it — `ClaudeAuth.getAccessToken` refreshes
  at/near expiry against `console.anthropic.com/v1/oauth/token` (**form-encoded**, not JSON — JSON
  400s) and persists the rotated token back. Usage comes from `api.anthropic.com/api/oauth/usage`
  with a specific `anthropic-beta` header set. On 401 it force-refreshes once and retries; 401/403
  after that → `auth_error`. This is set-and-forget — no manual token rotation.
- **Codex** (`src/auth/codex.ts`, `src/adapters/codex.ts`): login runs `codex login` with
  `CODEX_HOME=~/.subtrack/codex-homes/<id>`; creds live in that home's `auth.json`. **No
  auto-refresh** — a 401 surfaces as `auth_error` telling the user to re-run `codex login`. Usage
  comes from `chatgpt.com/backend-api/wham/usage`; the response nests windows under `rate_limit`, and
  the adapter classifies each present window into session (~5h) vs weekly (~7d) **by its
  `limit_window_seconds`**, so it's robust to which slot the API uses.

These usage/token endpoints are **unofficial / reverse-engineered** and require full-login OAuth
credentials (a `claude setup-token` can read usage but the login flow here uses the isolated Claude
Code login). Header sets and body encodings were verified against real traffic — treat the comments
in the adapter/auth files as load-bearing, not decoration.

> Note: `src/secrets.ts` provides a Windows-Credential-Manager–backed `SecretStore` (via
> `@napi-rs/keyring`, service `subtrack`) with tests, but it is **not currently wired into the
> adapters** — live credentials are the on-disk isolated homes described above. Don't assume the
> keyring is on the auth path.

### Always-on supervision (Windows) — `src/daemon.ts` + `src/install.ts`
`install` writes a `wscript` VBS shim and registers a Scheduled Task `subtrack-dashboard`:
at-logon trigger + a best-effort 30-min self-heal repetition, hidden (no console window),
**`LogonType Interactive` and runs as the user — never SYSTEM**, because it must read the user's
profile (the isolated Claude/Codex homes) and DPAPI-protected data. The task launches
`src/cli.ts daemon`, a supervisor that keeps `serve --no-open` alive: single-instance via an
`/api/health` check plus an exclusive PID lock at `~/.subtrack/daemon.lock`, restart-on-crash with
2→60s backoff (a run that survives 30s resets the backoff), logging to `~/.subtrack/logs/subtrack.log`
(rotated at 5 MB). If `status` shows the daemon running but the dashboard down, the supervisor's
`serve` child is wedged (e.g. socket died after sleep) — `stop` then `start` gives a clean child.

### Windows-specific care already baked in (don't "simplify" it away)
- Entry-point detection uses `pathToFileURL(process.argv[1])`, not a string-built `file://` URL
  (backslashed drive paths never compare equal otherwise).
- `serve` resolves `web/` with `fileURLToPath(new URL('../web/', import.meta.url))` — **never**
  `URL.pathname` (it leaves `%20` and a leading slash on Windows).
- The CLI sets `process.exitCode` and lets the loop drain instead of calling `process.exit()` — an
  abrupt exit while the keyring native module has an open handle trips a libuv assertion.

## Where to read more
- Full design + risk analysis: `docs/superpowers/specs/2026-06-29-subtrack-design.md`
- Implementation plan (with a self-review of deferred minors): `docs/superpowers/plans/2026-06-29-subtrack.md`
- Tests mirror `src/` under `tests/` and are the fastest way to learn a module's contract; adapters
  have `tests/fixtures/*.json` capturing real response shapes.
