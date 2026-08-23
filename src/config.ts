import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import type { SubtrackConfig, AccountConfig } from './types.ts';

export const DEFAULT_CONFIG: SubtrackConfig = {
  version: 1,
  port: 7777,
  uiRefreshSeconds: 30,
  pollIntervalSeconds: { claude: 180, codex: 60, grok: 60 },
  accounts: [],
};

export function configDir(base: string = homedir()): string {
  return join(base, '.subtrack');
}

export function configPath(base: string = homedir()): string {
  return join(configDir(base), 'accounts.json');
}

export async function loadConfig(base: string = homedir()): Promise<SubtrackConfig> {
  try {
    const raw = await readFile(configPath(base), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SubtrackConfig>;
    return { ...DEFAULT_CONFIG, ...parsed, pollIntervalSeconds: { ...DEFAULT_CONFIG.pollIntervalSeconds, ...parsed.pollIntervalSeconds }, accounts: parsed.accounts ?? [] };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_CONFIG, pollIntervalSeconds: { ...DEFAULT_CONFIG.pollIntervalSeconds } };
    throw e;
  }
}

export async function saveConfig(cfg: SubtrackConfig, base: string = homedir()): Promise<void> {
  await mkdir(configDir(base), { recursive: true });
  await writeFile(configPath(base), JSON.stringify(cfg, null, 2), 'utf8');
}

export function addAccount(cfg: SubtrackConfig, acc: AccountConfig): SubtrackConfig {
  if (cfg.accounts.some((a) => a.id === acc.id)) {
    throw new Error(`Account "${acc.id}" already exists`);
  }
  return { ...cfg, accounts: [...cfg.accounts, acc] };
}

export function removeAccount(cfg: SubtrackConfig, id: string): SubtrackConfig {
  return { ...cfg, accounts: cfg.accounts.filter((a) => a.id !== id) };
}

export function renameAccount(cfg: SubtrackConfig, id: string, label: string): SubtrackConfig {
  return { ...cfg, accounts: cfg.accounts.map((a) => (a.id === id ? { ...a, label } : a)) };
}
