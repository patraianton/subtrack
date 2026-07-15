import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { configDir } from '../config.ts';
import type { ServiceDef } from './types.ts';

export function servicesPath(base: string = homedir()): string {
  return join(configDir(base), 'services.json');
}

export async function loadServices(base: string = homedir()): Promise<ServiceDef[]> {
  let raw: string;
  try {
    raw = await readFile(servicesPath(base), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const parsed = JSON.parse(raw) as { services?: unknown };
  if (parsed.services === undefined) return [];
  if (!Array.isArray(parsed.services)) throw new Error('services.json is malformed: "services" must be an array');
  return parsed.services as ServiceDef[];
}

export async function saveServices(defs: ServiceDef[], base: string = homedir()): Promise<void> {
  await mkdir(configDir(base), { recursive: true });
  await writeFile(servicesPath(base), JSON.stringify({ version: 1, services: defs }, null, 2), 'utf8');
}
