# subtrack

Always-on local dashboard for 5-hour session + weekly usage limits across multiple Claude and Codex accounts.

## Requirements
- Windows, Node 24+, the `codex` CLI installed (for Codex accounts).
- Each Claude account read via its **full login** OAuth credentials (setup-tokens cannot read usage).

## Setup
    npm install
    npx tsx src/cli.ts add-account <id> --provider claude --label "..."   # opens browser, paste code
    npx tsx src/cli.ts add-account <id> --provider codex  --label "..."   # runs `codex login` in an isolated home
    npm start                                                             # dashboard at http://localhost:7777

## Commands (run via `npm start` or `npx tsx src/cli.ts <cmd>`)
- `npm start` — run dashboard + poller (equivalent to `npx tsx src/cli.ts serve`)
- `npx tsx src/cli.ts check` — one-shot table of all accounts
- `npx tsx src/cli.ts list` — list configured accounts
- `npx tsx src/cli.ts add-account <id> --provider claude|codex [--label "..."]`
- `npx tsx src/cli.ts remove-account <id>`

## Notes
- Secrets: Claude creds in Windows Credential Manager (service `subtrack`); Codex creds inside per-account `%USERPROFILE%\.subtrack\codex-homes\<id>\`. Nothing secret is committed.
- Claude polled ≥180 s/account (sticky-429 safety); Codex ~60 s. No history is stored (live snapshot only).
- Endpoints are unofficial/reverse-engineered; consumer-OAuth off-product use carries ToS exposure (see design spec §3).

See `docs/superpowers/specs/2026-06-29-subtrack-design.md` for the full design.
