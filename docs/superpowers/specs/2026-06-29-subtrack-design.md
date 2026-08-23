# subtrack — Design Spec

**Date:** 2026-06-29
**Status:** Approved (design); pending implementation plan
**Author:** Anton + Claude

---

## 1. Summary

`subtrack` is a personal, always-on **local web dashboard** (Windows 11) that shows the
**5-hour session** and **7-day weekly** usage-limit status across **5 Claude Pro/Max accounts**
and **2 Codex (ChatGPT-subscription) accounts** — 7 accounts total, mixed providers — at a glance.

A small Node process polls each account's live usage on a staggered schedule, normalizes the
result into one provider-agnostic shape, holds it in memory (no database — **live snapshot only**),
and serves an auto-refreshing browser dashboard at `http://localhost:<port>`.

---

## 2. Goals / Non-goals

### Goals
- One screen showing, per account: session % used + reset countdown, weekly % used + reset countdown.
- Mixed providers (Claude + Codex) in one view, each account independent.
- Color-coded thresholds so the tightest account is obvious at a glance.
- Robust against the providers' rate-limit / token quirks (sticky 429s, token refresh, token rotation).
- Easy onboarding of all 7 accounts via a guided `add-account` flow.

### Non-goals (this version)
- **No historical storage / trend lines / burn-rate projection** (explicitly deferred — live snapshot only).
- **No push notifications / Slack / desktop alerts** (visual thresholds only; alerting is a future add-on).
- No cost/dollar accounting (this is about *limits*, not spend).
- No multi-user / hosted deployment — single local user, localhost only.

---

## 3. Background & key findings (from feasibility research, 2026-06-29)

> Full brief: workflow `subtrack-feasibility-research`. The three findings that shaped this design:

1. **Claude onboarding = capture the `claude /login` credentials (NOT a setup-token, NOT a web flow).**
   ⚠️ Settled live 2026-06-30 after two wrong turns:
   - subtrack can't run its own OAuth web flow — Anthropic's authorize page is bound to the real Claude
     Code client; replicating it from a 3rd-party app fails with "Invalid request format" on every host.
   - A bare `claude setup-token` (`sk-ant-oat01-…`) **403s** on `/api/oauth/usage` — it lacks `user:profile`
     (verified live on a real setup-token). The `claude /login` token is ALSO `sk-ant-oat01-…` but carries
     `user:profile` + a refresh token and **does** read usage (verified: session 48% / weekly 55%).
   - So `add-account --provider claude` reads `%USERPROFILE%\.claude\.credentials.json` (`claudeAiOauth`,
     written by `claude /login`) and stores `{accessToken, refreshToken, expiresAt, scopes}`. No paste.
   Usage headers (per Aperant): `anthropic-beta: claude-code-20250219,oauth-2025-04-20` +
   `anthropic-version: 2023-06-01` (no User-Agent needed).
2. **Codex is feasible and cleaner via the official CLI.** Codex usage is readable at
   `GET https://chatgpt.com/backend-api/wham/usage` (endpoint existence confirmed live). To monitor **two**
   Codex accounts without colliding on one `~/.codex/auth.json`, subtrack gives each Codex account its own
   isolated `CODEX_HOME`, and lets the already-installed `codex` CLI own all token refresh.
3. **ToS caveat (accepted by user).** Anthropic's Feb-2026 policy intends consumer-plan OAuth tokens for
   Claude Code / Claude.ai only; an always-on off-product poller carries some account-flagging exposure.
   Mitigation: send a `claude-code/<version>` User-Agent (mimics the official client), poll Claude no more
   than once per **≥180 s** per account, stagger, and back off hard on 429. User has chosen to proceed.

---

## 4. Architecture

```
 CLI:  subtrack serve | add-account | list | remove-account | check
          │
          ▼
 POLLER ──per account, staggered, per-provider TTL──▶ ADAPTER (claude | codex)
 (timer, 429 backoff, freeze-on-throttle)                  │
                                                           ▼
                                                   NormalizedUsage
                                                           │
                                                           ▼
                                              in-memory SNAPSHOT STORE
                                                           │
 HTTP SERVER ── GET /api/usage (snapshot JSON) + serves web/ ──┘
          │
          ▼
 BROWSER dashboard — polls /api/usage every ~30 s, renders gauges (reads cache only)
```

The browser's refresh cadence is **decoupled** from the provider network cadence: the UI reads a cache
every ~30 s; the poller refreshes each provider on its own slower, staggered schedule. This is the core
defense against the sticky-429 problem.

---

## 5. Components

Each component is small, single-purpose, and communicates through a narrow interface.

| Component | Responsibility | Key interface | Depends on |
|---|---|---|---|
| `config` | Load/save non-secret account registry | `loadConfig()`, `saveConfig()`, `addAccount()`, `removeAccount()` | fs |
| `secrets` | Per-account secret get/set/delete | `getSecret(key)`, `setSecret(key,val)`, `deleteSecret(key)` | `@napi-rs/keyring` (Win Credential Manager), DPAPI-file fallback |
| `auth/claude` | Guided OAuth PKCE login + token refresh | `loginInteractive(id)`, `getAccessToken(id)` | `secrets`, `open`, fetch |
| `auth/codex` | Per-account `CODEX_HOME` isolation + login | `loginInteractive(id)`, `homeDir(id)`, `readAuth(id)` | child_process (`codex`), fs |
| `adapters/claude` | Fetch + normalize Claude usage | `fetchUsage(account) → NormalizedUsage` | `auth/claude`, fetch |
| `adapters/codex` | Fetch + normalize Codex usage | `fetchUsage(account) → NormalizedUsage` | `auth/codex`, fetch |
| `poller` | Schedule fetches, TTL, 429 backoff/freeze | `start()`, `stop()` | adapters, `snapshotStore` |
| `snapshotStore` | In-memory latest snapshot per account | `get(id)`, `set(id, usage)`, `all()` | — |
| `server` | Serve dashboard + JSON API | `GET /api/usage`, `GET /api/health`, static `web/` | `snapshotStore`, http |
| `web/` | Dashboard UI (zero-build vanilla HTML/JS/CSS) | polls `/api/usage` | — |
| `cli` | Command dispatch | `serve`, `add-account`, `list`, `remove-account`, `check` | all above |

---

## 6. Normalized data model

The **only** shape the UI and snapshot store know about. Adapters translate each provider into this:

```jsonc
{
  "accountId": "claude-work-1",
  "label": "Claude — Work A",
  "provider": "claude",                 // "claude" | "codex"
  "session":    { "utilization": 62, "resetsAt": "2026-06-29T17:40:00Z" } | null,  // 5h window
  "weekly":     { "utilization": 41, "resetsAt": "2026-07-02T09:00:00Z" } | null,  // 7d window
  "weeklyOpus": { "utilization": 55, "resetsAt": "2026-07-02T09:00:00Z" } | null,  // Claude-only, optional
  "status": "ok",                       // "ok" | "throttled" | "auth_error" | "error"
  "lastUpdated": "2026-06-29T13:12:04Z",
  "error": null,                        // human-readable when status != ok
  "retryAt": null                       // ISO, when throttled/frozen
}
```

`utilization` is percent-used (0–100). `resetsAt` is the window reset time (UTC, normalized to ISO).

---

## 7. Provider data paths (from research — verify live in the spike)

### 7.1 Claude
**✅ Verified live 2026-06-29 (Task 9 spike):** endpoint returns 200 with the token carrying
`user:profile`; `five_hour`→session, `seven_day`→weekly, `seven_day_opus`→weeklyOpus all confirmed
(`utilization` + `resets_at` ISO). The live body also includes `seven_day_sonnet`, a richer `limits[]`
array, and `spend{…}` — all ignored by v1. No code change was needed for Claude.
```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <claudeAiOauth.accessToken>     # MUST carry user:profile scope
anthropic-beta: oauth-2025-04-20
User-Agent: claude-code/<version>                      # load-bearing: omit → punitive 429 bucket
Content-Type: application/json
```
Response (reverse-engineered; confirm field names in spike):
```jsonc
{
  "five_hour":        { "utilization": 0-100, "resets_at": "ISO" },   // → session
  "seven_day":        { "utilization": 0-100, "resets_at": "ISO" },   // → weekly (all models)
  "seven_day_opus":   null | { "utilization": …, "resets_at": … },    // → weeklyOpus (separate cap)
  "seven_day_sonnet": null | { … },
  "extra_usage":      { "is_enabled": bool, … }
}
```
**Token refresh** (access token ~8 h, `expiresAt` in epoch ms — refresh reactively on 401 + proactively
before expiry):
```
POST https://platform.claude.com/v1/oauth/token          # ✅ corrected 2026-06-30 (was console.anthropic.com)
{ "grant_type": "refresh_token", "refresh_token": "sk-ant-ort01-…",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e" }
```
Persist rotated `accessToken` / `refreshToken` / `expiresAt`.

### 7.2 Codex
Credentials live in the account's isolated `CODEX_HOME/auth.json` →
`tokens.{access_token, refresh_token, id_token, account_id}`. Bearer = **`access_token`** (JWT,
lifetime ≈ 10 days; `id_token` is NOT the bearer).
```
GET https://chatgpt.com/backend-api/wham/usage
Authorization: Bearer <tokens.access_token>
chatgpt-account-id: <tokens.account_id>
```
**✅ Verified live 2026-06-29 (Task 9 spike) — corrected shape:** windows are nested under a
top-level `rate_limit` object as `primary_window`/`secondary_window`, each with `used_percent` (0–100),
`limit_window_seconds` (**18000 = 5h session, 604800 = 7d weekly**), and `reset_at` (unix seconds).
Also present: `plan_type`, `additional_rate_limits[]` (per-model, ignored), `credits{…}`.
**Map windows by `limit_window_seconds`** (shorter→session, longer→weekly), not by slot name.
(The original guess — top-level `primary`/`secondary` with `window_minutes` — was wrong; subtrack's
shape-mismatch safety net caught it and returned `error` rather than a fake `ok`.)

On 401, trigger refresh by invoking `codex` against that account's `CODEX_HOME` (Codex owns the rotating
refresh token — subtrack never holds/rotates it itself). Fallback path if the direct call proves
unreliable: `codex -s read-only -a untrusted app-server` JSON-RPC `account/rateLimits/read`.

> **The Codex 200-body shape is the one thing research could not verify live** — confirm it in the spike
> (§11) before committing the parser.

---

## 8. Onboarding flows (`add-account`)

### 8.1 Claude (capture `claude /login` creds — NO paste, NO web OAuth)
```
subtrack add-account <id> --provider claude --label "Claude — Work A"
  1. read %USERPROFILE%\.claude\.credentials.json -> claudeAiOauth  (written by `claude /login`)
  2. store { accessToken, refreshToken, expiresAt, scopes } in Credential Manager keyed by <id>
  3. append non-secret entry to accounts.json
To add N accounts: in Claude Code, `claude /login` as account 1 -> `subtrack add-account claude-1`,
then `claude /login` as account 2 -> `subtrack add-account claude-2`, ... (each add-account snapshots
whatever account is currently logged into Claude Code).
Caveat: the captured token is shared with Claude Code; when subtrack refreshes it (≈8h), Anthropic
rotates it and the matching Claude Code session must re-login. Only affects the account currently active
in `~/.claude`. v1-acceptable; a future option is an isolated CLAUDE_CONFIG_DIR per account (like Codex's
CODEX_HOME) to fully decouple.
```

### 8.2 Codex (isolated CODEX_HOME)
```
subtrack add-account <id> --provider codex --label "Codex — Main"
  1. create %USERPROFILE%\.subtrack\codex-homes\<id>\
  2. run `codex login` with CODEX_HOME pointed at that dir → user logs in as that Codex account
  3. auth.json lands in the isolated home; record { credentialsHome } in accounts.json
  (polling later runs codex / wham-usage with CODEX_HOME=<that dir>, so the 2 accounts never collide)
```

---

## 9. Secret storage & config schema

- **Secrets** (Claude `claudeAiOauth` blobs): **Windows Credential Manager** via `@napi-rs/keyring`
  (prebuilt binary, no node-gyp), one entry per account. Fallback: DPAPI-encrypted file under
  `%USERPROFILE%\.subtrack\` if the native module can't load. Codex secrets stay inside each isolated
  `CODEX_HOME` (managed by `codex`), not duplicated into Credential Manager.
- **Non-secret registry** — `%USERPROFILE%\.subtrack\accounts.json` (gitignored; keep out of cloud-synced
  folders):

```jsonc
{
  "version": 1,
  "port": 7777,
  "uiRefreshSeconds": 30,
  "pollIntervalSeconds": { "claude": 180, "codex": 60 },   // per-provider network TTL
  "accounts": [
    { "id": "claude-personal", "label": "Claude — Personal Max", "provider": "claude",
      "credentialKey": "subtrack/claude-personal", "enabled": true },
    { "id": "claude-work-1",   "label": "Claude — Work A",       "provider": "claude",
      "credentialKey": "subtrack/claude-work-1",   "enabled": true },
    { "id": "codex-main",      "label": "Codex — Main",          "provider": "codex",
      "credentialsHome": "C:\\Users\\<user>\\.subtrack\\codex-homes\\codex-main", "enabled": true }
  ]
}
```

---

## 10. Polling strategy & 429 mitigation

- **Claude:** network fetch per account no more than once per `pollIntervalSeconds.claude` (default 180 s),
  staggered across the 5 accounts (e.g. 36 s apart) so no burst. Always send the `claude-code/<ver>` UA.
  Treat 429 as **sticky**: set `status: throttled`, freeze that account with exponential backoff
  (5 → 10 → 15 min, capped), surface `retryAt`; resume on next success.
- **Codex:** ~60 s is comfortable; refresh handled by `codex`.
- The **UI** refreshes every `uiRefreshSeconds` (30 s) but only reads the in-memory snapshot — it never
  triggers a provider call directly.
- Each account is polled, refreshed, and fails **independently**; one throttled/broken account never blanks
  the dashboard (it shows its last-known value + a stale/error indicator).

---

## 11. Error handling matrix

| Condition | `status` | UI treatment | Action |
|---|---|---|---|
| Claude **403** (scope) | `auth_error` | red border, "token lacks user:profile — re-run add-account" | stop polling that account until re-onboarded |
| **401** (expired) | `ok` after refresh / `auth_error` if refresh fails | transient / red | refresh; on failure prompt re-login |
| **429** (sticky) | `throttled` | grey + "⏳ retry HH:MM" | freeze + exponential backoff |
| Network / 5xx | `error` | keep last value, "stale" badge | retry next cycle |
| Codex 200 shape mismatch | `error` | "unexpected response" | log raw body for diagnosis |

---

## 12. UI / dashboard

- One **card per account**, sorted with the tightest (highest max of session/weekly %) first.
- Card: provider badge (Claude/Codex) + label + status dot; a **SESSION (5h)** bar and a **WEEKLY** bar,
  each with `NN%` and a reset countdown ("resets in 1h44m" / "resets Thu 09:00"); Claude cards may show a
  thin **Opus weekly** sub-bar when `weeklyOpus` is present.
- **Colors:** green `<70%`, amber `70–89%`, red `≥90%`; throttled = grey; auth_error = red border.
- **Top summary line:** the single tightest window across all accounts ("Tightest: codex-main weekly 92%").
- Per-card `lastUpdated`; card dims/badges "stale" when older than its provider TTL.
- Zero-build: plain `index.html` + `app.js` + `styles.css`; `app.js` fetches `/api/usage` on an interval.

---

## 13. Testing strategy

- **Unit:** adapter response-parsing (fixtures of the Claude `/api/oauth/usage` body and the Codex
  `wham/usage` body → `NormalizedUsage`); token-refresh logic (mock `401 → refresh → retry`); config
  load/save round-trip; threshold→color mapping; window-mapping-by-`window_minutes` for Codex.
- **Validation gate (FIRST implementation step — cheap, de-risks everything):**
  `subtrack check` does a one-shot fetch of **one real Claude account + one real Codex account** and prints
  a table. This confirms, against live accounts, before any UI is built:
  - Claude `/api/oauth/usage` returns the assumed `five_hour` / `seven_day` shape (and the token has
    `user:profile`, not a setup-token 403). Validation curl:
    ```
    curl -s -o /dev/null -w "%{http_code}" https://api.anthropic.com/api/oauth/usage \
      -H "Authorization: Bearer <token>" -H "anthropic-beta: oauth-2025-04-20" \
      -H "User-Agent: claude-code/2.0.65"
    ```
    `200` → good; `403` → token is a setup-token, must capture full login creds.
  - Codex `wham/usage` returns the assumed `primary`/`secondary` `RateLimitSnapshot` shape.
- No heavy e2e — personal tool. Manual smoke test of the live dashboard against all 7 accounts before "done".

---

## 14. Tech stack & dependencies

- **Runtime:** Node 24 + TypeScript (run via `tsx` in dev). Node's built-in `fetch` and `http`.
- **Dependencies (deliberately minimal):**
  - `@napi-rs/keyring` — Windows Credential Manager access (prebuilt, no node-gyp).
  - `open` — launch the browser for the Claude login flow.
  - `tsx` (dev) — run TypeScript directly.
- **Frontend:** dependency-free vanilla HTML/CSS/JS.
- External tool reused: the **`codex` CLI** (already installed, v0.141) for Codex auth/refresh.

---

## 15. Risks & open questions (validate live during the spike — do not hardcode from research)

1. **Claude OAuth hosts** — ✅ RESOLVED 2026-06-30 (verified against the installed Claude Code binary). Claude Code has TWO OAuth configs; subtrack reads SUBSCRIPTION usage so it uses the **consumer/subscription** authorize URL, NOT the API/console one: authorize `https://claude.com/cai/oauth/authorize` (the `platform.claude.com/oauth/authorize` URL is the API-console flow — using it logs into the developer platform, wrong for a subscriber). Token exchange + refresh + the manual code-display callback are shared on platform.claude.com: token `https://platform.claude.com/v1/oauth/token`, redirect `https://platform.claude.com/oauth/code/callback`. Login scope `user:profile user:inference user:sessions:claude_code user:mcp_servers` (NOT the `org:create_api_key` setup-token scope). Usage endpoint stays `api.anthropic.com/api/oauth/usage`. Original note kept for history:
   the working one on first refresh.
2. **Claude access-token lifetime** — research saw ~8 h firsthand vs ~60 min elsewhere; don't hardcode,
   refresh on 401 + proactively before `expiresAt`.
3. **Codex 200-body shape** — endpoint confirmed live, success-body parse not. Confirm in spike before
   finalizing the parser; keep the `app-server` JSON-RPC path as fallback.
4. **Exact OAuth authorize URL + scope list** for the Claude login helper — confirm against the current
   Claude Code flow during implementation of `auth/claude`.
5. **ToS exposure** — accepted by user; minimized via `claude-code` UA + conservative polling. Revisit if
   any account shows enforcement signals.

---

## 16. Out of scope / possible future

- History + burn-rate projection (would add a small SQLite/JSONL store).
- Push alerts (desktop toast / Slack) when an account crosses a threshold.
- System-tray widget front-end.
- Auto-start on login (Windows Task Scheduler / startup shortcut).
