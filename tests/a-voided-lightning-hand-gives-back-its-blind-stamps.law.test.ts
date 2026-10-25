/**
 * LAW: A LIGHTNING HAND VOIDED BEFORE IT IS DEALT GIVES BACK ITS BLIND STAMPS
 * (2026-10-24).
 *
 * Dan, verbatim: "NEW PLAYERS SHOULD ALWAYS BE BB FIRST." The live matcher
 * decides "newcomer" and the big-blind order from
 * lightning_pool_slot.last_bb_at (NULL = never been the big blind, ranked
 * first), and fn_lightning_form_hand stamps it, with last_sb_at,
 * last_button_at, hands_since_bb and hands_since_sb, the moment a hand FORMS.
 *
 * A hand voided before begin_dealing posted nothing. The 20261007222717
 * remediation already gave its blind-ledger counts back; the pool-slot stamps
 * were kept, so the voided hand's big blind skipped a big blind everyone else
 * pays and a newcomer stopped being a newcomer without ever being dealt in the
 * big blind (24 voided hands in the 24 hours before this law).
 *
 * Migration 20261024231549 adds the reversal to the same trigger door every
 * abandon path crosses: each slot's stamps are recomputed from its own DEALT
 * hands, excluding the voided one; everyone else's hands-since counters are
 * decremented. This pins that SQL.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  'supabase/migrations/20261024231549_lightning_voided_hand_returns_its_blind_stamps.sql',
  'utf8'
);

describe('a voided Lightning hand gives back its blind stamps', () => {
  it('replaces the live trigger only from the definition it was qualified against', () => {
    expect(SQL).toContain("'public.fn_lightning_instance_releases_its_reservations()'");
    expect(SQL).toContain("want CONSTANT text := '232f8d4784738e52d18e9ecefb2cd567';");
    expect(SQL).toMatch(/IF md5\(s\) IS DISTINCT FROM want THEN\s*RAISE EXCEPTION/);
    expect(SQL).toMatch(/^BEGIN;$/m);
    expect(SQL).toMatch(/^COMMIT;$/m);
    expect(SQL).toContain("SET LOCAL lock_timeout = '1s';");
    expect(SQL).toMatch(/^-- @live-proof: .*A VOIDED HAND RETURNS ITS BLIND STAMPS/m);
  });

  it('acts only on a hand abandoned before it was dealt', () => {
    expect(SQL).toMatch(
      /A VOIDED HAND RETURNS ITS BLIND STAMPS[\s\S]*?IF NEW\.state = 'abandoned' AND NEW\.started_at IS NULL AND NEW\.hand_id IS NOT NULL THEN\s*UPDATE public\.lightning_pool_slot sl/
    );
  });

  it('gives back all five stamps formation wrote', () => {
    for (const stamp of [
      /last_bb_at\s*= CASE WHEN r\.was_bb\s+THEN r\.prev_bb_at\s+ELSE sl\.last_bb_at END/,
      /last_sb_at\s*= CASE WHEN r\.was_sb\s+THEN r\.prev_sb_at\s+ELSE sl\.last_sb_at END/,
      /last_button_at = CASE WHEN r\.was_btn THEN r\.prev_btn_at ELSE sl\.last_button_at END/,
      /hands_since_bb = CASE WHEN r\.was_bb THEN r\.dealt_since_bb\s+ELSE GREATEST\(sl\.hands_since_bb - 1, 0\) END/,
      /hands_since_sb = CASE WHEN r\.was_sb THEN r\.dealt_since_sb\s+ELSE GREATEST\(sl\.hands_since_sb - 1, 0\) END/,
    ]) {
      expect(SQL).toMatch(stamp);
    }
  });

  it('recomputes them from the slot’s own dealt hands, never the voided one', () => {
    const history =
      /WHERE x\.pool_slot_id = hp\.pool_slot_id\s+AND x\.hand_id <> NEW\.hand_id\s+AND i\.started_at IS NOT NULL/g;
    expect(SQL.match(history)?.length).toBe(2);
    // A slot with no dealt big blind is a newcomer again (max() of nothing is NULL).
    expect(SQL).toContain("max(d.formed_at) FILTER (WHERE d.blind_role = 'bb')  AS bb_at");
  });

  it('treats a horse exactly like a human (CLAUDE.md 10.5)', () => {
    expect(SQL.toLowerCase()).not.toMatch(/is_horse/);
  });
});
