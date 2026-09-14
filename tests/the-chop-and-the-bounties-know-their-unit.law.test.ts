/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - THE CHOP AND THE BOUNTIES FLOOR TO A UNIT, NOT TO A CENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three of the eight division sites the Phase 8 audit found, and the last
 * three in SQL. All three had the same shape: floor a proportional share to a
 * CENT, and hand the remainder to a designated party.
 *
 *   the chip chop      floor(chips * undistributed / total_chips), residual to
 *                      the chip leader. Proportional to PLAY-CHIP STACKS, so
 *                      almost never a whole anything.
 *   the bounty chop    floor(cents * weight / total_weight), last claimant
 *                      takes the rest.
 *   the PKO half       share / 2, the head keeping the odd cent. A 1 Diamond
 *                      bounty was 50 cents cash and 50 cents to the head.
 *
 * THE CHANGE AT EACH SITE IS ONE WRAP, and that is the point rather than a
 * convenience. Because the only thing inserted anywhere is a call to
 * fn_ca_unit_floor_cents, the entire chip-invariance argument collapses into a
 * single claim that can be proved exhaustively: at a unit of one cent that
 * function is the identity. Three separate hand-checked rewrites would each
 * have needed their own argument.
 *
 * WHERE A DIAMOND CANNOT BE SPLIT, THE CHOP REFUSES RATHER THAN ROUNDS. The
 * chip chop already raised on a non-positive share, and that guard is kept
 * untouched, so a Diamond chop that cannot give every player a whole Diamond
 * refuses deterministically and the tournament plays on. That is the right
 * answer HERE and the wrong answer for the prize ladder, which pays what it
 * can: the difference is whether the players have somewhere to go if the
 * answer is no. A deal is voluntary; a finished tournament is not.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MIGRATIONS = resolve(__dirname, '..', 'supabase', 'migrations');
const file = readdirSync(MIGRATIONS)
  .filter((n) => n.endsWith('_the_chop_and_the_bounties_know_their_unit.sql'))
  .sort()
  .at(-1);
if (!file) throw new Error('the chop and bounties migration is missing');

/** The header discusses every string asserted below; prose is not the rule. */
const executable = readFileSync(join(MIGRATIONS, file), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/--[^\n]*/g, ' ');

describe('LAW: the chop and the bounties floor to a unit', () => {
  it('sends all three sites through the one floor, with the tournament unit', () => {
    const floors = executable.match(/fn_ca_unit_floor_cents/g) ?? [];
    const units = executable.match(/fn_ca_tournament_unit_cents\(p_tournament_id\)/g) ?? [];
    // Three rewrites, plus the identity proof that exercises the floor.
    expect(floors.length).toBeGreaterThanOrEqual(3);
    expect(units.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps the chip chop refusing a share it cannot pay', () => {
    // A Diamond chop that cannot give everybody a whole Diamond must stop,
    // not pay somebody nothing.
    expect(executable).toContain('chip chop gives rank % a nonpositive share');
  });

  it('keeps every residual rule it did not set out to change', () => {
    expect(executable).toContain(
      'v_remainder_cents := v_undistributed_cents - v_distributed_cents;'
    );
    expect(executable).toContain('v_share_cents := v_cents - v_assigned_cents;');
    expect(executable).toContain('v_to_head := (v_share_cents - v_cash_cents) / 100.0;');
  });

  it('leaves a non-positive bounty share exactly as it found it', () => {
    // fn_ca_unit_floor_cents answers 0 for a non-positive input, and the loop
    // distinguishes a zero share from a negative one, so the wrap is guarded.
    expect(executable).toMatch(
      /IF v_share_cents > 0 THEN\s+v_share_cents := public\.fn_ca_unit_floor_cents\(/
    );
  });

  it('proves the chip path rather than asserting it', () => {
    // The identity at one cent is what makes all three rewrites no-ops for
    // chips, so the migration must actually check it.
    expect(executable).toMatch(/fn_ca_unit_floor_cents\(x, 1\) IS DISTINCT FROM x/);
    expect(executable).toMatch(/generate_series\(1, 20000\)/);
    expect(executable).toContain('the unit floor is not the identity at one cent');
  });

  it('checks the Diamond half is whole and never exceeds its input', () => {
    expect(executable).toMatch(/fn_ca_unit_floor_cents\(x, 100\) % 100 <> 0/);
    expect(executable).toMatch(/fn_ca_unit_floor_cents\(x, 100\) > x/);
  });
});
