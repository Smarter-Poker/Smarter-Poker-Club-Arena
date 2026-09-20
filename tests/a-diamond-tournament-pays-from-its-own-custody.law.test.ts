/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A DIAMOND TOURNAMENT PAYS FROM ITS OWN CUSTODY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 8 of the Diamond Arena programme, second half: the settlement. The
 * chip estate's one terminal path (fn_complete_tournament_terminal ->
 * fn_settle_tournament_places -> fn_settle_tournament_obligation ->
 * fn_credit_and_log, then fn_settle_tournament_rake) is kept, and only its
 * two last steps - where a prize is credited and where the fee goes - are
 * answered for a Diamond event by draining the event's own custody rows.
 *
 * What this law keeps true, against the migration text the estate was built
 * from (the live definitions were verified at apply time; every chip function
 * touched is edited in place with its md5 pinned and the reverse substitution
 * proved, so the chip credit, the chip receipt and the chip rake destinations
 * are byte for byte what they were):
 *
 *   1. A prize is whole Diamonds, from the PRIZE parts of the custody rows,
 *      oldest first, into the winner's wallet as arena_withdraw (a move inside
 *      the player supply: the register does not follow it), under the same
 *      credit key the chip credit claims, with the same tournament_payouts
 *      evidence row, capped by the same bank.
 *   2. The fee is each player's OWN fee part, out of their own row, journaled
 *      as that player's spend (the register retires it) and minted to the
 *      house in the register: players + house + custody = register, before
 *      and after. A bounty is refused by name until Phase 9.
 *   3. Every drained row records a release movement naming its bank, and the
 *      entry guard P0814 (an entry holds exactly its movements) is checked at
 *      the end of each drain, not at commit: a row drained twice in one
 *      settlement would otherwise present its first version against the final
 *      movement sum and refuse the whole terminal. Found by firing the deferred
 *      guard at every simulated commit boundary in the rehearsal.
 *   4. The escrow shadow (tournament_escrow) a Diamond event never had opens at
 *      the start of its terminal settlement, copied from the Diamond ledger
 *      with its exact refund parts (the chip shadow's proportional split is
 *      not that when an add-on carried no fee), so the terminal writer's
 *      exact-zero close and the receipt reader's checks hold unchanged.
 *   5. The internal steps are owner-only: no client role, the service role
 *      included, can call the drain, the pay, the fee, the close or the shadow.
 *   6. Nothing is opened: tournaments_enabled stays false and the migration
 *      refuses an estate that already carries a settlement row.
 */
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween, sliceDollarQuoted } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_a_diamond_tournament_pays_from_its_own_custody.sql'))
  .at(-1);
if (!NAME) throw new Error('the tournament-payout custody migration is missing');
const MIG = migrationText(NAME);

/** Comments carry no behaviour. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const section = (from: string, to: string) => sliceBetween(MIG, from, to);

const ESTATE = code(sliceBetween(MIG, 'Never reapply.', '-- 1. THE DRAIN'));
const DRAIN = code(sliceDollarQuoted(section('-- 1. THE DRAIN', '-- 2. THE PRIZE'), '$function$'));
const PAY = code(sliceDollarQuoted(section('-- 2. THE PRIZE', '-- 3. THE FEE'), '$function$'));
const FEE = code(sliceDollarQuoted(section('-- 3. THE FEE', '-- 4. CLOSING'), '$function$'));
const CLOSE = code(sliceDollarQuoted(section('-- 4. CLOSING', '-- 4b. THE SHADOW'), '$function$'));
const SHADOW = code(
  sliceDollarQuoted(section('-- 4b. THE SHADOW', '-- 5. fn_credit_and_log'), '$function$')
);
const CREDIT = section('-- 5. fn_credit_and_log', '-- 6. fn_settle_tournament_rake');
const RAKE = section('-- 6. fn_settle_tournament_rake', '-- 7. THE TERMINAL WRITER');
const WRITER = section('-- 7. THE TERMINAL WRITER', '-- 8. THE TERMINAL RECEIPT READER');
const READER = section('-- 8. THE TERMINAL RECEIPT READER', '-- 9. THE ESTATE IS AS IT WAS');
const FINAL = code(section('-- 9. THE ESTATE IS AS IT WAS', 'RAISE NOTICE'));

/** Every in-place edit of a chip function pins the live md5 and proves the reverse substitution. */
const pinnedEdits = (s: string) => ({
  pins: (s.match(/IF md5\(v_def\) <> '[0-9a-f]{32}' THEN/g) ?? []).length,
  reversals: (s.match(/IF md5\(replace\(/g) ?? []).length,
});

const INTERNAL_STEPS = [
  'fn_poker_diamond_tournament_drain(uuid,text,bigint,text,text,uuid)',
  'fn_poker_diamond_tournament_pay(uuid,numeric,text,text,uuid,text)',
  'fn_poker_diamond_tournament_settle_fee(uuid,text)',
  'fn_poker_diamond_tournament_close_custody(uuid)',
  'fn_poker_diamond_tournament_open_shadow(uuid)',
];

describe('LAW: a Diamond tournament pays from its own custody', () => {
  describe('the migration opens nothing and expects an unsettled estate', () => {
    it('refuses an estate with an open switch or a settlement row already in the ledger', () => {
      expect(ESTATE).toContain('tournaments_enabled');
      expect(ESTATE).toMatch(/expects it closed/);
      expect(ESTATE).toContain("kind IN ('prize','bounty','fee')");
      expect(ESTATE).toMatch(/expects none/);
    });
    it('asserts at the end that the door is still shut and the ledger gained nothing', () => {
      expect(FINAL).toContain('this migration must not open the tournament door');
      expect(FINAL).toContain('the ledger gained a settlement row during apply');
    });
    it('never writes the switch on', () => {
      expect(code(MIG)).not.toMatch(/SET\s+tournaments_enabled\s*=\s*true/i);
    });
    it('registers every settlement step in the money RPC registry before creating it', () => {
      const registry = code(ESTATE);
      for (const name of INTERNAL_STEPS.map((s) => s.slice(0, s.indexOf('(')))) {
        expect(registry).toContain(`('${name}', 'approved'`);
      }
      expect(MIG.indexOf('ca_money_rpc_registry')).toBeLessThan(
        MIG.indexOf('CREATE OR REPLACE FUNCTION')
      );
    });
  });

  describe('the drain takes one bank of the custody rows, oldest first, and keeps the entry guard true', () => {
    it('drains only prize or fee, and only what a row holds in that bank', () => {
      expect(DRAIN).toContain("p_bank NOT IN ('prize','fee')");
      expect(DRAIN).toMatch(/CASE WHEN p_bank='prize' THEN l\.prize_part ELSE l\.fee_part END/);
      expect(DRAIN).toMatch(
        /m\.request->>'action'='tournament_drain' AND m\.request->>'bank'=p_bank/
      );
      expect(DRAIN).toContain('CONTINUE WHEN v_c.held <= 0;');
      expect(DRAIN).toContain('v_take := LEAST(v_left, v_c.held, v_c.balance);');
      expect(DRAIN).toMatch(/ORDER BY c\.created_at, c\.id\s+FOR UPDATE OF c/);
    });
    it('checks P0814 at the end of each drain, with the movement written before the balance moves', () => {
      expect(DRAIN).toContain(
        'SET CONSTRAINTS public.zzz_diamond_entry_custody_is_the_entry IMMEDIATE;'
      );
      expect(DRAIN).toContain(
        'SET CONSTRAINTS public.zzz_diamond_entry_custody_is_the_entry DEFERRED;'
      );
      const movement = DRAIN.indexOf('INSERT INTO public.poker_diamond_movements');
      const balance = DRAIN.indexOf(
        'UPDATE public.poker_diamond_custody SET balance=balance-v_take'
      );
      expect(movement).toBeGreaterThan(0);
      expect(balance).toBeGreaterThan(movement);
      expect(DRAIN).toMatch(
        /'release',v_take,'arena_custody:'\|\|v_c\.id,p_destination_account,v_journal/
      );
    });
    it('consumes purchased lots exactly as a lost hand consumes them, and refuses to come up short', () => {
      expect(DRAIN).toContain('UPDATE public.diamond_purchase_lots');
      expect(DRAIN).toContain(
        'UPDATE public.poker_diamond_lot_reservations SET consumed=consumed+'
      );
      expect((DRAIN.match(/diamond_tournament_custody_short/g) ?? []).length).toBe(2);
    });
    it("journals a fee drain as that player's own spend, bound for the house", () => {
      expect(DRAIN).toMatch(/'tournament_fee','tournament_fee',-v_take::integer/);
      expect(DRAIN).toContain("'poker_arena','spend','house'");
    });
  });

  describe('a prize is whole Diamonds from the prize bank, under the chip credit key', () => {
    it('refuses anything but whole Diamonds and anything but a Diamond arena event', () => {
      expect(PAY).toContain('diamond_tournament_pay_requires_whole_diamonds');
      expect(PAY).toMatch(
        /c\.asset='diamonds' AND c\.is_platform IS TRUE AND c\.union_id IS NULL AND t\.union_id IS NULL/
      );
      expect(PAY).toContain('diamond_asset_required');
    });
    it('claims the credit key before any Diamond moves and returns false on a spent key', () => {
      const claim = PAY.indexOf('INSERT INTO public.wallet_credit_idempotency(key,user_id,amount)');
      const credit = PAY.indexOf('public.add_diamonds_to_balance(');
      expect(claim).toBeGreaterThan(0);
      expect(credit).toBeGreaterThan(claim);
      expect(PAY).toContain('IF v_inserted = 0 THEN RETURN false; END IF;');
    });
    it('is capped by the prize bank and drains the prize bank only', () => {
      expect(PAY).toContain('diamond_tournament_bank_short');
      expect(PAY).toMatch(
        /fn_poker_diamond_tournament_drain\(\s*p_tournament_id, 'prize', p_amount::bigint/
      );
    });
    it('credits the wallet as arena_withdraw, writes the ledger row and moves the shadow', () => {
      expect(PAY).toMatch(
        /add_diamonds_to_balance\(\s*p_user_id, p_amount::integer, 'arena_withdraw'/
      );
      expect(PAY).toMatch(
        /VALUES \(p_tournament_id,v_arena,p_user_id,NULL,v_kind,p_amount::bigint,p_amount::bigint,0,0/
      );
      expect(PAY).toContain(
        "fn_ca_escrow_apply(p_tournament_id,'diamond prize',p_prize_out => p_amount)"
      );
      expect(PAY).toContain('diamond_tournament_escrow_disagrees_with_custody');
    });
    it('refuses a bounty and any other category by name', () => {
      expect(PAY).toContain('diamond_tournament_bounties_not_open');
      expect(PAY).toContain('diamond_tournament_pay_unknown_category');
    });
  });

  describe("the fee is each player's own fee part, retired from that player and minted to the house", () => {
    it('drains the fee bank with no shared journal, so every drained row writes its own spend', () => {
      expect(FEE).toMatch(
        /fn_poker_diamond_tournament_drain\(p_tournament_id, 'fee', v_fee, v_key, 'house', NULL\)/
      );
    });
    it('proves the register retired exactly the fee from the players before crediting the house', () => {
      expect(FEE).toMatch(/m\.action='burn' AND m\.holder_type='player'/);
      expect(FEE).toContain('diamond_tournament_fee_not_retired_from_players');
      expect(FEE.indexOf('diamond_tournament_fee_not_retired_from_players')).toBeLessThan(
        FEE.indexOf('UPDATE public.ca_diamond_house SET balance=COALESCE(balance,0)+v_fee')
      );
    });
    it('mints the same amount to the house in the register, as fn_ca_mint does, with no house journal row', () => {
      expect(FEE).toContain("c_house constant uuid := '00000000-0000-0000-0000-00000000d1a0';");
      expect(FEE).toMatch(
        /\(v_key, 'mint', 'diamonds', 'house', c_house, 'the house', v_fee, v_before, v_after, v_supply\+v_fee/
      );
      expect(FEE).not.toContain('ca_diamond_house_ledger');
    });
    it('is idempotent on its key and writes the fee row with no player and fee part only', () => {
      expect(FEE).toContain("v_key := 'poker-tournament-fee:'||p_tournament_id::text;");
      expect(FEE).toContain("'already_settled',true");
      expect(FEE).toMatch(/VALUES \(p_tournament_id,v_arena,NULL,NULL,'fee',v_fee,0,0,v_fee,v_key/);
    });
  });

  describe('a settled event leaves no open entry and its shadow is exact', () => {
    it('releases only zero-balance rows, under the refund authority, through the estate release door', () => {
      expect(CLOSE).toContain('IF v_open <> 0 THEN');
      expect(CLOSE).toContain(
        "set_config('app.poker_diamond_tournament_release', v_c.id::text, true)"
      );
      expect(CLOSE).toContain('public.fn_poker_diamond_release(v_c.id,');
      expect(CLOSE).toMatch(/\(v_receipt->>'amount'\)::bigint <> 0/);
    });
    it('opens the shadow from the ledger with exact refund parts and refuses a disagreement', () => {
      expect(SHADOW).toMatch(
        /COALESCE\(sum\(prize_part\)\s+FILTER \(WHERE kind = 'refund'\),0\) AS refund_prize/
      );
      expect(SHADOW).toContain("'diamond terminal shadow (from the Diamond ledger)'");
      expect(SHADOW).toContain('ON CONFLICT (tournament_id) DO NOTHING');
      expect(SHADOW).toContain('escrow shadow disagrees with its Diamond banks');
      expect(SHADOW).toContain('fn_poker_diamond_tournament_custody(p_tournament_id)::numeric');
    });
  });

  describe('the chip path is edited in place, pinned, and proved reversible', () => {
    it('fn_credit_and_log: the Diamond leg replaces only the wallet credit and skips only the chip receipt', () => {
      expect(pinnedEdits(CREDIT)).toEqual({ pins: 1, reversals: 1 });
      expect(CREDIT).toContain("'215820042e2ef7969132f25d14148061'");
      expect(CREDIT).toMatch(
        /v_diamond := p_related_entity_id IS NOT NULL AND public\.fn_poker_diamond_tournament\(p_related_entity_id\);/
      );
      expect(CREDIT).toContain('v_credited := public.fn_poker_diamond_tournament_pay(');
      expect(CREDIT).toContain(
        'IF NOT v_diamond THEN -- DIAMOND PHASE 8: wallet_transactions is the chip receipt'
      );
      expect(CREDIT).toContain('v_credited := public.fn_credit_player_wallet_once(');
    });
    it('fn_settle_tournament_rake: the Diamond branch settles the fee to the house and closes custody', () => {
      expect(pinnedEdits(RAKE)).toEqual({ pins: 1, reversals: 1 });
      expect(RAKE).toContain("'657781a399203068a1a4888354757878'");
      expect(RAKE).toContain(
        "fn_poker_diamond_tournament_settle_fee(p_tournament_id, COALESCE(p_source, 'engine'))"
      );
      expect(RAKE).toMatch(
        /destination = CASE WHEN v_net > 0 THEN 'diamond_house' ELSE 'none' END/
      );
      expect(RAKE).toContain('fn_poker_diamond_tournament_close_custody(p_tournament_id)');
    });
    it('the terminal writer: fee from the Diamond banks, shadow opened before the first check, house admitted', () => {
      expect(pinnedEdits(WRITER)).toEqual({ pins: 1, reversals: 1 });
      expect(WRITER).toContain("'8397b4f24c6d1a072d7b2d946f45e3d6'");
      expect(WRITER).toContain('SELECT e.fee_balance + e.fee_out INTO v_rake_total');
      expect(WRITER).toContain(
        'PERFORM public.fn_poker_diamond_tournament_open_shadow(p_tournament_id);'
      );
      expect(WRITER).toContain(
        'v_prior_rake.amount > 0 AND v_t.club_id IS NOT NULL AND NOT v_diamond'
      );
      expect(WRITER).toContain('(v_rake.amount > 0 AND v_t.club_id IS NOT NULL AND NOT v_diamond');
      expect(WRITER).toContain('ARRAY[v_old1, v_old2, v_old3, v_old4, v_old5, v_old6]');
    });
    it('the terminal receipt reader: the Diamond fee and the house destination, nothing else', () => {
      expect(pinnedEdits(READER)).toEqual({ pins: 1, reversals: 1 });
      expect(READER).toContain("'185dcb02134aa1f1fd2d87cdddbcfd26'");
      expect(READER).toContain('SELECT e.fee_balance + e.fee_out INTO v_rake_total');
      expect(READER).toContain('AND NOT public.fn_poker_diamond_tournament(p_tournament_id)');
      expect(READER).toContain('ARRAY[v_old1, v_old2]');
    });
    it('asserts at the end that the chip rails are still there', () => {
      expect(FINAL).toContain("position('public.fn_credit_player_wallet_once(' in r.def)=0");
      expect(FINAL).toContain("position('public.log_wallet_transaction(' in r.def)=0");
      expect(FINAL).toContain("position('public.increment_union_wallet(' in r.def)=0");
      expect(FINAL).toContain("position('public.credit_club_rake_to_treasury(' in r.def)=0");
      expect(FINAL).toContain("'terminal receipt: exact zero'");
    });
  });

  describe('the settlement steps are internal', () => {
    it('revokes every step from every client role, the service role included', () => {
      for (const sig of INTERNAL_STEPS) {
        expect(MIG).toContain(
          `REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated, service_role;`
        );
      }
      expect(FINAL).toContain("has_function_privilege('service_role', r.oid, 'EXECUTE')");
      expect(FINAL).toContain('is callable by a client role; it is an internal step');
    });
    it('names all five steps in the final count', () => {
      expect(FINAL).toContain(')) <> 5 THEN');
    });
  });
});
