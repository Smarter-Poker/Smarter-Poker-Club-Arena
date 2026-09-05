import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { blankNonCode, sliceDollarQuoted } from '../helpers/sourceWindow';

/**
 * THE PER-PLAYER LIVE EDGE IS A ROLLUP, NOT A SCAN OF TODAY
 *
 * Found by phase 7's own gate, and it is the clearest example in this
 * programme of a measurement that was true and still misleading.
 *
 * `fn_ca_rake_by_agent` measured **490-983ms at 03:55 UTC**, and
 * `ca_rake_snapshot` answered the browser in 591-1,157ms on every range. The
 * same calls, on the same club, with nothing changed, at **07:37 the same
 * morning: 3,402ms**, and `ca_rake_snapshot` back to a 500 after 8,155ms.
 *
 * Nothing regressed. The live edge grows all day:
 *
 *     2026-09-01     9,288 attribution rows     175 players
 *     2026-09-02    77,619                      267
 *     2026-09-03   328,535                      257
 *     2026-09-04   185,928                      237
 *     2026-09-05    38,598  (07:37, still open) 174
 *
 * Bounding the scan to one day is only a fix while that day is small. The
 * panel would have healed every morning and failed every evening, which is
 * worse than failing outright because it looks like somebody else's fault.
 *
 * So the per-player figure gets what phase 6 gave the club-level figure: an
 * incremental daily rollup kept exact by statement-level triggers on the table
 * the sealed days are themselves built from.
 */

const TABLE = readFileSync(
  'supabase/migrations/20260905073943_the_per_player_live_edge_is_a_rollup_not_a_scan_of_today.sql',
  'utf8'
);
const TRIGGERS = readFileSync(
  'supabase/migrations/20260905074228_the_attribution_triggers_and_the_read_that_uses_them.sql',
  'utf8'
);

const fnIn = (sql: string, name: string) => {
  const start = sql.indexOf(`FUNCTION public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  return sliceDollarQuoted(sql.slice(start), '$function$');
};

describe('the per-player live edge is a rollup', () => {
  it('stores integer cents, because the sum is accumulated rather than taken in one pass', () => {
    // The read it replaces is SUM(round(rake*100)::bigint)::numeric/100 - each
    // row rounded to a cent, then summed. Accumulating that in numeric is a
    // different number; accumulating it in integer cents is the same one.
    expect(TABLE).toContain('rake_cents  bigint');
    expect(blankNonCode(fnIn(TABLE, 'fn_ca_club_rake_daily_user_apply'))).toContain(
      'SUM(round(ra.rake_amount * 100))::bigint'
    );
    expect(blankNonCode(fnIn(TRIGGERS, 'fn_ca_rake_by_agent'))).toContain(
      'du.rake_cents::numeric / 100'
    );
  });

  it('never lets the rollup fail a raked hand', () => {
    // A trigger that can refuse an INSERT into rake_attributions is a trigger
    // that can stop the engine paying rake. Every one of the three swallows
    // its own failure, exactly as phase 6's club-level trigger does.
    for (const t of [
      'trg_ca_club_rake_daily_user_insert',
      'trg_ca_club_rake_daily_user_change',
      'trg_ca_club_rake_daily_user_delete',
    ]) {
      const body = blankNonCode(fnIn(TRIGGERS, t));
      expect(body, `${t} swallows`).toContain('EXCEPTION WHEN OTHERS THEN');
      expect(body, `${t} warns`).toContain('RAISE WARNING');
    }
  });

  it('the triggers and the read land together, in one transaction', () => {
    // A read that switched to the rollup before the triggers existed would
    // lose every hand raked in between, silently. That happened for four
    // minutes on 2026-09-05 when a probe ran outside a transaction and
    // committed the read on its own; the read was put back within seconds and
    // this is the shape that stops it recurring.
    const begin = TRIGGERS.indexOf('\nBEGIN;');
    const commit = TRIGGERS.lastIndexOf('COMMIT;');
    expect(begin).toBeGreaterThan(-1);
    expect(TRIGGERS.indexOf('CREATE TRIGGER trg_ca_club_rake_daily_user_ins')).toBeGreaterThan(
      begin
    );
    expect(TRIGGERS.indexOf('CREATE TRIGGER trg_ca_club_rake_daily_user_ins')).toBeLessThan(commit);
    expect(TRIGGERS.indexOf('FUNCTION public.fn_ca_rake_by_agent(')).toBeLessThan(commit);
    // And the half that takes no lock carries neither.
    expect(TABLE).not.toContain('CREATE TRIGGER trg_ca_club_rake_daily_user_ins');
    expect(TABLE).not.toContain('FUNCTION public.fn_ca_rake_by_agent(');
  });

  it('a day is in range when its own midnight is before the exclusive end', () => {
    // THE OFF-BY-ONE THIS CAUGHT. `v_to` is either a midnight (a range ending
    // yesterday ends at TODAY's midnight) or now() (a range ending today). The
    // inclusive form `du.day <= date_trunc('day', v_to)::date` got the second
    // right and the first wrong, and put TODAY's rake into a report for
    // YESTERDAY. Found by comparing old against new under one snapshot: six
    // ranges agreed and that one did not.
    const body = blankNonCode(fnIn(TRIGGERS, 'fn_ca_rake_by_agent'));
    expect(body).toContain('du.day::timestamptz < v_to');
    expect(body).not.toContain("du.day <= date_trunc('day', v_to)::date");
  });

  it('keeps the sealed days disjoint from the live ones', () => {
    const body = blankNonCode(fnIn(TRIGGERS, 'fn_ca_rake_by_agent'));
    expect(body).toContain('NOT EXISTS (SELECT 1 FROM ok_days o WHERE o.day = du.day)');
    expect(body).toContain('FROM public.club_rake_daily_user rd');
  });

  it('does not filter tournaments out, because the read it replaces did not', () => {
    // Phase 6's club-level trigger excludes is_tournament because
    // ca_club_rake_daily is cash-only. This one must not: fn_ca_rake_by_agent
    // credits an agent with every attribution row the club produced, and a
    // rollup that filtered differently would quietly change what an agent
    // earns.
    expect(blankNonCode(fnIn(TABLE, 'fn_ca_club_rake_daily_user_apply'))).not.toContain(
      'is_tournament'
    );
    expect(TABLE).toContain('NO TOURNAMENT FILTER, deliberately');
  });

  it('the rollup is not reachable from a browser', () => {
    expect(TABLE).toContain(
      'REVOKE ALL ON TABLE public.ca_club_rake_daily_user FROM PUBLIC, anon, authenticated;'
    );
    expect(TABLE).toContain('ENABLE ROW LEVEL SECURITY');
    for (const f of [
      'fn_ca_club_rake_daily_user_apply(uuid[])',
      'fn_ca_club_rake_daily_user_rebuild_day(uuid, date, uuid)',
    ]) {
      expect(TABLE).toContain(
        `REVOKE ALL ON FUNCTION public.${f} FROM PUBLIC, anon, authenticated;`
      );
      expect(TABLE).toContain(`GRANT EXECUTE ON FUNCTION public.${f} TO service_role;`);
    }
  });

  it('both halves check themselves against the attributions before committing', () => {
    for (const m of [TABLE, TRIGGERS]) {
      expect(m).toContain('the rollup for % on % totals % where the attributions total %');
    }
    expect(TRIGGERS).toContain('nothing keeps the rollup current');
    expect(TABLE).toContain('a club-day the attributions carry is missing from the rollup');
  });
});
