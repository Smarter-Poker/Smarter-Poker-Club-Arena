/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A DIAMOND SPIN DRAWS A WHOLE PRIZE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 9 of the Diamond Arena programme: the Spin tournament format (three
 * seats, a multiplier drawn at launch, a prize pool of that multiplier times
 * the buy-in) in Diamonds - its draw and its reserve. Not the Diamond Spins
 * bonus wheel, which nothing here touches.
 *
 * The chip Spin authority stays the one authority: fn_spin_draw_and_settle_atomic
 * routes a Diamond Spin to its Diamond arm after its own lease, launch-receipt
 * and freeze proofs, and every other chip reserve path refuses or skips one by
 * name. The arm rolls over the multiplier table pinned when the Spin was
 * created, certifies a whole-Diamond prize pool and moves the difference from
 * the three entries against an authorized reserve source, in whole Diamonds, as
 * registered pairs inside the supply identity. No source is authorized: every
 * Diamond Spin is refused by name until a values migration quotes Dan.
 *
 * Every chip edit is an asserted substitution with the live md5 pinned and the
 * reverse proved; every Diamond door is pinned and redefined in full with the
 * same signature; the switch is never opened; nothing is priced.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_a_diamond_spin_draws_a_whole_prize.sql'))
  .at(-1);
if (!NAME) throw new Error('the Diamond Spin migration is missing');
const MIG = migrationText(NAME);

const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const section = (from: string, to: string) => sliceBetween(MIG, from, to);
const SOURCE = section(
  '-- 1. THE SOURCE UNDERWRITES ONLY WHAT IS AUTHORIZED',
  "-- 2. A DIAMOND SPIN'S TABLE IS PINNED WHEN IT IS CREATED"
);
const CONTRACT = section(
  "-- 2. A DIAMOND SPIN'S TABLE IS PINNED WHEN IT IS CREATED",
  '-- 3. THE LEDGER NAMES THE RESERVE LEGS'
);
const LEDGER = section(
  '-- 3. THE LEDGER NAMES THE RESERVE LEGS',
  '-- 4. THE RULE: A TABLE IS HONOURED IN WHOLE DIAMONDS OR IT IS REFUSED'
);
const RULE = section(
  '-- 4. THE RULE: A TABLE IS HONOURED IN WHOLE DIAMONDS OR IT IS REFUSED',
  '-- 5. THE CREATION DOOR ADMITS THE SPIN FORMAT'
);
const DOOR = section(
  '-- 5. THE CREATION DOOR ADMITS THE SPIN FORMAT',
  '-- 6. THE BANKS CARRY THE RESERVE LEGS'
);
const BANKS = section(
  '-- 6. THE BANKS CARRY THE RESERVE LEGS',
  '-- 7. THE DRAW: ONE AUTHORITY, ONE ROLL, ONE RECEIPT'
);
const DRAW = section(
  '-- 7. THE DRAW: ONE AUTHORITY, ONE ROLL, ONE RECEIPT',
  '-- 7b. The one authority routes a Diamond Spin to its arm'
);
const ROUTE = section(
  '-- 7b. The one authority routes a Diamond Spin to its arm',
  '-- 8. NO CHIP RESERVE TOUCHES A DIAMOND SPIN'
);
const NO_CHIP = section(
  '-- 8. NO CHIP RESERVE TOUCHES A DIAMOND SPIN',
  '-- 9. THE CONTRACT AND THE LAUNCH READ THE DIAMOND DRAW'
);
const LAUNCH = section(
  '-- 9. THE CONTRACT AND THE LAUNCH READ THE DIAMOND DRAW',
  '-- 10. A DRAWN SPIN GOES NOWHERE BUT TO ITS WINNERS'
);
const EXITS = section(
  '-- 10. A DRAWN SPIN GOES NOWHERE BUT TO ITS WINNERS',
  '-- 11. THE ESTATE IS AS IT WAS'
);
const FINAL = code(section('-- 11. THE ESTATE IS AS IT WAS', 'RAISE NOTICE'));

const pinnedEdits = (s: string) => ({
  pins: (s.match(/IF md5\(v_def\) <> '[0-9a-f]{32}' THEN/g) ?? []).length,
  reversals: (s.match(/IF md5\(replace\(/g) ?? []).length,
});
const doorPins = (s: string) => (s.match(/IF v_md5 <> '[0-9a-f]{32}' THEN/g) ?? []).length;

const ENGINE = (file: string) =>
  readFileSync(resolve(__dirname, '..', 'server', 'src', 'tournament', file), 'utf8');

describe('LAW: a Diamond Spin draws a whole prize', () => {
  it('opens nothing, authorizes nothing and prices nothing', () => {
    expect(code(MIG)).not.toMatch(/SET\s+tournaments_enabled\s*=\s*true/i);
    expect(code(MIG)).not.toMatch(/INSERT\s+INTO\s+public\.poker_diamond_spin_reserve_source/i);
    expect(FINAL).toContain('this migration must not authorize a reserve source');
    expect(FINAL).toContain('this migration must not open the tournament door');
    // the only account the source may name is the house, and only a ruling names it
    expect(SOURCE).toContain(
      "source_account text NOT NULL CHECK (source_account = 'diamond_house'),"
    );
    expect(SOURCE).toContain('ruling text NOT NULL CHECK (length(btrim(ruling)) >= 10),');
    expect(SOURCE).toContain(
      'REVOKE ALL ON TABLE public.poker_diamond_spin_reserve_source FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(SOURCE).toContain(
      'GRANT SELECT ON TABLE public.poker_diamond_spin_reserve_source TO service_role;'
    );
  });

  it('pins the table a Spin was created with, immutably, without locking the tournaments', () => {
    expect(CONTRACT).toContain('tournament_id uuid PRIMARY KEY,');
    expect(code(CONTRACT)).not.toMatch(/REFERENCES\s+public\.tournaments/i);
    expect(CONTRACT).toContain("rule_sha256 text NOT NULL CHECK (rule_sha256 ~ '^[0-9a-f]{64}$'),");
    expect(CONTRACT).toContain(
      'required_cover bigint NOT NULL CHECK (required_cover >= worst_excess),'
    );
    expect(CONTRACT).toContain('BEFORE UPDATE OR DELETE ON public.poker_diamond_spin_contracts');
    expect(CONTRACT).toContain("RAISE EXCEPTION 'A Diamond Spin contract is immutable'");
  });

  it('the ledger names the two reserve legs, prize bank only, per custody row', () => {
    expect(LEDGER).toContain("'refund', 'spin_underwrite', 'spin_surplus')),");
    expect(LEDGER).toContain(
      "OR (kind IN ('spin_underwrite','spin_surplus') AND user_id IS NOT NULL AND custody_id IS NOT NULL"
    );
    expect(LEDGER).toContain(
      'AND wallet_journal_id IS NOT NULL AND prize_part = amount AND bounty_part = 0 AND fee_part = 0));'
    );
    // both constraints are pinned to their live text before they are rebuilt
    expect(LEDGER).toContain('the ledger kind check is not the pinned text');
    expect(LEDGER).toContain('the ledger outflow check is not the pinned text');
  });

  it('the rule: the chip authority identity, the estate ladder, the blind ladder, whole Diamonds or a refusal by name', () => {
    expect(RULE).toContain('v_rake := public.fn_spin_rake_rate(p_buy_in);');
    expect(RULE).toContain("'diamond_spin_multiplier_table_invalid");
    expect(RULE).toContain("'diamond_spin_ladder_is_not_the_estate_ladder: ");
    expect(RULE).toContain("'diamond_spin_requires_its_blind_ladder");
    expect(RULE).toContain(
      "'diamond_spin_tier_not_whole_at_the_buy_in: %x at a buy-in of % Diamonds is a prize pool of % Diamonds'"
    );
    expect(RULE).toContain(
      "'diamond_spin_tier_not_whole_at_the_buy_in: %x place % takes % of a % Diamond pool'"
    );
    // the published table is certified whole at a buy-in of one Diamond, so at every whole buy-in
    expect(FINAL).toContain('the published Spin table no longer prices the approved edge');
    expect(FINAL).toContain('the published Spin table is not whole at a buy-in of one Diamond');
  });

  it("the creation door admits 'spin' under the chip seat-first door's rules and refuses a mismatch by name", () => {
    expect(doorPins(DOOR)).toBe(1);
    expect(DOOR).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_poker_diamond_create_tournament(p_config jsonb)'
    );
    expect(DOOR).toContain('RETURN public.fn_poker_diamond_create_spin(p_config, v_arena);');
    expect(DOOR).toContain(
      "IF p_config ?| ARRAY['spinTiers','spinMultiplier','spinLockedTiers','spin_multiplier','spin_locked_tiers'] THEN"
    );
    expect(DOOR).toContain("RAISE EXCEPTION 'diamond_tournament_spin_requires_a_spin_format'");
    for (const refusal of [
      "'diamond_spin_multiplier_is_drawn_not_configured'",
      "'diamond_spin_rejects_a_non_spin_configuration: %'",
      "'diamond_spin_is_three_handed'",
      "'diamond_spin_unsupported_variant'",
      "'diamond_spin_reserve_source_not_authorized'",
      "'diamond_spin_reserve_over_its_authorized_cap: ",
      "'diamond_spin_reserve_cannot_cover_the_table: ",
    ]) {
      expect(DOOR).toContain(refusal);
    }
    expect(DOOR).toContain(
      "IF v_key NOT IN ('type','name','gameVariant','buyIn','startingStack','blindStructure','spinTiers',"
    );
    expect(DOOR).toContain("IF v_game NOT IN ('NLH','PLO4','PLO5','PLO6') THEN");
    expect(DOOR).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_create_tournament(jsonb) TO authenticated, service_role;'
    );
  });

  it('the banks carry the legs: the escrow, the chip shadow convention, the shadow and the drain', () => {
    expect(pinnedEdits(BANKS)).toEqual({ pins: 1, reversals: 1 });
    expect(doorPins(BANKS)).toBe(3);
    expect(BANKS).toContain(
      '(prize_in + spin_underwrite - spin_surplus - prize_out - refund_prize)::numeric,'
    );
    expect(BANKS).toContain('e.prize_balance - r.spin_underwrite + r.spin_surplus');
    expect(BANKS).toContain('OR v_x.reserve_in IS DISTINCT FROM l.spin_underwrite::numeric');
    expect(BANKS).toContain('OR v_x.reserve_out IS DISTINCT FROM l.spin_surplus::numeric');
    expect(BANKS).toContain("l.kind IN ('entry','rebuy','reentry','addon','spin_underwrite')");
    expect(BANKS).toContain(
      "CASE WHEN p_bank='prize' THEN 'arena_spin_surplus' ELSE 'tournament_fee' END,"
    );
  });

  it('the draw: one roll over the pinned table, a whole pool, the legs against the authorized source, one receipt', () => {
    expect(DRAW).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_poker_diamond_spin_draw(p_tournament_id uuid, p_launch_id uuid, p_lease_generation uuid)'
    );
    expect(DRAW).toContain(
      "v_roll := (('x' || encode(extensions.gen_random_bytes(6), 'hex'))::bit(48)::bigint)::numeric"
    );
    expect(DRAW).toContain(
      "RETURN jsonb_build_object('ok', false, 'reason', 'diamond_spin_contract_missing');"
    );
    for (const reason of [
      "'reason', 'diamond_spin_reserve_source_not_authorized'",
      "'reason', 'diamond_spin_reserve_over_its_authorized_cap'",
      "'reason', 'diamond_spin_reserve_cannot_cover_the_table'",
    ]) {
      expect(DRAW).toContain(reason);
    }
    expect(DRAW).toContain(
      'v_prize := public.fn_ca_unit_floor_cents(trunc(v_cents)::bigint, 100) / 100;'
    );
    expect(DRAW).toContain('IF v_residue <> 0 OR v_prize < 1 THEN');
    expect(DRAW).toContain("'diamond_spin_prize_not_whole_at_the_unit: ");
    // the underwriting is a house burn and a player-side mint; the surplus a player-side burn and a house mint
    expect(DRAW).toContain(
      "('poker-spin-underwrite:' || p_tournament_id::text, 'burn', 'diamonds', 'house', c_house, 'the house',"
    );
    expect(DRAW).toContain(
      "('poker-spin-surplus:' || p_tournament_id::text, 'mint', 'diamonds', 'house', c_house, 'the house',"
    );
    expect(DRAW).toContain(
      "VALUES (v_c.user_id, 'arena_spin_underwrite', 'arena_spin_underwrite', v_take::integer, v_wallet,"
    );
    expect(DRAW).toContain(
      'INSERT INTO public.spin_draw_receipts(tournament_id, launch_id, lease_generation,'
    );
    // owner-only: reached through the one authority and nothing else
    expect(DRAW).toContain(
      'REVOKE ALL ON FUNCTION public.fn_poker_diamond_spin_draw(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;'
    );
  });

  it('exactly one draw authority: the atomic authority routes a Diamond Spin to its arm after its own proofs', () => {
    expect(pinnedEdits(ROUTE)).toEqual({ pins: 1, reversals: 1 });
    expect(ROUTE).toContain("'19e06d2d13a5f53cd7c59686802dae4a'");
    expect(ROUTE).toContain('public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)');
    expect(ROUTE).toContain(
      'RETURN public.fn_poker_diamond_spin_draw(p_tournament_id, p_launch_id, p_lease_generation);'
    );
    // after the freeze answer, which comes after the lease and the launch receipt
    expect(ROUTE).toContain("''reason'', ''entry_purchases_frozen''");
    expect(FINAL).toContain('the Spin draw authority does not route a Diamond Spin to its arm');
  });

  it('no chip reserve touches a Diamond Spin: two chip doors refuse it by name, the sweep and the third seat skip it', () => {
    expect(pinnedEdits(NO_CHIP)).toEqual({ pins: 4, reversals: 4 });
    for (const pin of [
      "'366a1981c2ea9f0f54b41fe50a5d19b4'",
      "'f1f01a7719faac3b426e6358a37c5873'",
      "'2b5c7761a1a1ed132f90c66b5a228b7f'",
      "'0e4acaf0ff080d4dafd1aa85068cf0b2'",
    ]) {
      expect(NO_CHIP).toContain(pin);
    }
    expect((NO_CHIP.match(/diamond_spin_is_drawn_by_its_own_authority/g) ?? []).length).toBe(2);
    expect(
      (NO_CHIP.match(/AND NOT public\.fn_poker_diamond_tournament\(t\.id\)/g) ?? []).length
    ).toBe(2);
    expect(NO_CHIP).toContain('AND NOT public.fn_poker_diamond_tournament(p_tournament_id) THEN');
    expect(FINAL).toContain('does not refuse a Diamond Spin');
    expect(FINAL).toContain('the unbooked sweep does not skip a Diamond Spin in both of its reads');
    expect(FINAL).toContain('the third seat would book a chip entry for a Diamond Spin');
  });

  it('the contract trigger and the launch completion read the Diamond draw', () => {
    expect(pinnedEdits(LAUNCH)).toEqual({ pins: 2, reversals: 2 });
    expect(LAUNCH).toContain("'747fc99476b082256141d42003a6c478'");
    expect(LAUNCH).toContain("'d1a25ca8de559144fe83b7639634baff'");
    expect(LAUNCH).toContain(
      'public.fn_poker_diamond_spin_draw_proof(p_tournament_id, p_launch_id)'
    );
    expect(FINAL).toContain('the Spin contract trigger does not read the Diamond draw');
    expect(FINAL).toContain('the launch completion does not prove a Diamond draw');
  });

  it('a drawn Spin is refunded by no door', () => {
    expect(doorPins(EXITS)).toBe(1);
    expect(EXITS).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_refund(p_tournament_id uuid, p_user_id uuid, p_kind text, p_source text, p_request_id uuid)'
    );
    expect(EXITS).toContain("l.kind IN ('spin_underwrite','spin_surplus')) THEN");
    expect(EXITS).toContain(
      "RAISE EXCEPTION 'diamond_spin_entry_already_booked' USING ERRCODE='55000';"
    );
  });

  it('asserts at the end that every edit landed, no new door is open, the identity is whole and every watched guard is on its baseline', () => {
    expect(FINAL).toContain('is not the text this migration wrote');
    expect(FINAL).toContain('is reachable without an account');
    expect(FINAL).toContain('is a browser door');
    expect(FINAL).toContain('is reachable by the engine; it is owner-only');
    expect(FINAL).toContain(
      'a Diamond Spin table is writable by the engine or readable from a browser'
    );
    expect(FINAL).toContain('the Diamond identity is not whole');
    expect(FINAL).toContain('watched guards off their baseline');
  });

  it("the engine's Spin paid-gate reads a Diamond Spin's custody entries, and the draw's reserve refusals park the launch", () => {
    const manager = ENGINE('TournamentManagerBase.ts');
    expect(manager).toContain(
      'const paidEvidenceIsDiamond = this.tournamentUnit() === DIAMOND_UNIT_CENTS;'
    );
    expect(manager).toContain(".from('poker_diamond_tournament_ledger')");
    expect(manager).toContain(".select('user_id, gross:amount, created_at')");
    expect(manager).toContain(".eq('kind', 'entry')");
    // the chip evidence, and its reveal anchor, are unchanged
    expect(manager).toContain(".eq('charge_category', 'tournament_buyin')");
    const parking = ENGINE('spinLaunchParking.ts');
    const terminal = sliceBetween(parking, 'export const SPIN_DRAW_TERMINAL_REASONS', ']);');
    for (const reason of [
      'diamond_spin_reserve_source_not_authorized',
      'diamond_spin_reserve_over_its_authorized_cap',
      'diamond_spin_reserve_cannot_cover_the_table',
      'diamond_spin_contract_missing',
    ]) {
      expect(terminal).toContain(`'${reason}'`);
    }
  });
});
