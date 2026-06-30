import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AccountConfig, NormalizedUsage } from './types.ts';
import { loadConfig, saveConfig, addAccount, removeAccount, configDir } from './config.ts';
import { defaultSecretStore } from './secrets.ts';
import { ClaudeAuth, claudeCredKey } from './auth/claude.ts';
import { codexHomeDir, buildCodexLogin } from './auth/codex.ts';
import { makeFetchUsage } from './adapters/index.ts';

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
  const fetchUsage = makeFetchUsage({ claudeAuth: new ClaudeAuth(defaultSecretStore()) });
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
    // Capture the credentials Claude Code wrote after `claude /login` for the currently active account.
    // (A bare `claude setup-token` lacks the user:profile scope and 403s on /api/oauth/usage; the
    //  /login token — same sk-ant-oat01- prefix — carries user:profile and a refresh token.)
    const credPath = join(homedir(), '.claude', '.credentials.json');
    let oauth: { accessToken?: string; refreshToken?: string; expiresAt?: number; scopes?: string[] } | undefined;
    try {
      oauth = (JSON.parse(await readFile(credPath, 'utf8')) as { claudeAiOauth?: typeof oauth }).claudeAiOauth;
    } catch {
      console.error(`Could not read ${credPath}. In Claude Code, run \`claude /login\` as the "${id}" account first, then re-run this.`);
      return 2;
    }
    if (!oauth?.accessToken) {
      console.error(`No Claude login token in ${credPath}. Run \`claude /login\` (as the "${id}" account) first.`);
      return 2;
    }
    const creds = {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken ?? '',
      expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : Date.now() + 8 * 60 * 60 * 1000,
      scopes: oauth.scopes ?? [],
    };
    await defaultSecretStore().set(claudeCredKey(id!), JSON.stringify(creds));
    const acc: AccountConfig = { id: id!, label: label!, provider: 'claude', enabled: true, credentialKey: claudeCredKey(id!) };
    await saveConfig(addAccount(cfg, acc), base);
    console.log(`Added Claude account ${id} — captured the current \`claude /login\` credentials.`);
  } else {
    const home = codexHomeDir(configDir(base), id!);
    await mkdir(home, { recursive: true });
    console.log(`\nLaunching: codex login (CODEX_HOME=${home}). Log in as this Codex account.\n`);
    const spec = buildCodexLogin(home);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(spec.cmd, spec.args, { stdio: 'inherit', env: { ...process.env, ...spec.env }, shell: true });
      child.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`codex login exited ${c}`))));
      child.on('error', reject);
    });
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
