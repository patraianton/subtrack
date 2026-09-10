import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AccountConfig, NormalizedUsage } from './types.ts';
import { loadConfig, saveConfig, addAccount, removeAccount, renameAccount, configDir } from './config.ts';
import { claudeHomeDir, buildClaudeLogin, readClaudeOauth } from './auth/claude.ts';
import { codexHomeDir, buildCodexLogin, readCodexAuth } from './auth/codex.ts';
import { grokHomeDir, grokCookiePath, readGrokCookie, readGrokMeta, writeGrokMeta } from './auth/grok.ts';
import { fetchGrokUsage, fetchGrokEmail } from './adapters/grok.ts';
import { makeFetchUsage } from './adapters/index.ts';

/** Spawn an interactive child (stdio inherited) and report whether it exited successfully. */
function runInteractive(cmd: string, args: string[], env: Record<string, string>): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env }, shell: true });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

export type InteractiveRunner = (cmd: string, args: string[], env: Record<string, string>) => Promise<boolean>;

export interface ParsedArgs {
  cmd: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [cmd = '', ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else {
      positionals.push(a);
    }
  }
  return { cmd, positionals, flags };
}

function pct(w: { utilization: number } | null): string {
  return w ? `${Math.round(w.utilization)}%` : '—';
}

export function formatCheckTable(usages: NormalizedUsage[]): string {
  const rows = usages.map((u) => {
    const status = u.status === 'ok' ? '' : `  [${u.status}${u.error ? `: ${u.error}` : ''}]`;
    return `${u.label.padEnd(24)} ${u.provider.padEnd(7)} session ${pct(u.session).padStart(4)}  weekly ${pct(u.weekly).padStart(4)}  fable ${pct(u.fable).padStart(4)}${status}`;
  });
  return ['ACCOUNT                  PROVIDER SESSION       WEEKLY        FABLE', ...rows].join('\n');
}

async function cmdCheck(base: string): Promise<number> {
  const cfg = await loadConfig(base);
  const fetchUsage = makeFetchUsage();
  const enabled = cfg.accounts.filter((a) => a.enabled);
  const usages = await Promise.all(enabled.map((a) => fetchUsage(a)));
  console.log(formatCheckTable(usages));
  return usages.some((u) => u.status === 'auth_error') ? 1 : 0;
}

/** Best-effort account email so the user can tell accounts apart (from the isolated home). */
async function accountEmail(a: AccountConfig): Promise<string> {
  if (!a.credentialsHome) return '';
  try {
    if (a.provider === 'claude') {
      const cj = JSON.parse(await readFile(join(a.credentialsHome, '.claude.json'), 'utf8')) as { oauthAccount?: { emailAddress?: string } };
      return cj.oauthAccount?.emailAddress ?? '';
    }
    if (a.provider === 'grok') {
      return (await readGrokMeta(a.credentialsHome)).email ?? '';
    }
    const auth = JSON.parse(await readFile(join(a.credentialsHome, 'auth.json'), 'utf8')) as { tokens?: { id_token?: string } };
    const idToken = auth.tokens?.id_token;
    if (idToken) {
      const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { email?: string };
      return payload.email ?? '';
    }
  } catch {
    /* email unavailable — fine */
  }
  return '';
}

async function cmdList(base: string): Promise<number> {
  const cfg = await loadConfig(base);
  for (const a of cfg.accounts) {
    const email = await accountEmail(a);
    console.log(`${a.enabled ? '●' : '○'} ${a.id.padEnd(14)} ${a.provider.padEnd(7)} ${email.padEnd(28)} ${a.label}`);
  }
  return 0;
}

async function cmdRemove(base: string, id: string): Promise<number> {
  const cfg = await loadConfig(base);
  await saveConfig(removeAccount(cfg, id), base);
  console.log(`Removed ${id}`);
  return 0;
}

async function cmdRename(base: string, id: string, label: string): Promise<number> {
  if (!id || !label) {
    console.error('Usage: subtrack rename <id> "<new name>"   (or --label "<new name>")');
    return 2;
  }
  const cfg = await loadConfig(base);
  if (!cfg.accounts.some((a) => a.id === id)) {
    console.error(`No account "${id}". Run \`list\` to see ids.`);
    return 2;
  }
  await saveConfig(renameAccount(cfg, id, label), base);
  console.log(`Renamed ${id} → "${label}"  (restart the dashboard to see it)`);
  return 0;
}

/**
 * Register an already-logged-in external Claude home (e.g. a Claude Code CLI config dir) as a
 * read-only account: subtrack reads its access token each poll but NEVER refreshes or writes it —
 * refresh tokens are single-use and belong to the CLI (incident 2026-07-08).
 */
async function registerReadonlyAccount(base: string, id: string, home: string, labelFlag?: string): Promise<number> {
  const cfg = await loadConfig(base);
  const oauth = await readClaudeOauth(home);
  if (!oauth?.accessToken) {
    console.error(`No Claude credentials found in ${home} (.credentials.json with claudeAiOauth.accessToken expected).`);
    return 2;
  }
  const acc: AccountConfig = { id, label: id, provider: 'claude', enabled: true, credentialsHome: home, credentialsMode: 'readonly' };
  acc.label = labelFlag ?? ((await accountEmail(acc)) || id);
  await saveConfig(addAccount(cfg, acc), base);
  console.log(`Added read-only Claude account ${id} (${acc.label}) — token is read from ${home} each poll; subtrack never refreshes it.`);
  return 0;
}

/**
 * Register a long-lived `claude setup-token` (sk-ant-oat01-…) account. The token is stored in an
 * owned home WITHOUT a refresh token or expiry, and the account is marked readonly, so the
 * no-refresh guarantee is the same by construction: there is nothing to rotate.
 */
export async function registerStaticTokenAccount(base: string, id: string, token: string, labelFlag?: string): Promise<number> {
  if (!token) {
    console.error('No token provided. Pipe it on stdin:  claude setup-token | subtrack add-account <id> --provider claude --static-token');
    return 2;
  }
  const cfg = await loadConfig(base);
  if (cfg.accounts.some((a) => a.id === id)) {
    console.error(`Account "${id}" already exists — run \`remove-account ${id}\` first to redo it.`);
    return 2;
  }
  const home = claudeHomeDir(configDir(base), id);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token } }, null, 2), 'utf8');
  const acc: AccountConfig = { id, label: labelFlag ?? id, provider: 'claude', enabled: true, credentialsHome: home, credentialsMode: 'readonly' };
  await saveConfig(addAccount(cfg, acc), base);
  console.log(`Added static-token Claude account ${id} (${acc.label}) — long-lived setup-token, no refresh ever.`);
  return 0;
}

/** Read all of stdin (for piping a setup-token in without putting it in argv/shell history). */
async function readStdinText(): Promise<string> {
  let out = '';
  for await (const chunk of process.stdin) out += chunk;
  return out.trim();
}

/**
 * Complete or repair an isolated Codex login before registering it. Unlike the original onboarding
 * path, a cancelled login never creates a configured account with a missing auth.json. Re-running
 * add-account repairs an already-configured broken Codex home instead of demanding remove/re-add.
 */
export async function registerCodexAccount(
  base: string,
  id: string,
  labelFlag?: string,
  interactive: InteractiveRunner = runInteractive,
): Promise<number> {
  const cfg = await loadConfig(base);
  const existing = cfg.accounts.find((account) => account.id === id);
  if (existing && existing.provider !== 'codex') {
    console.error(`Account "${id}" already exists with provider ${existing.provider}.`);
    return 2;
  }
  if (existing?.credentialsMode === 'readonly') {
    console.error(`Account "${id}" uses externally-owned Codex credentials. Repair or re-login with their owner; subtrack refuses to run codex login in that home.`);
    return 2;
  }

  const home = existing?.credentialsHome ?? codexHomeDir(configDir(base), id);
  await mkdir(home, { recursive: true });
  let authenticated = false;
  try { await readCodexAuth(home); authenticated = true; } catch { /* login or repair below */ }

  if (existing || !authenticated) {
    console.log(`\nLaunching: codex login (CODEX_HOME=${home}). Log in as this Codex account.\n`);
    const spec = buildCodexLogin(home);
    const completed = await interactive(spec.cmd, spec.args, spec.env);
    if (!completed) {
      console.error(`Codex login did not complete for ${id}. Re-run the same add-account command to try again.`);
      return 2;
    }
    authenticated = false;
    try { await readCodexAuth(home); authenticated = true; } catch { /* actionable error below */ }
  }
  if (!authenticated) {
    console.error(`No Codex login found in ${home}. Complete the login, then re-run the same add-account command.`);
    return 2;
  }

  const acc: AccountConfig = existing
    ? { ...existing, credentialsHome: home, label: labelFlag ?? existing.label }
    : { id, label: id, provider: 'codex', enabled: true, credentialsHome: home };
  if (!existing) acc.label = labelFlag ?? ((await accountEmail(acc)) || id);
  const next = existing
    ? { ...cfg, accounts: cfg.accounts.map((account) => account.id === id ? acc : account) }
    : addAccount(cfg, acc);
  await saveConfig(next, base);
  console.log(existing ? `Repaired Codex login for ${id} (${acc.label}).` : `Added Codex account ${id} (${acc.label}).`);
  return 0;
}

/**
 * Register a SuperGrok account. grok.com has no CLI login: the only credential is the browser
 * session cookie, pasted once into <home>/cookie.txt by the user. Registration probes the live
 * rate-limits endpoint first, so a bad paste cannot create a permanently-red card; re-running
 * the same add-account command after fixing the file completes it (mirrors Codex onboarding).
 */
export async function registerGrokAccount(base: string, id: string, labelFlag?: string, fetchImpl?: typeof fetch): Promise<number> {
  const cfg = await loadConfig(base);
  if (cfg.accounts.some((a) => a.id === id)) {
    console.error(`Account "${id}" already exists — run \`remove-account ${id}\` first to redo it.`);
    return 2;
  }
  const home = grokHomeDir(configDir(base), id);
  await mkdir(home, { recursive: true });
  let cookie: string;
  try {
    cookie = await readGrokCookie(home);
  } catch {
    console.error('No Grok cookie yet. In a logged-in grok.com browser tab:');
    console.error('  F12 → Network → refresh → click any grok.com request → Request Headers → copy the "cookie" value.');
    console.error(`Paste it into: ${grokCookiePath(home)}`);
    console.error('Then re-run this same add-account command.');
    return 2;
  }
  const acc: AccountConfig = { id, label: labelFlag ?? id, provider: 'grok', enabled: true, credentialsHome: home, credentialsMode: 'readonly' };
  // Live probe: register only a verified cookie. `throttled` still proves auth passed; anything
  // else (rejection, challenge page, unexpected body, network down) refuses so a bad paste can
  // never create a permanently-red card — fixing the file and re-running completes it.
  const probe = await fetchGrokUsage(acc, { readCookie: () => Promise.resolve(cookie), fetchImpl });
  if (probe.status !== 'ok' && probe.status !== 'throttled') {
    console.error(`Grok probe failed (${probe.error ?? probe.status}). Re-copy the cookie from the browser (or retry if this was a network blip) and re-run.`);
    return 2;
  }
  // account.json captures the email once, at registration; it is never refreshed (no write path
  // into the home afterwards). If a different account's cookie is later pasted into cookie.txt,
  // `list` keeps showing this email — redo remove-account/add-account to update it.
  const email = await fetchGrokEmail(cookie, fetchImpl);
  if (email) {
    await writeGrokMeta(home, { email });
    if (!labelFlag) acc.label = email;
  }
  await saveConfig(addAccount(cfg, acc), base);
  console.log(`Added Grok account ${id} (${acc.label}) — cookie is read from ${grokCookiePath(home)} each poll; when it expires, re-copy it there.`);
  return 0;
}

async function cmdAddAccount(base: string, args: ParsedArgs): Promise<number> {
  const id = args.positionals[0];
  const provider = args.flags.provider;
  const labelFlag = typeof args.flags.label === 'string' ? args.flags.label : undefined;
  if (!id || (provider !== 'claude' && provider !== 'codex' && provider !== 'grok')) {
    console.error('Usage: subtrack add-account <id> --provider claude|codex|grok [--label "..."] [--readonly-home <dir>] [--static-token]');
    return 2;
  }
  const readonlyHome = typeof args.flags['readonly-home'] === 'string' ? args.flags['readonly-home'] : undefined;
  const staticToken = args.flags['static-token'] === true;
  if ((readonlyHome || staticToken) && provider !== 'claude') {
    console.error('--readonly-home / --static-token are Claude-only.');
    return 2;
  }
  if (provider === 'codex') return registerCodexAccount(base, id, labelFlag);
  if (provider === 'grok') return registerGrokAccount(base, id, labelFlag);
  const cfg = await loadConfig(base);
  if (cfg.accounts.some((a) => a.id === id)) {
    console.error(`Account "${id}" already exists — run \`remove-account ${id}\` first to redo it.`);
    return 2;
  }
  if (readonlyHome) return registerReadonlyAccount(base, id, readonlyHome, labelFlag);
  if (staticToken) return registerStaticTokenAccount(base, id, await readStdinText(), labelFlag);
  if (provider === 'claude') {
    // Isolated CLAUDE_CONFIG_DIR per account: log Claude Code in HERE so subtrack owns this account's
    // token (separate from the user's main ~/.claude) and can auto-refresh it forever without conflict.
    const home = claudeHomeDir(configDir(base), id!);
    await mkdir(home, { recursive: true });
    // Idempotent: if this home already has a login (e.g. a prior run was Ctrl-C'd before it could
    // register), skip the interactive login and just register what's there.
    let oauth = await readClaudeOauth(home);
    if (!oauth?.accessToken) {
      console.log(`\nLaunching Claude Code with an isolated config (CLAUDE_CONFIG_DIR=${home}).`);
      console.log(`In it: run  /login , sign in as the "${id}" account, then type  /exit  to return.`);
      console.log(`(Use /exit — pressing Ctrl-C cancels onboarding. If that happens, just re-run this command; it resumes.)\n`);
      const spec = buildClaudeLogin(home);
      await runInteractive(spec.cmd, spec.args, spec.env);
      oauth = await readClaudeOauth(home);
    }
    if (!oauth?.accessToken) {
      console.error(`No login credentials found in ${home}. Did you complete /login? Re-run add-account (it resumes).`);
      return 2;
    }
    const acc: AccountConfig = { id: id!, label: id!, provider: 'claude', enabled: true, credentialsHome: home };
    acc.label = labelFlag ?? ((await accountEmail(acc)) || id!); // default the label to the account's email
    await saveConfig(addAccount(cfg, acc), base);
    console.log(`Added Claude account ${id} (${acc.label}) — isolated; subtrack auto-refreshes it (no manual rotation).`);
  }
  return 0;
}

export async function main(argv: string[], base: string = homedir()): Promise<number> {
  const args = parseArgs(argv);
  // One place turns any thrown error (bad config JSON, PowerShell/FS failure, a port already taken)
  // into a clean one-line message + exit 1, instead of an unhandled-rejection stack trace.
  try {
    switch (args.cmd) {
      case 'check': return await cmdCheck(base);
      case 'list': return await cmdList(base);
      case 'remove-account': return await cmdRemove(base, args.positionals[0] ?? '');
      case 'rename': return await cmdRename(base, args.positionals[0] ?? '', args.positionals.slice(1).join(' ') || (typeof args.flags.label === 'string' ? args.flags.label : ''));
      case 'add-account': return await cmdAddAccount(base, args);
      case 'serve': {
        const { serve } = await import('./server.ts');
        const noOpen = args.flags['no-open'] === true || process.env.SUBTRACK_NO_OPEN === '1';
        return await serve(base, { open: !noOpen });
      }
      case 'daemon': { const { runDaemon } = await import('./daemon.ts'); return await runDaemon(base); }
      case 'install': { const { installDaemon } = await import('./install.ts'); return await installDaemon(base); }
      case 'uninstall': { const { uninstallDaemon } = await import('./install.ts'); return await uninstallDaemon(base); }
      case 'start': { const { startDaemon } = await import('./install.ts'); return await startDaemon(base); }
      case 'stop': { const { stopDaemon } = await import('./install.ts'); return await stopDaemon(base); }
      case 'status': { const { daemonStatus } = await import('./install.ts'); return await daemonStatus(base); }
      case 'logs': { const { showLogs } = await import('./install.ts'); return await showLogs(base, Number(args.flags.lines) || 40); }
      default:
        console.log('Commands: serve | check | list | add-account <id> --provider claude|codex|grok | rename <id> "<name>" | remove-account <id>\n         install | uninstall | start | stop | status | logs   (always-on background dashboard)');
        return args.cmd ? 1 : 0;
    }
  } catch (e) {
    console.error(`subtrack ${args.cmd}: ${(e as Error)?.message ?? String(e)}`);
    return 1;
  }
}

// Entry point — robust on Windows (process.argv[1] is a backslashed drive path,
// so a string-built `file://...` URL never equals import.meta.url; use pathToFileURL).
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  // Set exitCode and let the loop drain rather than calling process.exit() abruptly — an abrupt
  // exit while the keyring native module has an open handle trips a libuv assertion on Windows.
  // The .catch() turns any thrown error (e.g. a corrupt accounts.json from loadConfig) into a clean
  // one-line message + exit 1 instead of an unhandled-rejection stack trace.
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((e: unknown) => { console.error((e as Error)?.message ?? String(e)); process.exitCode = 1; });
}
