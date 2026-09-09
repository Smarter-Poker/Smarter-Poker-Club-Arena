/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SAME TRAP, ONE LEVEL DOWN (2026-09-09)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * #3912 taught `proveTournamentLaunchSetup` that a zero stack is a BUST, not an
 * uncredited field, and asserted conservation instead. It did not land: the
 * wedged Spins moved straight to the next refusal, because
 * `fn_complete_tournament_launch_before_lease_generation` carried the identical
 * `chips <= 0` rule in SQL - twice, once for the roster and once for the felt.
 * `Tournament.launch_setup_unproven` simply became
 * `Tournament.launch_completion_unproven (launch_roster_unproven)`, 24 in six
 * minutes.
 *
 * CLAUDE.md 10.86 rule 4: "a fix that leaves the same trap one level up has not
 * landed. When you fix something, ask what the next person will reach for, and
 * check that it works."
 *
 * This pins that the two halves agree, so neither can be relaxed alone.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = readFileSync(resolve(__dirname, './TournamentManagerBase.ts'), 'utf8');
const MIGRATION = readFileSync(
  resolve(
    __dirname,
    '../../../supabase/migrations/20260909020315_the_launch_completion_tells_a_bust_from_an_uncredited_stack.sql'
  ),
  'utf8'
);

describe('the engine proof and the database completion apply the same rule', () => {
  it('neither refuses a roster row merely for holding zero', () => {
    // engine
    expect(BASE).toMatch(/Number\(row\.chips\) < 0/);
    expect(BASE).not.toMatch(/Number\(row\.chips\) <= 0/);
    // database
    expect(MIGRATION).toMatch(/v_new_roster\s+CONSTANT text := 'OR COALESCE\(p\.chips, 0\) < 0'/);
    expect(MIGRATION).toMatch(/v_old_roster\s+CONSTANT text := 'OR COALESCE\(p\.chips, 0\) <= 0'/);
  });

  it('neither refuses a seat merely for holding zero', () => {
    expect(BASE).toMatch(/Number\(seat\.stack\) < 0/);
    expect(MIGRATION).toMatch(/v_new_seat\s+CONSTANT text := 'OR COALESCE\(s\.stack, 0\) < 0'/);
    expect(MIGRATION).toMatch(/v_old_seat\s+CONSTANT text := 'OR COALESCE\(s\.stack, 0\) <= 0'/);
  });

  it('both assert conservation against starting_chips instead', () => {
    expect(BASE).toMatch(/const expectedFloor = fundingFieldSize \* startingChips;/);
    expect(BASE).toMatch(/launchStacksMeetFundingFloor\([\s\S]*?fundingFieldSize/);
    expect(MIGRATION).toMatch(/v_active_count \* COALESCE\(/);
    expect(MIGRATION).toMatch(/t2\.starting_chips/);
    // roster AND felt, because both carried the per-row rule
    expect(MIGRATION).toMatch(/FROM public\.tournament_players p2/);
    expect(MIGRATION).toMatch(/FROM public\.table_seats s2/);
  });

  it('an uncredited field is still refused, under its own reason', () => {
    expect(MIGRATION).toMatch(/'launch_stacks_uncredited'/);
    expect(BASE).toMatch(/the playing roster holds no chips at all/);
  });

  it('refuses to run if the live definition is not the shape it expects', () => {
    expect(MIGRATION).toMatch(/the live definition is not the shape this migration expects/);
    expect(MIGRATION).toMatch(/RAISE EXCEPTION 'the replacement did not take'/);
    expect(MIGRATION).toMatch(/RAISE EXCEPTION 'a proof went missing in the edit'/);
  });

  it('keeps every other launch proof the completion performs', () => {
    for (const reason of [
      'launch_receipt_state_mismatch',
      'launch_roster_unproven',
      'launch_seats_unproven',
      'launch_tables_unproven',
      'launch_spin_settlement_unproven',
    ]) {
      expect(MIGRATION, reason).toContain(reason);
    }
  });

  it('does not widen the grant, and is one transaction', () => {
    expect(MIGRATION).toMatch(/FROM PUBLIC, anon, authenticated;/);
    expect(MIGRATION).not.toMatch(/GRANT EXECUTE[\s\S]*TO (service_role|authenticated|anon)/);
    expect(MIGRATION.match(/^BEGIN;/gm) ?? []).toHaveLength(1);
    expect(MIGRATION.match(/^COMMIT;/gm) ?? []).toHaveLength(1);
  });
});
