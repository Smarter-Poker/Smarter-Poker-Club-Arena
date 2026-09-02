/**
 * MULTI-DAY IS REFUSED UNTIL IT IS BUILT (2026-09-02, Phase 3 of 6).
 *
 * Phase 3 set out to audit whether chips and prize money follow a survivor
 * across a flight boundary. THERE ARE NO FLIGHTS. Measured against production:
 *
 *   parent_tournament_id ........ 0 rows, ever
 *   survivors_advance_to ........ 0
 *   flight_end_chips_snapshot ... 0
 *   flight_number ............... 0
 *   day_number > 1 .............. 0
 *   total_days > 1 .............. 0
 *
 * 815 events carry `is_xmtt`, and THAT IS NOT A MULTI-DAY FLAG: it is set as
 * `is_xmtt: !!schedule.union_id` and means UNION event. Reading it as
 * "multi-day" is the mistake this phase found in its own Phase 2 code.
 *
 * On 2026-08-26 someone replaced a working toggle over a non-existent feature
 * with "NOT AVAILABLE YET" and a database trigger. That was right. What this
 * phase found is that the trigger covered the two columns that paint the LOBBY
 * BADGE and left open the five that would actually STRUCTURE a flight - so a
 * flight could be half-built with nothing to warn anybody, and a half-built
 * flight would have excused its seats from Phase 2's uncollected-entry check.
 *
 * Each pin below is one of the ways a feature that does not exist gets half
 * created anyway. Fix your change; never weaken a pin.
 *
 * WHEN DAY 2 IS BUILT: delete this file and the trigger in the same commit,
 * and say so in the pull request. A law that outlives the reason for it is how
 * a repo ends up with two laws demanding opposite things.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { sliceSqlStatement } from '../testHelpers/sourceWindow.js';

const MIG = (f: string) =>
  readFileSync(join(__dirname, '../../../supabase/migrations/', f), 'utf8');

const GUARD_MIGRATION = MIG(
  '20260902052302_a_half_guarded_feature_is_a_feature_that_can_be_half_built.sql'
);

/** The trigger function body, bounded by its own dollar quotes. */
const GUARD = sliceSqlStatement(
  GUARD_MIGRATION,
  'CREATE OR REPLACE FUNCTION public.fn_tournaments_refuse_unbuilt_multi_day'
);

/** The live body of the Phase 2 check, which reads two of these columns. */
const CHECK = sliceSqlStatement(
  MIG('20260902052604_is_xmtt_means_union_event_not_multi_day.sql'),
  'CREATE OR REPLACE FUNCTION public.fn_uncollected_entry_check'
);

/**
 * The two columns that paint the lobby badge, and the five that would
 * structure an actual flight. The split is the whole point of this law: the
 * original guard covered only the first pair.
 */
const BADGE_COLUMNS = ['is_multi_day', 'total_days'] as const;
const STRUCTURE_COLUMNS = [
  'day_number',
  'parent_tournament_id',
  'survivors_advance_to',
  'flight_number',
  'flight_end_chips_snapshot',
] as const;

describe('the guard refuses the structure, not just the badge', () => {
  it('tests every one of the seven columns in the function body', () => {
    for (const c of [...BADGE_COLUMNS, ...STRUCTURE_COLUMNS]) {
      expect(GUARD, `${c} is not tested by the guard`).toContain(c);
    }
  });

  it('the TRIGGER names every one of them in its UPDATE OF list', () => {
    // A trigger that does not name a column never fires on an UPDATE that
    // touches only that column, so the function body testing it is dead code.
    // This is the exact hole the phase found: the body would have refused
    // day_number, but the trigger never called the body.
    const trigger = GUARD_MIGRATION.slice(
      GUARD_MIGRATION.indexOf('CREATE TRIGGER trg_tournaments_refuse_unbuilt_multi_day'),
      GUARD_MIGRATION.indexOf('COMMENT ON FUNCTION')
    );
    expect(trigger).toContain('BEFORE INSERT OR UPDATE OF');
    for (const c of [...BADGE_COLUMNS, ...STRUCTURE_COLUMNS]) {
      expect(trigger, `the trigger does not fire on ${c}`).toContain(c);
    }
  });

  it('refuses with 0A000, the code that means the feature is not implemented', () => {
    // Not a check violation and not a permission error: 0A000 is
    // feature_not_supported, which is exactly what this is. The probe in the
    // migration asserts on that code, so a guard that started refusing for
    // some other reason would fail rather than look like it still worked.
    expect(GUARD).toContain("USING ERRCODE = '0A000'");
    expect(GUARD_MIGRATION).toContain("v_ok := (v_state = '0A000')");
  });

  it('names the offending column in the error, so the refusal is diagnosable', () => {
    expect(GUARD).toContain('v_field');
    expect(GUARD).toMatch(/refused on %/);
  });
});

describe('the guard was proved on a row where it could actually be tested', () => {
  it('probes a tournament with NO registrants', () => {
    // THE FIRST PROBE OF THIS GUARD WAS CONTAMINATED AND PASSED FOR THE WRONG
    // REASON. Run against a COMPLETED tournament, the lifecycle lock ("cannot
    // be modified after a player has registered") refused the write FIRST, and
    // a guard that had never been exercised looked like it was working. Only a
    // row with no registrants can test this one.
    expect(GUARD_MIGRATION).toContain('NOT EXISTS (SELECT 1 FROM public.tournament_players');
    expect(GUARD_MIGRATION).toContain('the guard is unverified');
  });

  it('refuses to land if any column is not refused', () => {
    expect(GUARD_MIGRATION).toContain(
      'the guard did not refuse %, so a flight can still be half built through it'
    );
  });
});

describe('the union flag is not a multi-day flag', () => {
  it('the day-2 exemption reads day_number and parent only', () => {
    // is_xmtt is `!!schedule.union_id` - UNION event. 815 live rows carry it.
    // Phase 2 read it as multi-day. It never changed a result, because the
    // exemption is an AND and the other half is zero everywhere, but the code
    // stated something false about 815 rows.
    expect(CHECK).toContain('COALESCE(t.day_number, 1) > 1 OR t.parent_tournament_id IS NOT NULL');
    expect(CHECK).not.toContain('t.is_xmtt');
    expect(CHECK).not.toContain('COALESCE(t.is_multi_day');
  });

  it('says the exemption is unreachable by construction, and why it is kept', () => {
    // Keeping a correct-but-unreachable rule beats deleting it and leaving
    // whoever builds Day 2 to remember it. Saying WHICH migration made it
    // unreachable is what lets the next reader check that it still is.
    expect(CHECK).toContain('UNREACHABLE BY CONSTRUCTION');
    expect(CHECK).toContain('20260902052302');
  });
});
