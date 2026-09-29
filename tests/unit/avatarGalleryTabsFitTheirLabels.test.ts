/**
 * EVERY AVATAR GALLERY TAB IS AS WIDE AS ITS LABEL (2026-09-29).
 *
 * Found on the Android emulator, a 393px-wide phone: "PRESETS (25)" ran into
 * "VIP (72)". The tab bar split its width into four equal columns
 * (`repeat(4, minmax(74px, 1fr))`) and every label is `white-space: nowrap`,
 * so a label wider than a quarter of the bar spilled into its neighbour.
 * Measured in the app with a Range over each label: PRESETS' glyphs ended at
 * x=119 inside a tab ending at x=99. With every column at least as wide as
 * its label (`minmax(max-content, 1fr)`) the tabs measure 124, 89, 89 and 89,
 * no label overflows, and the bar still fits the screen. A screen too narrow
 * for all four scrolls the bar sideways (it already has overflow-x: auto)
 * instead of printing one label over another.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CSS = readFileSync(
  resolve(__dirname, '../../src/components/customization/AvatarGallery.css'),
  'utf8'
).replace(/\/\*[\s\S]*?\*\//g, '');

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(CSS);
  if (!m) throw new Error(`AvatarGallery.css has no ${selector} rule`);
  return m[2];
}

const CONTENT_SIZED = 'repeat(4, minmax(max-content, 1fr))';

describe('avatar gallery tabs', () => {
  it('size every column to at least its label, so no label runs into the next tab', () => {
    expect(rule('.ag-tabs')).toMatch(
      /grid-template-columns:\s*repeat\(4,\s*minmax\(max-content,\s*1fr\)\)/
    );
  });

  it('keep each label on one line and let the bar scroll rather than overlap', () => {
    expect(rule('.ag-tab')).toMatch(/white-space:\s*nowrap/);
    expect(rule('.ag-tabs')).toMatch(/overflow-x:\s*auto/);
  });

  it('no other rule for the bar puts a fixed-width column back', () => {
    const blocks = [...CSS.matchAll(/\.ag-tabs\b[^{]*\{([^}]*)\}/g)].map((m) => m[1]);
    const columns = blocks.flatMap((b) =>
      [...b.matchAll(/grid-template-columns:\s*([^;]+);/g)].map((m) => m[1].trim())
    );
    expect(columns.length).toBeGreaterThan(0);
    for (const c of columns) expect(c).toBe(CONTENT_SIZED);
  });
});
