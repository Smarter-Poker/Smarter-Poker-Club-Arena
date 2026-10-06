-- A real authenticated cashout hold was refused because its escrow leg was
-- counted as tournament ticket custody, while chip_escrow had no balance tally.
-- Route the existing canonical cashout categories to their exact custody row;
-- preserve ticket escrow and every existing refusal. No balances are rewritten.
-- @live-proof: EXISTS (SELECT 1 FROM public.ca_ledger_invariant_store_mode WHERE store='cashout_escrow' AND mode='refuse')
BEGIN;
SET LOCAL lock_timeout = '500ms';
SET LOCAL statement_timeout = '10s';
SET LOCAL transaction_timeout = '15s';
LOCK TABLE public.chip_escrow IN SHARE ROW EXCLUSIVE MODE NOWAIT;
DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_tally_ledger_leg()'::regprocedure)) <> '11a0ded53fabe6919d5083942e25dcf5'
    OR md5(pg_get_functiondef('public.fn_ca_tally_store_move()'::regprocedure)) <> '2776e5fcbe0a13d51f0882257851d65c'
    OR md5(pg_get_functiondef('public.fn_ca_ledger_tally_key(text,uuid,uuid)'::regprocedure)) <> '7d8c761d9d43c0429448c4b8b588d6ac'
  THEN RAISE EXCEPTION 'cashout_escrow_preimage_changed'; END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.chip_escrow'::regclass
    AND tgname IN ('zy_ca_tally_store_move','zz_ca_store_has_its_ledger_row'))
    OR EXISTS (SELECT 1 FROM public.ca_ledger_invariant_store_mode WHERE store='cashout_escrow')
  THEN RAISE EXCEPTION 'cashout_escrow_already_installed'; END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.fn_ca_tally_ledger_leg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  /* SETTLEMENT SUSPENSE IS NOT A COUNTERPARTY FOR A BALANCE (2026-10-02).
     Every leg with settlement_suspense on either side is counted, before the
     journal-only exemption below, under a key no store resolves to. The
     commit check refuses a transaction that wrote one and moved any covered
     balance; a journal-only correction moves none and still commits. */
  IF NEW.from_type = 'settlement_suspense' OR NEW.to_type = 'settlement_suspense' THEN
    PERFORM public.fn_ca_ledger_tally_add('settlement_suspense', 's', abs(NEW.amount));
  END IF;
  /* A journal-only restatement (CLAUDE.md 10.9 rule 3, fn_ca_post_correction)
     moves no balance by design and is outside every meter, including this one. */
  IF NEW.category = 'correction' AND NEW.metadata ->> 'posted_via' = 'fn_ca_post_correction' THEN
    RETURN NULL;
  END IF;
  PERFORM public.fn_ca_ledger_tally_add(
    CASE WHEN NEW.to_type = 'escrow' AND NEW.category IN ('escrow_hold', 'escrow_release')
      THEN 'cashout_escrow:' || COALESCE(NEW.to_entity_id::text, 'null')
      ELSE public.fn_ca_ledger_tally_key(NEW.to_type, NEW.to_entity_id, NEW.club_id) END, 'l', NEW.amount);
  PERFORM public.fn_ca_ledger_tally_add(
    CASE WHEN NEW.from_type = 'escrow' AND NEW.category IN ('escrow_hold', 'escrow_release')
      THEN 'cashout_escrow:' || COALESCE(NEW.from_entity_id::text, 'null')
      ELSE public.fn_ca_ledger_tally_key(NEW.from_type, NEW.from_entity_id, NEW.club_id) END, 'l', -NEW.amount);
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_tally_store_move()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  o jsonb := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  n jsonb := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
BEGIN
  /* Feeds the same transaction tally as fn_ca_tally_balance_move, for the
     stores that function does not know. On club_members and clubs it counts
     ONLY the promo and insurance accounts: chip_balance, chip_treasury and
     chip_pool stay with the six-store trigger, so nothing is counted twice. */
  CASE TG_TABLE_NAME
    WHEN 'club_members' THEN
      PERFORM public.fn_ca_tally_pair(
        'promo_wallet:' || (o ->> 'user_id'), (o ->> 'promo_balance')::numeric,
        'promo_wallet:' || (n ->> 'user_id'), (n ->> 'promo_balance')::numeric);
    WHEN 'clubs' THEN
      PERFORM public.fn_ca_tally_pair(
        'promo_wallet:' || (o ->> 'id'), (o ->> 'promo_balance')::numeric,
        'promo_wallet:' || (n ->> 'id'), (n ->> 'promo_balance')::numeric);
      PERFORM public.fn_ca_tally_pair(
        'insurance_bank:' || (o ->> 'id'), (o ->> 'insurance_balance')::numeric,
        'insurance_bank:' || (n ->> 'id'), (n ->> 'insurance_balance')::numeric);
    WHEN 'agents' THEN
      /* No column list on this trigger: sync_agent_wallet_columns moves
         agent_wallet_balance when a writer sets business_balance, and a
         column-specific trigger would not see that. */
      PERFORM public.fn_ca_tally_pair(
        'agent_wallet:' || (o ->> 'user_id'), (o ->> 'agent_wallet_balance')::numeric,
        'agent_wallet:' || (n ->> 'user_id'), (n ->> 'agent_wallet_balance')::numeric);
      PERFORM public.fn_ca_tally_pair(
        'promo_wallet:' || (o ->> 'user_id'), (o ->> 'promo_wallet_balance')::numeric,
        'promo_wallet:' || (n ->> 'user_id'), (n ->> 'promo_wallet_balance')::numeric);
    WHEN 'club_wallets' THEN
      PERFORM public.fn_ca_tally_pair(
        'club_wallet:' || (o ->> 'club_id'), (o ->> 'chip_balance')::numeric,
        'club_wallet:' || (n ->> 'club_id'), (n ->> 'chip_balance')::numeric);
      PERFORM public.fn_ca_tally_pair(
        'insurance_bank:' || (o ->> 'club_id'), (o ->> 'insurance_balance')::numeric,
        'insurance_bank:' || (n ->> 'club_id'), (n ->> 'insurance_balance')::numeric);
    WHEN 'spin_bonus_pools' THEN
      PERFORM public.fn_ca_tally_pair(
        'spin_reserve:' || (o ->> 'id'), (o ->> 'balance')::numeric,
        'spin_reserve:' || (n ->> 'id'), (n ->> 'balance')::numeric);
    WHEN 'tournament_escrow' THEN
      /* The event's liability is its escrow: prize + bounty + fee, exactly
         fn_ca_supply_snapshot's tournament_liability. A Diamond event's
         shadow is Diamonds in custody and is not counted. */
      PERFORM public.fn_ca_tally_pair(
        CASE WHEN o IS NOT NULL AND public.fn_ca_tournament_counts((o ->> 'tournament_id')::uuid)
             THEN 'tournament_liability:' || (o ->> 'tournament_id') END,
        COALESCE((o ->> 'prize_balance')::numeric, 0) + COALESCE((o ->> 'bounty_balance')::numeric, 0)
          + COALESCE((o ->> 'fee_balance')::numeric, 0),
        CASE WHEN n IS NOT NULL AND public.fn_ca_tournament_counts((n ->> 'tournament_id')::uuid)
             THEN 'tournament_liability:' || (n ->> 'tournament_id') END,
        COALESCE((n ->> 'prize_balance')::numeric, 0) + COALESCE((n ->> 'bounty_balance')::numeric, 0)
          + COALESCE((n ->> 'fee_balance')::numeric, 0));
    WHEN 'chip_escrow' THEN
      -- Cashout custody is separate from the outstanding tournament ticket float.
      PERFORM public.fn_ca_tally_pair(
        CASE WHEN o IS NOT NULL THEN 'cashout_escrow:' || (o ->> 'id') END,
        CASE WHEN o ->> 'released_at' IS NULL THEN COALESCE((o ->> 'amount')::numeric, 0) ELSE 0 END,
        CASE WHEN n IS NOT NULL THEN 'cashout_escrow:' || (n ->> 'id') END,
        CASE WHEN n ->> 'released_at' IS NULL THEN COALESCE((n ->> 'amount')::numeric, 0) ELSE 0 END);
    WHEN 'tournament_tickets' THEN
      /* fn_ca_ticket_escrow_float: an issued ticket's value is held in escrow
         until it is redeemed or cancelled. */
      PERFORM public.fn_ca_tally_pair(
        CASE WHEN o IS NOT NULL THEN 'ticket_escrow' END,
        CASE WHEN o ->> 'status' = 'issued' THEN COALESCE((o ->> 'value')::numeric, 0) ELSE 0 END,
        CASE WHEN n IS NOT NULL THEN 'ticket_escrow' END,
        CASE WHEN n ->> 'status' = 'issued' THEN COALESCE((n ->> 'value')::numeric, 0) ELSE 0 END);
    WHEN 'unions' THEN
      /* The legacy unions row: its autoledger journals into these accounts
         (trg_ca_autoledger on unions), so its balances are counted in them. */
      PERFORM public.fn_ca_tally_pair(
        'union_bank:' || (o ->> 'id'), (o ->> 'chip_balance')::numeric,
        'union_bank:' || (n ->> 'id'), (n ->> 'chip_balance')::numeric);
      PERFORM public.fn_ca_tally_pair(
        'union_wallet:' || (o ->> 'id'), (o ->> 'rake_wallet')::numeric,
        'union_wallet:' || (n ->> 'id'), (n ->> 'rake_wallet')::numeric);
      PERFORM public.fn_ca_tally_pair(
        'bbj_pool:' || (o ->> 'id'),
        COALESCE((o ->> 'main_bbj_balance')::numeric, 0) + COALESCE((o ->> 'backup_bbj_balance')::numeric, 0),
        'bbj_pool:' || (n ->> 'id'),
        COALESCE((n ->> 'main_bbj_balance')::numeric, 0) + COALESCE((n ->> 'backup_bbj_balance')::numeric, 0));
      PERFORM public.fn_ca_tally_pair(
        'promo_wallet:' || (o ->> 'id'), (o ->> 'promo_fund_balance')::numeric,
        'promo_wallet:' || (n ->> 'id'), (n ->> 'promo_fund_balance')::numeric);
      PERFORM public.fn_ca_tally_pair(
        'insurance_bank:' || (o ->> 'id'), (o ->> 'insurance_balance')::numeric,
        'insurance_bank:' || (n ->> 'id'), (n ->> 'insurance_balance')::numeric);
    WHEN 'club_opening_setups' THEN
      PERFORM public.fn_ca_tally_pair(
        'opening_setup:' || (o ->> 'club_id'), (o ->> 'leaderboard_seed_remaining')::numeric,
        'opening_setup:' || (n ->> 'club_id'), (n ->> 'leaderboard_seed_remaining')::numeric);
    ELSE
      RAISE EXCEPTION 'fn_ca_tally_store_move is not configured for %', TG_TABLE_NAME;
  END CASE;
  RETURN NULL;
END;
$function$;

CREATE TRIGGER zy_ca_tally_store_move
  AFTER INSERT OR UPDATE OR DELETE ON public.chip_escrow
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_tally_store_move();
CREATE CONSTRAINT TRIGGER zz_ca_store_has_its_ledger_row
  AFTER INSERT OR UPDATE OR DELETE ON public.chip_escrow
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_balance_has_its_ledger_row();
INSERT INTO public.ca_ledger_invariant_store_mode(store,mode,reason)
VALUES ('cashout_escrow','refuse','The exact cashout escrow row and its canonical hold/release leg must move equally in the original transaction.');
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note) VALUES
 ('chip_escrow','zy_ca_tally_store_move','Tallies the held cashout amount in the existing transaction-local conservation meter; writes no money.'),
 ('chip_escrow','zz_ca_store_has_its_ledger_row','Existing deferred conservation constraint refuses missing or mismatched cashout custody legs.');
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_tally_ledger_leg','20261006140948 cashout custody has its own ledger account');
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_tally_store_move','20261006140948 cashout custody has its own ledger account');
COMMIT;
