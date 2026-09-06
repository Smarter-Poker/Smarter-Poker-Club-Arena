/**
 * THE BOARD TELLS THE TRUTH (chip standard, the board clearance, 2026-09-06).
 * Pinned on the migrations mirrored byte-exact from production.
 *
 * LAW 1 - THE OVERLAY A TOURNAMENT WAS FUNDED BY IS READ FROM THE JOURNAL.
 *   Two paths fund a guarantee: fn_apply_prize_guarantee writes a
 *   tournament_guarantee_overlays row, fn_ca_fund_overlay_on_lock writes a
 *   chip_ledger leg. fn_tournament_conservation_delta must read the journal,
 *   and must take the GREATEST of the two rather than their sum, because a
 *   sum would double-count the day an event ever carries both.
 *
 * LAW 2 - A HAND THAT CANNOT NAME ITSELF BY ID STILL NAMES ITSELF BY TABLE
 *   AND NUMBER. atomic_distribute_rake keyed both of its idempotency guards on
 *   p_hand_id, and both switch themselves off when it is NULL: ON CONFLICT
 *   (hand_id) WHERE hand_id IS NOT NULL cannot refuse a NULL, and a leg key of
 *   COALESCE(p_hand_id, gen_random_uuid()) cannot collide with anything. That
 *   produced 4,452 duplicate rake rows carrying 16,426.46 of rake that no hand
 *   ever dropped. The leg key must be DERIVED, never random.
 *
 * LAW 3 - THE FROZEN POOL BASELINE MOVES ONLY WITH A REASON WRITTEN BESIDE IT.
 *   ca_frozen_pool_baseline may be moved, and only alongside a row in
 *   ca_frozen_pool_baseline_changes naming the amount and the migration. A
 *   trigger refuses any other change, so the guard cannot be quietly disarmed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(HERE, '../supabase/migrations');
const load = (re: RegExp): string => {
  const f = readdirSync(MIG).find((n) => re.test(n));
  if (!f) throw new Error(`not mirrored: ${re}`);
  return readFileSync(resolve(MIG, f), 'utf8');
};

describe('the board tells the truth', () => {
  it('LAW 1: the conservation delta reads the overlay out of the journal, and takes the greatest', () => {
    const s = load(/^\d{14}_the_overlay_a_tournament_was_funded_by_is_read_from_the_jour\.sql$/);
    expect(s).toContain('CREATE OR REPLACE FUNCTION public.fn_tournament_conservation_delta(');
    // the journal is read
    expect(s).toMatch(/FROM public\.chip_ledger l\s+WHERE l\.tournament_id = t\.id/);
    expect(s).toMatch(/AND l\.category = 'overlay'/);
    expect(s).toMatch(/AND l\.to_type = 'prize_liability'/);
    // and the side table is still read, under GREATEST and never a sum
    expect(s).toContain('GREATEST(');
    expect(s).toContain('public.tournament_guarantee_overlays o');
    const term = s.slice(s.indexOf('GREATEST('), s.indexOf('AS funded_overlay'));
    expect(term, 'the two records of one funding are never added').not.toMatch(
      /\)\s*\+\s*COALESCE\(\(SELECT o\.amount/
    );
    // and the migration proves itself against the board it measured
    expect(s).toMatch(/RAISE EXCEPTION 'still % short bounty-family events in the last 36 hours'/);
  });

  it('LAW 2: the rake door resolves the hand, and its leg key is derived rather than random', () => {
    const s = load(/^\d{14}_a_hand_that_cannot_name_itself_by_id_still_names_itself_by_t\.sql$/);
    expect(s).toContain('CREATE OR REPLACE FUNCTION public.atomic_distribute_rake(');

    // it asks hand_history for the id before giving up on it
    expect(s).toMatch(
      /SELECT h\.id INTO p_hand_id\s+FROM public\.hand_history h\s+WHERE h\.table_id = p_table_id\s+AND h\.hand_number = p_hand_number/
    );

    // a second unlinked row for the same table and hand number is refused
    expect(s).toMatch(/AND \(rr\.metadata->>'hand_number'\) = p_hand_number::text/);
    expect(s).toMatch(/RETURN QUERY SELECT false, true, false, v_dup_id/);

    // THE PIN THAT MATTERS: the leg key is derived from the hand's own name.
    expect(s).toContain("md5('rake:' || p_table_id::text || ':' || p_hand_number::text)::uuid");
    // lastIndexOf, because the header quotes the OLD line it is replacing.
    const leg = s.slice(
      s.lastIndexOf('v_leg_key := COALESCE('),
      s.lastIndexOf("PERFORM set_config('app.ledger_settlement'")
    );
    expect(leg, 'a random leg key can never collide, so it can never dedupe').not.toMatch(
      /COALESCE\(\s*p_hand_id,\s*gen_random_uuid\(\)\s*\)/
    );

    // and it was proved before it committed, in a sub-block that was rolled back
    expect(s).toMatch(/ZZ_PROBE_BAD: two calls left % rake rows, expected 1/);
    expect(s).toMatch(/RAISE EXCEPTION 'ZZ_PROBE_OK'/);
  });

  it('LAW 3: the frozen pool baseline cannot move without a recorded reason', () => {
    const s = load(/^\d{14}_the_frozen_pool_baseline_moves_only_with_a_reason_written_be\.sql$/);
    expect(s).toContain('CREATE TABLE IF NOT EXISTS public.ca_frozen_pool_baseline_changes');
    expect(s).toContain('CREATE OR REPLACE FUNCTION public.fn_ca_frozen_baseline_needs_a_reason()');
    expect(s).toMatch(
      /CREATE TRIGGER zz_ca_frozen_baseline_needs_a_reason\s+BEFORE UPDATE OR DELETE ON public\.ca_frozen_pool_baseline/
    );
    expect(s).toMatch(/may not move from % to % without a row in ca_frozen_pool_baseline_changes/);
    // the guard keeps its sensitivity: the baseline is moved by the measured
    // amount and only after the migration has checked that amount itself
    expect(s).toMatch(/IF round\(v_before - v_after, 2\) <> 10700\.00 THEN/);
  });
});
