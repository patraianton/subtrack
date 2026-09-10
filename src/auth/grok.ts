import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function grokHomeDir(base: string, id: string): string {
  return join(base, 'grok-homes', id);
}

export function grokCookiePath(home: string): string {
  return join(home, 'cookie.txt');
}

/**
 * cookie.txt holds the raw Cookie header value copied from a logged-in grok.com browser tab
 * (DevTools → Network → any grok.com request → Request Headers → cookie). grok.com has no CLI
 * login, so the browser session cookie is the only credential. The home is read-only by
 * construction: subtrack never refreshes or rewrites the cookie — when grok.com rejects it,
 * the card goes auth_error and the user re-copies the value from the browser.
 */
export async function readGrokCookie(home: string): Promise<string> {
  const p = grokCookiePath(home);
  let buf: Buffer;
  try {
    buf = await readFile(p);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Grok cookie missing — copy the Cookie header from a logged-in grok.com tab into ${p}`);
    }
    throw error;
  }
  // PowerShell 5.1 Out-File writes UTF-16LE by default; decoded as UTF-8 that passes the non-empty
  // check but sends a NUL-laced header value that undici rejects with an opaque error. Detect and
  // decode it instead of failing later.
  const utf16 = (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) || buf.includes(0);
  const raw = utf16 ? buf.toString('utf16le') : buf.toString('utf8');
  // Tolerate how the value actually arrives from a manual paste: a BOM from Notepad,
  // a copied "Cookie:" prefix, and editor-introduced line wraps inside one header value.
  const cookie = raw.replace(/^﻿/, '').replace(/^\s*cookie:\s*/i, '').replace(/\s*\r?\n\s*/g, ' ').trim();
  if (!cookie) throw new Error(`Grok cookie file is empty — paste the Cookie header value into ${p}`);
  return cookie;
}

export interface GrokMeta { email?: string }

const META_FILE = 'account.json';

/** Best-effort registration-time metadata (account email for labels/list) — never credentials. */
export async function readGrokMeta(home: string): Promise<GrokMeta> {
  try {
    return JSON.parse(await readFile(join(home, META_FILE), 'utf8')) as GrokMeta;
  } catch {
    return {};
  }
}

export async function writeGrokMeta(home: string, meta: GrokMeta): Promise<void> {
  await writeFile(join(home, META_FILE), JSON.stringify(meta, null, 2), 'utf8');
}
