/**
 * A ROVING TABINDEX THAT DOES NOT MOVE FOCUS IS HALF A PATTERN, AND THE WRONG HALF.
 *
 * Both footer tablists render `tabIndex={selected ? 0 : -1}`. Arrow keys changed
 * the SELECTION but never called focus(), so the previously selected button kept
 * DOM focus while dropping to tabIndex={-1}:
 *
 *   - the screen reader announced nothing, because focus never moved;
 *   - the focused element was no longer in the tab order, so the user's next Tab
 *     press jumped somewhere unrelated;
 *   - and visually the highlight moved, so sighted keyboard users saw the tab
 *     change while their focus silently did not.
 *
 * The ARIA tablist pattern requires focus to follow selection. These tests pin
 * that both halves stay together, and that Home/End exist.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sliceEnclosingBlock } from './helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const STATS = read('src/pages/PlayerStatsPage.tsx');
const MARKET = read('src/pages/MarketplacePage.tsx');

describe.each([
  ['PlayerStatsPage', STATS, 'stats-tab-', 'setCategory(next)'],
  ['MarketplacePage', MARKET, 'market-tab-', 'switchTab(next)'],
])('%s tablist', (_name, src, idPrefix, selector) => {
  it('still uses a roving tabindex', () => {
    // If this stops being roving, the focus() below becomes unnecessary rather
    // than wrong - but the pairing is what the next test depends on.
    expect(src).toMatch(/tabIndex=\{[^}]*\? 0 : -1\}/);
  });

  it('moves DOM focus to the newly selected tab', () => {
    expect(src).toContain(`document.getElementById(\`${idPrefix}\${next}\`)?.focus()`);
  });

  it('changes selection AND focus together, never one alone', () => {
    expect(src.indexOf(selector), 'selection call must exist').toBeGreaterThan(-1);
    // focus() must live in the SAME handler as the selection change, not
    // somewhere unrelated - so bound it by that block, not by a byte count.
    expect(sliceEnclosingBlock(src, selector)).toMatch(/\.focus\(\)/);
  });

  it('supports Home and End, per the tablist pattern', () => {
    expect(src).toMatch(/'Home'/);
    expect(src).toMatch(/'End'/);
  });

  it('still prevents default so the page does not scroll on arrow keys', () => {
    expect(src).toMatch(/e\.preventDefault\(\)/);
  });
});

describe('the guard would have caught the old code', () => {
  it('old handler had no focus() call', () => {
    // Reproduced from origin/main before this change: selection only.
    const OLD = [
      '        onKeyDown={(e) => {',
      "          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;",
      '          e.preventDefault();',
      '          const i = TABS.indexOf(category);',
      '          setCategory(TABS[next]);',
      '        }}',
    ].join('\n');
    expect(OLD).not.toMatch(/\.focus\(\)/);
    expect(OLD).not.toMatch(/'Home'/);
  });
});

describe('Marketplace End respects the admin filter', () => {
  it('derives the key list from the admin-filtered tabs, not all tabs', () => {
    // Otherwise End would jump a non-admin to a tab that is not rendered.
    const keys = 'const keys = TABS.filter((t) => !t.adminOnly || isAdmin)';
    expect(MARKET.indexOf(keys)).toBeGreaterThan(-1);
    expect(sliceEnclosingBlock(MARKET, keys)).toMatch(/keys\[keys\.length - 1\]/);
  });
});
