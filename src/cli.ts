import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { AccountConfig, NormalizedUsage } from './types.ts';
import { loadConfig, saveConfig, addAccount, removeAccount, configDir } from './config.ts';
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

async function cmdList(base: string): Promise<number> {
  const cfg = await loadConfig(base);
  for (const a of cfg.accounts) {
    console.log(`${a.enabled ? '●' : '○'} ${a.id.padEnd(20)} ${a.provider.padEnd(7)} ${a.label}`);
  }
  return 0;
}

async function cmdRemove(base: string, id: string): Promise<number> {
  const cfg = await loadConfig(base);
  await saveConfig(removeAccount(cfg, id), base);
  console.log(`Removed ${id}`);
  return 0;
}

async function cmdAddAccount(base: string, args: ParsedArgs): Promise<number> {
  const id = args.positionals[0];
  const provider = args.flags.provider;
  const label = typeof args.flags.label === 'string' ? args.flags.label : id;
  if (!id || (provider !== 'claude' && provider !== 'codex')) {
    console.error('Usage: subtrack add-account <id> --provider claude|codex [--label "..."]');
    return 2;
  }
  const cfg = await loadConfig(base);
  if (provider === 'claude') {
    // Isolated CLAUDE_CONFIG_DIR per account: log Claude Code in HERE so subtrack owns this account's
    // token (separate from the user's main ~/.claude) and can auto-refresh it forever without conflict.
    const home = claudeHomeDir(configDir(base), id!);
    await mkdir(home, { recursive: true });
    console.log(`\nLaunching Claude Code with an isolated config (CLAUDE_CONFIG_DIR=${home}).`);
    console.log(`In it: run  /login , sign in as the "${id}" account, then  /exit  (or Ctrl-C). subtrack will own this token.\n`);
    const spec = buildClaudeLogin(home);
    await runInteractive(spec.cmd, spec.args, spec.env);
    const oauth = await readClaudeOauth(home);
    if (!oauth?.accessToken) {
      console.error(`No login credentials found in ${home}. Did you complete /login? Re-run add-account.`);
      return 2;
    }
    const acc: AccountConfig = { id: id!, label: label!, provider: 'claude', enabled: true, credentialsHome: home };
    await saveConfig(addAccount(cfg, acc), base);
    console.log(`Added Claude account ${id} — isolated; subtrack auto-refreshes it (no manual rotation).`);
  } else {
    const home = codexHomeDir(configDir(base), id!);
    await mkdir(home, { recursive: true });
    console.log(`\nLaunching: codex login (CODEX_HOME=${home}). Log in as this Codex account.\n`);
    const spec = buildCodexLogin(home);
    await runInteractive(spec.cmd, spec.args, spec.env);
    const acc: AccountConfig = { id: id!, label: label!, provider: 'codex', enabled: true, credentialsHome: home };
    await saveConfig(addAccount(cfg, acc), base);
    console.log(`Added Codex account ${id}.`);
  }
  return 0;
}

export async function main(argv: string[], base: string = homedir()): Promise<number> {
  const args = parseArgs(argv);
  switch (args.cmd) {
    case 'check': return cmdCheck(base);
    case 'list': return cmdList(base);
    case 'remove-account': return cmdRemove(base, args.positionals[0] ?? '');
    case 'add-account': return cmdAddAccount(base, args);
    case 'serve': { const { serve } = await import('./server.ts'); return serve(base); }
    default:
      console.log('Commands: serve | check | list | add-account <id> --provider claude|codex | remove-account <id>');
      return args.cmd ? 1 : 0;
  }
}

// Entry point — robust on Windows (process.argv[1] is a backslashed drive path,
// so a string-built `file://...` URL never equals import.meta.url; use pathToFileURL).
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  // Set exitCode and let the loop drain rather than calling process.exit() abruptly — an abrupt
  // exit while the keyring native module has an open handle trips a libuv assertion on Windows.
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
