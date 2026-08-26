/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FOOTER CLEARANCE — every page that mounts ClubBottomNav must reserve for it
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ClubBottomNav is `position: fixed; bottom: 0` and is
 * `--bottom-nav-height` (74px) tall PLUS `env(safe-area-inset-bottom)`. A page
 * that renders it without reserving that space at the bottom loses its last row
 * of content underneath the bar - and the loss is invisible on a desktop
 * viewport, which is why it survived so long on seven pages at once.
 *
 * THE BUG THIS EXISTS TO STOP COMING BACK (found 2026-08-25, on seven pages):
 *
 *     padding-bottom: max(70px, env(safe-area-inset-bottom));
 *
 * The bar's height and the inset are ADDITIVE; `max()` picks one or the other.
 * So that line reserved 70px on a flat screen (4px short) and still 70px on a
 * notched phone (short by 74 + inset - 70, about 38px). It reads like a
 * safe-area-aware reservation and is neither.
 *
 * The correct form is the shared token, which is the same value the component
 * pins its own min-height to:
 *
 *     padding-bottom: var(--bottom-nav-clearance, 74px);
 *     padding-bottom: max(var(--bottom-nav-clearance, 74px), env(safe-area-inset-bottom));
 *
 * This test is deliberately a STATIC READ of the source. Mounting each page to
 * measure it would need a real layout engine, and jsdom does not have one.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(__dirname, '..');
const PAGES = join(ROOT, 'src/pages');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Page files that render the bar. */
function pagesMountingTheNav(): string[] {
  return walk(PAGES).filter(
    (f) => f.endsWith('.tsx') && readFileSync(f, 'utf8').includes('<ClubBottomNav')
  );
}

/**
 * The stylesheets a page could be reserving in: its own sibling CSS, plus the
 * shared layout every StandardContentLayout page inherits from.
 */
function stylesheetsFor(pageFile: string): string[] {
  const base = pageFile.replace(/\.tsx$/, '');
  const candidates = [
    `${base}.css`,
    `${base}.module.css`,
    join(ROOT, 'src/components/layouts/StandardContentLayout.module.css'),
  ];
  return candidates.filter((f) => {
    try {
      return statSync(f).isFile();
    } catch {
      return false;
    }
  });
}

describe('every page that mounts ClubBottomNav reserves space for it', () => {
  const pages = pagesMountingTheNav();

  it('finds the pages at all (a rename must not silently empty this suite)', () => {
    expect(pages.length).toBeGreaterThan(15);
  });

  it.each(pages.map((p) => [p.slice(ROOT.length + 1), p]))(
    '%s reserves the bottom-nav clearance',
    (_label, file) => {
      const css = stylesheetsFor(file as string)
        .map((f) => readFileSync(f, 'utf8'))
        .join('\n');
      expect(css).toMatch(/padding-bottom:[^;]*--bottom-nav-clearance/);
    }
  );

  /**
   * Scoped to the stylesheets of pages that actually mount the bar. The same
   * `max(70px, env(...))` line appears on plenty of pages that have no footer
   * at all - there it reserves nothing that matters, and widening it to the
   * nav clearance would only add dead space at the bottom of those screens.
   */
  it('no page that mounts the nav still uses the max(70px, env(...)) reservation', () => {
    const offenders = [...new Set(pages.flatMap(stylesheetsFor))]
      .filter((f) => /padding-bottom:\s*max\(\s*70px\s*,\s*env\(/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(ROOT.length + 1));
    expect(offenders).toEqual([]);
  });
});
