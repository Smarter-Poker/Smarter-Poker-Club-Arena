/**
 * LAW: A PUBLIC ASSET URL NAMES A FILE THAT SHIPS.
 *
 * GSC fix, 2026-09-22. Production logs showed 228 requests in three days for
 * https://smarter.poker/assets/club-buttons/wallet-row-shell.webp, a 404 on
 * the World Hub root. #4704 renamed public/assets/club-buttons/
 * wallet-row-shell.webp to its sealed name wallet-row-shell-e7964bb1791f.webp
 * and left three stylesheets (VIPMembershipPlate.css, VIPPage.css,
 * MarketplacePage.module.css) pointing at the old name. Vite rewrites a
 * root-absolute url() to the /hub/club-arena/ base only when the file exists
 * in public/; for a missing file it leaves the path as written, so the
 * browser asked the World Hub root for it, and the VIP plate and the
 * Marketplace rows lost their shell.
 *
 * Every url('/...') in a stylesheet or component under src/, every literal
 * mediaUrl('...') and every literal src/href/srcSet="/..." attribute that
 * names a file must resolve to a file in public/. Template paths (${...})
 * are runtime choices and are not checked here.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const WEB_BASE = '/hub/club-arena';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(css|tsx|ts|jsx|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** The public-asset paths a source file names literally, comments removed. */
export function publicAssetReferences(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const found: string[] = [];
  for (const m of code.matchAll(/url\(\s*['"]?(\/[^'")\s]+)/g)) found.push(m[1]);
  for (const m of code.matchAll(/mediaUrl\(\s*['"]([^'"`$]+)['"]/g)) {
    found.push(`/${m[1].replace(/^\/+/, '')}`);
  }
  for (const m of code.matchAll(/(?:src|href|srcSet)="(\/[^"{}]+)"/g)) found.push(m[1]);
  return found
    .filter((p) => !p.includes('${') && !p.includes('<'))
    .map((p) => p.split('?')[0].split('#')[0])
    .map((p) => (p.startsWith(`${WEB_BASE}/`) ? p.slice(WEB_BASE.length) : p))
    .filter((p) => /\.[a-z0-9]{2,5}$/i.test(p));
}

describe('a public asset url names a file that ships', () => {
  it('finds the reference form that shipped the 404', () => {
    const css =
      ".plate { background: #03070b url('/assets/club-buttons/wallet-row-shell.webp') center; }";
    expect(publicAssetReferences(css)).toEqual(['/assets/club-buttons/wallet-row-shell.webp']);
    expect(existsSync(join(ROOT, 'public/assets/club-buttons/wallet-row-shell.webp'))).toBe(false);
    expect(
      publicAssetReferences('<img src={mediaUrl(\'assets/a.webp\')} /> <link href="/b.png" />')
    ).toEqual(['/assets/a.webp', '/b.png']);
    expect(publicAssetReferences("/* url('/gone.webp') */ const u = `${base}/x.webp`;")).toEqual(
      []
    );
  });

  it('every literal public asset reference under src/ resolves to a file in public/', () => {
    const missing: string[] = [];
    for (const file of sourceFiles(join(ROOT, 'src'))) {
      for (const ref of publicAssetReferences(readFileSync(file, 'utf8'))) {
        if (!existsSync(join(ROOT, 'public', ref))) {
          missing.push(`${file.slice(ROOT.length + 1)} -> ${ref}`);
        }
      }
    }
    expect(
      missing,
      'these url()/mediaUrl()/src references name files public/ does not ship'
    ).toEqual([]);
  });

  it('the wallet row shell points at its sealed file', () => {
    for (const file of [
      'src/components/vip/VIPMembershipPlate.css',
      'src/pages/VIPPage.css',
      'src/pages/MarketplacePage.module.css',
    ]) {
      const css = readFileSync(join(ROOT, file), 'utf8');
      expect(css, file).toContain('/assets/club-buttons/wallet-row-shell-e7964bb1791f.webp');
      expect(css, file).not.toContain('/assets/club-buttons/wallet-row-shell.webp');
    }
  });
});
