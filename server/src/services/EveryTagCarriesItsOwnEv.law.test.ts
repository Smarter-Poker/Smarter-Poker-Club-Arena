/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LAW: EVERY TAG CARRIES ITS OWN EV (2026-09-06)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A tag COUNT says how often a shape happened. It never says whether the
 * shape was wrong. Ranking the leak table by its loss totals ranks situations
 * by how often they occur in big pots - which is how `river_aggr_lost`, at
 * -778,000bb the largest number in the table, read as the fleet's worst leak
 * while being one side of a line that makes +12.66 bb/hand over 75,811 hands.
 *
 * `horse_review_rollup.leak_net_bb` is the net beside the count, and
 * `fn_horse_tag_ev` pairs each situation with its winning mirror. This law
 * pins the two things that make the ranking honest, both of which were WRONG
 * in the first cut and both of which were found by reading its output against
 * the tag inventory rather than by re-reading the code:
 *
 *   1. BOTH NAMING SHAPES PAIR. Almost every situation is `X` / `X_won`, but
 *      river aggression is `river_aggr_lost` / `river_aggr_won` - it was the
 *      first tag ever mirrored and got a symmetric name. Stripping only
 *      `_won` left it showing a 100% win rate over 48,891 hands, which is one
 *      half of a ledger rather than a measurement.
 *
 *   2. MIRROR STATUS IS A FACT ABOUT THE CODE. Inferring it from "a _won key
 *      exists this week" drops any situation whose mirror is real but RARE -
 *      and the rarest mirrors are the worst situations. plo_naked_trips
 *      stackoff won 4 of 480 and plo_toppair_no_redraw won 3 of 237; those
 *      are the two biggest losers in the fleet and the first cut hid both.
 *
 * The fold family is the ONLY unmirrored set, and it is unmirrored by
 * definition rather than by accident: big_bet_fold, big_fold_river,
 * big_fold_early and bet_fold_line all require hero to have folded, and a
 * folded hand never wins. HorseHandReview says so in the source; this law
 * makes the SQL and the source agree.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'src');
const MIGRATIONS = join(process.cwd(), '..', 'supabase', 'migrations');

const review = readFileSync(join(SRC, 'services/HorseHandReview.ts'), 'utf8');
const ev = readdirSync(MIGRATIONS)
  .filter((f) => f.includes('the_ev_ranking_pairs_every_mirror'))
  .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
  .join('\n');

/** The fold family, as HorseHandReview defines it. */
const FOLD_FAMILY = ['big_bet_fold', 'big_fold_river', 'big_fold_early', 'bet_fold_line'];

describe('LAW: every tag carries its own EV', () => {
  it('the migration that defines the ranking is in the repo', () => {
    expect(ev.length, 'the_ev_ranking_pairs_every_mirror.sql must be committed').toBeGreaterThan(0);
    expect(ev.includes('create or replace function public.fn_horse_tag_ev')).toBe(true);
  });

  it('both naming shapes are paired, not just _won', () => {
    expect(ev.includes("like '%\\_won'"), 'the _won mirror must be stripped').toBe(true);
    expect(
      ev.includes("like '%\\_lost'"),
      'river_aggr_lost must pair with river_aggr_won, or the situation reads as 100% wins'
    ).toBe(true);
  });

  it('mirror status comes from the fold family, not from this week s cards', () => {
    for (const tag of FOLD_FAMILY) {
      expect(
        ev.includes(`'${tag}'`),
        `${tag} must be named in fn_horse_tag_ev - mirror status is a fact about the code`
      ).toBe(true);
    }
    // Inferring it from the data is the defect this replaced.
    expect(ev.includes('bool_or(p.is_won)')).toBe(false);
  });

  it('the fold family in the SQL is exactly the fold family in the engine', () => {
    // HorseHandReview is the authority: these four tags require hero to have
    // folded. If a fifth is ever added there, this fails until the SQL knows.
    for (const tag of FOLD_FAMILY) {
      expect(review.includes(tag), `${tag} must still exist in HorseHandReview`).toBe(true);
    }
    const note = review.slice(review.indexOf('THE FOLD FAMILY IS NOT MIRRORED'));
    const paragraph = note.slice(0, 400);
    for (const tag of FOLD_FAMILY) {
      expect(
        paragraph.includes(tag),
        `${tag} must be named in the fold-family note, which is what the SQL copies`
      ).toBe(true);
    }
  });

  it('the rollup writer accumulates the net, not just the count', () => {
    const mig = readdirSync(MIGRATIONS)
      .filter((f) => f.includes('every_tag_carries_its_own_ev'))
      .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
      .join('\n');
    expect(mig.includes('leak_net_bb')).toBe(true);
    expect(mig.includes('fn_hhr_rollup_add')).toBe(true);
    // The backfill must group by the DATE. Grouping by the timestamp made
    // every hand its own group and jsonb_object_agg kept the last one, which
    // read as +4,298bb on a day the raw table says +136,479bb.
    expect(mig.includes('r.played_at::date as day')).toBe(true);
  });
});
