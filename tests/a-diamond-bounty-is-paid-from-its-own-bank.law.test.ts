/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A DIAMOND BOUNTY IS PAID FROM ITS OWN BANK
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 9 of the Diamond Arena programme, first piece: knockout and
 * progressive (PKO) bounties in Diamonds. The bounty bank was always in the
 * ledger (every entry's bounty part); this opens the three Diamond doors that
 * refused it by name, admits the two knockout formats at the creation door
 * under the chip door's rule, carries the head on the Diamond roster row, and
 * teaches six chip readers of "bounty paid" the Diamond ledger. The chip
 * knockout machinery - the engine's claim, fn_collect_bounty, the PKO half
 * rule, fn_finalize_bounty_pool - is reused whole.
 *
 * Every chip edit is in place with the live md5 pinned and the reverse
 * substitution proved; every Diamond door is pinned, redefined with the same
 * signature and declared to the guard watch; the switch is never opened; no
 * price is invented (the bounty is what staff enter, within the buy-in).
 */
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_a_diamond_bounty_is_paid_from_its_own_bank.sql'))
  .at(-1);
if (!NAME) throw new Error('the bounty-bank migration is missing');
const MIG = migrationText(NAME);

const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const section = (from: string, to: string) => sliceBetween(MIG, from, to);
const DRAIN = section(
  '-- 1. THE DRAIN LEARNS THE BOUNTY BANK',
  '-- 2. THE PAYER PAYS A BOUNTY FROM THE BOUNTY BANK'
);
const PAY = section(
  '-- 2. THE PAYER PAYS A BOUNTY FROM THE BOUNTY BANK',
  '-- 3. THE CHARGE CARRIES A BOUNTY PART'
);
const CHARGE = section(
  '-- 3. THE CHARGE CARRIES A BOUNTY PART',
  '-- 4. THE CREATION DOOR ADMITS A KNOCKOUT BOUNTY EVENT'
);
const DOOR = section(
  '-- 4. THE CREATION DOOR ADMITS A KNOCKOUT BOUNTY EVENT',
  "-- 5. THE REGISTRATION CORE'S DIAMOND ROSTER ROW CARRIES THE HEAD"
);
const ROSTER = section(
  "-- 5. THE REGISTRATION CORE'S DIAMOND ROSTER ROW CARRIES THE HEAD",
  '-- 6. SIX READERS OF "BOUNTY PAID" LEARN THE DIAMOND LEDGER'
);
const READERS = section(
  '-- 6. SIX READERS OF "BOUNTY PAID" LEARN THE DIAMOND LEDGER',
  '-- 7. THE ESTATE IS AS IT WAS'
);
const FINAL = code(section('-- 7. THE ESTATE IS AS IT WAS', 'RAISE NOTICE'));

const pinnedEdits = (s: string) => ({
  pins: (s.match(/IF md5\(v_def\) <> '[0-9a-f]{32}' THEN/g) ?? []).length,
  reversals: (s.match(/IF md5\(replace\(/g) ?? []).length,
});
const declared = (s: string, fn: string) =>
  s.includes(
    `fn_ca_declare_guard_redefinition('${fn}', 'migration a_diamond_bounty_is_paid_from_its_own_bank')`
  );

describe('LAW: a Diamond bounty is paid from its own bank', () => {
  it('opens nothing and invents no price', () => {
    expect(code(MIG)).not.toMatch(/SET\s+tournaments_enabled\s*=\s*true/i);
    expect(code(MIG)).toContain(
      'tournaments_enabled is already on somewhere; this migration expects it closed'
    );
    expect(FINAL).toContain('this migration must not open the tournament door');
    // the bounty is what staff enter; the only rule is the chip door's bound
    expect(code(DOOR)).not.toMatch(/bountyAmount[^\n]*\*\s*0\./);
    expect(code(DOOR)).toContain(
      "v_bounty_num := COALESCE((p_config->>'bountyAmount')::numeric,0);"
    );
  });

  it('the drain holds the bounty bank exactly as the prize and fee banks, pinned and declared', () => {
    expect(DRAIN).toContain("'f8331db31f22a439aceac81b6d221354'");
    expect(DRAIN).toContain("p_bank NOT IN ('prize','fee','bounty')");
    expect(DRAIN).toContain("WHEN p_bank='bounty' THEN l.bounty_part");
    expect(DRAIN).toContain(
      "AND m.request->>'action'='tournament_drain' AND m.request->>'bank'=p_bank"
    );
    expect(DRAIN).toContain(
      'SET CONSTRAINTS public.zzz_diamond_entry_custody_is_the_entry IMMEDIATE;'
    );
    expect(DRAIN).toContain('FROM PUBLIC, anon, authenticated, service_role;');
    expect(declared(DRAIN, 'fn_poker_diamond_tournament_drain')).toBe(true);
  });

  it('the payer pays a bounty from the bounty bank, in whole Diamonds, after opening the shadow from the ledger', () => {
    expect(PAY).toContain("'4abbd98ae4d70aab511834f3c9bfd8e8'");
    expect(PAY).not.toContain('diamond_tournament_bounties_not_open');
    expect(PAY).toContain(
      "v_bank := CASE WHEN v_kind='bounty' THEN v_e.bounty_balance ELSE v_e.prize_balance END;"
    );
    expect(PAY).toContain(
      'PERFORM public.fn_poker_diamond_tournament_open_shadow(p_tournament_id);'
    );
    expect(PAY).toContain(
      "p_tournament_id, v_kind, p_amount::bigint, 'poker-tournament-pay:'||p_idempotency_key"
    );
    expect(PAY).toContain("CASE WHEN v_kind='bounty' THEN p_amount::bigint ELSE 0 END,0,");
    expect(PAY).toContain(
      "PERFORM public.fn_ca_escrow_apply(p_tournament_id,'diamond bounty',p_bounty_out => p_amount);"
    );
    expect(PAY).toContain('diamond_tournament_pay_requires_whole_diamonds');
    expect(PAY).toContain('diamond_tournament_escrow_disagrees_with_custody');
    expect(declared(PAY, 'fn_poker_diamond_tournament_pay')).toBe(true);
  });

  it('the charge carries a bounty part and follows an open shadow', () => {
    expect(CHARGE).toContain("'086afbf5418dec38e69cc6d9f6321443'");
    expect(CHARGE).not.toContain('IF p_bounty <> 0 THEN');
    expect(CHARGE).toContain('OR p_prize + p_bounty + p_fee <> p_gross THEN');
    expect(CHARGE).toContain(
      'p_gross_in => p_gross, p_fee_entries_in => p_fee, p_bounty_in => p_bounty'
    );
    expect(CHARGE).toContain(
      'IF EXISTS (SELECT 1 FROM public.tournament_escrow x WHERE x.tournament_id=p_tournament_id) THEN'
    );
    expect(declared(CHARGE, 'fn_poker_diamond_tournament_charge')).toBe(true);
  });

  it("the creation door admits 'bounty' and 'progressive_bounty' under the chip door's rule and refuses the rest by name", () => {
    expect(DOOR).toContain("'23246b204df4183f77ff097b07839d92'");
    expect(DOOR).toContain("IF v_type NOT IN ('mtt','sng','bounty','progressive_bounty') THEN");
    expect(DOOR).toContain('diamond_tournament_format_not_open');
    expect(DOOR).toContain("(p_config->>'satelliteTargetId')");
    expect(DOOR).toContain("(p_config->>'freeBuy')");
    expect(DOOR).toContain("(p_config->>'guarantee')");
    expect(DOOR).toContain('diamond_tournament_bounty_requires_a_bounty_format');
    expect(DOOR).toContain(
      'IF v_bounty_num<>trunc(v_bounty_num) OR v_bounty_num<1 OR v_bounty_num>v_buy_in THEN'
    );
    expect(DOOR).toContain('diamond_tournament_requires_a_whole_bounty_within_the_buy_in');
    expect(DOOR).toContain("v_is_bounty, v_type='progressive_bounty', false, v_bounty,");
    expect(DOOR).toContain("'bounty_amount',v_bounty,'asset','diamonds'");
    expect(DOOR).toContain('IF NOT public.fn_is_platform_admin() THEN');
  });

  it('the Diamond roster row carries the head, in place', () => {
    expect(pinnedEdits(ROSTER)).toEqual({ pins: 1, reversals: 1 });
    expect(ROSTER).toContain("'1be2832d585daf91ee2bd7473b0f56e5'");
    expect(ROSTER).toContain(
      'current_bounty, mystery_bounty_value, bounties_collected, bounty_winnings)'
    );
    expect(ROSTER).toContain('v_head, 0, 0, 0)');
  });

  it('six chip readers of "bounty paid" learn the Diamond ledger, in place', () => {
    expect(pinnedEdits(READERS)).toEqual({ pins: 5, reversals: 5 });
    for (const pin of [
      '4546cd9cc782941527b9061dd68061d6',
      '1bfe7e44e13f02b482c752884024893a',
      '03cf1ababf460e38ffda77bdce247640',
      '60c5ab70c7a51d9de9d9177a760eef74',
      'ae1de9113a9e90a869c0a7eaf87d64ba',
    ]) {
      expect(READERS).toContain(`'${pin}'`);
    }
    // each Diamond leg reads the ledger through the escrow function; the chip reading is kept
    expect(
      (READERS.match(/fn_poker_diamond_tournament_escrow\(p_tournament_id\) e;/g) ?? []).length
    ).toBe(5);
    expect(READERS).toContain('SELECT e.bounty_balance INTO v_available');
    expect(READERS).toContain('SELECT e.bounty_out INTO v_paid');
    expect(READERS).toContain('SELECT e.bounty_out INTO v_bounty_before');
    expect(READERS).toContain('SELECT e.bounty_out INTO v_bounty_total');
    expect(READERS).toContain("WHERE l.tournament_id = t.id AND l.kind = ''bounty''), 0) AS paid");
    expect((READERS.match(/v_new\d? := v_old\d?\n/g) ?? []).length).toBe(5);
  });

  it('asserts at the end that the doors are not browser doors, the identity is whole and every watched guard is on its baseline', () => {
    expect(FINAL).toContain('still refuses the bounty bank by name');
    expect(FINAL).toContain('the drain does not hold the bounty bank');
    expect(FINAL).toContain('the payer does not pay from the bounty bank');
    expect(FINAL).toContain('the charge does not follow an open shadow');
    expect(FINAL).toContain(
      "'fn_collect_bounty','fn_finalize_bounty_pool','fn_complete_tournament_terminal_pre_seat_guard','fn_payout_guarantee_check','fn_ca_tournament_terminal_receipt'"
    );
    expect(FINAL).toContain('lost its chip reading');
    expect(FINAL).toContain('is a browser door');
    expect(FINAL).toContain('it is owner-only');
    expect(FINAL).toContain('the Diamond identity is not whole');
    expect(FINAL).toContain('watched guards off their baseline');
  });
});
