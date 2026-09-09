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
  '20260909215641_non_satellite_terminal_settlement_commits_one_stored_receipt.sql'
);
const REBUY = read('20260909014433_spin_reserve_settlement_commits_its_journal_or_nothing.sql');
const HALVES = read('20260909012046_retire_the_six_stranded_half_chips_on_the_felt.sql');

describe('an unhandled conflict target no longer discards the hand', () => {
  /**
   * `tournament_knockout_candidates` carries TWO unique constraints, and the
   * insert named only one of them as its ON CONFLICT target. A paid rebuy now
   * advances `seat_joined_at` in the same transaction as its money, candidate,
   * roster and seat commit. The next bust is therefore a new immutable entry
   * generation and cannot collide with the prior chair identity.
   */
  it('keeps one candidate per global hand and advances a same-chair rebuy generation', () => {
    expect(CONFLICT).toMatch(
      /ON CONFLICT \(tournament_id,hand_number,eliminated_user_id\) DO NOTHING/
    );
    expect(CONFLICT).not.toMatch(
      /DROP CONSTRAINT(?: IF EXISTS)?\s+tournament_knockout_candidate_tournament_id_eliminated_user_key/
    );
    expect(REBUY).toMatch(/joined_at=clock_timestamp\(\),status='active'/);
    expect(REBUY).toMatch(/AND s\.joined_at=v_candidate\.seat_joined_at/);
    expect(CONFLICT).toMatch(/idx_tournament_knockout_candidates_user_hand/);
  });

  it('accepts only an exact replay of this hand after a conflict', () => {
    expect(CONFLICT).toMatch(/AND c\.hand_number=p_hand_number/);
    expect(CONFLICT).toMatch(/AND c\.hand_id=v_hand_id/);
    expect(CONFLICT).not.toMatch(/AND c2\.seat_joined_at=v_seat\.joined_at/);
  });

  it('uses a hard-coded source definition, not a catalog body rewrite', () => {
    expect(CONFLICT).not.toMatch(/pg_get_functiondef\([\s\S]*?replace\(v_src/);
    expect(CONFLICT).toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_ca_commit_hand_settlement_before_lease_generation/
    );
  });

  it('does not widen the grant: this writer is reachable only inside the definer chain', () => {
    expect(CONFLICT).toMatch(/FROM PUBLIC,anon,authenticated,service_role;/);
    expect(CONFLICT).not.toMatch(
      /GRANT EXECUTE ON FUNCTION\s+public\.fn_ca_commit_hand_settlement_before_lease_generation\([\s\S]*?TO service_role;/
    );
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
