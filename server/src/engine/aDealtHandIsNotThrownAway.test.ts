/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A DEALT HAND IS NOT THROWN AWAY (2026-09-09)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ServerTableEngine.authoritative_hand_semantic_refusal` filed 312 critical
 * `financial_alerts` rows in three hours and killed 37 table engines in twenty
 * minutes. Every one of them discarded a hand that had already been dealt,
 * played and settled. Two distinct causes, both pinned here.
 *
 * The alerts began at 21:27 UTC on 2026-09-08, before the 22:53 database
 * outage - they are not outage damage.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATIONS = resolve(__dirname, '../../../supabase/migrations');
const read = (f: string) => readFileSync(resolve(MIGRATIONS, f), 'utf8');

const CONFLICT = read(
  '20260909011642_a_second_bust_on_the_same_chair_does_not_throw_away_the_hand.sql'
);
const HALVES = read('20260909012046_retire_the_six_stranded_half_chips_on_the_felt.sql');

describe('an unhandled conflict target no longer discards the hand', () => {
  /**
   * `tournament_knockout_candidates` carries TWO unique constraints, and the
   * insert named only one of them as its ON CONFLICT target. An ON CONFLICT with
   * an explicit target does not absorb a violation of any other constraint, so a
   * second bust from the SAME chair - the ordinary rebuy shape, because a rebuy
   * credits chips without moving `seat_joined_at` - raised, and the raise took
   * the whole atomic hand commit with it.
   */
  it('absorbs every unique violation rather than one of them', () => {
    expect(CONFLICT).toMatch(/v_new_conflict CONSTANT text :=\s*\n?\s*'ON CONFLICT DO NOTHING'/);
    expect(CONFLICT).toMatch(
      /v_old_conflict CONSTANT text :=\s*\n?\s*'ON CONFLICT \(tournament_id,hand_number,eliminated_user_id\) DO NOTHING'/
    );
  });

  it('teaches the identity re-check to accept the same seat generation', () => {
    // Absorbing the conflict alone would swap a constraint violation for a
    // hand-killing RAISE, because the re-check verified an exact replay of THIS
    // hand and a second bust is a different hand number.
    expect(CONFLICT).toMatch(/AND c2\.eliminated_user_id=v_uid/);
    expect(CONFLICT).toMatch(/AND c2\.seat_joined_at=v_seat\.joined_at\) THEN/);
  });

  it('refuses to run if the live definition is not the shape it expects', () => {
    expect(CONFLICT).toMatch(
      /IF position\(v_old_conflict in v_src\) = 0 THEN\s*\n\s*RAISE EXCEPTION/
    );
    expect(CONFLICT).toMatch(/IF position\(v_old_check in v_src\) = 0 THEN\s*\n\s*RAISE EXCEPTION/);
    expect(CONFLICT).toMatch(/RAISE EXCEPTION 'the replacement did not take'/);
    expect(CONFLICT).toMatch(/a landmark of the hand settlement went missing/);
  });

  it('does not widen the grant: this writer is reachable only inside the definer chain', () => {
    expect(CONFLICT).toMatch(/FROM PUBLIC, anon, authenticated;/);
    expect(CONFLICT).not.toMatch(/GRANT EXECUTE[\s\S]*TO service_role/);
  });
});

describe('the stranded half-chips are retired without minting or burning one', () => {
  it('pairs the halves and gives the whole chip to the earlier seat', () => {
    expect(HALVES).toMatch(
      /row_number\(\) OVER \(PARTITION BY tournament_id ORDER BY table_id, seat_number\)/
    );
    expect(HALVES).toMatch(
      /WHEN f\.rn % 2 = 1 THEN ceil\(f\.stack_before\) ELSE floor\(f\.stack_before\)/
    );
  });

  it('leaves an odd-count tournament alone rather than guessing half a chip', () => {
    expect(HALVES).toMatch(/DELETE FROM zz_frac WHERE per_tournament % 2 = 1/);
    expect(HALVES).toMatch(/v_odd/);
  });

  it('asserts conservation over the rows it touched, and aborts otherwise', () => {
    expect(HALVES).toMatch(/IF v_after <> v_before THEN\s*\n\s*RAISE EXCEPTION/);
    expect(HALVES).toMatch(/refusing to commit: the seats this touched moved from/);
    // The baseline must be the locked rows, NOT a platform-wide total: live play
    // moves that between two reads, which is what aborted the first attempt.
    expect(HALVES).toMatch(/SELECT coalesce\(sum\(stack_before\), 0\) INTO v_before FROM zz_frac;/);
  });

  it('locks the rows before ranking them', () => {
    const lockAt = HALVES.indexOf('FOR UPDATE OF ts;');
    const rankAt = HALVES.indexOf('CREATE TEMP TABLE zz_frac');
    expect(lockAt).toBeGreaterThan(0);
    expect(rankAt).toBeGreaterThan(lockAt);
  });

  it('is one transaction, per the production DDL policy', () => {
    for (const [name, sql] of [
      ['conflict', CONFLICT],
      ['halves', HALVES],
    ] as const) {
      expect(sql.match(/^BEGIN;/gm) ?? [], name).toHaveLength(1);
      expect(sql.match(/^COMMIT;/gm) ?? [], name).toHaveLength(1);
    }
  });
});
