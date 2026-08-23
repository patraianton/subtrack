# Configuration

## Overview

subtrack owns two core JSON configuration files and one optional Hermes-monitor file under its local state directory:

| File | Default path | Purpose | Reload behavior |
|---|---|---|---|
| Account configuration | ~/.subtrack/accounts.json | Dashboard port, refresh timing, provider polling TTLs, and account metadata used by Usage and Sessions. | Read once when serve starts. Restart the dashboard after changes. |
| Services manifest | ~/.subtrack/services.json | Definitions used by the Services page and service actions. | Loaded during a Services cache rebuild. No daemon restart is required, but the successful response cache can delay visibility. |
| Hermes monitor | ~/.subtrack/hermes.json | Shared Codex subscriptions, expected/discovered profiles, check/canary/recovery policy, and optional webhooks. | Read when the post-bind monitor initializes. Failed initialization retries every 60 seconds; after success, restart the dashboard for changes. |

Both paths are relative to the current user's home by default. Tests and embedded callers can supply another base directory.

Sessions has no subtrack configuration or history file. It discovers provider-owned Claude project JSONL files and Codex thread databases under the profile/default or configured homes described below. Those source stores are not written by the Sessions scanner.

`accounts.json` and `services.json` do not currently have strict runtime schema validation, an atomic writer, a writer lock, an automatic backup, or an explicit file-permission mode. `hermes.json` is validated on load but is still a plain local file with no writer lock or ACL policy. Back up a working file before manual edits. See [Security](security.md) for the trust boundary and hardening gaps.

## accounts.json

### Default document

If accounts.json is absent, loadConfig returns these defaults in memory without creating the file:

    {
      "version": 1,
      "port": 7777,
      "uiRefreshSeconds": 30,
      "pollIntervalSeconds": {
        "claude": 180,
        "codex": 60
      },
      "accounts": []
    }

The file is created the next time a CLI operation saves configuration.

### Top-level schema

| Field | Type | Required in file | Default | Meaning |
|---|---|---:|---|---|
| version | number | No | 1 | Format marker. The writer emits 1, but the loader does not validate it or perform version-driven migration. |
| port | number | No | 7777 | IPv4 loopback HTTP port used by the dashboard and health probe. No integer or 1–65535 validation currently exists. |
| uiRefreshSeconds | number | No | 30 | Intended Usage-page refresh interval in seconds. The server returns it through /api/usage. Current Usage JavaScript creates its timer before reading this value, so the page remains at 30 seconds until that client bug is fixed. |
| pollIntervalSeconds | object | No | claude 180, codex 60, grok 60 | Per-provider normal polling TTLs in seconds. The nested object is merged over these defaults. Values are not checked for positivity or finiteness. |
| accounts | array of AccountConfig | No | empty array | Configured accounts. A missing or null value becomes an empty array; other invalid values are not rejected during load. |

Unknown top-level properties and unknown pollIntervalSeconds keys survive the in-memory object produced by loadConfig. They are not an endorsed extension mechanism and may not be preserved by future validated formats.

### AccountConfig schema

| Field | Type or enum | Required | Meaning |
|---|---|---:|---|
| id | string | Yes | Local stable identifier. CLI add rejects an exact case-sensitive duplicate, but existing files are not checked for duplicate or path-unsafe identifiers. Use a simple unique value made from letters, digits, dots, underscores, and hyphens. |
| label | string | Yes | Human-facing Usage/Sessions account label. Keep it free of secrets. |
| provider | claude, codex, or grok | Yes | Provider dispatch key. The CLI accepts only these exact lowercase values; hand-edited files are not validated. At runtime, exact `codex` selects Codex, exact `grok` selects Grok, and every other value falls through to Claude, so a typo is not safely rejected. |
| enabled | boolean | Yes | Only enabled accounts are polled and included in check. list still displays disabled accounts. |
| credentialsHome | string | Operationally required | Provider-specific credential directory. The type is optional, but a missing value normally becomes an authentication error. Sessions considers configured Codex homes and Claude `readonly` homes when they contain the expected history source; Claude `owned` Usage homes are deliberately not resume targets. |
| credentialsMode | owned or readonly | No | Credential ownership. For Claude it selects the refresh path; for a manually configured external Codex/Hermes home, `readonly` also blocks the CLI repair command and changes recovery guidance to the external owner. |

credentialsMode details:

- owned is the legacy/default interpretation when the field is missing. subtrack may refresh and persist Claude credentials in that isolated home.
- readonly means another process or a static-token workflow owns the file. subtrack re-reads the access token and never refreshes or writes it. For Codex it also prevents `add-account` from launching `codex login` inside that external home.
- The loader does not validate the enum. For Claude, any runtime value other than exact readonly falls into the owned path. Do not invent values.
- The CLI does not create readonly Codex accounts. A manually registered Hermes shared store must set `credentialsMode: readonly`; Codex `auth.json` remains read-only in either mode, while this marker protects the external owner from unsafe repair hints/actions.

The same fail-open routing applies to `provider`: only exact lowercase `codex` and `grok` select those adapters. Treat any other value, including capitalization or a typo, as unsafe configuration rather than a future extension.

### Credential-home conventions

CLI-created homes use:

| Provider and mode | Conventional home | Credential file | Owner |
|---|---|---|---|
| Claude owned | ~/.subtrack/claude-homes/<id> | .credentials.json | subtrack |
| Claude static readonly | ~/.subtrack/claude-homes/<id> | .credentials.json | Static-token workflow; subtrack never writes after registration |
| Claude external readonly | Any explicitly supplied external Claude home | .credentials.json | External Claude Code process or operator |
| Codex | ~/.subtrack/codex-homes/<id> | auth.json | Codex CLI |
| Codex external readonly | Explicit Hermes shared-store directory | auth.json (`providers.openai-codex`) | Hermes shared resolver; subtrack never writes |
| Grok | ~/.subtrack/grok-homes/<id> | cookie.txt (plus non-secret account.json) | Operator pastes the browser Cookie header; subtrack only reads it |

An external readonly home is intentionally allowed outside ~/.subtrack. Never relabel an externally owned home as owned: rotating refresh tokens are single-use, and two writers can invalidate one another.

Codex `credentialsHome` is also read-only from subtrack's perspective. The CLI creates an isolated home, verifies its `auth.json`, and registers it only after login succeeds. A manually configured Codex home may point at an existing Codex CLI/Desktop home when its identity is verified; subtrack only rereads that file, but the external owner remains responsible for refresh and account switching.

The Codex reader also accepts an externally owned Hermes store whose `auth.json` contains `providers.openai-codex.tokens`. Set `credentialsHome` to the directory containing that file, never to the file itself, and set `credentialsMode` to `readonly`. This keeps Hermes as the refresh owner, makes `add-account` refuse an unsafe `codex login` in the canonical directory, and routes 401 guidance back to Hermes. The matching `hermes.json` subscription must pin the expected account ID.

Use an absolute path for an external readonly home. A relative path is stored as supplied and can resolve differently when the daemon runs from its installed working directory.

Grok has no CLI or refresh flow at all: `cookie.txt` holds the raw Cookie header value copied from a logged-in grok.com browser tab, `add-account` verifies it against the live rate-limits endpoint before registering (any unverified probe — rejection, challenge page, unexpected body — registers nothing), and the account is stored with `credentialsMode: readonly`. When grok.com rejects the cookie the card shows `auth_error` until the operator re-copies the value. Treat `cookie.txt` as a session credential equivalent to a password. The sibling `account.json` stores only the account email, captured once at registration and never refreshed — if a different account's cookie is later pasted into the same home, `list` keeps showing the old email until the account is removed and re-added.

### Privacy-safe example

The following example shows all supported account patterns. Static-token metadata looks like another isolated readonly Claude home; the token itself belongs only in that home's `.credentials.json`, never in `accounts.json`. Placeholder strings must be replaced locally.

    {
      "version": 1,
      "port": 7777,
      "uiRefreshSeconds": 30,
      "pollIntervalSeconds": {
        "claude": 180,
        "codex": 60
      },
      "accounts": [
        {
          "id": "claude-owned-a",
          "label": "Claude account A",
          "provider": "claude",
          "enabled": true,
          "credentialsHome": "<home>/.subtrack/claude-homes/claude-owned-a"
        },
        {
          "id": "claude-external-b",
          "label": "Claude external B",
          "provider": "claude",
          "enabled": true,
          "credentialsHome": "<absolute-path-to-external-claude-home>",
          "credentialsMode": "readonly"
        },
        {
          "id": "claude-static-c",
          "label": "Claude static C",
          "provider": "claude",
          "enabled": true,
          "credentialsHome": "<home>/.subtrack/claude-homes/claude-static-c",
          "credentialsMode": "readonly"
        },
        {
          "id": "codex-a",
          "label": "Codex account A",
          "provider": "codex",
          "enabled": true,
          "credentialsHome": "<home>/.subtrack/codex-homes/codex-a"
        }
      ]
    }

The first Claude record omits credentialsMode deliberately: missing means owned.

### Load and merge semantics

loadConfig performs:

1. Read UTF-8 JSON.
2. Shallowly overlay parsed top-level properties over DEFAULT_CONFIG.
3. Separately merge parsed pollIntervalSeconds over the two provider defaults.
4. Replace a missing or null accounts value with an empty array.

Consequences:

- A partial polling object inherits the missing provider TTL.
- A partial nested account object does not receive field defaults.
- Unknown account properties pass through unchanged.
- Invalid JSON and read errors other than missing-file propagate to the CLI or server startup.
- version is descriptive today, not an enforced compatibility or migration switch.

This is default filling, not schema migration.

### Save and account-operation semantics

saveConfig:

- creates ~/.subtrack recursively;
- serializes the complete in-memory object as UTF-8, two-space-indented JSON;
- overwrites accounts.json directly.

It does not use temp-file plus rename, fsync, a backup, a lock, or explicit permissions. A crash, concurrent writer, or full disk can leave a damaged file.

Account helpers and CLI behavior:

- add appends a record and rejects an exact duplicate id.
- rename changes label metadata only.
- remove filters metadata only; removing an unknown id is a no-op at the config-helper layer.
- rename and remove do not move or delete credential homes or revoke credentials. The unused keyring component is not part of this account lifecycle and has no live account entry to clean up.
- CLI-created account records set enabled true.

Credential cleanup is intentionally not automatic because a readonly home may belong to another application. Remove orphaned owned homes only after confirming ownership and retaining any required backup.

### Polling timings

Configurable normal TTL defaults:

- Claude: 180 seconds.
- Codex: 60 seconds.

Other poller timings are currently fixed in code rather than accounts.json:

- Due-check heartbeat: 5 seconds. It checks scheduling state; it does not call every provider every five seconds.
- Initial account staggering: 7 seconds.
- Throttling backoff: 5, 10, then 15 minutes.
- Authentication-error pause: 15 minutes.

stale and generic error results return to the normal provider TTL. Non-ok results carry forward last-known usage windows while preserving the current error status.

### Restart requirement

serve loads accounts.json once, constructs the poller, and passes port and timing values into the server. Changes to accounts, labels, enabled state, port, UI refresh, or provider TTLs require a dashboard restart.

The CLI rename message explicitly reminds the operator to restart. add-account and remove-account save the same file and have the same runtime requirement even when their success output is shorter.

## hermes.json

The optional Hermes Fleet Monitor is enabled by creating `~/.subtrack/hermes.json` and restarting the dashboard. A privacy-safe two-subscription example is:

```json
{
  "version": 1,
  "enabled": true,
  "profileRoot": "C:\\Users\\you\\AppData\\Local\\hermes\\profiles",
  "hermesCommand": "C:\\Users\\you\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\hermes.exe",
  "checkIntervalSeconds": 120,
  "authProbeSeconds": 300,
  "canarySeconds": 21600,
  "canaryRetrySeconds": 1800,
  "restartAfterFailures": 2,
  "restartCooldownSeconds": 1800,
  "maxRestartsPerHour": 3,
  "autoRestart": true,
  "subscriptions": [
    {
      "id": "account-a",
      "label": "Codex A",
      "authFile": "C:\\Users\\you\\AppData\\Local\\hermes\\shared-codex\\account-a\\auth.json",
      "expectedAccountId": "<verified ChatGPT account UUID>",
      "probeProfile": "representative-a"
    }
  ],
  "profileOverrides": {
    "representative-a": { "subscriptionId": "account-a", "expectedPlatform": "telegram" },
    "cli-only-profile": { "subscriptionId": "account-a", "expectedPlatform": "none" }
  }
}
```

Top-level fields:

| Field | Meaning |
|---|---|
| `version` | Must be `1` when present. |
| `enabled` | Missing/true enables the monitor; false prevents it from starting. |
| `profileRoot` | Absolute directory containing Hermes profile homes. |
| `hermesCommand` | Absolute profile-aware Hermes executable used only for canary and safe recovery. |
| `checkIntervalSeconds` | Background runtime cadence; clamped to 30–3600 seconds, default 120. |
| `authProbeSeconds` | Minimum interval between read-only live usage probes; default 300. |
| `canarySeconds` | Successful real-model canary interval per subscription; default 21600 (6 hours). |
| `canaryRetrySeconds` | Retry delay after a failed canary and minimum cooldown before a 401/403 can force another owner canary; default 1800. |
| `restartAfterFailures` | Consecutive confirmed runtime failures required before recovery; minimum/default 2. |
| `restartCooldownSeconds` | Per-profile recovery cooldown; default 1800. |
| `maxRestartsPerHour` | Per-profile rolling hourly cap; default 3. |
| `autoRestart` | Enables safe runtime recovery. It never enables login or token rewriting. |
| `heartbeatUrl` | Optional absolute HTTP(S) endpoint receiving a compact status POST every completed cycle. |
| `alertWebhookUrl` | Optional absolute HTTP(S) endpoint receiving sanitized transition/recovery events. |
| `subscriptions` | Non-empty unique shared-store definitions. Each requires `id`, public `label`, absolute `authFile`, and `expectedAccountId`; `probeProfile` selects the representative canary profile. |
| `profileOverrides` | Optional expected-profile inventory keyed by profile name. Supports `enabled`, public `label`, known `subscriptionId`, and `expectedPlatform` (`telegram` or `none`). An enabled key remains visible as unhealthy when its directory/gateway disappears; `enabled:false` explicitly opts it out. |

Discovery is repeated every cycle, so a newly installed gateway is included without editing the file when its profile has `gateway-service/` and `.env` points `HERMES_CODEX_AUTH_FILE` at a configured subscription store. Put every must-exist profile in `profileOverrides`; this prevents a deleted directory from shrinking a green `7/7` fleet into a misleading green `6/6`. Telegram is required when `TELEGRAM_BOT_TOKEN` is non-empty; use `expectedPlatform` when that inference must be pinned. Installed profiles with missing/unassigned shared auth are shown as unhealthy rather than silently ignored.

The monitor atomically writes operational state to `~/.subtrack/hermes-monitor-state.json` and appends sanitized transition lines to `~/.subtrack/logs/hermes-monitor.jsonl`. These are not configuration and should not be hand-edited while the daemon runs. They contain counters, status text, timestamps, and public profile/subscription labels, never access/refresh token values. A restart/canary reservation is saved before the external owner action. If state is malformed or unreadable at startup, all automatic owner actions fail closed for that server lifetime and Services reports the condition; restart the dashboard after investigating. Deleting state loses cooldown/canary history and can cause immediate canaries after restart, so do not use deletion as routine recovery.

`accounts.json` is startup-loaded. A successfully initialized Hermes monitor also keeps its loaded `hermes.json` until restart. If Hermes initialization fails, Services shows an `unknown` fleet row and retries initialization every 60 seconds, so correcting malformed startup configuration can recover without taking down the rest of the dashboard.

## Sessions discovery and reload behavior

Sessions does not add fields to `accounts.json`. At server startup it receives the already-loaded account array for matching configured labels, IDs, homes, and Claude launcher names. It also has built-in discovery:

| Provider | Candidate stores | Required source |
|---|---|---|
| Claude | `~/.claude`, immediate non-backup directories under `~/.claude-accounts`, and configured Claude `credentialsHome` only for `credentialsMode: readonly` | A `projects` directory containing direct `<encoded-cwd>/*.jsonl` session files |
| Codex | `~/.codex` and every configured Codex `credentialsHome` | `state_5.sqlite`; optional `session_index.jsonl` supplies title overrides |

Configured account metadata is used when a discovered home matches. `enabled` controls Usage polling, not whether already-existing session history in an otherwise eligible home is discoverable. Claude ownership mode does matter: configured `readonly` homes belong to an external interactive CLI and are eligible, while subtrack-owned Usage homes are excluded even if they contain probe transcripts. Duplicate home paths are normalized and coalesced.

There is currently no user configuration for the Sessions 24-hour `recent` threshold, 15-second server cache, or 15-second browser refresh. These are implementation defaults. Session source files and databases are rescanned after cache expiry, so new activity normally appears without restarting the daemon. Simultaneous cache misses share one scan, and unchanged Claude metadata is reused by path/size/mtime.

Account labels, IDs, and configured-home mappings are different: because the account array was loaded once at startup, changing them still requires a restart. Deleting or moving a provider-owned session store requires no subtrack migration, but it naturally removes that source from a later scan. Sessions never creates, edits, archives, or deletes provider session files/databases.

On non-Windows platforms the persistent-store scan can still run, but the live Claude process probe returns no windows. On Windows that probe depends on observed x64 process-layout offsets; failure produces a partial warning rather than a configuration fallback.

## services.json

### Top-level format

The services writer emits:

    {
      "version": 1,
      "services": []
    }

| Field | Type | Loader behavior |
|---|---|---|
| version | number | Written as 1 but not read or validated. |
| services | array of ServiceDef | Missing property becomes an empty array. A non-array property throws a malformed-file error. Array elements are not validated. |

Invalid JSON and non-missing I/O errors propagate.

### ServiceDef schema

| Field | Type or enum | Required | Meaning and current use |
|---|---|---:|---|
| id | string | Yes | Local service identifier and restart/stop request key. Uniqueness is not validated. |
| label | string | Yes | Display label. It is also returned through the local API. |
| kind | task, process, port, or http | Yes | Selects the primary health rule. |
| alwaysOn | boolean | Yes | Marks continuously expected work and influences urgency ordering. In current probe code it changes detailed classification only for task definitions. |
| taskName | string | No | Scheduled Task name used for task health and restart/stop. TaskPath is not represented. |
| port | number | No | Listener signal for port/http definitions and optionally task definitions. No range validation exists. |
| httpPath | string | No | Path appended to the IPv4 loopback probe URL for http definitions. Use a leading slash. See the known authority/redirect risk in [Security](security.md). |
| match | string | No | JavaScript regular-expression source, case-insensitive, tested against process name and full command line. First match wins. |
| startCmd | string | No | Stored and exposed as definition metadata; current action code does not execute it. |
| cwd | string | No | Stored and exposed as definition metadata. |
| group | string | No | UI grouping label. |

Because loadServices casts array elements without validation, missing required fields, invalid enums, duplicate ids, unsafe regexes, invalid ports, and unknown properties can enter runtime behavior.

### Privacy-safe example

    {
      "version": 1,
      "services": [
        {
          "id": "dashboard",
          "label": "subtrack dashboard",
          "kind": "task",
          "taskName": "subtrack-dashboard",
          "port": 7777,
          "alwaysOn": true,
          "group": "local-tools"
        },
        {
          "id": "worker-http",
          "label": "Example HTTP worker",
          "kind": "http",
          "port": 8080,
          "httpPath": "/health",
          "alwaysOn": true,
          "group": "workers"
        },
        {
          "id": "worker-process",
          "label": "Example process worker",
          "kind": "process",
          "match": "example-worker",
          "alwaysOn": true,
          "group": "workers"
        },
        {
          "id": "daily-summary",
          "label": "Daily summary task",
          "kind": "task",
          "taskName": "example-daily-summary",
          "alwaysOn": false,
          "group": "periodic"
        }
      ]
    }

### One-time seed

When /api/services builds and services.json does not exist, subtrack gathers the current Windows task snapshot and writes one task definition per discovered task:

- id, label, and taskName are the task name.
- alwaysOn becomes false when the name case-insensitively contains healthcheck, refresh, _summary, or -summary; otherwise it is true.
- group is the first segment before a hyphen or underscore.
- source order is retained.

This is a one-time snapshot, not ongoing discovery or reconciliation.

Important consequences:

- A first collection that returns no tasks writes a persistent empty manifest.
- Later task additions, removals, renames, or changed health expectations do not update the file.
- Deleting services.json triggers another seed on the next build.
- An existing deliberately empty manifest stays empty and is not reseeded.
- Seeded vendor and disabled tasks may be irrelevant. Manual curation is expected.

Review services.json after its first creation. Remove irrelevant definitions, correct alwaysOn and group, and add stronger port, process, or HTTP evidence where appropriate.

### Load, save, and cache visibility

loadServices reads services.json during a Services response build. saveServices creates the state directory and directly overwrites the file as version 1 plus the supplied array.

The Services orchestrator has a default 10-second successful-response cache:

- a fresh cached object is returned without rereading the file;
- simultaneous expired-cache requests share one in-flight build;
- the TTL is anchored after a successful build;
- there is no force-refresh endpoint;
- a failed rebuild does not return the old response as a stale fallback.

The Services page normally requests data every 15 seconds. A manual edit therefore requires no daemon restart, but it is not visible until the cache expires and a subsequent request completes. Sequential HTTP probes, each with a 1.5-second timeout, can extend a rebuild.

Any rejected state collection, config read, unexpectedly rejected HTTP-probe dependency, or rejected service probe currently fails the whole Services response rather than isolating one service. The default HTTP probe normally catches timeout and transport errors and returns an indeterminate result, which becomes an `unknown` service status instead of rejecting the whole build; HTTP non-2xx becomes negative probe evidence.

### Manual cleanup caveats

- There is no services CLI for add, edit, delete, validate, reconcile, or backup.
- File writes are non-atomic and unlocked.
- Task and process labels, cwd, startCmd, regexes, and full command lines can be sensitive when returned by the local API.
- Removing a service definition does not stop a process or delete a Scheduled Task.
- Register creates a Scheduled Task but does not add a ServiceDef, so the new task may still require manual manifest curation.
- ids, task names, ports, paths, and regexes are trusted more than the current validation justifies.

Keep a backup, edit while avoiding concurrent writers, validate JSON before replacement, and inspect the Services page and local API afterward.

## Configuration checklist

- Use exact lowercase providers claude, codex, and grok.
- Use simple unique account ids; do not use path separators, `..`, or drive-qualified values.
- Treat missing credentialsMode as owned.
- Use readonly only for externally owned or static Claude sources.
- Store external readonly homes as absolute paths.
- Never put tokens in either JSON file.
- Restart the dashboard after accounts.json changes.
- Do not look for a Sessions manifest: session history remains owned by Claude/Codex and is rescanned after the 15-second cache.
- Do not restart merely for services.json changes; allow for cache and UI polling delay.
- Curate the one-time services seed.
- Use leading-slash HTTP paths and simple bounded process patterns.
- Back up both files before manual edits.
- Remove credential homes or Scheduled Tasks only as separate, ownership-aware operations.
