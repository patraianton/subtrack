# ccwatch — uptime watchdog for the interactive Claude Code fleet

**Status:** design (spike validated 2026-07-12 — GO)
**Author:** brainstormed with Anton, 2026-07-12
**Repo:** lives inside `sub-tracking` alongside `subtrack`.

## Problem

Anton runs ~10 autonomous **interactive** Claude Code windows across several accounts. Each
launches via a `ccN` PowerShell function (sets `CLAUDE_CONFIG_DIR`, runs
`claude --chrome --dangerously-skip-permissions [--resume <id>]` in the shell foreground). They
freeze on three recurring things and then sit idle burning wall-clock:

1. **Usage-limit block** — "You've hit your session/weekly/Opus/Fable limit · resets HH:MM" plus an
   interactive menu (`/rate-limit-options`) with a "Stop and wait for limit to reset" row. No hook
   fires; the session does not auto-continue at reset.
2. **Request timeout / transient API error** — 429/500/502/503/504/529/overloaded.
3. **Wedged / interrupted turn** — stuck mid-stream.

Goal («следить за бесперебойностью работы»): an external babysitter that detects these and recovers
them so the fleet keeps running.

## Hard constraints (from Anton)

- **Do not change how windows launch.** No PTY/ConPTY wrapper, no respawning under a supervisor. The
  window stays a normal visible interactive TUI the user can also use. The watchdog is a separate
  background process that **reads session jsonl + presses keys in the live window**.
- **Workers stay on classic conhost** (accepted constraint). If a window is ever on Windows
  Terminal/ConPTY the injection channel does not reach its stdin — the watchdog degrades that window
  to **notify-only**. Only conhost windows are actuated.
- **Must not be fragile:** never act on a false positive, never double-send, never press anything that
  spends money.

## Spike result (2026-07-12) — GO

A ~200-line C# Win32 helper `conagent` proved every primitive against real conhost targets including a
live scratch `claude` Ink TUI (details in memory `watchdog-conagent-spike`):

- `AttachConsole(pid)` attaches by pid with `foreground:false` — **no focus theft**.
- Right-window proof = `GetConsoleWindow`→class `ConsoleWindowClass` + `GetConsoleProcessList` contains
  the target pids (not HWND/title guessing).
- `ReadConsoleOutputW` (fresh `CONOUT$`) reads the **Ink alternate-screen buffer** — menus, dialogs,
  and the `>`/`❯` selection marker are legible.
- `WriteConsoleInputW` KEY_EVENTs reach Ink's raw-mode reader: **arrows move a Select** (2→4 on
  DOWN×2), **Enter is accepted**, **text injects with verified-echo**, **backspace deletes precisely**.
  Cooked readers work too (cmd executed an injected `echo`).

Load-bearing risk #1 (does injection reach the live Ink TUI) is therefore **retired**. The remaining
risks (below) are about correctness of detection and drift, not channel viability.

## Architecture

A sibling daemon in `sub-tracking`, same conventions as `subtrack` (Node 24 + tsx, no build step,
dependency-injected seams, DI clock, `node --test`). It reuses `src/daemon.ts`/`src/install.ts`
(parameterized) for a Scheduled Task `subtrack-watchdog` — **LogonType Interactive, runs as the user**
(AttachConsole + PEB reads are same-session/same-user only) — with a PID lock at
`~/.subtrack/watchdog.lock` and rotating log `~/.subtrack/logs/watchdog.log`.

```
tools/conagent/conagent.cs   the ONLY native code — verbs: list · info · read · send · selftest
                             (compiled with framework csc.exe to ~/.subtrack/bin at install)
src/watchdog/
  types.ts        WindowBinding, TranscriptFacts, ScreenFacts, InstantLabel, ConfirmedState,
                  Plan, SagaStep, LedgerEntry
  config.ts       ~/.subtrack/watchdog.json: homes map (configDir basename → ccN → subtrack
                  accountId), switchTargets (USER-EDITABLE), thresholds, budgets, mode, flags
  conagent.ts     ConAgent { list(); info(pid); read(pid); send(SendReq) } — spawns conagent.exe
                  windowsHide, JSON via --out file, hard deadline, fail-closed on nonzero/garbage
  scanner.ts      FleetScanner(ConAgent, Clock) → WindowBinding[]  (enumerate + PEB + probe)
  binding.ts      PURE (procs, homes, fsListing, consoleTitles) → bindings + confidence
  transcript.ts   PURE jsonl tail parser + synthetic-text table → TranscriptFacts
  screen.ts       PURE raw rows+attrs → ScreenFacts (regex table, spinner collapse, highlight)
  usage.ts        UsageSource → subtrack GET /api/usage via fetchWithRetry + freshness stamp
  classify.ts     PURE classify(T,S,U,P,H,now) → InstantLabel
  fsm.ts          dwell/debounce state machine (injected Clock, poller.ts style) → ConfirmedState
  policy.ts       PURE decide(window, fleet, usage, cfg) → Plan | null
  targets.ts      PURE pickTarget(usage, fleet, ledger, cfg) → accountId | null
  playbooks/      waitInPlace · switchAccount · retryTurn · nudge — each an ordered saga of
                  {precondition, action, verify, timeout, onFail} steps
  executor.ts     gate chain + verified-send runner + saga step machine (persisted, resumable)
  ledger.ts       append-only JSONL idempotency store, replayed on startup
  statefile.ts    atomic write of ~/.subtrack/watchdog/state.json each tick
  orchestrator.ts staggered per-window tick loop (subtrack Poller pattern)
tests/watchdog/   fixtures: real jsonl tails, real screen captures (incl. a limit menu WITH an
                  Upgrade row), canned /api/usage snapshots; FakeConAgent, FakeClock
```

Everything above `conagent.ts`/`usage.ts` is pure or takes injected fs/clock — the whole safety
surface runs in `node --test` with no windows, exactly like `subtrack`'s poller.

`WindowBinding` carries `windowKey = claudePid + ':' + processStartTime` (pid-reuse guard),
`claudePid`, `shellPid` (+ start times), `configDir`, `accountId`, `cwd`, `projectDirEscaped`
(`_cc_escape` rule from launchers.ps1), `sessionJsonl`, `sessionId`, `consoleHost`,
`bindingConfidence: exact | ambiguous`.

**Session binding (layered, confidence-scored):** (1) console title ⊇ a unique candidate's
`custom-title` record → high; (2) jsonl mtime advancing across ≥2 scans while pid alive → medium;
(3) unique non-stale jsonl whose records' `cwd` matches PEB cwd and mtime ≥ claude start → medium. Two
live windows on one (home, cwd) with no title discrimination → **ambiguous**.

## Per-window state machine

Overlays (evaluated first, compose with any state): **HUMAN** (this conhost was foreground ≤ 5 min ago
/ 10-min hold-down / a `hold` file) → observe only; **UNACTUATABLE** (probe says not conhost) → detect
+ alert only; **AMBIGUOUS** → screen-local actions only; **SETTLING** (5 min after a wall-clock jump >
2× tick, i.e. machine sleep/resume) → fleet-wide observe only.

| State | Entry evidence (all clauses) | Actionable? |
|---|---|---|
| UNKNOWN | default / just (re)bound / unclassifiable | never |
| WORKING | jsonl grew since last scan OR spinner on screen OR CPU delta > 0 with turn open | never (wins ties) |
| LOOP-SLEEPING | pending ScheduleWakeup, `now < wakeAt + grace`, idle prompt; grace = max(5 min, 10% of delay) | never — sleep is health |
| LOOP-OVERDUE | `now ≥ wakeAt + grace`, still silent, idle prompt | Phase 2 nudge |
| IDLE-DONE | clean `end_turn` + `turn_duration`, no pending wakeup, idle prompt, quiet ≥ 10 min, stable 2 ticks | **never** — no recovery edge (don't start work); sticky until a new record |
| LIMIT-BLOCKED(kind) | screen banner/menu (`/hit your (session\|weekly\|opus\|fable).*limit/i`) **AND** (synthetic jsonl limit line OR subtrack matching window ≥ 95% / `throttled`, one 180 s-stale cycle allowed) | **yes (MVP)** |
| API-ERROR | synthetic retryable line (`Overloaded`, 429/5xx, "Connection closed mid-response") or screen error text, **and** idle prompt (spinner active ⇒ WORKING — the CLI's own retries are running), stable 60 s | Phase 2 |
| WEDGED | turn open, jsonl + screen hash + CPU all flat ≥ 30 min, not LIMIT/API-ERROR, 2 ticks | Phase 2 ladder |
| AUTH-BROKEN | `Not logged in` synthetic or subtrack `auth_error` | alert only, never auto-login |
| TAIL-CORRUPT | byte-identical unparseable tail across 3 reads / ≥ 10 s, size frozen; or dangling `tool_use` on a **dead** process | alert (Phase 1); guarded repair (Phase 4) |
| EXITED | claude.exe gone, shell alive, `PS …>` on screen | drop after 1 h unless mid-saga |
| COOLDOWN | action just taken; watching for effect | gates further action |
| QUARANTINED | 3 failed/unconfirmed sends on this window | manual clear only |

**Dwell before any action:** an actionable state must hold across 2 classifications ≥ 30 s apart;
LIMIT-BLOCKED additionally needs the two-factor above. Every plan carries an evidence fingerprint and
runs at most once per fingerprint.

## Detection signals

| # | Source | Cadence | Facts | Feeds |
|---|---|---|---|---|
| S1 | jsonl tail (incremental byte-offset, last ~64 KB, defensive line-wise parse; unknown `type` ignored+counted) | 15 s stat, parse on change | lastRecordAt/type, `turnOpen`, `pendingToolUse`, `turn_duration` anchor, `scheduledWakeAt`, synthetic-text class (limit/API/auth), `tailIntegrity`, model, version | semantic state |
| S2 | jsonl + `subagents/` size/mtime | 15 s | growth boolean | WORKING, wedge timer |
| S3 | subtrack `GET 127.0.0.1:7777/api/usage` | 60 s | per account session/weekly/weeklyOpus/fable util + resetsAt, fableAccess, status, lastUpdated (stale > 2× TTL) | limit two-factor, target pick, reset scheduling |
| S4 | screen read (`conagent read`, visible rect + attributes, spinner→`<spin>`, double-read stability) | **on demand only** (corroborate a state, pre/post action; ≤ 1/min/window) | IDLE_PROMPT, LIMIT_BANNER(+reset), LIMIT_MENU(+rows+highlight via `❯` + inverse attr), SPINNER(+elapsed), API_ERR, SHELL_PROMPT, input-line-empty, hash | UI state, all pre/postconditions |
| S5 | process liveness + CPU-time delta (`conagent list`) | 15 s | alive, ppid chain, start times, CPU delta | EXITED, wedge, pid-reuse |
| S6 | presence: `GetForegroundWindow` vs fleet conhost HWNDs; `GetLastInputInfo` | 15 s | HUMAN overlay | suppression |
| S7 | PEB via `conagent info` (ccwindows technique, offsets 0x20/0x80/0x38/0x40) | once per pid | CLAUDE_CONFIG_DIR, cwd → account, project | binding |

**Cross-checks:** jsonl says limit but subtrack says 40% → BINDING-SUSPECT, freeze + rebind. subtrack ≥
99% + jsonl silent mid-turn ±3 min → LIMIT-BLOCKED pending one screen confirm (the interactive menu
writes no transcript record — the only path that catches it). Spinner elapsed-counter advancing across
2 snapshots → WORKING regardless of jsonl silence (long Bash builds write nothing).

## Actuation procedure

`conagent send --pid <claude> --pid2 <shell> --script <ops>` runs **one transaction in one attach**,
serialized fleet-wide by named mutex `Global\subtrack-conagent`, parent-killed at 3 s (reads) / 10 s
(scripted sends):

1. `FreeConsole()`; `AttachConsole(pid)`; fail → `{stage:"attach"}`.
2. `GetConsoleWindow()` class must be `ConsoleWindowClass`; `GetConsoleProcessList()` must contain both
   `claudePid` and `shellPid` with matching start times — **the "right window" proof**.
3. Gates: `GetNumberOfConsoleInputEvents > 0` → abort `pending_input`; `GetForegroundWindow() ==
   GetConsoleWindow()` → abort `foreground`; kill-switch file present → abort.
4. Read screen; compare to `--expect-hash` from the planner's last read → mismatch = `stale`, abort
   (planner re-observes); assert `--expect-re` precondition (e.g. IDLE_PROMPT + empty input line, or
   LIMIT_MENU, or `PS .*>`).
5. Execute the closed-vocabulary script (there is **no arbitrary-text API**):
   - Keys as INPUT_RECORD down+up pairs: ENTER (VK 0x0D, `\r`), UP/DOWN (0x26/0x28, **ENHANCED_KEY**),
     ESC, BACKSPACE×n; text per-char via `VkKeyScanW` (user32) with UnicodeChar; 30–50 ms inter-key
     delays; `SLEEP:n` between arrow steps.
   - **Verified echo** for text: type WITHOUT Enter → re-read → assert the exact text sits on the input
     line → only then ENTER. Assert-fail → BACKSPACE×len, abort, alert.
   - **Menu select** (`SELECT /stop and wait/i`): re-read; locate rows + highlighted row (`❯` + inverse
     attr); target must match allowlist AND **not** match paid denylist
     `/upgrade|extra usage|buy|purchase|credit|billing|subscribe|payment|add funds/i`; move ONE arrow at
     a time re-reading after each (max 8); ENTER only when a fresh read shows the highlighted row passing
     allow+deny; no match → single ESC, abort, alert. Never index-based, never blind counts.
6. Poll-read every 150 ms up to `--confirm-ms` for `--confirm-re` (and pre-state gone). Return
   `{sent, confirmed, beforeHash, afterHash}`. `confirmed:false` = failed action: no same-script retry,
   failure counter++, 3 → QUARANTINED.

Typed-text vocabulary (total): `continue` · `/exit` · `. $HOME\.claude-accounts\launchers.ps1; cclast
<N>`. **Banned forever:** Ctrl-C, `/usage-credits`, `/model`, any menu-Enter without step-5
verification, anything while HUMAN overlay is set.

Extra safety rules from the adversarial pass: (i) any script whose first committed token is ENTER (or
that types text) first asserts the TUI input line is **empty** (never submit a half-typed human draft);
(ii) a screen classification counts only if two reads ~150 ms apart hash identically (Ink repaints tear);
(iii) before typing `cclast`, PEB-read the **shell** and assert its cwd equals the project cwd
(cclast keys off the shell cwd).

**Fallback chain (not conhost):** mark UNACTUATABLE → detection + a dashboard prescription
("cc3 limit-blocked, reset 19:40 — run `cclast 5` in that window") + local toast → optional
`allowFocusStealing` (SetForegroundWindow + SendInput, only if global idle > 15 min) **shipped OFF** →
never WriteConsoleInput at ConPTY.

## Recovery decision policy ("smart choice")

Gate chain before any plan executes: kill-switch file `~/.subtrack/watchdog/PAUSE` → mode=observe →
HUMAN/hold overlay → dwell + two-factor → per-window cooldown 15 min → idempotency ledger → budgets →
fleet action spacing 60 s → **one saga in flight fleet-wide**.

**LIMIT-BLOCKED(kind):** `resetAt` = subtrack `resetsAt` for the matching window (banner cross-check;
divergence > 15 min → WAIT + alert, never switch).
- `resetAt − now ≤ waitThresholdMin` (default **30 min**) → **WAIT_IN_PLACE**: if the menu is on screen,
  SELECT the wait row (safe even if the saga then dies); banner-only → ESC to the idle prompt. Arm a
  re-check at `resetAt + 2 min`: transcript advancing → done; else idle prompt + pre-block `turnOpen` +
  a **fresh** subtrack poll showing utilization actually dropped (< 50) → verified-echo `continue` ENTER,
  once. A clean pre-block turn → do nothing (no busywork).
- else → **SWITCH_ACCOUNT** (exact-confidence bindings only). Saga, each step verified, every failure
  state safe (parked at wait / claude untouched / bare PS prompt):
  1. Park safely: SELECT wait row (or ESC banner) → verify idle.
  2. Verified-echo `/exit` ENTER → poll claude.exe exit ≤ 30 s; won't exit → freeze + alert (never kill).
  3. Flush check: jsonl size+mtime stable 2 s AND `tailIntegrity == ok`; else repair/alert BEFORE
     resuming (cclast copies the largest jsonl — must not propagate a corrupt tail).
  4. Verify SHELL_PROMPT; `conagent info` the shell → cwd must equal the project cwd.
  5. Verified-echo `. $HOME\.claude-accounts\launchers.ps1; cclast <N>` ENTER.
  6. Verify ≤ 60 s: new claude.exe child of shellPid, PEB CLAUDE_CONFIG_DIR = target home, cwd
     unchanged, jsonl appears in target home and grows; rebind (ledger links old→new windowKey).
  7. `--resume` opens idle; only if pre-switch `turnOpen`/`pendingToolUse` → verified-echo `continue`.
  8. New transcript record ≤ 3 min → SUCCEEDED; else LANDED_UNVERIFIED → freeze + alert. Any step
     failure: stop, never improvise past it.

`pickTarget` (in `targets.ts`, pure): eligible account ∈ **user-editable `switchTargets`**, ≠ current,
subtrack `status=ok` fresh ≤ 6 min, session < 50, weekly < 85; if the window runs a Fable model then
`fableAccess && fable < 85`; exclude an account another WORKING window sits on near a weekly cliff;
hysteresis (not an account this window left < 45 min; ≤ 2 inbound switches/account/30 min); rank by
fewest attached WORKING windows, then composite headroom (weekly weighted double). None qualify →
WAIT-ALL at the earliest fleet reset + a "fleet exhausted until HH:MM" panel state. Fable/model-cap
kind: switch or wait only; `/usage-credits` and `/model` are denylisted.

**API-ERROR (Phase 2):** after 60 s dwell — explicit retry affordance on screen → ENTER only
(empty-input asserted); else idle + `turnOpen` → one verified-echo `continue`; no new records in 5 min →
one repeat; then freeze. ≤ 2 nudges/window/hour.

**LOOP-OVERDUE / WEDGED (Phase 2):** evidence snapshot → single ENTER (empty input asserted) → ESC +
`continue` only if `turnOpen` → freeze + alert. Never Ctrl-C, never `/exit` a wedged window
(mid-write jsonl), never ESC a WORKING window.

**Budgets (blast-radius caps, all in config):** ≤ 3 actions/window/h, ≤ 6/window/24 h, ≤ 2
`continue`/window/day (it spends quota), ≤ 1 switch/window/6 h, ≤ 4 switches/h fleet, ≤ 20 actions/24 h
fleet. Exceeded → alert-only. Auto-quarantine: 3 failed sends/window; 3 quarantines/h fleet → global
self-pause.

## Integration & observability

- **subtrack**: read-only `/api/usage` consumer (honors `resetsAt: null` unanchored + `stale`). Server
  gains `GET /api/watchdog` (per-request read of `state.json`, sidesteps the read-config-once gotcha)
  and `POST /api/watchdog/killswitch`. Web gains a **Fleet panel** — row per window (project, account
  chip, state badge reusing severity styling, since, last action+outcome, confidence), fleet header
  (mode, kill-switch toggle, switches-last-hour, saga-in-flight), pinned alert feed, **and an editor for
  the `switchTargets` list** (Anton changes eligibility by situation). Codex windows listed, actuation
  out of scope v1.
- **ccwindows**: PEB reader ported verbatim into `conagent info` (incl. the shrink-on-failure read loop
  and the root-vs-home `.claude.json` email asymmetry); the PS function stays for humans.
- **cclast**: invoked exactly as the user would — typed into the freed shell with the re-source prefix;
  largest-copy semantics stay in launchers.ps1.
- **Observability**: ledger `~/.subtrack/watchdog/ledger.jsonl` (decision/step/result + evidence
  fingerprint = idempotency store); per-action evidence bundle `~/.subtrack/watchdog/actions/<ts>-<pid>/`
  (last 20 jsonl records, pre/post screen text, usage slice, exact script); `watchdog.log` rotated;
  alert states raise a **local Windows toast** — nothing outbound is ever sent.

CLI (via existing `src/cli.ts` switch): `watchdog install|uninstall|start|stop|status|logs|on|off|mode
observe|act|hold <pid|all>|windows|selftest`.

## Phased delivery

- **Phase 0 — spike: DONE (GO).** `conagent` primitives proven on a live Ink TUI. Next: promote the
  scratch helper to `tools/conagent/conagent.cs`, add `selftest` (hidden conhost + readline echo child)
  as a permanent install check, and capture real fixtures (idle prompt, spinner, PS prompt; a limit menu
  when one occurs).
- **Phase 1 — MVP (observe + the one most common freeze):** scanner/binder/transcript/classify/fsm,
  state file, subtrack Fleet panel + switchTargets editor, ledger, kill switch, `mode observe` writing
  WOULD-DO ledger entries; run 3–7 days and audit against reality. Then `act` **only** for LIMIT-BLOCKED
  **WAIT branch** (menu wait-row select + post-reset verified `continue`). Far-reset blocks alert with
  the exact manual `cclast <N>` prescription (computed but not executed). Everything else = detect +
  alert. **Deliverable: no window ever again sits silently parked on a soon-resetting limit.**
- **Phase 2:** API-ERROR nudge; LOOP-OVERDUE/WEDGED ladder (ENTER first).
- **Phase 3:** SWITCH_ACCOUNT saga + `pickTarget` live; saga resumability across watchdog restarts.
- **Phase 4 (deferred):** guarded jsonl tail repair behind a flag; opt-in focus-stealing fallback for
  non-conhost windows; Codex window actuation.

## Riskiest assumptions & de-risking (post-spike)

1. **Channel reaches Ink** — RETIRED by the spike (arrows moved a Select, Enter/text/backspace all
   landed on a live claude).
2. **Screen reading vs Ink alt-buffer is trustworthy** — proven readable; residual risk = torn repaints
   → double-read stability rule; any menu-shaped-but-unmatched screen → UNKNOWN, no action; regexes
   built only from captured fixtures.
3. **Limit-menu wording drifts across CLI versions** — allowlist+denylist fail closed (ESC + alert);
   3–7 days observe-mode fixture collection before `act`; regex table hot-reloadable; verify the denylist
   against a captured menu **containing a real Upgrade row**. Worst case = a missed recovery, never a
   paid press.
4. **Corrupted-jsonl "dangling tool_use breaks resume"** is folklore until reproduced — repair ships
   detect+alert first; the switch saga's flush check (step 3) protects cclast regardless.
5. **Binding wrongness** (two windows same account+cwd) — AMBIGUOUS bars switching; post-`/exit`
   re-check asserts the newest cwd session id equals the bound id; jsonl-vs-subtrack contradiction →
   BINDING-SUSPECT freeze.
6. **User-typing race** — no exclusive console lock exists; mitigated by <1 s scripts, HUMAN 5-min
   hold-down, foreground + pending-input aborts, and empty-input-line precondition (worst realistic
   interleave = garbled text that verified-echo refuses to ENTER and backspaces away).
7. **Default-terminal migration to Windows Terminal** — per-window probe classifies; "fleet majority not
   conhost" raises a one-time loud alert; degrade to notify-only.
8. **subtrack staleness/outage** — every subtrack-dependent action needs a fresh `ok` datapoint; else
   degrade to screen+jsonl detection, WAIT-only, alerts.

## Open questions for Anton (resolve before/while writing the plan)

1. **Wait-row ground truth:** OK to force a usage-limit on a throwaway account to capture the exact
   current menu wording, or wait for one to occur organically in observe mode?
2. **Threshold:** is 30 min the right wait-vs-switch line? Should weekly/Opus/Fable blocks (reset days
   away) **always** switch, never wait?
3. **The nudge word:** is bare `continue` the right universal resume for both /loop workers and one-shot
   tasks, or do some loops need a different continuation?
4. **Budgets sign-off:** 2 `continue`/window/day, 1 switch/window/6 h, 4 switches/h fleet — acceptable?
5. **Ambiguous windows:** confirm — screen-local wait-select allowed, switch/continue forbidden.
6. **Alerting surface:** dashboard panel + local Windows toasts enough?
```
