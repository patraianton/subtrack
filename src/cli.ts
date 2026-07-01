import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AccountConfig, NormalizedUsage } from './types.ts';
import { loadConfig, saveConfig, addAccount, removeAccount, renameAccount, configDir } from './config.ts';
import { claudeHomeDir, buildClaudeLogin, readClaudeOauth } from './auth/claude.ts';
import { codexHomeDir, buildCodexLogin } from './auth/codex.ts';
import { makeFetchUsage } from './adapters/index.ts';

/** Spawn an interactive child (stdio inherited) and resolve when it exits. */
function runInteractive(cmd: string, args: string[], env: Record<string, string>): Promise<void> {
  return new Promise<void>((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env }, shell: true });
    child.on('exit', () => resolve());
    child.on('error', () => resolve());
  });
}

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
    return `${u.label.padEnd(24)} ${u.provider.padEnd(7)} session ${pct(u.session).padStart(4)}  weekly ${pct(u.weekly).padStart(4)}${status}`;
  });
  return ['ACCOUNT                  PROVIDER SESSION       WEEKLY', ...rows].join('\n');
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

async function cmdAddAccount(base: string, args: ParsedArgs): Promise<number> {
  const id = args.positionals[0];
  const provider = args.flags.provider;
  const labelFlag = typeof args.flags.label === 'string' ? args.flags.label : undefined;
  if (!id || (provider !== 'claude' && provider !== 'codex')) {
    console.error('Usage: subtrack add-account <id> --provider claude|codex [--label "..."]');
    return 2;
  }
  const cfg = await loadConfig(base);
  if (cfg.accounts.some((a) => a.id === id)) {
    console.error(`Account "${id}" already exists — run \`remove-account ${id}\` first to redo it.`);
    return 2;
  }
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
  } else {
    const home = codexHomeDir(configDir(base), id!);
    await mkdir(home, { recursive: true });
    console.log(`\nLaunching: codex login (CODEX_HOME=${home}). Log in as this Codex account.\n`);
    const spec = buildCodexLogin(home);
    await runInteractive(spec.cmd, spec.args, spec.env);
    const acc: AccountConfig = { id: id!, label: id!, provider: 'codex', enabled: true, credentialsHome: home };
    acc.label = labelFlag ?? ((await accountEmail(acc)) || id!); // default the label to the account's email
    await saveConfig(addAccount(cfg, acc), base);
    console.log(`Added Codex account ${id} (${acc.label}).`);
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
        console.log('Commands: serve | check | list | add-account <id> --provider claude|codex | rename <id> "<name>" | remove-account <id>\n         install | uninstall | start | stop | status | logs   (always-on background dashboard)');
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
