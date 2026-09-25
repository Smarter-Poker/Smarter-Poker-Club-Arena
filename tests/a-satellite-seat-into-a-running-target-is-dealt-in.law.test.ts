/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A SATELLITE SEAT INTO A RUNNING TARGET IS DEALT IN (2026-09-25)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The engine's tournament chip-conservation sentinel reported, every cycle
 * from 2026-09-22 14:10:02 UTC onwards:
 *
 *   TOURNAMENT CHIPS: 1 live tournament(s) do not hold the chips they issued -
 *   Sunday Funday Six-Card Closer: 120000 vs 150000 expected
 *   (drift -30000 over 5 players)
 *
 * It was right, and nothing had been stolen. The felt held 35,956 + 24,418 +
 * 28,714 + 30,912 = 120,000.00 - four entrants times a 30,000 starting stack,
 * conserved to the chip. The fifth entrant was a satellite qualifier admitted
 * into the RUNNING target at 2026-09-22 14:08:23 who held
 * tournament_players.status = 'registered', table_id NULL and chips 0, and
 * had never been seated. ca_tournament_conservation_samples carried 473
 * consecutive samples of drift exactly -30,000 with hands_dealt = 0 in every
 * one: no chip ever moved. One starting stack was simply never created.
 *
 * WHY THE ROW WAS NEVER SEATED. fn_ca_settle_satellite_cohort's 'seat'
 * delivery writes the target registration with a raw INSERT and leaves the
 * chair to the target's launch. That is correct for an ANNOUNCED or
 * REGISTERING target - startLifecycle reads the roster with
 * status IN ('registered','playing') and createTablesAndSeatPlayers seats the
 * field. A target that is already RUNNING has no launch left: the engine's
 * resume adopts the existing tables and never calls createTablesAndSeatPlayers
 * again, so nothing ever comes back for the row. The sibling ticket-funded
 * admission (fn_ca_register_for_tournament_with_ticket_for) never had this
 * hole - it takes the chair through fn_seat_late_registrant in the same
 * transaction. This door did not.
 *
 * THE LAW. A door that admits a paid entrant into a RUNNING tournament takes
 * their chair in the same transaction, through the canonical authority, or it
 * does not admit them at all. Proved against the live rows on 2026-09-25 in a
 * rolled-back probe: fn_seat_late_registrant returned
 * {"ok":true,"chips":30000,"seat_number":5} and the felt went 120,000 ->
 * 150,000 against a supply of 150,000, drift -30,000 -> 0.00.
 *
 * WHAT MUST NOT HAPPEN TO THIS LAW. The cheap way to make the alarm stop is
 * to teach the sentinel to skip an entrant who was never seated - to count
 * only players with a chair, or to widen p_tolerance_per_player. That would
 * hide exactly the defect this law exists for. The three sentinel functions
 * are pinned below by the md5 assertions the migration carries, so a change
 * to any of them turns this test red rather than quietly silencing the alarm.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATION =
  'supabase/migrations/20260925205909_a_satellite_seat_into_a_running_target_is_dealt_in.sql';
const SQL = fs.readFileSync(path.join(process.cwd(), MIGRATION), 'utf8');

/** The shipped text of exactly one function: its CREATE through its closing tag. */
const cohortBody = (): string => {
  const start = SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_settle_satellite_cohort');
  expect(start, 'fn_ca_settle_satellite_cohort is not in the migration').toBeGreaterThan(-1);
  const end = SQL.indexOf('$f08_fn_ca_settle_satellite_cohort$;', start);
  expect(end, 'fn_ca_settle_satellite_cohort has no closing tag').toBeGreaterThan(start);
  return SQL.slice(start, end);
};

/**
 * The RUNNING branch itself, bounded by the structure it is about: from its own
 * IF to the statement that follows the branch. A byte count would drift off the
 * end of the thing it guards the first time a comment is added inside it - see
 * tests/helpers/sourceWindow.ts.
 */
const runningBranch = (body: string): string => {
  const start = body.indexOf("IF upper(COALESCE(v_target.status, '')) = 'RUNNING' THEN");
  expect(start, 'the seat delivery has no RUNNING branch').toBeGreaterThan(-1);
  const end = body.indexOf('v_pool_before :=', start);
  expect(end, 'the RUNNING branch is not followed by the pool statement').toBeGreaterThan(start);
  return body.slice(start, end);
};

describe('a satellite seat into a running target is dealt in', () => {
  const body = cohortBody();
  const branch = runningBranch(body);

  it('the seat delivery takes the chair through the canonical authority', () => {
    expect(body).toContain('public.fn_seat_late_registrant(');
  });

  it('it does so only when the target is already RUNNING, where no launch remains', () => {
    expect(body).toMatch(/IF\s+upper\(COALESCE\(v_target\.status,\s*''\)\)\s*=\s*'RUNNING'\s+THEN/);
  });

  it('a refused chair refuses the admission - no unseatable entry is ever booked', () => {
    expect(body).toContain('Aborting So No Unseatable Entry Is Booked');
    // The refusal must RAISE. A delivery that merely reports and carries on is
    // the stranded registration this law was written for.
    expect(branch).toContain('public.fn_seat_late_registrant(');
    expect(branch).toMatch(/RAISE EXCEPTION/);
    expect(branch).toContain("USING ERRCODE = '55000'");
  });

  it('the chair is read back from the felt, not trusted from the receipt', () => {
    expect(branch).toContain('FROM public.table_seats ts');
    expect(branch).toContain('ts.left_at IS NULL');
    expect(branch).toContain('reported success but left no live chair in');
  });

  it('the entry is still admitted before it is seated, so the roster owns the entrant', () => {
    // fn_seat_late_registrant reads tournament_players for the unseated entry
    // and grants starting_chips + chips; the INSERT must still come first.
    const insert = body.indexOf('INSERT INTO public.tournament_players');
    const seat = body.indexOf('public.fn_seat_late_registrant(');
    expect(insert).toBeGreaterThan(-1);
    expect(seat).toBeGreaterThan(insert);
  });

  it('THE SENTINEL IS NOT SILENCED: all three of its functions are pinned unchanged', () => {
    expect(SQL).toContain("p.proname='fn_ca_tournament_chip_supply'");
    expect(SQL).toContain("p.proname='fn_ca_tournament_felt_total'");
    expect(SQL).toContain("p.proname='fn_tournament_chip_conservation_check'");
    expect(SQL).toContain('ABORT: fn_ca_tournament_chip_supply changed under this migration');
    expect(SQL).toContain('ABORT: fn_ca_tournament_felt_total changed under this migration');
    expect(SQL).toContain(
      'ABORT: fn_tournament_chip_conservation_check changed under this migration'
    );
    // And the open finding must still report its exact value afterwards.
    expect(SQL).toContain('fn_tournament_chip_conservation_check(1)');
    expect(SQL).toMatch(/v_drift\s*<>\s*-30000/);
  });

  it('the migration replaces exactly the definition it was written against', () => {
    expect(SQL).toContain("md5(p.prosrc) = '86709c353867d59865ba23c5bdbcd7a8'");
    expect(SQL).toContain("md5(p.prosrc) = '51a3254789bfdc2c1f80994d0c26ad6a'");
    expect(SQL).toContain('SATELLITE_SEAT_PREIMAGE_CHANGED');
  });

  it('the settlement lane doctrine is re-proved with the new call edge', () => {
    expect(SQL).toContain('public.fn_ca_settlement_lane_doctrine()');
    expect(SQL).toContain('ABORT: settlement lane doctrine refuses this change');
  });

  it('it is one transaction, one replacement, and it settles nobody', () => {
    expect(SQL.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(SQL.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(SQL.match(/^CREATE OR REPLACE FUNCTION /gm)?.length).toBe(1);
    // Outside the replaced function body nothing writes a row: the stranded
    // entrant is an owner decision recorded alongside this change, not a
    // settlement smuggled into a migration.
    const outside = SQL.replace(body, '').replace('$f08_fn_ca_settle_satellite_cohort$;', '');
    expect(outside).not.toMatch(/\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+public\./);
  });
});
