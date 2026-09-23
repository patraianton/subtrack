# subtrack HTTP API

This is the complete current HTTP contract implemented by `src/server.ts`, `src/sessions/`, `src/ops/`, and `src/fleet/`. It is a local implementation reference, not a versioned, official, public, or remotely safe API.

For system ownership and data flow, see [Architecture](architecture.md). Service-manifest input is documented in [Configuration](configuration.md), and the action/probe trust boundary is documented in [Security](security.md).

## Transport and routing assumptions

- Production binds plain HTTP to `127.0.0.1:<port>` only. The default port is `7777`.
- The UI is advertised at `http://localhost:<port>`, but probes should use `127.0.0.1`; Windows may resolve `localhost` to IPv6 `::1`, where this server is not listening.
- There is no TLS, authentication, session, API version, CORS policy header, or rate limiter.
- Browser code assumes root-relative same-origin URLs.
- The router ignores the query string. For example, `/api/usage?x=1` routes as `/api/usage`.
- JSON responses use `content-type: application/json; charset=utf-8`.
- `/api/health`, `/api/usage`, and `/api/services` are conventionally read with `GET`, but the current router does not enforce their method and returns the same response for any method.
- `/api/sessions` and `/api/fleet` enforce `GET`. Other methods return JSON `405`, `Allow: GET`, and `Cache-Control: no-store`.
- `POST /api/services/action`, `POST /api/fleet/mode` and `POST /api/fleet/focus` are the only action routes. Other methods for routes other than `/api/sessions` fall through to static-file lookup and normally return `404 not found`, not `405 Method Not Allowed`.
- Unknown routes and missing static files return `404` with plain text `not found`. A static path that fails the normalized web-root boundary returns `403` with plain text `forbidden`.

## Endpoint summary

| Method | Path | Success body | State change |
| --- | --- | --- | --- |
| `GET` by convention | `/api/health` | `HealthResponse` | No |
| `GET` by convention | `/api/conveyor` | `ConveyorStatus` (pass-through) | No |
| `GET` by convention | `/api/usage` | `UsageResponse` | No |
| `GET` | `/api/sessions` | `SessionsResponse` | No |
| `GET` | `/api/burn?account=<id>` | `BurnResponse` | No |
| `GET` by convention | `/api/services` | `ServicesResponse` | No, except first request can seed `services.json` |
| `POST` | `/api/services/action` | `ActionResult` | Yes |
| `GET` | `/api/fleet` | `FleetResponse` | No |
| `POST` | `/api/fleet/mode` | `SetModeResult` | Yes, rewrites `window-modes.json` |
| `POST` | `/api/fleet/focus` | `FocusResult` | Yes, switches the herdr client and raises its window |

## Common scalar types and enums

The schemas below use TypeScript notation. Usage contracts come from `src/types.ts`; the authoritative Services and action contracts come from `src/ops/types.ts`. Optional properties marked `?` can be omitted from serialized JSON. ISO timestamps are strings produced with `Date.toISOString()` unless they originate as unvalidated Windows Task Scheduler strings.

```ts
type Provider = 'claude' | 'codex' | 'grok';
type UsageStatus = 'ok' | 'throttled' | 'auth_error' | 'stale' | 'error';
type Severity = 'ok' | 'warn' | 'crit';

type SessionProvider = 'claude' | 'codex';
type SessionActivity = 'open' | 'recent' | 'idle' | 'archived';
type WindowBinding = 'launch' | 'likely' | 'ambiguous' | 'unknown';

type ServiceKind = 'task' | 'process' | 'port' | 'http' | 'hermes';
type ServiceStatus = 'up' | 'down' | 'degraded' | 'unknown';
type ServiceAction = 'restart' | 'stop' | 'register';

type WindowMode = 'ever' | 'warm' | 'off';
```

The server trusts internal types more than it validates runtime data. In particular, service configuration can inject unsupported values and the action endpoint casts parsed JSON without schema validation. Consumers should not treat these enums as an input-validation guarantee.

## `GET /api/health`

Returns HTTP `200` whenever the Node HTTP server can route the request:

```json
{"ok":true}
```

Schema:

```ts
interface HealthResponse {
  ok: true;
}
```

This is a process/HTTP routing check only. It does not verify provider connectivity, poll freshness, credential validity, Sessions-store/window inspection, Services snapshot acquisition, the daemon, or the Scheduled Task.

## `GET /api/conveyor`

Returns the contents of `~/.autopase-conveyor-status.json` verbatim with `Cache-Control: no-store`. The file is written by an external pipeline; subtrack does not validate it. When the file is missing or unparsable the route answers `200` with `{"project":null,"task":null,"timeline":[]}`, which the Conveyor tab renders as "no active task". The fields the tab reads are `project`, `task`, `phase`, `status` (`ok` | `warn` | `err` | `info`), `next`, `pulse` (`{at, text}`), `links` (name to URL), `timeline` (`{ts, level, text}[]`, newest rendered first) and `updatedAt`.

## `GET /api/usage`

Returns HTTP `200` with the current in-memory account snapshots:

```ts
interface ApiWindow {
  utilization: number;       // percent used; not clamped by the server
  resetsAt: string | null;   // ISO reset time, or unknown/unanchored
  severity: Severity;
}

interface UsageAccount {
  accountId: string;
  label: string;
  provider: Provider;
  session: ApiWindow | null;
  weekly: ApiWindow | null;
  weeklyOpus: ApiWindow | null;
  fable: ApiWindow | null;
  fableAccess: boolean;
  status: UsageStatus;
  lastUpdated: string;
  error: string | null;
  retryAt: string | null;
}

interface UsageResponse {
  accounts: UsageAccount[];
  uiRefreshSeconds: number;
  pollIntervalSeconds: {
    claude: number;
    codex: number;
    grok: number;
  };
}
```

Example shape:

```json
{
  "accounts": [
    {
      "accountId": "work",
      "label": "Work Claude",
      "provider": "claude",
      "session": {
        "utilization": 72,
        "resetsAt": "2026-07-15T18:00:00.000Z",
        "severity": "warn"
      },
      "weekly": null,
      "weeklyOpus": null,
      "fable": null,
      "fableAccess": false,
      "status": "ok",
      "lastUpdated": "2026-07-15T15:00:00.000Z",
      "error": null,
      "retryAt": null
    }
  ],
  "uiRefreshSeconds": 30,
  "pollIntervalSeconds": {
    "claude": 180,
    "codex": 60,
    "grok": 60
  }
}
```

### Usage semantics

- `session`, `weekly`, `weeklyOpus`, and `fable` are independent nullable windows.
- `fableAccess` is independent of `fable`. `true` plus `fable: null` means a Claude Fable entry existed but did not yield a valid numeric window. Codex and Grok always report `false` and `null`.
- For Grok, `session` is the grok-4 DEFAULT two-hour rolling window (`remainingQueries`/`totalQueries` as a percent). Its `resetsAt` is null while queries remain — the endpoint anchors a wait time only when the window is exhausted. `weekly` is the weekly SuperGrok allowance (`credit_usage_percent` and the current period end from the gRPC-Web call `grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig`), which also counts the `grok` CLI's spend. That call is advisory: when it fails, `weekly` is null and `status` stays whatever the session call reported.
- `lastUpdated` is the current polling attempt timestamp. On a non-`ok` attempt, the Poller carries forward prior windows and `fableAccess`, so the windows can be older than `lastUpdated`.
- `retryAt` is set by the Poller for `throttled` and `auth_error`. `stale` and generic `error` retry on the normal provider TTL and normally have `null` here.
- A fresh process returns an empty `accounts` array until enabled accounts complete their first staggered attempts.

Severity is computed at response time:

| Utilization | Severity |
| --- | --- |
| `< 70` | `ok` |
| `>= 70` and `< 90` | `warn` |
| `>= 90` | `crit` |

There is no input-domain validation before this calculation. Values below zero, above 100, or non-finite internal values are not normalized safely.

Accounts are sorted descending by the maximum utilization among `session`, `weekly`, and `fable`; missing windows count below all numeric values. `weeklyOpus` is intentionally absent from this server sort. Ties retain the store's insertion order. The Usage browser then groups Claude, then Codex, then Grok, re-sorting within each group by the nearest weekly-class reset (see [Usage guide](usage.md)); the server order is not preserved in the UI.

Configured provider polling defaults are 180 seconds for Claude and 60 seconds for Codex and Grok. The server exposes them for stale display logic; it does not promise that an upstream attempt occurs exactly at that cadence because initial staggering, the five-second heartbeat, sequential due-account fetches, throttling backoff, and auth pauses apply.

The browser currently requests immediately and then every fixed 30 seconds. Although it reads `uiRefreshSeconds`, assigning the value after the first response does not replace the already-created interval. Therefore non-default `uiRefreshSeconds` is metadata in the current UI, not an effective live timer setting.

There is no endpoint-specific Usage error response. Under normal typed state it returns `200`; an unexpected exception in the outer server handler falls through to the generic plain-text `404` behavior.

## `GET /api/sessions`

Returns the current read-only view of provider-owned work-session history plus live Claude windows that can be inspected on Windows:

```ts
interface WorkSession {
  provider: SessionProvider;
  id: string;
  title: string | null;
  accountId: string;
  accountLabel: string;
  launcher: string;
  availableLaunchers: string[];
  project: string;
  folder: string;
  cwd: string;
  branch: string | null;
  lastActivity: string;
  activity: SessionActivity;
  pid: number | null;
  resumeCommand: string;
}

interface LiveSessionWindow {
  provider: 'claude';
  pid: number;
  startedAt: string;
  accountId: string;
  accountLabel: string;
  launcher: string;
  project: string;
  folder: string;
  cwd: string;
  sessionId: string | null;
  launchSessionId: string | null;
  binding: WindowBinding;
  title: string | null;
  resumeCommand: string | null;
}

interface SessionsResponse {
  windows: LiveSessionWindow[];
  sessions: WorkSession[];
  generatedAt: string;
  recentHours: number;
  partial: boolean;
  warnings: string[];
}
```

Example shape:

```json
{
  "windows": [
    {
      "provider": "claude",
      "pid": 12345,
      "startedAt": "2026-07-15T08:20:00.000Z",
      "accountId": "claude-3",
      "accountLabel": "cc3 account",
      "launcher": "cc3",
      "project": "example-project",
      "folder": "example-project",
      "cwd": "C:\\Users\\you\\projects\\example-project",
      "sessionId": "11111111-2222-3333-4444-555555555555",
      "launchSessionId": "11111111-2222-3333-4444-555555555555",
      "binding": "launch",
      "title": "Example task",
      "resumeCommand": "Set-Location -LiteralPath 'C:\\Users\\you\\projects\\example-project'; cc3 --resume '11111111-2222-3333-4444-555555555555'"
    }
  ],
  "sessions": [
    {
      "provider": "claude",
      "id": "11111111-2222-3333-4444-555555555555",
      "title": "Example task",
      "accountId": "claude-3",
      "accountLabel": "cc3 account",
      "launcher": "cc3",
      "availableLaunchers": ["cc3"],
      "project": "example-project",
      "folder": "example-project",
      "cwd": "C:\\Users\\you\\projects\\example-project",
      "branch": "main",
      "lastActivity": "2026-07-15T12:49:00.000Z",
      "activity": "open",
      "pid": 12345,
      "resumeCommand": "Set-Location -LiteralPath 'C:\\Users\\you\\projects\\example-project'; cc3 --resume '11111111-2222-3333-4444-555555555555'"
    }
  ],
  "generatedAt": "2026-07-15T15:00:00.000Z",
  "recentHours": 24,
  "partial": false,
  "warnings": []
}
```

### Sessions semantics

- `windows` is one row per inspected live Claude process, newest process first. There is no equivalent live Codex-window mapping.
- `binding: launch` means the UUID appeared in that process's launch command. It can be stale after Claude `/clear`. `likely` means only one transcript in the same account home and cwd had activity around/after process start; `ambiguous` and `unknown` deliberately leave `sessionId` null.
- `activity: open` requires a live Claude correlation. `recent` means non-archived activity within `recentHours`, currently 24 by default; it is not proof that a Codex or Claude UI window remains open. `archived` comes from Codex's database flag; older rows are `idle`.
- `lastActivity` uses Claude transcript timestamps (filesystem mtime only as a fallback) or Codex database timestamps. It is independent of `generatedAt`.
- Duplicate copies of one provider UUID produce one `sessions` row. `availableLaunchers` records the Claude launchers in which copies were discovered.
- `project` is inferred from the nearest Git root (with a special owning-repository/worktree label for Claude worktrees); `folder` is the cwd leaf; `cwd` is the exact normalized working directory.
- `resumeCommand` is escaped PowerShell text for copying. The API and UI do not execute it. A live window without an inferred ID has a null command.

The scanner reads direct Claude `projects/<encoded-cwd>/*.jsonl` metadata and read-only Codex `state_5.sqlite` interactive rows. Configured Claude homes are eligible only in `readonly` mode; subtrack-owned Usage homes and their probe transcripts are not resume targets. It does not serialize prompts, user/assistant messages, tool calls/output, complete transcripts, full process command lines, or complete process environments. It creates no session-history file or database.

Successful responses are cached in-process for 15 seconds, and simultaneous misses share one scan. Provider-owned files/databases are reconsidered after cache expiry; Claude metadata for an unchanged path/size/mtime is reused. Account configuration and label/home mappings were captured when `serve` started, so account edits still require a restart.

Every Sessions endpoint response, including errors, carries `Cache-Control: no-store`. This prevents a browser/shared HTTP cache from retaining the sensitive payload; it is separate from the scanner's own 15-second in-process response cache.

Scanning failures are isolated where possible. Each failed Claude home, Codex home, or live-window probe appends a human-readable warning, sets `partial: true`, and leaves successful stores in the same HTTP `200` response. A complete provider failure has these endpoint errors:

| HTTP status | Body | Condition |
| --- | --- | --- |
| `200` | `SessionsResponse` | Scan succeeds, including a partial result with warnings |
| `405` | `{"error":"method not allowed"}` plus `Allow: GET` | Request method is not `GET` |
| `503` | `{"error":"sessions unavailable"}` | `createApp()` was constructed without a Sessions provider |
| `500` | `{"error":"sessions failed","detail":"..."}` | Sessions provider throws outside its isolated scan paths |

The response contains sensitive local paths, account/project metadata, IDs, PIDs, and executable resume text. Loopback is not authentication; do not publish or proxy it.

## `GET /api/burn`

Answers "which local session burned this account's five-hour window", for Claude and Codex accounts. `account` is required and is a configured `accountId`.

```ts
interface BurnSession {
  id: string;                 // Claude session UUID (transcript file name), or Codex `session_id`
  cwd: string | null;
  project: string | null;     // cwd leaf
  share: number;              // percent of this account's weighted total in the window
  weight: number;
  replies: number;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  models: string[];           // most-used first
  host: string | null;        // machine the row was read from; null = the dashboard's own
  firstAt: string;
  lastAt: string;
  contested: boolean;
}

interface BurnResponse {
  accountId: string;
  accountLabel: string;
  windowStart: string;
  resetsAt: string | null;
  windowHours: number;        // 5
  sessions: BurnSession[];    // heaviest first
  totals: { weight: number; replies: number; inputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; outputTokens: number };
  otherSessions: number;      // transcripts active in the window owned by another account
  generatedAt: string;
  partial: boolean;
  warnings: string[];
}
```

### Burn semantics

- Every number is a **local estimate** derived from the provider's own local session files — Claude Code transcripts, or Codex rollouts. The provider publishes one percentage per window and never says which session produced it; `share` is a share of subtrack's own weighting, not of the provider's quota. Never present it as provider accounting.
- Sessions are ranked by a cost-shaped weight: `input + 1.25 × cacheWrite + 0.1 × cacheRead + 5 × output`. The raw components are returned so a reader can reweigh them.
- The window is `resetsAt − windowHours` from the account's latest `/api/usage` snapshot. With no snapshot (or an unknown reset) it falls back to a rolling five hours and reports `resetsAt: null`.
- Claude attribution uses per-home state that is **not** shared between homes: `session-env/<sessionId>/` and `history.jsonl`. The transcript store itself is one physical directory shared by every home (each home's `projects/` is a junction), so a transcript alone cannot name an account.
- About one in ten session IDs is claimed by several homes because the session was resumed under another account. The claim with the freshest evidence (last prompt in that home's `history.jsonl`, else the `session-env` directory mtime) wins the whole session; when a losing claim also falls inside the window the row is returned with `contested: true`. Splitting one session between two accounts is not possible locally.
- Only `readonly` Claude accounts are analysed by the Claude scanner. Subtrack-owned homes contain usage probes rather than interactive work, and Grok has no local session store at all; those requests return an empty `sessions` list with an explanatory warning instead of a guess.
- Codex accounts are answered by a separate scanner over `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl`. Those stores are per-home, so `contested` is always `false`; the ambiguity there is the opposite one, and is handled by identity rather than by claims:
  - a card's subscription is the ChatGPT account id in its home's `auth.json`, and candidate homes are discovered under `~/.codex`, `~/.codex-homes/*`, `~/.subtrack/codex-homes/*`, plus every configured Codex `credentialsHome`. A store therefore counts for a card because the two share a login, not because the card was configured with that path;
  - a store reachable from homes of two different logins is skipped, with a warning when it holds work inside the window, rather than being split;
  - a row is keyed by the rollout's `session_id`, so a session and every subagent thread it spawned are one row;
  - token sums come from `token_usage_record` where the CLI writes it and from `event_msg/token_count` `last_token_usage` otherwise, never both, and `inputTokens` excludes the cached part that Codex folds into its own `input_tokens`;
  - only the `YYYY/MM/DD` folders the window can touch are opened;
  - every ssh target in `codexRemotes` is scanned for the same window and its rows are merged in with `host` set. A host that fails or answers with anything but JSON adds a warning and leaves the rest of the response intact; one scan per host and window is shared by all cards.
- `otherSessions` counts session files active in the window inside stores that belong to another login.
- Only transcripts whose mtime is at or after the window start are opened, and only the file tail that can contain the window is read (grown from 1 MiB, capped at 64 MiB, which appends a warning).
- Successful responses are cached in-process for 30 seconds per `accountId` + `resetsAt`; simultaneous misses share one scan. A rolled window is a different cache key, never a stale hit.

| HTTP status | Body | Condition |
| --- | --- | --- |
| `200` | `BurnResponse` | Scan succeeds, including an empty or partial result with warnings |
| `400` | `{"error":"account query parameter required"}` | `account` missing |
| `405` | `{"error":"method not allowed"}` plus `Allow: GET` | Request method is not `GET` |
| `503` | `{"error":"burn unavailable"}` | `createApp()` was constructed without a burn provider |
| `500` | `{"error":"burn failed","detail":"..."}` | Burn provider throws |

Responses carry `Cache-Control: no-store` and contain sensitive local paths and session IDs, exactly like `/api/sessions`.

## `GET /api/services`

Returns a cached live Windows inventory and derived service health:

```ts
interface ServiceHealth {
  id: string;
  label: string;
  kind: ServiceKind;
  taskName?: string;
  port?: number;
  httpPath?: string;
  match?: string;
  startCmd?: string;
  cwd?: string;
  alwaysOn: boolean;
  group?: string;

  status: ServiceStatus;
  detail: string;
  pid: number | null;
  lastRun: string | null;
  nextRun: string | null;
  checkedAt?: string;             // ISO; background Hermes check time
  subscription?: string;          // public label only
  autoHeal?: boolean;
  lastRestartAt?: string | null;
  consecutiveFailures?: number;
}

interface UntrackedRunner {
  kind: 'port' | 'process';
  port: number | null;
  pid: number;        // -1 when no captured owner was guessed
  name: string;
  cmd: string;        // full captured command line
}

interface ServicesResponse {
  services: ServiceHealth[];
  untracked: UntrackedRunner[];
  generatedAt: string;
}
```

`generatedAt` is the normal system-snapshot clock, not the browser render time. Background Hermes rows carry their own `checkedAt`, which can predate `generatedAt`. The current Services header displays browser receipt time.

Example shape; optional manifest fields that were not configured are omitted:

```json
{
  "services": [
    {
      "id": "subtrack-dashboard",
      "label": "subtrack dashboard",
      "kind": "task",
      "taskName": "subtrack-dashboard",
      "port": 7777,
      "alwaysOn": true,
      "group": "subtrack",
      "status": "up",
      "detail": "task Ready, listening :7777",
      "pid": null,
      "lastRun": "7/15/2026 3:00:00 PM",
      "nextRun": "7/15/2026 3:30:00 PM"
    }
  ],
  "untracked": [
    {
      "kind": "port",
      "port": 7788,
      "pid": -1,
      "name": "",
      "cmd": ""
    }
  ],
  "generatedAt": "2026-07-15T15:00:00.000Z"
}
```

Task Scheduler timestamp strings are locale-dependent and are not normalized to ISO. `pid: -1` on an untracked port means ownership was not guessed; it is not a real process ID.

### Snapshot, configuration, and cache behavior

On a cache miss the provider:

1. runs one PowerShell snapshot for non-Microsoft scheduled tasks, loopback/wildcard listeners below port 50000, and `node`/`python` processes;
2. loads `~/.subtrack/services.json`, or if the file is absent seeds it from the observed scheduled tasks only and saves it;
3. derives every configured health record, running HTTP probes sequentially where needed;
4. appends the latest already-collected background Hermes rows, when the monitor is configured;
5. sorts tracked services and derives untracked listener ports;
6. stores the successful response in a process-local cache.

The default cache TTL is 10 seconds. Requests within the TTL reuse the same object and `generatedAt`; concurrent misses share one in-flight build. A failed build is not cached. Editing `services.json` becomes visible on the first rebuild after cache expiry and does not require a server restart.

Tracked sort order is:

1. `alwaysOn: true` before periodic entries;
2. within that partition: `down`, `degraded`, `unknown`, then `up`;
3. stable input order for ties.

### Health derivation

| Kind | `up` | `degraded` | `down` | `unknown` |
| --- | --- | --- | --- | --- |
| `task` | Task exists, is not `Disabled`, has a benign last result, and the selected always-on evidence passes or no evidence is selected | Non-benign last result, or selected always-on port/process evidence is absent | Missing task or state exactly `Disabled` | Selected always-on process regex is invalid |
| `port` | Captured listener contains `port` | Not used | Missing/undefined port | Not used |
| `http` | Probe returns 2xx | Probe returns non-2xx while captured port is listening | Non-2xx and no captured listener | Probe is not attempted because `port` is missing, or it throws, times out, or URL construction fails |
| `process` | First regex match in captured name or command line | Not used | Valid regex has no match | Missing/invalid regex |
| `hermes` | Live profile PID/start/command/state, required platform, shared account binding, and auth probe pass | Live runtime with a recoverable platform/auth warning, planned restart, or just-completed auto-heal | Confirmed runtime outage or confirmed auth/account failure | Required files or Windows/upstream evidence cannot be read reliably |

Hermes rows are not `ServiceDef` records loaded from `services.json`; they are sanitized projections of the latest independent background monitor snapshot. Reading `/api/services` does not run a model canary, refresh OAuth, or trigger auto-heal. If monitor initialization fails, one sanitized `hermes-fleet / unknown` fallback row remains visible while a background retry runs. The public fields deliberately omit credential paths, pinned account IDs, access/refresh tokens, process command lines, exception text, and webhook URLs.

Task results `null`, `0`, and `0x41300` through `0x4130B` are treated as benign. Task lookup uses exact `TaskName` only and discards `TaskPath` identity. For an `alwaysOn` task, a configured `port` takes precedence and makes `match` irrelevant. Only when no port is configured does a truthy `match` become the selected evidence. A periodic task (`alwaysOn` false) ignores both evidence fields during task health derivation.

The HTTP probe is a plain IPv4 GET with a 1500 ms timeout. It returns only true/false/undefined: 2xx, non-2xx, or thrown/timeout. It records no status code, latency, redirect chain, or structured error.

Untracked detection emits only unclaimed listener ports. It does not emit standalone captured processes despite the `UntrackedRunner` union allowing `process`. Ownership is guessed by searching captured command lines for the literal `:<port>`; no socket-to-PID mapping is performed.

### Services errors

| HTTP status | Body | Condition |
| --- | --- | --- |
| `200` | `ServicesResponse` | Snapshot/cache provider succeeds |
| `503` | `{"error":"services unavailable"}` | `createApp()` was constructed without a Services provider |
| `500` | `{"error":"services failed","detail":"..."}` | Provider throws, including manifest read/parse errors or failed persistence |

In production the provider is installed. PowerShell nonzero exit and invalid snapshot JSON do not throw; they become an empty `SystemState`, which can make configured items appear down and can seed an empty manifest on first run.

## `POST /api/services/action`

This endpoint changes local Task Scheduler state. Valid request shapes are:

```ts
type ActionRequest =
  | { action: 'restart'; id: string }
  | { action: 'stop'; id: string }
  | { action: 'register'; pid: number; label?: string };

interface ActionResult {
  ok: boolean;
  ran: string;
  output?: string;
  error?: string;
  taskName?: string; // sanitized register target; can be present even when ok is false
}
```

The TypeScript source declares all request properties optional and the server performs no discriminated runtime validation. The shapes above are the usable contract, not enforced validation. Unknown actions and missing IDs/PIDs usually return an `ActionResult` with `ok: false`; pathological JSON shapes can throw and produce HTTP `500`.

Example valid request:

```http
POST /api/services/action HTTP/1.1
Host: 127.0.0.1:7777
Content-Type: application/json

{"action":"stop","id":"subtrack-dashboard"}
```

An action-level failure still returns HTTP `200`:

```json
{
  "ok": false,
  "ran": "stop",
  "error": "unknown service \"missing\""
}
```

Callers must inspect `ok`; HTTP status alone does not indicate whether Task Scheduler succeeded.

### Current action semantics

#### `restart`

1. Reloads `services.json`.
2. Finds the first definition whose `id` exactly equals the request `id`.
3. Requires `taskName`.
4. runs `Start-ScheduledTask -TaskName '<taskName>'`.

Despite its name, this is **start**, not restart. It does not stop an existing instance, wait, run `startCmd`, check port/process/HTTP health, or verify a new process.

#### `stop`

It resolves the configured task in the same way, then runs `Stop-ScheduledTask -TaskName '<taskName>'`. This stops the current task instance only. It does not disable or unregister the task, terminate an unrelated child not controlled by Task Scheduler, or prevent a later trigger.

#### `register`

1. Takes a fresh PowerShell snapshot.
2. Finds a captured `node.exe`, `python.exe`, or `pythonw.exe` process by PID.
3. splits its full Windows command line with a simplified leading-quoted-executable parser;
4. sanitizes the requested/default task name to ASCII letters, digits, `.`, `_`, and `-`;
5. guesses `WorkingDirectory` as the executable's directory only when the parsed executable contains a backslash; otherwise it supplies an empty string;
6. registers an at-logon Scheduled Task with `LogonType Interactive`, `RunLevel Limited`, current user, battery-friendly settings, no execution limit, and `MultipleInstances IgnoreNew`;
7. uses `Register-ScheduledTask -Force`.

Registration does **not**:

- start the new task now;
- stop or replace the currently running process;
- append a service definition to `services.json`;
- persist a real process working directory;
- use Windows' complete command-line parsing rules;
- add the daemon installer's best-effort 30-minute repetition;
- set the Scheduled Task hidden;
- detect a task-name collision before `-Force` replacement;
- verify the adopted command or task after creation.

For `register`, `taskName` is the sanitized name that was attempted. It is spread into both success and PowerShell-failure results, so its presence does **not** prove that a task was created. On success it names the created Scheduled Task. In either case, the runner can remain “untracked” because the manifest is unchanged.

Task-name values are PowerShell single-quote escaped. Restart/stop use `TaskName` without `TaskPath`, so same-name task ambiguity remains. A reused PID can identify a different process between display and action. Captured command-line arguments can contain credentials and will be persisted into Task Scheduler.

### PowerShell result mapping

An action is successful only when the PowerShell exit code is zero and stdout contains its sentinel (`STARTED`, `STOPPED`, or `REGISTERED`). On success, `output` is the last 300 characters of trimmed stdout. On failure, `error` is the last 300 characters of trimmed stderr, then stdout, or `exit <code>`. No redaction is applied.

On non-Windows platforms a valid handler returns HTTP `200` with `ok: false` and `Actions are Windows-only (Task Scheduler).`

### Origin policy

Before reading the body, the server accepts the request when any of these is true:

- the `Origin` header is absent;
- `Origin` equals the literal `http://` plus the received `Host` header;
- `Origin` matches `http://localhost[:port]`, `https://localhost[:port]`, `http://127.0.0.1[:port]`, or `https://127.0.0.1[:port]`, case-insensitively.

The regex branch accepts either scheme and any port; it does not require the actual server origin. The literal equality branch also trusts the received `Host` header. Non-browser clients are accepted without `Origin`. There is no authentication, Referer check, Fetch Metadata check, CSRF token, authorization, idempotency key, or action rate limit. The browser's `confirm()` dialog is not a security control.

### Request parsing and HTTP errors

The action body is accumulated as a JavaScript string. The limit is `1,000,000` characters, not a defined byte count. The server does not require or validate `Content-Type`.

| HTTP status | Body | Condition |
| --- | --- | --- |
| `200` | `ActionResult` | Handler returns, whether `ok` is true or false |
| `400` | `{"error":"bad json"}` | Body is not valid JSON |
| `400` | `{"error":"bad request"}` | Request stream errors while reading |
| `403` | `{"error":"forbidden (cross-origin)"}` | Present Origin fails the policy |
| `413` | `{"error":"payload too large"}` | Accumulated string length exceeds 1,000,000 |
| `500` | `{"error":"action failed","detail":"..."}` | Handler throws |
| `503` | `{"error":"actions unavailable"}` | `createApp()` has no action handler |

An empty body is parsed as `{}` and reaches the handler as an unknown action. There is no `422` schema error and no `405` response for a wrong method.

## `GET /api/fleet`

One row per herdr pane that is running a Claude agent, joined with subtrack's own activity and quota view, the care mark a human pinned on that window, and the last compaction the external watchdog recorded. Read-only. Always `Cache-Control: no-store`; there is no server-side cache, so each request re-runs `herdr pane list`.

```ts
interface FleetWindow {
  paneId: string;              // herdr pane, e.g. "w85:p1" — the identity a mark is keyed on
  workspaceId: string | null;
  folder: string;              // from the session record, else the cwd's last segment
  cwd: string;                 // no trailing separator
  title: string | null;        // terminal title, stripped
  agentStatus: string;         // herdr's own word: 'working' | 'idle' | 'done' | ...
  sessionId: string | null;
  lastActivity: string | null; // ISO-8601, from /api/sessions
  idleMinutes: number | null;
  accountId: string | null;    // 'claude-default' records fall back to the folder's live window
  accountLabel: string | null;
  mode: WindowMode | null;     // null means no mark: the general rule applies
  markScope: 'pane' | 'folder' | null;
  markedAt: string | null;     // 'yyyy-MM-dd HH:mm' as ccmode wrote it
  lastCompactAt: string | null;
  lastCompactFailed: boolean;
  compactable: boolean;        // what the external watchdog would do next round
  reason: string;
}

interface FleetResponse {
  windows: FleetWindow[];      // longest idle first
  generatedAt: string;
  warnings: string[];
  idleWindowMinutes: { min: number; max: number };
}
```

| HTTP status | Body | Condition |
| --- | --- | --- |
| `200` | `FleetResponse` | Normal, including a degraded one |
| `405` | `{"error":"method not allowed"}`, `Allow: GET` | Any other method |
| `500` | `{"error":"fleet failed","detail":"..."}` | Provider throws |
| `503` | `{"error":"fleet unavailable"}` | `createApp()` has no fleet provider |

### Fleet semantics

- herdr owns the pane list. An unreachable or silent herdr yields `windows: []` plus a warning, never a `500`; a failing `/api/sessions` likewise degrades to a warning, leaving panes with `idleMinutes: null`.
- `compactable` and `reason` mirror the thresholds of the external `claude-idle-compact` watchdog (`~/.claude/hooks/idle-compact-watch.ps1`): marked `off`, `working`, unknown activity, an account without headroom, idle under 55 minutes, and idle over 24 hours are all reasons it would skip. Subtrack itself never compacts, warms, or writes to a window.
- Account headroom comes from the same in-process snapshots `/api/usage` serves: non-`ok` status or a session/weekly window at 99 percent or more.

## `POST /api/fleet/mode`

Pins, changes, or removes one window's care mark. The request body is JSON:

```ts
interface SetModeRequest {
  pane?: string | null;              // herdr pane id; preferred identity
  cwd?: string;                      // used when there is no pane
  mode: WindowMode | 'auto';         // 'auto' removes the mark
}

interface SetModeResult { ok: boolean; mode: WindowMode | 'auto'; pane: string | null; cwd: string }
```

| HTTP status | Body | Condition |
| --- | --- | --- |
| `200` | `SetModeResult` | Mark written |
| `400` | `{"error":"bad json"}` | Body is not valid JSON |
| `400` | `{"error":"mode must be ever, warm, off or auto"}` | Unknown mode |
| `400` | `{"error":"pane or cwd required"}` | Neither identity supplied |
| `403` | `{"error":"forbidden (cross-origin)"}` | Present Origin fails the same policy as the services action |
| `413` | `{"error":"payload too large"}` | Body exceeds 1,000,000 characters |
| `503` | `{"error":"fleet unavailable"}` | `createApp()` has no handler |

### Mode semantics

- The marks live in `~/.claude/idle-handover/window-modes.json`, shared with the `ccmode` shell function and read by both the cache warmer (`claude-window-care`) and the idle-compaction watchdog. Subtrack rewrites the whole file, always as a JSON array without a BOM, preserving every other row.
- A pane-keyed mark replaces only that pane's row. A paneless (folder-keyed) mark covers every paneless window of that folder, exactly as `ccmode` treats a window outside herdr.
- Nothing applies the mark synchronously: the watchdogs read the file on their own rounds.

## `POST /api/fleet/focus`

Opens one window: switches the herdr client to that pane's workspace and tab, then brings the terminal window hosting herdr to the front. This is the only way subtrack touches a window at all — it still never types into one, compacts it, or clears it.

```ts
interface FocusRequest { pane: string }                 // herdr pane id, e.g. "w62:p1"

interface FocusResult {
  ok: boolean;
  pane: string;
  workspaceId: string | null;
  raised: boolean;                                      // terminal window came to the front
  warning: string | null;                               // partial success, e.g. tab not focused
}
```

| HTTP status | Body | Condition |
| --- | --- | --- |
| `200` | `FocusResult` | Workspace switched; `raised`/`warning` report the rest |
| `400` | `{"error":"bad json"}` | Body is not valid JSON |
| `400` | `{"error":"pane required, e.g. w62:p1"}` | Missing or malformed pane id |
| `400` | `{"error":"herdr has no pane w99:p1"}` | The id is not in the live pane list |
| `400` | `{"error":"herdr could not focus w85: ..."}` | herdr refused the workspace switch |
| `403` | `{"error":"forbidden (cross-origin)"}` | Present Origin fails the same policy as the other action routes |
| `413` | `{"error":"payload too large"}` | Body exceeds 1,000,000 characters |
| `503` | `{"error":"fleet unavailable"}` | `createApp()` has no handler |

### Focus semantics

- The pane id is checked twice: by shape (`<workspace>:<pane>`, alphanumerics only) and against the live `herdr pane list`. An unknown id is a `400`, never a command.
- Raising the terminal is best-effort and Windows-specific: the window is found by herdr's own `HUB:` title, then by falling back to Windows Terminal, and focused through an `AttachThreadInput` + `SetForegroundWindow` pair because Windows grants foreground rights only to the process owning the current input. A herdr client hosted elsewhere simply returns `raised: false`; the workspace switch already happened.
- A tab that will not focus is a warning, not an error: the operator is already on the right workspace.

## Security and privacy warnings

### Local does not mean trusted

Any same-user process can normally connect to loopback. A non-browser caller can omit `Origin`. Do not expose the port through a proxy, port-forward, container bridge, firewall exception, or non-loopback bind without adding real authentication and authorization.

### Command-line disclosure and persistence

`GET /api/services` serializes full command lines for untracked runners, and `web/services.js` renders them. Action diagnostics can return the tail of PowerShell output. `register` can persist captured arguments into Task Scheduler. Treat browser screenshots, API captures, logs, and task definitions as potentially secret-bearing.

`GET /api/sessions` serializes exact working directories, project/session titles and IDs, account labels, PIDs, and resume commands. It deliberately omits transcript content and complete process command lines/environments, but its response and screenshots remain sensitive local artifacts.

### HTTP probe can escape loopback

The current probe constructs:

```text
http://127.0.0.1:${port}${path}
```

without validating `port` or `path`, and native `fetch` follows redirects by default. A path beginning `@example.invalid/x` can be parsed as user-info plus a different host, and a loopback service can redirect to a remote host. Therefore a configured `http` service can trigger outbound requests despite the intended loopback model. Until fixed, only trusted users should edit `services.json`; safe behavior requires strict numeric-port validation, an absolute path beginning `/`, post-construction origin verification, and redirects disabled or revalidated.

### Unofficial provider integrations

The HTTP routes documented here expose normalized data, but the upstream Claude and Codex usage endpoints are private/unofficial observational contracts. Do not infer provider support, stability, or public API status from subtrack's local response shape.

## Known client behavior

- Usage fetches `/api/usage` immediately and then every fixed 30 seconds. On any fetch/parse/render exception it preserves old cards and shows a generic retry message.
- Sessions fetches `/api/sessions` with browser caching disabled immediately and every 15 seconds. It displays partial warnings, preserves its prior rows on refresh failure, treats `recent` as activity rather than liveness, and keeps resume commands in JavaScript for copy-only buttons rather than embedding command text in HTML attributes. Its default history filter is `open + recent`; search, provider, and all-sessions controls are client-side.
- Services fetches `/api/services` immediately and every 15 seconds. It has no timeout, abort, overlap guard, or out-of-order response guard.
- Services action success output and `taskName` are ignored by the current UI. Failure is shown with `alert()`; success merely triggers another refresh.
- The pages rely on the server for safe enum/class values. Labels, details, errors, paths, and command lines are HTML-escaped, but several enum-derived class names are inserted from API data.
- No page stores observations. Sessions displays persistent provider history read by the server; it does not copy that history into browser storage.
