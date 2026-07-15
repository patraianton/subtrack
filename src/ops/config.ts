import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { configDir } from '../config.ts';
import type { ServiceDef } from './types.ts';

export function servicesPath(base: string = homedir()): string {
  return join(configDir(base), 'services.json');
}

export async function loadServices(base: string = homedir()): Promise<ServiceDef[]> {
  try {
    const raw = await readFile(servicesPath(base), 'utf8');
    const parsed = JSON.parse(raw) as { services?: ServiceDef[] };
    return Array.isArray(parsed.services) ? parsed.services : [];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

export async function saveServices(defs: ServiceDef[], base: string = homedir()): Promise<void> {
  await mkdir(configDir(base), { recursive: true });
  await writeFile(servicesPath(base), JSON.stringify({ version: 1, services: defs }, null, 2), 'utf8');
}
