/**
 * THE MULTI-TABLE PROFIT CHIP NEEDS TWO CASH TABLES (Dan 2026-09-23)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "THE MULTI TABLE PROFIT/LOSS COUNTER SHOULD ONLY APPEAR WHEN 2 OR MORE CASH
 * GAMES ARE BEING PLAYED, NOT A MTT AND CASH GAME, OR JUST ONE CASH GAME."
 *
 * The gate counted every game table toward "multiple" and only afterwards
 * dropped tournaments from the sum, so an MTT beside one cash table passed as
 * two tables and printed a "0" chip for the one cash table. Both counts - the
 * effect's gate and compute()'s re-check between ticks - are cash counts now.
 * The rule is pinned at the source because it is two lines of a 5,000-line
 * page, and a render of that page is not what this test is for.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE = readFileSync(resolve(__dirname, '../../src/pages/MultiTablePage.tsx'), 'utf8');
const code = PAGE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the profit chip gate', () => {
  it('counts CASH tables, twice, and needs two of them', () => {
    expect(code).toContain(
      'const liveCashCount = tables.filter((t) => isTableTab(t) && !t.isTournament).length;'
    );
    expect(code).toContain('if (hidden || liveCashCount < 2 || !profitTracking) {');
    expect(code).toContain(
      'const live = tablesRef.current.filter((t) => isTableTab(t) && !t.isTournament);'
    );
    expect(code).toContain('if (live.length < 2) {');
  });

  it('no count of every game table gates it any more', () => {
    // The profit effect is the block between these two lines; the body's
    // data-ca-live-tables attribute keeps its own all-tables count elsewhere.
    const effect = code.slice(
      code.indexOf('const liveCashCount'),
      code.indexOf('const iv = setInterval(compute')
    );
    expect(effect).not.toContain('liveTableCount');
    expect(effect).not.toMatch(/filter\(\(t\) => isTableTab\(t\)\)\.length/);
  });
});
