import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { blankNonCode, sliceDollarQuoted } from '../helpers/sourceWindow';

/**
 * THE BOMB POT REPORT REMEMBERS, AND STOPS READING THE HANDS
 *
 * Phase 7 of Dan's Club Operations upgrade. Two defects in one function, and
 * the first of them was a wrong DIAGNOSIS carried in the plan document rather
 * than a wrong line of code.
 *
 * The phase 6 gate measured `fn_club_bomb_pot_report` at 684ms as `postgres`
 * and 9.7 and 17.3 SECONDS as `authenticated`, and concluded something
 * role-dependent was happening that it could not name. Nothing role-dependent
 * was happening: a psql session as postgres carries no `request.jwt.claims`,
 * `auth.uid()` is NULL, and the function's first statement raises
 * `not_authenticated`. **The 684ms baseline was the timing of an error.**
 *
 * Holding the role constant and changing only the claims:
 *
 *     postgres, no claims                  ERROR not_authenticated      88ms
 *     postgres, the owner's claims           50 rows              31,715ms
 *     postgres, same claims, again           50 rows                  384ms
 *
 * so it is a cold cache, and the report is exactly the kind of read - opened
 * once a day, over ~20,200 wide `hand_history` rows whose `players` jsonb is
 * TOASTed - that is never resident. Through PostgREST the 8s statement_timeout
 * killed the cold call, which meant the read that would have warmed the cache
 * could never finish. It could not bootstrap out of the cold state.
 *
 * The second defect was found while measuring the first: the report reads
 * `hand_history`, and `sp_prune_hand_history` removes horse-only hands after
 * seven days (Dan's ruling, CLAUDE.md 10.5 - a storage decision, not a player
 * one). Ask for 365 days and it answered with seven, silently, as a number
 * rather than a gap.
 *
 * Both are fixed by the same rollup, and these pins are on the properties that
 * make it correct rather than on its shape.
 */

const MIGRATION = readFileSync(
  'supabase/migrations/20260905051000_the_bomb_pot_report_remembers_and_stops_reading_the_hands.sql',
  'utf8'
);

/**
 * The correction, and the reason it was needed: the first version bounded the
 * live scan by the REQUESTED window and relied on the anti-join to keep only
 * the unsealed days. The anti-join removes them from the result; it cannot
 * stop them being read. The club filter lives on `tables`, so `h.table_id` is
 * wanted for every candidate row and is not in the partial index - so the
 * planner still fetched ~20,200 wide rows and threw 96% away.
 *
 * It measured 1.2-1.9s anyway, because that measurement was taken minutes
 * after the backfill had warmed every page it touched. The same call from a
 * real browser session fifteen minutes later took 8,718ms and 500'd. Measuring
 * a cold path warm is precisely the mistake this whole item exists to correct,
 * and it was made twice in one night.
 */
const CORRECTION = readFileSync(
  'supabase/migrations/20260905052000_the_live_edge_is_bounded_by_the_days_that_are_live.sql',
  'utf8'
);

const fnIn = (sql: string, name: string) => {
  const start = sql.indexOf(`FUNCTION public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  return sliceDollarQuoted(sql.slice(start), '$function$');
};
const fn = (name: string) => fnIn(MIGRATION, name);

describe('the bomb pot report reads a rollup, not twenty thousand hands', () => {
  it('the report reads the sealed days from the rollup', () => {
    const body = blankNonCode(fnIn(CORRECTION, 'fn_club_bomb_pot_report'));
    expect(body).toContain('public.ca_club_bomb_pot_daily d');
    expect(body).toContain('public.ca_club_bomb_pot_complete c');
  });

  it('the live edge excludes every sealed day, so nothing is counted twice', () => {
    // The mirror failure of a rollup that misses today is a rollup that is
    // added to a live read of the same day, and it reads as a club producing
    // more bomb pots than it dealt.
    const body = blankNonCode(fnIn(CORRECTION, 'fn_club_bomb_pot_report'));
    expect(body).toMatch(/NOT EXISTS \(SELECT 1 FROM ok_days o2/);
  });

  it('averages are re-derived from the sums, not averaged again', () => {
    // An average of daily averages is not the average of the range. The
    // rollup stores sums for exactly this reason.
    const body = blankNonCode(fnIn(CORRECTION, 'fn_club_bomb_pot_report'));
    expect(body).toContain('round(tt.seats_sum / NULLIF(tt.hands, 0), 2)');
    expect(body).toContain('round(tt.pot_sum   / NULLIF(tt.hands, 0), 2)');
    expect(MIGRATION).toContain('Sums, never averages.');
  });

  it('a day is not sealed until fifteen minutes after it ends', () => {
    // bomb_pot_award_units can land a moment late, and a sealed day is never
    // recomputed - so sealing at midnight would write a wrong scoop/split
    // count permanently.
    // Raw, not blankNonCode: the interval IS a string literal, and blanking
    // literals is exactly what would erase the number under test.
    const raw = fn('fn_ca_bomb_pot_rollup_day');
    expect(raw).toMatch(/\(p_day \+ 1\)::timestamptz > now\(\) - interval '15 minutes'/);
    expect(blankNonCode(raw)).toContain('RETURN 0;');
  });

  it('a day with no bomb pots still gets a marker', () => {
    // Without it, an empty day is re-scanned live for ever and reads as "not
    // yet known" rather than "none".
    const body = blankNonCode(fn('fn_ca_bomb_pot_rollup_day'));
    expect(body).toContain('INSERT INTO public.ca_club_bomb_pot_complete');
    expect(MIGRATION).toContain('A day with');
  });

  it('the catchup never rolls up a day the hands can no longer answer for', () => {
    // Reaching past the retention horizon would write ZEROES over history
    // that pruning removed, which is worse than the gap: the rollup exists to
    // be believed.
    const body = blankNonCode(fn('fn_ca_bomb_pot_catchup'));
    expect(body).toContain('MIN(h.created_at)::date');
    expect(body).toContain('GREATEST(');
  });

  it('nothing new is attached to hand_history', () => {
    // 221,000 inserts a day on the engine's hottest path. The rollup catches
    // itself up from the report instead.
    expect(MIGRATION).not.toMatch(/CREATE\s+(OR REPLACE\s+)?TRIGGER[^;]*ON public\.hand_history/i);
    expect(MIGRATION).not.toMatch(/cron\.schedule/i);
  });

  it('the rollup tables are not reachable from a browser', () => {
    expect(MIGRATION).toContain(
      'REVOKE ALL ON TABLE public.ca_club_bomb_pot_daily    FROM PUBLIC, anon, authenticated;'
    );
    expect(MIGRATION).toContain(
      'REVOKE ALL ON TABLE public.ca_club_bomb_pot_complete FROM PUBLIC, anon, authenticated;'
    );
    expect(MIGRATION).toContain('ENABLE ROW LEVEL SECURITY');
  });

  it('the two writers are service_role only; the report keeps its one door', () => {
    for (const f of [
      'fn_ca_bomb_pot_rollup_day(uuid, date)',
      'fn_ca_bomb_pot_catchup(uuid, integer)',
    ]) {
      expect(MIGRATION).toContain(
        `REVOKE ALL ON FUNCTION public.${f} FROM PUBLIC, anon, authenticated;`
      );
      expect(MIGRATION).toContain(`GRANT EXECUTE ON FUNCTION public.${f} TO service_role;`);
    }
    expect(MIGRATION).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_club_bomb_pot_report(uuid, integer) TO authenticated, service_role;'
    );
  });

  it('the live scan is bounded by the earliest unsealed day, not by the window', () => {
    // Without this the rollup saves nothing: every call still reads the whole
    // window's hands and discards them after the join. Measured from a real
    // browser session: 8,718ms and a 500 before, 1.8-3.2s and 200 after.
    const body = blankNonCode(fnIn(CORRECTION, 'fn_club_bomb_pot_report'));
    expect(body).toContain('h.created_at >= v_live_from::timestamptz');
    expect(body).toContain('public.ca_club_bomb_pot_complete c');
    // And the anti-join SURVIVES the bound: a day the rollup skipped and later
    // filled sits inside the live range and would otherwise be counted twice.
    expect(body).toMatch(/NOT EXISTS \(SELECT 1 FROM ok_days o2/);
    expect(CORRECTION).toContain(
      'the live scan is still bounded by the requested window, not by the unsealed days'
    );
  });

  it('the report still returns the fourteen columns the page reads', () => {
    for (const col of [
      'table_id uuid',
      'table_name text',
      'trigger_reason text',
      'board_count integer',
      'variant text',
      'hands bigint',
      'avg_players numeric',
      'avg_pot numeric',
      'total_pot numeric',
      'total_rake numeric',
      'total_antes numeric',
      'scoops bigint',
      'splits bigint',
      'unrecorded_hands bigint',
    ]) {
      expect(MIGRATION, `${col} is still returned`).toContain(col);
    }
  });

  it('the migration checks the rollup against the hands before it commits', () => {
    // Proved before applying, too: the report's fifty rows were captured
    // before and after inside one transaction that was rolled back, and
    // EXCEPT in both directions returned nothing.
    expect(MIGRATION).toContain('the rollup for % on % totals % where the hands total %');
  });

  it('its own assertion reads code rather than the prose beside it', () => {
    // 20260905042100 failed its first apply because an assertion matched the
    // comment that explained what it had replaced. Third time in this
    // programme; this one strips comment lines first.
    expect(MIGRATION).toContain("WHERE btrim(line) NOT LIKE '--%'");
  });
});
