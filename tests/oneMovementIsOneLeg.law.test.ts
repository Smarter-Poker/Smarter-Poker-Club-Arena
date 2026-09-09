/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ONE MOVEMENT IS ONE LEG, AND A FINDING IS CLOSED BY WHAT MEASURED IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Round 2 of the union settlement cascade moved 20,377.49 of commission into
 * 28 agent wallets on 2026-09-09 and recorded 40,754.98 of legs doing it. It
 * wrote a named leg for each payment by hand, and it ALSO left both balance
 * writes to journal themselves; neither trigger had been told who the
 * counterparty was, so each payment arrived a second time as an anonymous
 * pair through settlement_suspense.
 *
 * Three faults are pinned here.
 *
 * 1. THE AUTOSKIP CONTRACT IS ONE CONTRACT. Every journal writer on this
 *    platform stands down when the caller sets app.ledger_autoskip_<table>,
 *    because the caller is writing the leg itself. fn_club_members_ledger_writer
 *    never learned that clause, so callers that suppressed the clubs trigger
 *    still got a twin from the busiest balance column on the platform.
 *
 * 2. A CHIP THAT KEPT NO NAME IS A FINDING. settlement_suspense is what a
 *    trigger uses when nobody said who the other side was. The only thing
 *    watching it was a daily note measuring flow - and flow nets to zero the
 *    moment a movement passes straight through, which is the exact shape of
 *    this bug. The check asks the balance question per account instead.
 *
 * 3. A BOARD THAT CANNOT GO GREEN IS NOT READ. No detector on this platform
 *    could close an incident. The sweep folded the same two findings from
 *    2026-09-02 to 2026-09-09, and fn_bbj_reconcile raised under a fresh key
 *    every hour so its incidents could never even fold. A detector that runs
 *    on a schedule says a finding is gone by not raising it again - after TWO
 *    clean runs, never one.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATIONS = resolve(__dirname, '../supabase/migrations');
const readMigration = (fragment: string): string => {
  const file = readdirSync(MIGRATIONS).find((f) => f.includes(fragment));
  expect(file, `no migration matching ${fragment}`).toBeTruthy();
  return readFileSync(resolve(MIGRATIONS, file as string), 'utf8');
};

const STAND_DOWN = readMigration('one_movement_one_leg_the_settlement_stands_its_triggers_down');
const CANCEL = readMigration('the_twenty_eight_anonymous_twins_of_round_two_are_cancelled');
const NO_NAME = readMigration('a_chip_that_passed_through_suspense_and_kept_no_name_is_a_finding');
const CLOSES = readMigration(
  'a_finding_the_measurement_stopped_reporting_is_closed_by_that_measurement'
);
const BASIS = readMigration('a_meter_that_changed_its_basis_does_not_compare_across_the_change');
const JACKPOT_CLOSES = readMigration('the_jackpot_meter_closes_what_it_has_stopped_reporting');
const BANK = readMigration('the_shared_player_payout_door_names_the_bank_it_pays_from');
const RUNNER_UP = readMigration('the_spin_runner_up_gets_the_share_the_ladder_promised');
const NO_CHAIR = readMigration('a_player_still_in_the_event_with_no_chair_is_a_finding_of_its_own');

describe('one movement is one leg', () => {
  it('the club_members journal writer stands down when told to', () => {
    expect(STAND_DOWN).toContain(
      "IF current_setting('app.ledger_autoskip_club_members', true) = '1' THEN"
    );
    // The migration refuses to commit unless the live function took the clause.
    expect(STAND_DOWN).toContain('the club_members writer did not learn to stand down');
  });

  it('both settlement rounds set the stand-down around every balance write', () => {
    expect(STAND_DOWN).toContain("PERFORM set_config('app.ledger_autoskip_clubs', '1', true);");
    expect(STAND_DOWN).toContain(
      "PERFORM set_config('app.ledger_autoskip_club_members', '1', true);"
    );
    // Set immediately before each write and cleared immediately after, so a
    // CONTINUE out of the loop cannot leave a later statement unjournalled.
    expect(STAND_DOWN).toContain("PERFORM set_config('app.ledger_autoskip_clubs', '', true);");
    expect(STAND_DOWN).toContain(
      "PERFORM set_config('app.ledger_autoskip_club_members', '', true);"
    );
    expect(STAND_DOWN).toContain('a settlement round did not learn to stand the trigger down');
  });

  it('the duplicate already written is cancelled, never deleted', () => {
    expect(CANCEL).toContain('round2-twin-cancel:debit:');
    expect(CANCEL).toContain('round2-twin-cancel:credit:');
    expect(CANCEL).toContain('expected 56 cancelling legs, wrote %');
    expect(CANCEL).toContain('expected to cancel 20377.49 of twins, covered %');
    // The journal is hash-chained; a wrong row is answered, not removed.
    expect(CANCEL).not.toMatch(/DELETE\s+FROM\s+public\.chip_ledger/i);
  });

  it('the shared player payout door names the bank it pays from', () => {
    expect(BANK).toContain("PERFORM public.fn_ca_declare_ledger(v_cat, 'club_treasury', v_club);");
    // A caller that already declared knows better than this function does.
    expect(BANK).toContain("v_had_cp = ''");
    // And the declaration is cleared so it cannot label a later write.
    expect(BANK).toContain("PERFORM set_config('app.ledger_counterparty', '', true);");
    expect(BANK).toContain('fn_pay_player_chips did not learn to name its bank');
  });
});

describe('a chip that kept no name is a finding', () => {
  it('the check asks the balance question per account, not the flow question', () => {
    expect(NO_NAME).toContain('fn_ca_undeclared_leg_check');
    expect(NO_NAME).toContain('HAVING round(sum(s.delta), 2) <> 0');
    // A twin that has been explicitly cancelled nets to zero and is not a finding.
    expect(NO_NAME).toContain("'settlement_suspense' IN (from_type, to_type)");
  });

  it('the check runs in the sweep and reads clean the moment it is installed', () => {
    expect(NO_NAME).toContain("('fn_ca_undeclared_leg_check',");
    expect(NO_NAME).toContain('the undeclared-leg check reads % open account(s) at install time');
    expect(NO_NAME).toContain('the sweep did not take the new check');
  });

  it('a definer that reads the journal is not reachable by anon', () => {
    expect(NO_NAME).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_undeclared_leg_check(integer) FROM anon;'
    );
    expect(NO_NAME).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_ca_undeclared_leg_check(integer) TO service_role;'
    );
  });
});

describe('a finding is closed by what measured it', () => {
  it('two clean runs, never one', () => {
    expect(CLOSES).toContain('TWO CLEAN RUNS, NOT ONE');
    expect(CLOSES).toContain('ORDER BY ran_at DESC OFFSET 1 LIMIT 1');
    expect(CLOSES).toContain('fewer than two recorded runs so far');
    // A finding raised after the earlier run is too young to judge.
    expect(CLOSES).toContain('AND i.created_at < v_second');
    expect(CLOSES).toContain('AND i.last_seen_at < v_second');
  });

  it('the resolution names the two runs that stopped reporting it', () => {
    expect(CLOSES).toContain("correction_ref = 'verified: '");
    expect(CLOSES).toContain('without raising it either time');
    expect(CLOSES).toContain('no chips moved to close this');
  });

  it('only a detector that reads the whole standing state may be on the list', () => {
    expect(JACKPOT_CLOSES).toContain('fn_ca_quick_reconcile is deliberately absent');
    expect(JACKPOT_CLOSES).toContain('ten minute window');
    expect(JACKPOT_CLOSES).toContain(
      "ARRAY['fn_ca_conservation_sweep','fn_ca_ratchet_watch','fn_bbj_reconcile']"
    );
  });

  it('a completed run is recorded at the end, when every check has run', () => {
    expect(CLOSES).toContain('A COMPLETED RUN IS ITSELF EVIDENCE');
    expect(CLOSES).toContain('INSERT INTO public.ca_detector_runs');
    expect(CLOSES).toContain('a detector did not learn to record its runs');
  });
});

describe('a meter does not compare across a change of basis', () => {
  it('the jackpot reading records the basis it was taken on', () => {
    expect(BASIS).toContain("'cumulative-since-open-v1'");
    expect(BASIS).toContain('basis_version');
    expect(BASIS).toContain('the basis rule did not reach both halves of the meter');
  });

  it('not comparable is not growth, and a write failure still raises on its own', () => {
    expect(BASIS).toContain('NOT COMPARABLE IS NOT GROWTH');
    expect(BASIS).toContain('prev.basis_version IS NOT DISTINCT FROM s.basis_version');
    expect(BASIS).toContain('IF (v_comparable AND abs(v_two) > 0.01');
    expect(BASIS).toContain('OR s.write_failures > 0 THEN');
  });
});

describe('the ladder decides the split, and the record says what was paid', () => {
  it('the runner up is paid and the winner is not clawed back', () => {
    expect(RUNNER_UP).toContain('fn_ca_adjustment_under_10_9');
    expect(RUNNER_UP).toContain('second place was not paid their 1.40');
    expect(RUNNER_UP).toContain('this event still shows an outstanding obligation');
    // The house funds what it under-paid; the overpaid player keeps theirs.
    expect(RUNNER_UP).toContain('the overlay leg was not written exactly once');
  });

  it('the obligation row is brought to what was paid, never below it', () => {
    // A CHECK constraint forbids amount_paid above amount_owed, and that
    // invariant is right: the column is a ceiling, not a wish.
    expect(RUNNER_UP).toContain('SET amount_owed = 9.40');
    expect(RUNNER_UP).toContain("WHY FIRST PLACE'S ROW READS 9.40 AND NOT THE LADDER'S 8.00");
  });

  it('a player with chips and no chair is its own finding', () => {
    expect(NO_CHAIR).toContain('fn_ca_stranded_tournament_players');
    expect(NO_CHAIR).toContain('cannot be dealt a hand');
    expect(NO_CHAIR).toContain("('fn_ca_stranded_tournament_players',");
    // It does not pretend to close the conservation finding it came out of.
    expect(NO_CHAIR).toContain('That part stays open and unexplained');
  });
});
