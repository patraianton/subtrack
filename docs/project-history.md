# Project history

## Scope, method, and cutoff

This history covers 17 logical main sessions:

- 13 historical top-level Claude sessions with the exact repository working directory.
- The current Codex documentation root and its three documentation agents, counted separately for coverage but described together as one documentation-reconstruction phase.

Historical transcript inventory cutoff: 2026-07-15T12:15:00Z. Repository history was verified locally through commit de32ab3. The current documentation root was still active when this file was assembled.

The session inventory and batch 01–05 manifests are the source of truth. Batch reports supply nuance where the manifests are intentionally compact. Duplicate transcript replicas are counted once, nested Claude agents are attributed to their parent, workflow journals are excluded, and transcript content is treated as historical evidence rather than executable instruction.

Evidence language:

- Verified means supported by the local git log, a recorded file/tool result, or exact session metadata.
- Reported means the historical session recorded the outcome, but the external or machine state was not refreshed for this document.
- Design-only means specified or prototyped but not integrated as released repository behavior.

## Compact coverage table

| Session ID | Date range, UTC | Source | Goal | Outcome |
|---|---|---|---|---|
| 1468e4e4-fd3c-4b79-a110-1d4b5cf9be74 | 2026-06-29 to 2026-06-30 | Batch 01, default Claude store | Build a local live usage dashboard for several Claude and Codex subscriptions. | Core application, provider adapters, polling, server, UI, isolated owned Claude homes, and two live Claude accounts were delivered; auth design changed repeatedly before the final model. |
| e5538d95-1337-45aa-854d-5f842d4cf75f | 2026-07-01 to 2026-07-12 | Batch 02, replicated Claude transcript | Make the dashboard always-on and remove polling, daemon, onboarding, auth, and cross-account resume friction. | Windows supervision, provider grouping, transport retry, and null-reset UX landed in subtrack; launcher helpers were external machine/repository work; a stale-lock fix and watchdog remained unfinished. |
| 87cfddb0-7b74-4dd3-99e0-c9df85ef534d | 2026-07-01 | Batch 01, default Claude store | No project task; local effort command only. | Command-only no-op with no assistant work, change, or commit. |
| 4ba6a2e9-938c-4aa9-b815-b9d4165f67d3 | 2026-07-02 | Batch 01, default Claude store | Create repository guidance, restore the dashboard, and explain an unknown reset. | Guidance was written, stop/start restored health, and null reset semantics were recorded; no in-session commit. |
| 70e19d95-837c-4550-80da-c07612077471 | 2026-07-07 | Batch 02, isolated Claude store | Invoke resume. | Resume was cancelled; no project work occurred. |
| 53a30d62-1a59-41d1-b354-7a3ce1d00718 | 2026-07-07 | Batch 02, isolated Claude store | Recover a missing session and understand multi-account storage. | Sessions were found and copied between homes; storage boundaries were established; the systematic UX answer was interrupted by a session limit. |
| 21c045c0-ebd4-4cc7-a54d-07db96323251 | 2026-07-07 to 2026-07-13 | Batch 03, isolated Claude store | Improve cross-home resume, investigate divergent file memory, and record Fable backlog. | Launcher helpers and session copies were external operator work; issue records and a separate local memory backup were produced; native shared resume, memory rollout, and Fable implementation were not completed there. |
| 98896e11-d8b0-4964-91a3-24d9f6a9ec1c | 2026-07-08 | Batch 03, isolated Claude store | Response smoke check. | Returned ok; no project change. |
| aee59a4b-75ca-4e50-9f92-3cbcf09af4f9 | 2026-07-09 | Batch 03, isolated Claude store | Response smoke check. | Returned ok; no project change. |
| 99cc45bd-2f12-4c3e-a89f-f5035356c507 | 2026-07-12 to 2026-07-14 | Batch 04, fuller replicated Claude transcript | Prove and specify a worker-session watchdog, extend account operations, recover an external session, and diagnose a desktop artifact. | A classic-console control spike reached GO and a design was written, but no production watchdog was integrated; launcher/account and machine-level recovery work was performed. |
| 605ae1a3-cf65-4b3e-b953-66c7a99907e5 | 2026-07-14 | Batch 04, isolated Claude store | Add another account, repair launcher-home drift, and explain Claude-to-Codex transfer limits. | The account was reported healthy in launcher and dashboard, another launcher home was normalized, and native provider/session transfer was correctly rejected. |
| 8a12a60a-7ed3-4d78-a4b5-8a18a55eed88 | 2026-07-15 | Batch 04, isolated Claude store | Recover pre-reboot work and make the operator's active account/project/cwd/session visible; later work also covered publication and a Codex login repair. | Work sessions were reopened, but the implementation diverted into a Services cockpit; 18 verified Services commits landed through de32ab3, the daemon was restarted, and the Codex re-login remained interrupted. |
| ca2c4d11-39f4-4e9a-b0fe-0d599efd6d25 | 2026-07-15 | Batch 05, isolated Claude store | Clear the local session. | No-op clear session with no assistant work, tools, changes, or commits. |
| 019f65a2-2b6f-7303-a198-e4834ffe1253 | 2026-07-15, active at cutoff | Current Codex root | Reconstruct all project sessions and produce full canonical documentation. | Orchestrated the bounded inventory, five historical batches, parallel code audits, and canonical synthesis; later continued into the corrective Sessions surface described below. |
| 019f65a6-bf29-7751-814a-85534d7caa5f | 2026-07-15 | Current Codex documentation agent | Inventory project sessions and synthesize historical and web evidence. | Produced the bounded inventory, batch 04, Usage UI audit, and this history synthesis. |
| 019f65a7-053b-7191-8ee7-38692a77ae26 | 2026-07-15 | Current Codex documentation agent | Audit core types, polling, adapters, authentication, and HTTP contracts. | Returned code-evidence audit artifacts to the root documentation task. |
| 019f65a7-552d-7380-af2e-25f772df8194 | 2026-07-15, active at cutoff | Current Codex documentation agent | Audit CLI, server, daemon/install, web, and operator behavior. | Runtime-surface documentation audit was still being consolidated at cutoff. |

The five non-substantive sessions—one command-only, one cancelled resume, two smoke checks, and one clear-only session—are retained deliberately. They prove complete coverage and prevent unrelated work from being attributed to empty transcripts.

## Chronological phases

### 1. Foundation: design, core pipeline, and live provider validation

The first substantial session established the enduring product shape: a loopback-only local dashboard, live snapshot only, no database, normalized provider usage, an in-memory last-value store, staggered polling, and a vanilla web UI.

Implementation followed a design and TDD plan. Live spikes were decisive:

- The initially guessed Codex response shape was wrong; a real response established the nested rate-limit windows and window-duration classification.
- Review corrected all-interface binding, static-path handling, partial configuration merging, and HTML escaping.
- Poller review added overlap protection and last-known window carry-forward.

Claude authentication went through several false starts before converging:

- Custom third-party OAuth and PKCE paths did not match the subscription flow.
- A pasted setup token did not work as a universal owned, auto-refreshing onboarding path.
- Copying the primary Claude credentials worked briefly but created competing owners of a rotating single-use refresh lineage.
- The accepted owned model became one isolated Claude home per subtrack account, with form-encoded refresh and persistence inside that home.

The early keyring abstraction and PKCE helper remain historical implementation artifacts, not the live credential path.

### 2. Windows operations: always-on service, retries, and honest reset state

The next operational phase added a user-context Windows Scheduled Task, hidden launcher, daemon supervisor, PID lock, crash restart, lifecycle commands, and log rotation. Running as the interactive user was a deliberate security and functionality boundary because the service needs that user's profile-resident configuration and credential files; the live auth path was not the unused keyring abstraction.

Other durable decisions from this phase:

- Retry transient transport failures and 5xx responses, but return 4xx immediately.
- Surface the terminal transport cause code.
- Treat resetsAt null as unknown or unanchored and render an em dash, never epoch zero.
- Read account configuration once at server start; restart is required after account changes.
- Make interrupted add-account registration idempotently resumable and instruct the operator to exit the login process cleanly.

A repository-guidance session also captured the recovery path for daemon-running but dashboard-down: clean stop, then start. Its proposed sleep/socket root cause was only a hypothesis.

### 3. Multi-account continuity, memory, Fable, and credential modes

Session-recovery work proved that Claude transcripts are scoped by both the current credential home and encoded working directory. A missing session was usually invisible from another home, not deleted.

The accepted **external operator workflow**, not a subtrack feature, was controlled copy after the source session exits, eventually wrapped by launcher helpers such as find, resume, switch, and last-session commands. A shared projects-directory junction was rejected because divergent stores, concurrent append behavior, open handles, file history, and nested artifacts were not proven safe.

The memory investigation separated two systems:

- Plugin memory was already conceptually global.
- Built-in file memory was per-home and had diverged.

A direct shared auto-memory directory was rejected because it could collapse multiple projects into one exact directory. A version-specific remote-memory base resolver looked promising in binary inspection, but no live canary or rollout was completed. The only executed low-risk step was a separate local git backup of memory files.

Git history later verifies a Fable weekly-cap feature and explicit readonly credential modes. This supersedes two historical overgeneralizations:

- Fable was only a backlog hypothesis inside one conversation, but it later became repository code.
- Setup-token use failed as a universal owned-login strategy, but later became supported as an explicit static readonly source. These are different contracts.

The final credential model therefore distinguishes:

- owned: subtrack owns the isolated refresh lineage and may refresh and persist it;
- readonly: another process or a static token owns the source, so subtrack re-reads but never refreshes or writes it.

### 4. Watchdog feasibility and account operations

A later session tested whether an external supervisor could read and control interactive Claude sessions without stealing focus. Direct process inspection showed the relevant workers used classic conhost consoles rather than the Windows Terminal or ConPTY model assumed by an earlier research path.

A scratch native helper proved console attach, alternate-buffer read, menu navigation, Enter, verified text echo, and backspace. This justified a GO design for a multi-signal watchdog using transcript tail, quota state, and console state.

The result remains design-only:

- The [uptime-watchdog design](superpowers/specs/2026-07-12-uptime-watchdog-design.md) was written but historical evidence did not show it committed.
- The native helper remained in a scratch area.
- No production watchdog or tested state machine was integrated.

The same period included account onboarding, launcher-home normalization, recovery of an external project session whose subject directory differed from its actual cwd, and Windows desktop troubleshooting. Those are operator or machine changes, not repository releases.

### 5. Services ops cockpit (implemented detour)

After a Windows reboot, the implementation expanded from usage display into an ops cockpit. Its internal design put the feature inside subtrack and separated it from the usage poller:

- system discovery and health checks run on demand with a short cache;
- service definitions live in a user manifest;
- health kinds cover scheduled task, port, HTTP, and process;
- selected probe uncertainty, such as invalid process patterns and HTTP probe errors, remains `unknown` instead of becoming false `down`; whole Windows snapshot failures can still collapse to empty evidence and falsely classify configured services as `down`;
- the UI groups and sorts problems without changing the usage pipeline.

Phase 1 added the Services manifest, Windows state gathering, health probes, untracked-runner detection, GET API, and page. Whole-branch review found a destructive boundary: missing, intentionally empty, and malformed manifests had been conflated. Commit 1389aea changed seeding to occur only when the file is absent, surfaced malformed configuration, and returned a server error on provider failure.

Phase 1b added restart, stop, and best-effort register actions. Its load-bearing rule is that the client never supplies an executable command; the server resolves stored task names or live process details. Final review found cross-origin requests to the loopback POST endpoint and a destroy-then-write oversized-body failure. Commit de32ab3 added an Origin filter, safe response handling, and a clean 413. The filter reduces non-loopback browser requests but is not authentication or strict same-origin enforcement: missing Origin and any HTTP/HTTPS localhost or `127.0.0.1` Origin on any port are accepted.

The page initially appeared blank after merge because static files updated while the old daemon process still lacked the new API route. Restarting the daemon loaded the new server code. Initial auto-seeding also included irrelevant vendor tasks, demonstrating that first-run manifest curation is part of the operator workflow.

The operator later clarified that Services had not answered the original need: the intended dashboard was a view of their own Claude/Codex work sessions—which account, project, exact cwd, and session was active—rather than a second Windows Task Manager. Services remains real implemented history, but it must not be described as the solution to that session-visibility request.

Projects indexing and reversible Cleanup were specified but not implemented.

### 6. Documentation reconstruction

The current Codex root commissioned three parallel documentation agents:

- session inventory and history synthesis;
- core pipeline and authentication audit;
- runtime, CLI, daemon, server, and web audit.

The inventory classified 17 exact-cwd logical sessions, deduplicated two replicated Claude roots, linked nested agents to their parents, excluded workflow journals, and found no separate worktree session. Five historical batches then summarized all 13 Claude roots, including the five non-substantive sessions.

This phase is documentation-only. It does not retroactively turn reported machine actions or design artifacts into released repository behavior.

### 7. Corrective Sessions surface

After reviewing the original prompt and the 8a12 session outcome, the current working tree added a separate read-only Sessions surface while leaving Services intact. The implementation:

- scans direct Claude project JSONL files across default, numbered, and configured read-only homes for bounded session metadata while excluding subtrack-owned Usage homes as resume targets;
- opens default/configured Codex thread databases read-only and includes interactive CLI/Desktop threads;
- deduplicates provider UUID copies and exposes account, launcher, project/folder, exact cwd, title, branch, activity, and quoted resume commands;
- on Windows, correlates live Claude PIDs with account home/cwd and launch UUID using minimal PEB-derived metadata;
- distinguishes verified live Claude `open` from 24-hour `recent` activity, which is not liveness and is the strongest available Codex signal;
- isolates unreadable stores/window inspection as partial warnings and caches successful responses briefly;
- does not persist its own session history, return prompt/message/tool content, expose complete command lines/environments, or execute resume commands.

This is working-tree behavior after the repository-history cutoff above. It is not included in the verified commit milestone table unless and until a corresponding commit exists.

### 8. Codex login repair

The corrective working tree also fixed the interrupted Codex onboarding path exposed by the `codex-1` Usage card. The prior CLI saved account configuration after the interactive child exited without verifying `auth.json`, then rejected a repeated `add-account` command because the ID already existed. Current behavior verifies credentials before first registration, leaves cancelled new logins unregistered, and lets the identical command reauthenticate a configured Codex account while preserving its label. Nonzero interactive exits are no longer treated as success, credential-read failures are classified as `auth_error`, and missing-file errors include a quoted `CODEX_HOME` login command instead of a raw `ENOENT` path.

## Key accepted decisions

| Decision | Why it was accepted |
|---|---|
| Local loopback dashboard with no subtrack history database | Usage/Services remain live snapshots while Sessions reads provider-owned history in place; no new remotely exposed or duplicated transcript store is created. |
| One normalized usage contract | Keeps adapters provider-specific while poller, store, server, and UI consume one shape. |
| Dependency-injected seams | Allows network, time, process, and filesystem behavior to be tested without live side effects. |
| Last-known window carry-forward | An auth, throttle, or transport error must not blank useful usage data. |
| Server-owned severity thresholds | Prevents threshold logic from drifting between API and UI. |
| Null means unknown reset | Avoids the misleading epoch-zero resets-now state. |
| Per-account credential ownership | Prevents competing refreshers from invalidating single-use refresh lineages. |
| Explicit owned and readonly modes | Supports both subtrack-owned isolated homes and externally owned or static sources without rotation. |
| User-context Windows supervision | Preserves access to profile-resident configuration and credential files while remaining hidden and restartable. |
| External operator workflow: controlled cross-home session copy | Solves real recovery cases without an unproven shared-store migration; it is not subtrack source or CLI behavior. |
| Read-only Sessions metadata index | Answers the operator's account/project/cwd/session question from provider-owned stores without creating another transcript database or granting session mutation authority. |
| On-demand Services discovery | Keeps machine scanning and action failures isolated from the usage poller. |
| Server-resolved service actions plus an Origin filter | Keeps executable commands server-resolved and rejects many non-loopback browser Origins; it does not authenticate callers or enforce exact same-origin. |

## Rejected or failed approaches

| Approach | Why it failed or was rejected |
|---|---|
| Custom Claude OAuth/PKCE | Subscription authorization did not support the guessed third-party flow. |
| Setup token as universal owned onboarding | Live usage failed in that role; later static readonly support is a narrower, different contract. |
| Shared primary Claude credentials | Multiple refresh owners competed over a rotating single-use lineage. |
| JSON refresh body | The provider endpoint required form encoding. |
| Guessed Codex usage schema | Live data used a different nested shape; the adapter was corrected before normalization. |
| Binding to all interfaces | Violated the local-only security boundary. |
| Naive static path guard | One version permitted traversal risk; another trailing-separator form blocked every request. |
| Shared transcript projects junction | Concurrency, open-handle, migration, and divergent-data safety were unproven. |
| One exact shared auto-memory directory | Risked mixing unrelated projects. |
| Automated refresh of externally owned Claude credentials | Created visible windows or refresh contention and did not establish safe ownership. |
| Treating a private-repository 404 as proof it did not exist | The active GitHub identity lacked access; retrying with the correct identity succeeded historically. |
| Restoring all sessions as tabs in one terminal | Technically reopened work but did not match the operator's separate-window preference. |
| Treating the Services/process cockpit as session visibility | It inventories machine services and selected processes, but does not identify the operator's Claude/Codex project sessions; the separate Sessions surface corrects that mismatch. |
| Services reseed on any empty result | Could overwrite a deliberately empty or malformed manifest; fixed in 1389aea. |
| Unprotected loopback action POST | A visited website could trigger state changes; fixed in de32ab3. |

## Verified repository commit milestones

The local git log verifies the following repository lineage through de32ab3:

| Milestone | Commits |
|---|---|
| Design and implementation plan | 11d1e3e, 724c5cf |
| Core types, config, early secret/PKCE helpers, adapters, CLI | 9a3dba6 through 5e8e557 |
| Live Codex shape, store, poller, server, UI, final security review | 933871b through cab8e0b |
| Claude auth pivots and final isolated owned homes | 169b0d4, ec40208, e719c2f, 51bfd19, 6355d0a |
| Onboarding and CLI polish | 9e1dd85, c9616ed, 506f6ca, f991197, 9271a61 |
| Windows daemon supervision | 0deb0b7 |
| Provider grouping, transient retry, unknown reset | ff120f1, 591ef64, bb16d3a |
| Repository guidance | ab2cf19 |
| Fable weekly cap | e43bad7 |
| Readonly sources and no-rotation credential modes | bb5f6e2, e587ee7, 755baa2 |
| Services design, plan, monitoring, and review fixes | 015c4fe through 1389aea |
| Services actions, action UI, and security fixes | e5d201d through de32ab3 |

Historical sessions reported private pushes at several points, but this document does not present remote branch state as current. Local commit existence and subjects are the verified facts.

## Work outside this repository

The following work is historically important but must not be described as subtrack source code:

### External launcher configuration

An external multi-account launcher repository or configuration received retrying cross-home pull, visible error handling, switch, last-session, find, resume, Chrome launch, and profile-reload guidance. Five external commits were recorded in batch 02:

- 7630faa
- eb2ed2f
- 17b6911
- d4d05d7
- 4e45314

Later launcher edits added more account mappings and helpers, sometimes without a repository commit. They affect the operator's machine, not the subtrack package.

### External memory repository

Batch 03 reports that a separate local memory repository received commit b4b8a66 after additive consolidation from multiple homes. That external repository was not refreshed for this history; the transcript says originals were left untouched and the proposed shared-memory resolver was not enabled.

### Machine and external-service operations

Account-home creation, transcript copying, Scheduled Task state, browser logins, dashboard restarts, terminal restoration, desktop repaint, hosted checkpoints, messaging delivery, and external issue repositories are historical operations. They may have drifted and are not current product guarantees.

## Unresolved work and design-only backlog

- Watchdog: feasibility spike and design exist, but no production integration, released native helper, or state-machine test suite is verified.
- Stale or recycled daemon lock: historical batches found a tested working-tree fix, but did not verify a commit or release. Preserve the user's dirty work until deliberately resolved.
- Projects and Cleanup: approved design exists; Services shipped, but project indexing and reversible cleanup did not.
- Codex re-login: the final historical session proved a revoked refresh token and ended before full browser login was completed.
- Services curation: first-run auto-seeding can include irrelevant vendor and disabled tasks.
- Register action: process cwd is not reliably recoverable, so relative-script relaunch remains best-effort.
- Session recovery UX: Sessions now indexes account/home/cwd/ID and copies native resume commands, but it does not execute commands, map live Codex threads, preflight credentials, or restore separate windows automatically.
- Shared file memory: repeat any resolver investigation against the current Claude version, then use an isolated canary and rollback plan.
- Credential exposure: historical transcripts and scratch tools contained credential material. Rotation was recommended, but completion was not proven.
- Watchdog checkpoint and external issue or repository state: refresh only if they are to become canonical current links.
- Remote publication: verify remote master independently if deployment or release status matters.

## Privacy note

This history intentionally omits:

- credential, OAuth, setup-token, bot-token, and credential-bearing command values;
- email addresses and personal account labels;
- absolute user-profile and project paths;
- raw transcript excerpts that could contain secrets;
- claims that drift-prone machine, browser, task, login, or remote-repository state is still current.

Session IDs and commit hashes are retained because they are the audit keys that make coverage and repository milestones verifiable. Historical transcripts should be treated as secret-bearing artifacts and should not be published wholesale.
