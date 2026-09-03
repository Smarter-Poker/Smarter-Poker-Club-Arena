import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ONE LIST, ONE GRID (binding)
 *
 * The rake snapshot renders three breakdowns through the same <li>, and they
 * do not have the same number of cells:
 *
 *   union scope   4   name, bar, fee, share
 *   downline      5   name, count, bar, rake, their own downline
 *   agents        6   name, players, bar, direct, network, cost
 *
 * Each phase that added a column appended another unconditional
 * `.breakdown li { grid-template-columns: ... }` to the end of this stylesheet.
 * CSS takes the last one, so whichever phase shipped most recently governed all
 * three lists - the club list had been laid into the agent list's grid ever
 * since the agent breakdown was added, and Phase 5 widened it again to six.
 *
 * NOTHING ERRORS WHEN THIS HAPPENS. Extra columns are simply empty and the real
 * cells are squeezed; a screenshot looks slightly wrong and no test fails. That
 * is precisely why it survived two phases and needs a law rather than care.
 *
 * The rule: the shared element declares no column count at all, and each list
 * declares its own through a class that names it.
 */

const CSS = readFileSync(
  resolve(__dirname, '../src/components/club/RakeSnapshotPanel.module.css'),
  'utf8'
);

/** Rule bodies for a selector, at the top level and inside media queries. */
function bodiesFor(selector: string): string[] {
  const out: string[] = [];
  const needle = `${selector} {`;
  let i = CSS.indexOf(needle);
  while (i !== -1) {
    const end = CSS.indexOf('}', i);
    out.push(CSS.slice(i, end === -1 ? undefined : end));
    i = CSS.indexOf(needle, i + 1);
  }
  return out;
}

describe('one list, one grid', () => {
  it('the shared row element declares no column count', () => {
    const offenders = bodiesFor('.breakdown li').filter((b) => b.includes('grid-template-columns'));
    expect(
      offenders,
      `.breakdown li must not set columns - three lists share it:\n${offenders.join('\n---\n')}`
    ).toEqual([]);
  });

  it.each(['.listClub li', '.listAgent li', '.listDownline li'])(
    '%s declares its own column count exactly once per breakpoint',
    (sel) => {
      const withGrid = bodiesFor(sel).filter((b) => b.includes('grid-template-columns'));
      expect(withGrid.length, `${sel} never sets its own columns`).toBeGreaterThan(0);
      // One at the top level and at most one per media query. More than two is
      // the accumulation pattern starting again.
      expect(withGrid.length, `${sel} has ${withGrid.length} column rules`).toBeLessThanOrEqual(2);
    }
  );

  it('the agent grid has one column per cell the agent row renders', () => {
    const tsx = readFileSync(
      resolve(__dirname, '../src/components/club/RakeSnapshotPanel.tsx'),
      'utf8'
    );
    const start = tsx.indexOf("kind === 'agent' && rows.length");
    expect(start).toBeGreaterThan(-1);
    const end = tsx.indexOf('rowNote', start);
    const block = tsx.slice(start, end);
    const cells = (block.match(/className={styles\.row[A-Z]\w*}/g) || []).length;

    const rule = bodiesFor('.listAgent li').find((b) => b.includes('grid-template-columns'))!;
    const cols = rule
      .slice(rule.indexOf('grid-template-columns'))
      .split(':')[1]
      .split(/\s+(?![^(]*\))/)
      .filter(Boolean).length;

    expect(cols, `agent row renders ${cells} cells into ${cols} columns`).toBe(cells);
  });

  it('the legend is declared once, not once per phase', () => {
    const legends = bodiesFor('.legend').filter((b) => b.includes('grid-template-columns'));
    expect(legends.length, 'two .legend grids is the same accumulation bug').toBe(1);
  });
});
