import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { ModeMark, WindowMode } from './types.ts';

/** Same file the `ccmode` shell function writes and both window watchdogs read. */
export function modesPath(base: string): string {
  return join(base, '.claude', 'idle-handover', 'window-modes.json');
}

const MODES: readonly WindowMode[] = ['ever', 'warm', 'off'];

export function isWindowMode(v: unknown): v is WindowMode {
  return typeof v === 'string' && (MODES as readonly string[]).includes(v);
}

/** Windows paths are compared without a trailing separator, exactly as ccmode trims them. */
export function normalizeCwd(cwd: string | null | undefined): string {
  return String(cwd ?? '').replace(/[\\/]+$/, '');
}

/**
 * PowerShell's ConvertTo-Json collapses a one-element array to a bare object and Set-Content
 * -Encoding UTF8 prefixes a BOM, so both shapes have to parse. Anything unrecognised is dropped
 * rather than thrown: a corrupt marks file must not take the page down.
 */
export function parseMarks(raw: string): ModeMark[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw.replace(/^﻿/, '') || '[]'); } catch { return []; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const out: ModeMark[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Partial<ModeMark>;
    if (!isWindowMode(r.mode)) continue;
    out.push({
      cwd: normalizeCwd(r.cwd),
      pane: r.pane ? String(r.pane) : null,
      mode: r.mode,
      set: typeof r.set === 'string' ? r.set : '',
    });
  }
  return out;
}

export async function readMarks(base: string): Promise<ModeMark[]> {
  try { return parseMarks(await readFile(modesPath(base), 'utf8')); }
  catch { return []; }
}

export async function writeMarks(base: string, marks: ModeMark[]): Promise<void> {
  const file = modesPath(base);
  await mkdir(dirname(file), { recursive: true });
  // Always an array (never PowerShell's single-object collapse) and no BOM: both PowerShell
  // readers use -Encoding UTF8, which reads a BOM-less file correctly.
  await writeFile(file, JSON.stringify(marks, null, 2), 'utf8');
}

/** Local 'yyyy-MM-dd HH:mm' — the stamp format ccmode writes into `set`. */
export function stamp(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
}

/**
 * Replace this window's mark, mirroring ccmode: a pane-keyed mark owns the pane, and a
 * folder-keyed mark (no pane) owns every paneless window of that folder. 'auto' just removes.
 */
export function applyMode(
  marks: ModeMark[],
  opts: { pane: string | null; cwd: string; mode: WindowMode | 'auto'; now: Date },
): ModeMark[] {
  const pane = opts.pane || null;
  const cwd = normalizeCwd(opts.cwd);
  const kept = marks.filter((m) => !(pane ? m.pane === pane : (!m.pane && m.cwd === cwd)));
  if (opts.mode === 'auto') return kept;
  return [...kept, { cwd, pane, mode: opts.mode, set: stamp(opts.now) }];
}

/** The mark that applies to a window: an exact pane mark wins over a folder-wide one. */
export function markFor(marks: ModeMark[], pane: string, cwd: string): { mark: ModeMark; scope: 'pane' | 'folder' } | null {
  const byPane = marks.find((m) => m.pane && m.pane === pane);
  if (byPane) return { mark: byPane, scope: 'pane' };
  const folder = normalizeCwd(cwd);
  const byCwd = marks.find((m) => !m.pane && m.cwd === folder);
  return byCwd ? { mark: byCwd, scope: 'folder' } : null;
}
