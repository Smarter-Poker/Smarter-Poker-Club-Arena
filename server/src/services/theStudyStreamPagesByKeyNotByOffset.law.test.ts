/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE STUDY STREAM PAGES BY KEY, NOT BY OFFSET (2026-09-28)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The self-tuner streams the study window out of `hand_history` newest first.
 * It has had two paging bugs, and this law holds both fixed at once, because
 * the obvious repair for either one reintroduces the other.
 *
 * ── BUG 1: THE PAGE THAT SKIPS ROWS (V12.3) ───────────────────────────────
 *
 * It paged with `.lt('created_at', before)`. `created_at` is not unique — the
 * fleet writes several hands per second and inserts are batched — so every row
 * that shared the page-boundary timestamp and did not fit in the page was
 * stepped over and never read.
 *
 * ── BUG 2: THE PAGE THAT RE-READS EVERY PAGE BEFORE IT (this fix) ─────────
 *
 * V12.3's remedy was a stable sort plus `range()`. That is correct and also
 * quadratic: OFFSET does not seek, it counts, so page N re-walks and
 * re-filters every row of pages 0..N-1 — and this scan throws away tournament
 * hands one row at a time, so the cost per page grows both with the offset and
 * with how far the fleet has tilted towards tournaments.
 *
 * Measured on production, this exact query, 7-day window:
 *
 *     OFFSET 0           12 ms
 *     OFFSET 119,000     96,190 ms   1,029,222 rows removed by filter
 *     keyset, same depth     16 ms      10,114 rows removed by filter
 *
 * MAX_HANDS_TO_STUDY is 120,000 at PAGE_SIZE 1,000, so the study's last pages
 * sat at exactly that depth. PostgREST's statement timeout is far below 96 s:
 * the page errored, the error was thrown out of `runSelfTune`, and the night
 * ended before `prepareHorseTunerStudy` had written anything.
 *
 * What that cost, measured the same day: `horse_tuner_study_rosters`,
 * `horse_tuner_write_receipts` and `horse_tuner_study_completions` all stop
 * dead at 2026-09-25 08:10, while `horse_job_runs` shows the nightly job
 * claiming - and stale-claim taking over - its slot on 09-26, 09-27 and 09-28.
 * 684 horses were over the 300-hand bar the whole time. Every leak read in
 * those three days ran against profiles nothing had tuned.
 *
 * ── WHAT THIS LAW PINS ────────────────────────────────────────────────────
 *
 *   1. No OFFSET paging in the stream. That is bug 2, by construction.
 *   2. The cursor is the WHOLE sort key, and it is taken from the last row of
 *      the page just read. A cursor on `created_at` alone is bug 1.
 *   3. `id` is selected. Without it there is no second cursor component, and
 *      the only way to page is bug 1 or bug 2.
 *   4. A night that studied nobody says so. Returning in silence is what let
 *      three days of dead nights look exactly like three quiet ones.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, 'HorseSelfTuner.ts'), 'utf8');

/** The stream loop, sliced from its `for` to its matching brace. */
const STREAM = (() => {
  const start = SRC.indexOf('    for (let page = 0;');
  expect(start, 'the study stream loop moved; re-anchor this law').toBeGreaterThan(-1);
  let depth = 0;
  for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) return SRC.slice(start, i + 1);
  }
  throw new Error('unbalanced stream loop');
})();

describe('the self-tuner study stream', () => {
  it('never pages by offset', () => {
    expect(STREAM, 'range()/OFFSET paging is quadratic here - see the header').not.toMatch(
      /\.range\s*\(/
    );
    expect(STREAM).not.toMatch(/offset/i);
  });

  it('carries a cursor over BOTH sort-key components', () => {
    expect(STREAM, 'the index narrows on created_at').toMatch(/\.lte\('created_at', cursor\./);
    expect(STREAM, 'and the tie at that timestamp is settled by id').toMatch(
      /id\.lt\.\$\{cursor\./
    );
  });

  it('takes the cursor from the last row of the page it just read', () => {
    expect(STREAM).toMatch(/const last = data\[data\.length - 1\]/);
    expect(STREAM).toMatch(/cursor = \{ createdAt: last\.created_at, id: last\.id \}/);
  });

  it('selects the id the cursor is made of', () => {
    expect(STREAM).toMatch(/\.select\('id, /);
  });

  it('still reads cash hands only, newest first, in bounded pages', () => {
    // The fix may not quietly widen what the study measures.
    expect(STREAM).toMatch(/\.is\('tournament_id', null\)/);
    expect(STREAM).toMatch(/\.order\('created_at', \{ ascending: false \}\)/);
    expect(STREAM).toMatch(/\.order\('id', \{ ascending: false \}\)/);
    expect(STREAM).toMatch(/\.limit\(PAGE_SIZE\)/);
    expect(STREAM).toMatch(/page \* PAGE_SIZE < MAX_HANDS_TO_STUDY/);
  });

  it('reports a night that studied nobody instead of returning in silence', () => {
    const bail = SRC.slice(SRC.indexOf('if (stats.size === 0)'));
    expect(bail.slice(0, bail.indexOf('\n    }') + 6)).toMatch(/HorseSelfTuner\.noStats/);
  });
});

/**
 * The predicate itself, as a model. `created_at <= c.ts AND (created_at < c.ts
 * OR id < c.id)` must admit exactly the rows that follow the cursor in
 * (created_at DESC, id DESC) order — no row skipped (bug 1) and none repeated.
 */
describe('the keyset predicate', () => {
  type Row = { ts: number; id: string };
  const admits = (c: Row, r: Row) => r.ts <= c.ts && (r.ts < c.ts || r.id < c.id);
  const order = (a: Row, b: Row) => b.ts - a.ts || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

  it('admits every row after the cursor and no row at or before it', () => {
    const rows: Row[] = [];
    for (let ts = 3; ts >= 1; ts--) for (const id of ['a', 'b', 'c']) rows.push({ ts, id });
    const sorted = [...rows].sort(order);
    for (let i = 0; i < sorted.length; i++) {
      const cursor = sorted[i];
      const admitted = sorted.filter((r) => admits(cursor, r));
      expect(admitted, `cursor ${cursor.ts}/${cursor.id}`).toEqual(sorted.slice(i + 1));
    }
  });

  it('loses nobody to a shared timestamp - the bug V12.3 was fixing', () => {
    // Three hands written in the same millisecond, page size 1.
    const page: Row[] = [
      { ts: 7, id: 'c' },
      { ts: 7, id: 'b' },
      { ts: 7, id: 'a' },
    ];
    const seen: Row[] = [];
    let cursor: Row | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const next = page.filter((r) => (cursor ? admits(cursor, r) : true)).sort(order)[0];
      if (!next) break;
      seen.push(next);
      cursor = next;
    }
    expect(seen).toEqual(page);
  });
});
