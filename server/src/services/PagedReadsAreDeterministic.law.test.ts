/**
 * A PAGED READ MUST ORDER BY A UNIQUE KEY (2026-09-01).
 *
 * Postgres does not promise a stable order within ties. LIMIT/OFFSET
 * pagination over a non-unique ORDER BY therefore repeats some rows and drops
 * others, silently, with no error anywhere.
 *
 * Four reads in this service layer had it, found in one afternoon:
 *
 *   horse_daily_nets      keyed (horse_user_id, day, game_variant, format)
 *                         ordered by (horse_user_id, day) - 2,589 tied groups
 *   horse_review_rollup   keyed (horse_user_id, day, game_variant)
 *                         ordered by (horse_user_id, day) - 3,413 tied groups
 *   table_seats           ordered by user_id alone, and a horse holds up to
 *                         FOUR seats - user_id is the least unique column in
 *                         the read
 *   tournament_players    ordered by user_id alone, and a horse is registered
 *                         for several events at once
 *
 * The first two were live: two horses with 2,141 and 2,332 cash hands landed
 * under the 1,500-hand bar and were logged with the -9999 "no real sample"
 * sentinel, so their dials were tuned from frequency estimates instead of
 * settlement truth.
 *
 * The last two are latent - 244 live seat rows and 540 registration rows on
 * 2026-09-01, both inside a single page - and are fixed anyway, because the
 * failure is invisible until the fleet outgrows a page and then presents as
 * intermittent starvation with no error to point at. Both directions are
 * documented failures of horseLoadMap: understated load hands out a horse
 * already at four tables (the four-table trigger then refuses it with 23514
 * and the pass fills nobody), overstated load holds a free horse out of every
 * board.
 *
 * This test is the guard against the fifth one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A call's argument list, bounded by the paren that closes it. */
const callArgs = (src: string, at: number): string => {
  const open = src.indexOf('(', at);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
};

const FILES = ['HorseSelfTuner.ts', 'TournamentRecurringService.ts'];

/** Every `.range(` call, with the query text that precedes it. */
function pagedReads(src: string): Array<{ table: string; block: string }> {
  const out: Array<{ table: string; block: string }> = [];
  let idx = src.indexOf('.range(');
  while (idx !== -1) {
    const from = src.lastIndexOf(".from('", idx);
    if (from !== -1) {
      const block = src.slice(from, idx);
      const table = /\.from\('([^']+)'\)/.exec(block)?.[1] ?? 'unknown';
      // Only reads that page inside a loop matter; a single bounded .range
      // with no offset arithmetic cannot straddle a boundary.
      // The call and its whole argument list, not the next 60 bytes: a
      // .range() whose arguments grow past a fixed window stops being
      // classified as paging at all, and this scanner then covers less than it
      // says it does.
      if (/^\(\s*(page|offset)/.test(callArgs(src, idx))) {
        out.push({ table, block });
      }
    }
    idx = src.indexOf('.range(', idx + 1);
  }
  return out;
}

/**
 * What makes a row unique, per table.
 *
 * A read satisfies the rule EITHER by ordering on the table's primary key -
 * `id` is unique whatever the filters are, and is the safest tiebreaker - OR
 * by ordering on the full composite key listed here. Both are deterministic;
 * neither leaves a tie for LIMIT/OFFSET to resolve arbitrarily.
 */
const UNIQUE_KEY: Record<string, string[]> = {
  horse_daily_nets: ['horse_user_id', 'day', 'game_variant', 'format'],
  horse_review_rollup: ['horse_user_id', 'day', 'game_variant'],
  table_seats: ['user_id', 'table_id'],
  // Two different paged reads hit this table with different filters: the
  // fleet-wide load read (keyed user_id + tournament_id) and the per-event
  // entrant read, which filters to ONE tournament and so must fall back to
  // the primary key - re-entry formats put a player on the list twice.
  tournament_players: ['user_id', 'tournament_id'],
  // Already correct before this sweep: created_at is not unique, and the id
  // tiebreaker is what makes the page boundaries stable.
  hand_history: ['created_at', 'id'],
};

describe('paged reads order by a unique key', () => {
  for (const file of FILES) {
    const src = readFileSync(join(__dirname, file), 'utf8');
    const reads = pagedReads(src);

    it(`${file} has paged reads to check`, () => {
      expect(reads.length).toBeGreaterThan(0);
    });

    for (const { table, block } of reads) {
      const key = UNIQUE_KEY[table];
      if (!key) continue;
      it(`${file}: ${table} orders deterministically`, () => {
        // The primary key alone is enough - it is unique under any filter.
        if (block.includes(".order('id'")) return;
        for (const col of key) {
          expect(
            block,
            `${table} must .order('${col}') (or .order('id')) or pagination drops rows`
          ).toContain(`.order('${col}'`);
        }
      });
    }

    it(`${file}: every paged read is over a table with a declared key`, () => {
      // Forces a decision on the next one someone adds: either declare what
      // makes the row unique, or this fails and says why.
      for (const { table } of reads) {
        expect(
          UNIQUE_KEY[table],
          `${table} is paged but has no unique key declared in this test - ` +
            `add it, and make sure the read orders by it`
        ).toBeDefined();
      }
    });
  }
});
