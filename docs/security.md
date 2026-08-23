# Security

## Security posture

subtrack is a local operator tool, not a hardened multi-user service. Its primary mitigation is binding the HTTP server to IPv4 loopback at 127.0.0.1. It has no user authentication, session authentication, TLS, or authorization roles.

The intended trust boundary is one Windows user account and the local processes that user chooses to run. Any same-user process can generally read or modify the same configuration, credential homes, source checkout, and local HTTP API. Browser content, extensions, local proxies, other localhost applications, malformed configuration, and unofficial upstream APIs remain distinct risks inside or adjacent to that boundary.

This document separates current mitigation from open risk. Loopback, Limited tasks, escaping, and readonly modes reduce exposure; none is a guarantee against a compromised local account or malicious same-user process.

## Data and network boundary

### Current mitigation

- The dashboard listens on 127.0.0.1, not all interfaces.
- Usage state is a live in-memory snapshot. Sessions reads existing provider-owned history, but subtrack creates no usage/session-history database. The optional Hermes monitor persists bounded recovery/canary state and a sanitized transition JSONL log; it does not persist prompts or token values.
- Static assets and API endpoints are normally same-origin.
- Sessions responses send `Cache-Control: no-store`; this reduces browser/proxy retention but is not authentication and does not disable the server's 15-second process-local scan cache.
- Account labels and error text are escaped in the Usage UI, and Services templates escape their displayed fields and generated data attributes.
- The service-action body accumulator rejects with HTTP 413 after its JavaScript string grows beyond 1,000,000 characters.

### Open risk

- All local API endpoints are unauthenticated.
- /api/health, /api/usage, and /api/services accept methods beyond a strict GET-only contract. `/api/sessions` does enforce GET, but remains unauthenticated.
- Another same-user process can call the APIs directly and omit Origin.
- A reverse proxy, port forward, browser extension, or changed bind behavior can invalidate the local-only assumption.
- The Usage UI renders with `innerHTML` and interpolates provider, status, and severity keys without escaping or an allowlist; utilization also enters an inline style. The current typed server path normally supplies expected values, but malformed configuration or a compromised API response can cross this browser-rendering boundary.
- The HTML has no Content Security Policy. Same-origin and escaping reduce some injection paths but do not replace response validation or browser hardening.
- The action limit counts accumulated JavaScript characters, not request bytes. It does not pre-check Content-Length, impose a body-read timeout, or destroy the request stream after rejecting, so it is an in-memory-value guard rather than a complete request-resource limit.
- No subtrack-owned history does not mean no sensitive artifacts: provider transcripts/databases, credential JSON, configuration, daemon logs, Scheduled Tasks, and command lines persist elsewhere.
- The server uses plain HTTP. Do not expose it outside the host.

Do not publish the dashboard through a tunnel, proxy, LAN bind, remote desktop web gateway, or container port mapping without adding real authentication, authorization, TLS, and a fresh threat review.

## Sessions metadata confidentiality

The Sessions surface is read-only but sensitive. Its local API can expose:

- provider/account IDs and labels;
- session UUIDs and titles;
- project/folder names, exact working directories, and Git branches;
- activity/start timestamps, live Claude PIDs, and confidence labels;
- copyable PowerShell resume commands containing home/cwd/session data.

Current mitigation:

- Claude discovery scans only direct project-session JSONL files, not nested session subagents, and extracts a bounded metadata set into the response/cache.
- Codex `state_5.sqlite` is opened read-only and filtered to interactive `vscode` / `cli` threads.
- The API does not return prompts, user/assistant messages, tool calls/output, full transcripts, credential values, full process command lines, or complete environments.
- The browser keeps resume commands in JavaScript for explicit copy buttons; the Sessions API has no endpoint that executes, launches, archives, edits, or deletes a session.
- A failed store/window probe is represented as a partial warning rather than silently converting missing evidence into a false live-state claim.

Open risk and implementation detail:

- Claude JSONL head/tail chunks necessarily pass through process memory while metadata strings are found; Codex rows are read from an existing persistent database. “Not returned or persisted by subtrack” is not “the source content was never read.”
- The Windows helper queries each Claude process command line to extract a `--resume` UUID and reads a bounded environment block to locate `CLAUDE_CONFIG_DIR`; it returns neither complete value to Node or HTTP, but both exist transiently inside the PowerShell helper.
- Live correlation uses observed x64 PEB offsets rather than a stable supported process API. Failure can hide open windows; a launch UUID can also be stale after Claude `/clear`.
- A `likely` binding is heuristic, and `recent` means timestamp recency only. There is no authoritative live Codex-thread mapping.
- Warning text can contain labels or filesystem/database error details. It is returned without a redaction layer.
- Loopback has no authentication. Any same-user process or browser context able to reach the port can read the metadata and resume commands.

Treat Sessions API captures and screenshots like transcript indexes. Review paths, titles, IDs, and commands before sharing them, even though message bodies are omitted.

## Credential storage and ownership

### Actual storage

Live authentication uses provider-specific files in isolated or external homes:

| Mode | File | Read | Refresh/write |
|---|---|---|---|
| Claude owned | .credentials.json in an isolated Claude home | Yes | Yes |
| Claude readonly external | .credentials.json in an explicitly supplied external home | Re-read every call | Never |
| Claude readonly static | .credentials.json in an isolated static-token home | Re-read every call | Never |
| Codex | auth.json in an isolated CODEX_HOME | Re-read | No Codex refresh or persistence in subtrack |
| Codex via Hermes shared store | externally owned `providers.openai-codex` auth.json | Re-read and live-probe | Never; periodic canary invokes Hermes as the sole refresh owner |
| Grok | cookie.txt in an isolated grok home — a raw browser session cookie, equivalent to a logged-in grok.com session | Re-read every call | Never; only the operator replaces it by re-copying from the browser |

src/secrets.ts contains a Windows keyring abstraction under service name subtrack, but current adapters do not use it. Do not claim that live provider credentials are protected by Windows Credential Manager merely because that component exists.

Credential files are ordinary JSON from the perspective of these modules. They do not establish encryption at rest, DPAPI protection, explicit restrictive modes, an ACL policy, or a secure-delete policy.

### Claude owned rotation

Current mitigation:

- subtrack refreshes only when forced or when no more than 60 seconds remain.
- refresh uses the provider's HTTPS token endpoint with a form-encoded body.
- a lexical owned-root check blocks refresh and write for an obvious path outside the configured owned root.
- a new refresh token replaces the old token when returned.
- token values are not intentionally printed by the auth module.

Open risk:

- Refresh tokens rotate and are single-use.
- The server may invalidate the old token before the new token is safely written.
- Persistence is a direct unlocked, non-atomic whole-file overwrite with no backup, fsync, or explicit permissions.
- Concurrent refreshes of one home are not serialized.
- A lost response followed by retry can be ambiguous for a single-use token.
- Refresh response fields are weakly validated; a missing access token can be stringified into a bogus value.
- The owned-root check is lexical, refresh-only, case-sensitive in JavaScript, and does not resolve Windows reparse points. It does not prevent reading or returning a fresh token from an incorrectly routed external home.

Owned means one intended writer, not a code-enforced transactional lock. Never point two subtrack processes or another refreshing application at the same owned home.

### Claude readonly

Current mitigation:

- The readonly token-source object itself has no refresh-network dependency and no write method. The provider adapter still sends the returned access token over HTTPS to read usage.
- It re-reads the file every call so an external owner can rotate credentials.
- A known expired token becomes stale instead of being refreshed or repeatedly sent.

Open risk:

- A token without expiresAt is treated as locally non-expiring until the service rejects it.
- Missing, unreadable, and malformed credential files are partly collapsed into the same error.
- The external owner and its filesystem permissions are outside subtrack control.

Use readonly for a live external Claude home or static setup-token workflow. Never change it to owned merely to suppress stale state.

### Codex

subtrack launches codex login in an isolated CODEX_HOME and later reads auth.json. It does not refresh or rewrite Codex credentials. Registration now requires a successful interactive exit plus a readable access token; a cancelled new login is not saved, and repeating `add-account` reauthenticates an existing Codex entry in place. The reader also accepts a manually configured externally owned Hermes shared-store shape. In that mode the Hermes monitor may invoke a real-model canary, but Hermes's resolver/shared lock performs any needed rotation; subtrack still never handles refresh tokens as a writer. Credential-read failures are reported as `auth_error` with a quoted login command. Presence of auth.json or a locally reported logged-in state still does not prove the token remains valid.

## Unofficial provider endpoints

Both usage integrations call private or observational endpoints rather than stable public usage APIs:

- Claude usage is fetched from an Anthropic OAuth usage endpoint.
- Codex usage is fetched from a private ChatGPT backend endpoint.

Current mitigation:

- Requests are bodyless HTTPS GETs with bearer credentials.
- Transient transport failures and 5xx responses are retried at most three total attempts by default, with short delays.
- 4xx responses return immediately.
- Claude performs one additional forced credential read or refresh after the first 401.

Open risk:

- Hosts, headers, schemas, status meanings, and access policy can change without notice.
- Utilization and timestamp fields are permissively normalized.
- Provider error mappings are asymmetric.
- The Codex adapter can log an account identifier and up to 500 characters of an unexpected upstream response.
- User-visible errors can contain full local credential paths.
- The shared retry policy must be reviewed carefully for rotating-token POSTs with an ambiguous outcome.

Treat local logs as sensitive. Do not attach an unredacted log to an issue or public chat.

## Windows Scheduled Task boundary

### Dashboard installation

Current mitigation:

- The Scheduled Task principal is the current interactive user.
- Run level is Limited, not SYSTEM and not elevated.
- The task launches a hidden VBS shim, which starts the daemon without a console window.
- Management PowerShell uses NoProfile and NonInteractive and runs hidden.

Open risk:

- Management scripts use ExecutionPolicy Bypass.
- The VBS, configuration, and source checkout are writable inside the same-user trust boundary.
- The task embeds absolute Node, CLI, and repository paths. Moving or replacing them changes what executes at logon.
- Install uses a fixed task name and -Force, so it can replace an accessible same-name task.
- The 30-minute self-heal repetition is best-effort and remains enabled after stop. stop is not a durable disable operation.
- Current stop logic trusts any live PID in daemon.lock, force-kills its process tree, does not verify process identity or taskkill success, removes the lock, and reports success. PID reuse can target an unrelated process.
- install and start do not wait for dashboard health; uninstall does not strictly verify task absence.

Use uninstall, not stop, when automatic restart must be disabled. Verify status, Task Scheduler state, and health after lifecycle operations.

## Services inventory confidentiality

The Services feature inspects more of the machine than the Usage dashboard.

The Windows snapshot can include:

- every non-Microsoft-path Scheduled Task visible to the current user, not only tasks owned by this project;
- task names, states, result codes, and run times;
- listening TCP ports below 50000 on loopback and wildcard addresses;
- Node and Python process identifiers, names, and full command lines.

ServiceHealth also copies complete ServiceDef metadata, including taskName, match, startCmd, cwd, port, and httpPath. The local API and UI can therefore reveal project names, local paths, command arguments, URLs, and tokens embedded in command lines.

Current mitigation:

- The server is loopback-bound.
- UI text is HTML-escaped in the current templates.
- Inventory collection runs as the current user, not an elevated principal.

Open risk:

- There is no authentication or redaction layer.
- Command-line data and PowerShell output tails can contain secrets.
- Task collection is non-Microsoft-path, not current-user-only.
- Wildcard listeners are network-facing even though some comments describe them as loopback ports.
- Process discovery is incomplete and heuristic, while exposed data is still sensitive.
- Invalid or partial PowerShell output can become an empty snapshot and produce false down states.

Avoid credentials in process arguments. Curate service labels and stored commands as if anyone with access to the local user session can read them.

## Hermes monitor boundary

The optional monitor reads each configured canonical auth file into process memory to validate its pin/JWT and send a bearer-authenticated HTTPS usage probe. It deliberately exposes only public labels, status text, PIDs, timestamps, and recovery counters through Services. Credential paths, expected account IDs, raw process commands, token values, and webhook URLs are not copied into `ServiceHealth`, monitor state, or incident events.

The configured `hermesCommand` is executed with a fixed argument vector for a profile-scoped model canary and safe `gateway restart`; no shell is used. Any owner action is permitted only when the canonical pin and JWT claim match the expected account, a refresh token is present, relogin is not required, and that profile's `.env` binds the exact store. Expired access is allowed because this is the proven Hermes refresh-owner path; a live 401/403 still suppresses gateway restart while the canary path owns refresh recovery. Restart permission additionally requires two confirmed missing-runtime observations. Command-line acquisition gaps, stale metadata, duplicates, ambiguous ownership, and corrupt monitor state cannot authorize mutation, and the attempt/cooldown is atomically persisted before execution. Configuration is nevertheless trusted local input: a same-user attacker who can replace that executable, profile directory, auth file, or `hermes.json` already crosses the intended boundary.

Hermes stdout/stderr is used only in memory to classify a canary failure; arbitrary output is not copied into state/events. Persisted and webhook diagnostics use stable messages plus defense-in-depth redaction for token/key fields and common opaque prefixes. The private Windows process snapshot base64-wraps command lines before JSON parsing, then the public projection omits them entirely.

`heartbeatUrl` and `alertWebhookUrl` are outbound destinations and may embed secret path components. They are stored in plaintext `hermes.json`, are not returned by the API, and receive public profile/subscription labels plus health timing. Use HTTPS to a trusted receiver, limit retention, rotate leaked URLs, and do not point them at an endpoint that reflects payloads publicly. Webhook failure is ignored so it cannot stop local checking.

## Service action semantics and risk

The action allowlist is restart, stop, and register, but their names are broader than their exact effects.

The HTTP layer parses JSON and casts it to `ActionRequest` without a strict runtime schema. The executor rejects unknown actions and checks some action-specific fields, but it assumes the request is a non-null object, does not fully validate field types, and can throw on malformed values; the server then returns a generic HTTP 500. The allowlist limits intended verbs but is not complete request validation.

### restart

Actual effect: Start-ScheduledTask for the configured taskName.

It does not stop a running task, wait, perform stop-then-start, or verify health. TaskPath is not supplied, so duplicate names in different folders are ambiguous.

### stop

Actual effect: Stop-ScheduledTask for the configured taskName.

It stops the current instance only. The task remains registered and enabled and may run again on a later trigger. There is no post-state or health verification.

### register

Actual effect: create or replace an at-logon Scheduled Task from a process found by PID.

Current mitigation:

- The process must appear in a fresh system snapshot.
- Client label characters are restricted and PowerShell single quotes are escaped.
- The new task runs Interactive and Limited as the current user.

Open risk:

- PID reuse is not protected by process start time or executable fingerprint.
- Windows command-line parsing is simplified.
- Working directory is guessed from the executable directory, not captured from the process.
- Executables and arguments are not allowlisted.
- Arguments may contain credentials that become persistent Task Scheduler data.
- The task name has no length or uniqueness check.
- Register-ScheduledTask -Force can overwrite an accessible unrelated task.
- The task is not guaranteed hidden.
- Registration does not start it now, stop the source process, add a services.json definition, or prove it will relaunch correctly.

Treat register as best-effort Scheduled Task creation, not safe service adoption.

### Origin and request boundary

The server rejects some cross-origin browser POSTs, but the policy is not exact same-origin authentication:

- Missing Origin is accepted for non-browser clients.
- An Origin equal to http://<Host header> is accepted.
- Any HTTP or HTTPS Origin on localhost or 127.0.0.1, on any port, is accepted.
- Content-Type is not required to be application/json.
- Browser confirmation is UX only and can be bypassed by direct API calls.

Another localhost application can therefore satisfy the regex, and any same-user process can omit Origin. A strict mitigation would bind actions to the configured dashboard origin, require a per-session anti-CSRF secret or authenticated local channel, enforce JSON content type, and add replay or idempotency control.

## HTTP health-probe escape risk

The current HTTP probe constructs:

    http://127.0.0.1:<port><httpPath>

and uses default fetch redirect behavior.

Current mitigation:

- The literal URL begins with IPv4 loopback.
- Requests have a 1.5-second abort timer.
- No credentials or custom headers are added.
- Only final 2xx versus non-2xx versus thrown error is used.

Known open risk:

- port is not runtime-validated.
- httpPath is raw-concatenated and is not required to start with a slash.
- A path beginning with an authority-style value such as @host can change URL interpretation away from loopback.
- A loopback service can redirect to another host, and fetch follows redirects by default.
- The final origin is never checked.

This is a local-server request-forgery boundary. Until fixed:

- use only integer local ports;
- use simple leading-slash paths such as /health;
- do not configure paths containing @, scheme markers, backslashes, or authority syntax;
- ensure the target health endpoint does not redirect;
- treat services.json write access as code-adjacent privilege.

The code should parse with URL, require exact protocol, hostname, and port, reject credentials and authority changes, set redirect to error or manual, and verify the final URL.

## Transcript, log, and diagnostic secrecy

Historical project sessions demonstrated that transcripts and tool output can contain credentials, command-line arguments, local paths, account metadata, and external-service responses.

Safe rules:

- Never paste tokens, credential JSON, or credential-bearing URLs into chat.
- Treat Claude and Codex transcripts as sensitive local artifacts.
- Do not publish raw daemon logs, process listings, Sessions/Services API responses, or screenshots without review and redaction.
- Pipe static tokens through stdin as intended; do not put them in argv, accounts.json, labels, or issue text.
- Rotate any credential that appears in a transcript, log, process argument, screenshot, or scratch script.
- Keep local state and credential backups out of public repositories.

## Recommended hardening

Priority 0:

1. Fix HTTP probe origin escape: validate port/path, construct and inspect URL, disable redirects, and add SSRF regression tests.
2. Add strict runtime schemas for accounts.json, services.json, action requests, provider responses, and Windows snapshots.
3. Redact or remove full process command lines, provider response bodies, local credential paths, and PowerShell output tails from API, UI, and logs.

Priority 1:

4. Make owned credential persistence validated, per-home locked, restrictive, atomic, and recoverable after an ambiguous refresh.
5. Enforce exact configured Origin plus a CSRF secret or authenticated local IPC for actions; require JSON content type and add replay protection.
6. Use TaskPath plus TaskName, detect collisions, remove unconditional -Force, verify PID start time and executable fingerprint, use Windows-correct argv handling, capture real cwd, and verify postconditions.
7. Harden daemon locks with freshness, process identity, taskkill result, and post-kill checks.

Priority 2:

8. Add config backup/recovery, ACL guidance, writer coordination, and ownership-aware credential cleanup.
9. Distinguish partial inventory failure from a genuinely empty machine snapshot and isolate per-service errors.
10. Decide whether the unused keyring abstraction should be integrated with a migration plan or removed from user-facing claims.
11. Add contract tests and a drift policy for unofficial provider endpoints.
12. Replace observed PEB-offset live-window correlation with a supported minimal metadata channel if Claude/Codex expose one, and redact filesystem details from warnings.

## Safe operating practices

- Keep the server bound to 127.0.0.1 and do not proxy it externally.
- Run under the intended non-elevated user; do not install as SYSTEM.
- Restrict write access to ~/.subtrack, credential homes, the source checkout, and installed launcher files.
- Use one writer per owned Claude home.
- Use readonly for externally owned Claude homes.
- Back up JSON before manual edits and validate it before replacement.
- Review the one-time Services seed and remove irrelevant or sensitive definitions.
- Avoid register unless the command, target task name, and relaunch behavior have been manually reviewed.
- Use uninstall when self-heal must stop.
- Verify health and Task Scheduler state after lifecycle or action operations.
- Keep secrets out of labels, process arguments, regexes, startCmd, cwd, and logs.
- Treat Sessions titles, IDs, paths, branches, PIDs, and resume commands as sensitive even though prompts/messages/tools are omitted.
- Rotate exposed credentials rather than relying on deletion of a transcript.

## What subtrack does not guarantee

subtrack does not currently guarantee:

- protection from a malicious same-user process;
- safe exposure beyond loopback;
- authentication of local API callers;
- crash-safe single-use token rotation;
- encrypted credential storage through the unused keyring component;
- complete or authoritative process/task/port inventory;
- complete or authoritative live Claude/Codex session-window mapping, or freshness of a Claude launch UUID after `/clear`;
- safe arbitrary HTTP probe paths or redirects;
- collision-free or faithful Scheduled Task adoption;
- durable stop while self-heal remains installed;
- stable unofficial provider schemas.

These are explicit boundaries, not hidden promises.
