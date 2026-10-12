/**
 * LAW - THE DIAMOND ARENA IS BLACK, THE SAME AS THE CLUB ARENA
 *
 * Dan, 2026-10-12: "ALL OF THE WHITE OF THE DIAMOND ARENA BACKGROUND SHOULD BE
 * BLACK AND LOOK JUST LIKE THE CLUB ARENA." This retires 2026-09-11's light
 * room ("DIAMOND ARENA SHOULD BE WHITE, OR LIGHT SCHEMA"), which painted the
 * arena's ground, plates and panels white through a `data-arena-scheme`
 * attribute on `<html>`. The latest owner instruction wins, so the attribute,
 * its writer and every block keyed on it are gone, and this law keeps any of
 * them from coming back from a stale branch.
 *
 * And the footer: "THE FOOTER NEEDS THE IMAGES LIKE THE CLUB ARENA, NOT JUST
 * WORDS." The Diamond bar paints its doors in its art (v2), as the chip bar
 * does, and prints nothing over it.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const at = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(css|ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe('LAW - the Diamond Arena is black like the Club Arena', () => {
  it('no source keeps a light room for the arena', () => {
    const offenders = walk(join(ROOT, 'src')).filter((file) =>
      /data-arena-scheme|ARENA_SCHEME_LIGHT|arenaSchemeFor/.test(readFileSync(file, 'utf8'))
    );
    expect(offenders.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
    expect(existsSync(join(ROOT, 'src/lib/arenaScheme.ts'))).toBe(false);
  });

  it('the page ground is the one black body rule, for every room', () => {
    expect(at('src/styles/club-engine.css')).not.toMatch(/\[data-arena-scheme=/);
    expect(at('src/pages/ClubHomePage.css')).not.toMatch(/\[data-arena-scheme=/);
  });

  it('the Diamond footer paints its doors in the art and prints nothing over it', () => {
    const nav = at('src/components/arena/DiamondBottomNav.tsx');
    expect(nav).toContain('images/club-footer/diamond-arena-footer-v2.webp');
    expect(nav).not.toContain('useFitText');
    expect(existsSync(join(ROOT, 'public/images/club-footer/diamond-arena-footer-v2.webp'))).toBe(
      true
    );
    expect(at('src/components/arena/DiamondBottomNav.module.css')).not.toMatch(/\.label\s*\{/);
  });
});
