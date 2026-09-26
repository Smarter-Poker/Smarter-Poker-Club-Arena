/**
 * THE SELF-HOSTED FONT FILE GETS A NAME EVERY FILE SYSTEM ACCEPTS (2026-09-26).
 *
 * `self-host-fonts.mjs` downloads each woff2 the Google stylesheet names into
 * dist/fonts/. A normal URL (https://fonts.gstatic.com/s/inter/v19/xyz.woff2)
 * becomes inter-v19-xyz.woff2, the name the append-only font pool on the
 * origin already holds, so it is kept exactly. But Google sometimes answers
 * with a kit URL instead (https://fonts.gstatic.com/l/font?kit=...&skey=...),
 * and the old rule turned that into a file name full of ':' and '?'. The
 * publish run of 2026-09-26 06:11 UTC (run 36222857383) failed on exactly that:
 * the dist upload refuses such a path. Any URL outside /s/ is now named by a
 * hash of the URL, and every name is reduced to [A-Za-z0-9._-].
 */
import { createHash } from 'node:crypto';

const STATIC_PREFIX = 'https://fonts.gstatic.com/s/';

export function fontFileName(url) {
  if (url.startsWith(STATIC_PREFIX) && !url.includes('?')) {
    const name = url.slice(STATIC_PREFIX.length).split('/').join('-');
    if (/^[A-Za-z0-9._-]+$/.test(name)) return name;
  }
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 20);
  return `gstatic-${hash}.woff2`;
}
