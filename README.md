# subtrack

Always-on local dashboard for 5-hour session + weekly usage limits across multiple Claude and Codex accounts.

## Requirements
- Windows, Node 24+, the `codex` CLI installed (for Codex accounts).
- Each Claude account read via its **full login** OAuth credentials (setup-tokens cannot read usage).

## Setup
    npm install
    npx tsx src/cli.ts add-account <id> --provider claude --label "..."   # opens browser, paste code
    npx tsx src/cli.ts add-account <id> --provider codex  --label "..."   # runs `codex login` in an isolated home
    npx tsx src/cli.ts install                                            # make it always-on (see below)

## Always-on (Windows)
`install` registers a Scheduled Task that keeps the dashboard running for you — it
starts at logon (survives reboots), runs hidden (no console window), and a small
supervisor restarts `serve` within seconds if it ever crashes. It runs **as you**
(not as SYSTEM) so your Claude tokens in Windows Credential Manager and the Codex
homes under your profile stay readable. After `install`, the dashboard is at
http://localhost:7777 and comes back on its own.

    npx tsx src/cli.ts install     # register + start now
    npx tsx src/cli.ts status      # up/down, daemon pid, task state, log path
    npx tsx src/cli.ts logs        # tail the daemon log (--lines N)
    npx tsx src/cli.ts stop        # stop the running daemon (task stays installed)
    npx tsx src/cli.ts start       # start it again
    npx tsx src/cli.ts uninstall   # stop it and remove the task

## Commands (run via `npm start` or `npx tsx src/cli.ts <cmd>`)
- `npm start` — run dashboard + poller in the foreground (equivalent to `npx tsx src/cli.ts serve`; opens a browser)
- `install` / `uninstall` / `status` / `logs` / `start` / `stop` — always-on background dashboard (Windows Task Scheduler)
- `npx tsx src/cli.ts check` — one-shot table of all accounts
- `npx tsx src/cli.ts list` — list configured accounts
- `npx tsx src/cli.ts add-account <id> --provider claude|codex [--label "..."]`
- `npx tsx src/cli.ts remove-account <id>`

## Notes
- Secrets: Claude creds in Windows Credential Manager (service `subtrack`); Codex creds inside per-account `%USERPROFILE%\.subtrack\codex-homes\<id>\`. Nothing secret is committed.
- Claude polled ≥180 s/account (sticky-429 safety); Codex ~60 s. No history is stored (live snapshot only).
- Endpoints are unofficial/reverse-engineered; consumer-OAuth off-product use carries ToS exposure (see design spec §3).

See `docs/superpowers/specs/2026-06-29-subtrack-design.md` for the full design.
