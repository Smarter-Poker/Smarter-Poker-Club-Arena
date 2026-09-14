/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A DIAMOND TOURNAMENT ENTRY IS CUSTODY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 8 of the Diamond Arena programme funds a tournament entry. A Diamond
 * entry is a custody row exactly as a Diamond cash seat is: the registration
 * core reserves settled Diamonds out of the wallet into poker_diamond_custody
 * (purpose tournament_entry), an add-on, rebuy or re-entry adds to that same
 * row through the same lot and journal mechanics, and a refund releases it
 * whole through fn_poker_diamond_release. The custody rows ARE the event's
 * escrow; the new ledger says how each custody decomposes (prize, bounty, fee)
 * so the banks can be read in the chip shape and the payer can be capped.
 *
 * What this law keeps true, against the migration text the estate was built
 * from (the live definitions were verified at apply time and are hashed by
 * the guard watchlist where they are watched):
 *
 *   1. The chip path is untouched: every edit to a chip function is an
 *      asserted substitution behind fn_ca_tournament_unit_cents = 100, with
 *      the chip debit, the chip fee rail and the chip cancellation body still
 *      present, and the migration proves the reverse substitution.
 *   2. An entry is ACTIVE from the moment it is paid (the seat guards P0810 and
 *      P0812 admit a tournament seat only against an active entry) and never
 *      binds a seat.
 *   3. A tournament entry leaves custody only through the refund authority:
 *      fn_poker_diamond_release refuses it for anyone else, including the
 *      service role, and the refund authority only opens for an unregistration
 *      before the start or a cancellation before the start.
 *   4. A started Diamond event is never voided (the chip rule, kept): the
 *      Diamond cancellation refuses exactly as atomic_cancel_tournament does,
 *      and a cancellation before the start writes the same immutable receipt
 *      the chip estate writes, marked with its asset.
 *   5. The two wallet-moving steps are the only Diamond names the profile
 *      wallet guard admits; the arena structure guard admits a player's own
 *      session to exactly the play-state counters and nothing structural.
 *   6. Nothing is opened: tournaments_enabled stays false, the creation door
 *      refuses every Phase 9 format by name, and a horse is refused by name.
 */
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween, sliceDollarQuoted } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_a_diamond_tournament_entry_is_custody.sql'))
  .at(-1);
if (!NAME) throw new Error('the tournament-entry custody migration is missing');
const MIG = migrationText(NAME);

/** Comments carry no behaviour. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const section = (from: string, to: string) => sliceBetween(MIG, from, to);

const ESTATE = section('-- 0. Nothing this migration touches', '-- 1. EVERY PLATFORM USER');
const LEDGER = section('-- 2. THE LEDGER', '-- 3. THE BANKS');
const CHARGE = code(
  sliceDollarQuoted(section('-- 5. THE CHARGE', '-- 6. THE REFUND'), '$function$')
);
const REFUND = code(
  sliceDollarQuoted(section('-- 6. THE REFUND', '-- 7. fn_poker_diamond_release'), '$function$')
);
const RELEASE = section('-- 7. fn_poker_diamond_release', '-- 7a. THE WALLET GUARD');
const WALLET_GUARD = section('-- 7a. THE WALLET GUARD', '-- 7a2. THE ARENA STRUCTURE GUARD');
const STRUCTURE_GUARD = section(
  '-- 7a2. THE ARENA STRUCTURE GUARD',
  '-- 7b. THE THREE SEAT GUARDS'
);
const HAND_ROUTING = section('-- 7b. THE THREE SEAT GUARDS', '-- 8. THE REGISTRATION CORE');
const REGISTRATION = section('-- 8. THE REGISTRATION CORE', '-- 9. THE REBUY CORE');
const REBUY = section('-- 9. THE REBUY CORE', '-- 10. THE BANK ANSWERS');
const BANK = section('-- 10. THE BANK ANSWERS', '-- 11. UNREGISTRATION');
const UNREGISTER = section('-- 11. UNREGISTRATION', '-- 12. CANCELLATION');
const CANCEL = section('-- 12. CANCELLATION', '-- 13. HORSES ARE PHASE 9');
const HORSE = section('-- 13. HORSES ARE PHASE 9', '-- 14. THE CREATION DOOR');
const DOOR = code(
  sliceDollarQuoted(
    section('-- 14. THE CREATION DOOR', '-- 15. THE ESTATE IS AS IT WAS'),
    '$function$'
  )
);
const FINAL = code(section('-- 15. THE ESTATE IS AS IT WAS', 'RAISE NOTICE'));

/** Every in-place edit of a chip function pins the live md5 and proves the reverse substitution. */
const pinnedEdits = (s: string) => ({
  pins: (s.match(/IF md5\(v_def\) <> '[0-9a-f]{32}' THEN/g) ?? []).length,
  reversals: (s.match(/IF md5\(replace\(/g) ?? []).length,
});

describe('LAW: a Diamond tournament entry is custody', () => {
  describe('the migration opens nothing and expects an empty estate', () => {
    it('refuses to run on an estate that already has Diamond tournaments, entries or an open switch', () => {
      const t = code(ESTATE);
      expect(t).toContain("purpose='tournament_entry'");
      expect(t).toContain('tournaments_enabled');
      expect(t).toMatch(/expects it closed/);
    });
    it('asserts at the end that the door is still shut and no custody row was written', () => {
      expect(FINAL).toContain('this migration must not open the tournament door');
      expect(FINAL).toContain('custody gained tournament rows during apply');
      expect(FINAL).toContain('the ledger is not empty after apply');
    });
    it('never writes the switch on', () => {
      expect(code(MIG)).not.toMatch(/SET\s+tournaments_enabled\s*=\s*true/i);
      expect(code(MIG)).not.toMatch(/SET\s+cash_games_enabled\s*=\s*true/i);
    });
  });

  describe('the ledger decomposes every custody movement into its banks', () => {
    it('is append-only, whole-Diamond, and its parts sum to the amount', () => {
      const t = code(LEDGER);
      expect(t).toContain('fn_poker_diamond_append_only');
      expect(t).toContain('CHECK (prize_part + bounty_part + fee_part = amount)');
      expect(t).toContain('amount >= 1 AND amount <= 2147483647');
      expect(t).toContain('idempotency_key text NOT NULL UNIQUE');
    });
    it('is not readable by a browser', () => {
      expect(code(LEDGER)).toContain(
        'REVOKE ALL ON public.poker_diamond_tournament_ledger FROM PUBLIC, anon, authenticated'
      );
    });
  });

  describe('an entry is active from the moment it is paid, and never binds a seat', () => {
    it('reserves through the estate reserve door, then activates the row', () => {
      expect(CHARGE).toContain('public.fn_poker_diamond_reserve(');
      expect(CHARGE).toMatch(
        /UPDATE public\.poker_diamond_custody SET state='active' WHERE id=v_c\.id AND state='reserved' AND purpose='tournament_entry'/
      );
      expect(CHARGE).toContain('diamond_tournament_entry_activation_failed');
    });
    it('refuses a bounty part until Phase 9 wires the pools', () => {
      expect(CHARGE).toContain('IF p_bounty <> 0 THEN');
      expect(CHARGE).toContain('diamond_tournament_bounties_not_open');
    });
    it('holds one open entry per player per event and asserts banks = custody after every charge', () => {
      expect(CHARGE).toContain('diamond_tournament_entry_already_held');
      expect(CHARGE).toContain('diamond_tournament_escrow_disagrees_with_custody');
    });
    it('never writes a seat binding onto an entry', () => {
      expect(CHARGE).not.toMatch(/seat_id\s*=/);
      expect(REFUND).not.toMatch(/SET[^;]*seat_id\s*=/);
    });
  });

  describe('an entry leaves custody only through its refund authority', () => {
    it('the release door refuses a tournament_entry row without the transaction-local authority', () => {
      const t = code(sliceDollarQuoted(RELEASE, '$new$'));
      expect(t).toContain("v_c.purpose = 'tournament_entry'");
      expect(t).toContain(
        "current_setting('app.poker_diamond_tournament_release', true) IS DISTINCT FROM p_custody_id::text"
      );
      expect(t).toContain('diamond_tournament_entry_requires_refund_authority');
      // the cash seat's settlement test is kept, scoped to the cash seat
      expect(t).toContain("v_c.state <> 'reserved' AND v_c.purpose <> 'tournament_entry'");
      expect(t).toContain("v_c.purpose <> 'cash_seat'");
    });
    it('the release edit is pinned, reverse-proved and declared to the watcher', () => {
      expect(pinnedEdits(RELEASE)).toEqual({ pins: 1, reversals: 1 });
      expect(RELEASE).toContain(
        "fn_ca_declare_guard_redefinition('fn_poker_diamond_release', 'migration a_diamond_tournament_entry_is_custody')"
      );
    });
    it('the refund authority opens the release for one row, in one transaction, then closes it', () => {
      expect(REFUND).toContain(
        "set_config('app.poker_diamond_tournament_release', v_c.id::text, true)"
      );
      expect(REFUND).toContain("set_config('app.poker_diamond_tournament_release', '', true)");
    });
    it('refunds only before the start (unregister) or before any payout (cancel), and only an active seatless entry', () => {
      expect(REFUND).toContain("p_kind NOT IN ('unregister','cancel')");
      expect(REFUND).toContain('diamond_tournament_entry_in_play');
      expect(REFUND).toContain('diamond_tournament_already_paid');
      expect(REFUND).toContain("v_c.state<>'active' OR v_c.balance<1 OR v_c.seat_id IS NOT NULL");
    });
    it('proves the custody equals its ledger before releasing and records the refund as an obligation', () => {
      expect(REFUND).toContain('diamond_tournament_custody_disagrees_with_ledger');
      expect(REFUND).toContain(
        'INSERT INTO public.tournament_obligations(tournament_id,kind,place,user_id,amount_owed,amount_paid,source,settled_at)'
      );
      expect(REFUND).toContain("'refund',v_c.balance,v_parts.prize,v_parts.bounty,v_parts.fee");
    });
  });

  describe('the chip path is edited in place and proved unchanged', () => {
    it('pins and reverse-proves every chip function it touches', () => {
      expect(pinnedEdits(REGISTRATION)).toEqual({ pins: 1, reversals: 1 });
      expect(pinnedEdits(REBUY)).toEqual({ pins: 1, reversals: 1 });
      expect(pinnedEdits(HAND_ROUTING)).toEqual({ pins: 2, reversals: 2 });
      expect(pinnedEdits(CANCEL)).toEqual({ pins: 2, reversals: 2 });
      expect(pinnedEdits(WALLET_GUARD)).toEqual({ pins: 1, reversals: 1 });
      expect(pinnedEdits(STRUCTURE_GUARD)).toEqual({ pins: 1, reversals: 1 });
    });
    it('puts the Diamond branch of the registration core behind the unit, with the chip debit as its ELSE', () => {
      const t = code(REGISTRATION);
      expect(t).toContain('IF v_split.charge > 0 AND v_unit = 100 THEN');
      expect(t).toContain('ELSIF v_split.charge > 0 THEN');
      expect(t).toContain('fn_poker_diamond_tournament_charge(');
      expect(t).toContain(
        "v_uid, p_tournament_id, 'entry', v_split.charge, v_split.prize, v_split.bounty, v_split.rake"
      );
      // the chip fee rail is kept for the chip unit only
      expect(t).toContain('IF v_split.rake > 0 AND v_t.club_id IS NOT NULL AND v_unit = 1 THEN');
    });
    it('puts the Diamond branch of the rebuy core behind the unit, keeps the chip debit, fee rail and receipt', () => {
      const t = code(REBUY);
      expect(t).toContain('IF v_unit = 100 THEN');
      expect(t).toContain(
        'p_user_id, p_tournament_id, p_rebuy_type, v_total, v_base, v_bounty_head, v_fee, v_p.id, v_key'
      );
      expect(t).toContain('SET chip_balance=chip_balance-v_total');
      expect(t).toContain('IF v_fee>0 AND v_t.club_id IS NOT NULL AND v_unit = 100 THEN');
      expect(t).toContain('ELSIF v_fee>0 AND v_t.club_id IS NOT NULL THEN');
      expect(t).toContain('IF v_unit = 1 THEN');
    });
    it('routes only a Diamond CASH hand to the cash settler; a Diamond tournament hand is a tournament hand', () => {
      const t = code(HAND_ROUTING);
      expect(t).toMatch(
        /c\.asset='diamonds' AND t\.tournament_id IS NULL\) THEN\s+RETURN public\.fn_poker_diamond_settle_cash_hand\(/
      );
      expect(t).toContain("c.asset='diamonds' AND t.tournament_id IS NULL) INTO v_diamond;");
    });
    it('the final assertion checks the chip debit, fee rail and chip cancellation body are still present', () => {
      expect(FINAL).toContain(
        "position('v_ok := public.atomic_deduct_wallet_and_log(' in r.def)=0"
      );
      expect(FINAL).toContain("position('SET chip_balance=chip_balance-v_total' in r.def)=0");
      expect(FINAL).toContain("position('fn_settle_tournament_refund_exact(' in r.def)=0");
    });
  });

  describe('the banks answer for a Diamond event in the chip shape', () => {
    it('fn_ca_escrow_can_pay answers enforced from the Diamond banks and the escrow reader routes by asset', () => {
      const t = code(BANK);
      expect(t).toContain('IF public.fn_poker_diamond_tournament(p_tournament_id) THEN');
      expect(t).toContain("'known', true, 'enforced', true");
      expect(t).toContain(
        'ALTER FUNCTION public.fn_ca_tournament_escrow(uuid) RENAME TO fn_ca_tournament_escrow_chips'
      );
      expect(t).toContain('SELECT * FROM public.fn_ca_tournament_escrow_chips(p_tournament_id)');
    });
    it('the router keeps exactly the grants the chip body carried', () => {
      expect(FINAL).toContain("'{postgres=X/postgres,service_role=X/postgres}'");
    });
  });

  describe('a started Diamond event is never voided, and a cancellation is receipted', () => {
    it('the Diamond cancellation keeps the chip rule word for word', () => {
      const t = code(CANCEL);
      expect(t).toContain(
        'Tournament has started or committed awards; resume or settle it instead of cancelling'
      );
      expect(t).toContain("upper(COALESCE(v_t.status::text,'')) IN ('RUNNING','BREAK')");
      expect(t).toContain('tournament_launch_receipts');
      expect(t).toContain('hand_history');
    });
    it('only platform staff, or the service role, cancel a Diamond event', () => {
      expect(code(CANCEL)).toContain(
        'IF v_uid IS NOT NULL AND NOT public.fn_is_platform_admin() THEN'
      );
    });
    it('writes the same immutable receipt the chip estate writes, marked with its asset, and routes the reader', () => {
      const t = code(CANCEL);
      expect(t).toContain('INSERT INTO public.tournament_cancellation_receipts(');
      expect(t).toContain("'receipt_version',2,'asset','diamonds'");
      expect(t).toContain("v_h.receipt->>'asset' IS DISTINCT FROM 'diamonds'");
      expect(t).toContain(
        'RETURN public.fn_poker_diamond_tournament_cancellation_receipt(p_tournament_id,p_observed_actor_id);'
      );
      expect(t).toContain(
        'RETURN public.fn_poker_diamond_tournament_cancel(p_tournament_id, p_admin_id);'
      );
    });
    it('the Diamond receipt verifier proves every refund line against the ledger, the custody row, the journal and the obligation', () => {
      const t = code(CANCEL);
      expect(t).toContain("c.state IS DISTINCT FROM 'released' OR c.balance IS DISTINCT FROM 0");
      expect(t).toContain("j.type IS DISTINCT FROM 'arena_withdraw'");
      expect(t).toContain(
        "m.action IS DISTINCT FROM 'release' OR m.amount IS DISTINCT FROM line.amount"
      );
      expect(t).toContain('cancellation receipt carries chip evidence on a Diamond event');
    });
    it('does not alter the receipts table (it is read under the settlement lane by every hand settlement)', () => {
      expect(code(MIG)).not.toMatch(/ALTER TABLE public\.tournament_cancellation_receipts/);
    });
  });

  describe('the unregistration door routes and the horse door refuses', () => {
    it('fn_unregister_from_tournament routes a Diamond event to its own authority and keeps the chip call', () => {
      const t = code(UNREGISTER);
      expect(t).toContain(
        'RETURN public.fn_poker_diamond_tournament_unregister(p_tournament_id,v_uid,p_request_id);'
      );
      expect(t).toContain('RETURN public.fn_ca_unregister_tournament_player_exact(');
      expect(t).toContain("RETURN jsonb_build_object('ok',false,'reason','tournament_started');");
    });
    it('a horse is refused by name until Phase 9', () => {
      expect(code(HORSE)).toContain("'reason','diamond_horse_funding_not_open'");
    });
  });

  describe('the guards admit exactly what a signed-in player moves', () => {
    it('the wallet guard learns exactly the two tournament money steps', () => {
      const t = code(sliceDollarQuoted(WALLET_GUARD, '$n$'));
      expect(t).toContain('fn_poker_diamond_tournament_charge[(]');
      expect(t).toContain('fn_poker_diamond_tournament_refund[(]');
      expect((t.match(/fn_poker_diamond_/g) ?? []).length).toBe(2);
    });
    it('the arena structure guard admits only the play-state counters, and only on UPDATE', () => {
      const t = code(STRUCTURE_GUARD);
      expect(t).toContain(
        "WHEN 'tournaments' THEN ARRAY['current_players','prize_pool','bounty_pool','total_rake','entry_contract_locked','updated_at']"
      );
      expect(t).toContain("WHEN 'tables' THEN ARRAY['current_players','updated_at']");
      expect(t).toContain("TG_OP='UPDATE' AND TG_TABLE_NAME IN ('tournaments','tables')");
      expect(t).toContain("'Diamond Games Require Platform Operations'");
    });
    it('the internal steps are owner-only and the final assertion checks it', () => {
      for (const fn of [
        'fn_poker_diamond_tournament_custody_add(uuid,numeric,uuid)',
        'fn_poker_diamond_tournament_charge(uuid,uuid,text,numeric,numeric,numeric,numeric,uuid,text)',
        'fn_poker_diamond_tournament_refund(uuid,uuid,text,text,uuid)',
        'fn_poker_diamond_tournament_unregister(uuid,uuid,uuid)',
        'fn_poker_diamond_tournament_cancel(uuid,uuid)',
      ]) {
        expect(code(MIG)).toContain(
          `REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated, service_role;`
        );
      }
      expect(FINAL).toContain('is callable by a client role; it is an internal step');
    });
  });

  describe('the creation door is staff-only and refuses Phase 9 by name', () => {
    it('requires a platform admin and refuses bounty, satellite, spin, guarantee and free-buy formats', () => {
      expect(DOOR).toContain('IF NOT public.fn_is_platform_admin() THEN');
      expect(DOOR).toContain("IF v_type NOT IN ('mtt','sng') THEN");
      expect(DOOR).toContain('diamond_tournament_format_not_open');
      expect(DOOR).toContain("(p_config->>'satelliteTargetId')");
      expect(DOOR).toContain("(p_config->>'freeBuy')");
    });
    it('prices in whole Diamonds with the recovery-fee ratio at the Diamond unit', () => {
      expect(DOOR).toContain('v_ratio := CASE WHEN v_max<=2 THEN 0.05 ELSE 0.10 END;');
      expect(DOOR).toContain(
        'public.fn_ca_unit_floor_cents(round(v_total*100*v_ratio)::bigint, 100)/100'
      );
      expect(DOOR).toContain(
        'IF public.fn_ca_tournament_unit_cents(v_id) <> 100 OR NOT public.fn_poker_diamond_tournament(v_id) THEN'
      );
    });
  });
});
