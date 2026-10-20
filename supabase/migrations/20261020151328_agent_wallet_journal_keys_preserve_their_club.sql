-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_tally_store_move()'::regprocedure))='6db4f04e33013c8f9b00e2155b31e72d' AND EXISTS(SELECT FROM public.ca_guard_defs WHERE proname='fn_ca_tally_store_move' AND def_hash='6db4f04e33013c8f9b00e2155b31e72d') AND md5(pg_get_functiondef('public.fn_ca_ledger_tally_key(text,uuid,uuid)'::regprocedure))='ff30c09043719389496193946bbec15e' AND EXISTS(SELECT FROM public.ca_guard_defs WHERE proname='fn_ca_ledger_tally_key' AND def_hash='ff30c09043719389496193946bbec15e'))
-- Agent cash and user promo balances belong to a club and a user. The old
-- transaction tally grouped a user's positions across clubs, so opposite
-- unjournaled changes cancelled. Native actual-component tests reproduce it.
-- Scope the original store and ledger keys to the same club. Club/union
-- promo banks and all other financial accounts keep their identities.
-- Existing member/agent promo positions within one club retain the original
-- shared promo account; this does not introduce new wallet types or routing.
-- No balances, ledger rows, histories, rates or payouts change.
--
-- NOWAIT locks drain only writers of the changed key format and its journal.
-- An active writer refuses installation immediately, leaving it unchanged.
-- After installation new transactions use one consistent format. There is
-- no legacy key fallback, delayed repair or retry loop. These short locks
-- apply only in the actual installation, never in a production probe.
BEGIN;
SET LOCAL lock_timeout='250ms';
SET LOCAL statement_timeout='10s';
DO $early$ BEGIN
 IF md5(pg_get_functiondef('public.fn_ca_declare_guard_redefinition(text,text)'::regprocedure))<>'3a3746dc6e0a5b7a1db97805588c0eb8'
  OR NOT ('fn_ca_tally_store_move'=ANY(public.fn_ca_guard_watchlist()))
  OR NOT ('fn_ca_ledger_tally_key'=ANY(public.fn_ca_guard_watchlist()))
 THEN RAISE EXCEPTION 'agent_club_journal_declaration_contract_changed';END IF;
END $early$;
LOCK TABLE public.agents,public.club_members,public.chip_ledger IN SHARE ROW EXCLUSIVE MODE NOWAIT;
DO $change$
DECLARE r record;p record;post record;
BEGIN
 FOR r IN SELECT *FROM(VALUES
('public.fn_ca_tally_store_move()','fn_ca_tally_store_move','ba64376ceff72886b399349b53fcd2fa','6db4f04e33013c8f9b00e2155b31e72d',$body$CREATE OR REPLACE FUNCTION public.fn_ca_tally_store_move()
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
        'promo_wallet:' || (o ->> 'user_id') || ':' || COALESCE(o ->> 'club_id','null'), (o ->> 'promo_balance')::numeric,
        'promo_wallet:' || (n ->> 'user_id') || ':' || COALESCE(n ->> 'club_id','null'), (n ->> 'promo_balance')::numeric);
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
        'agent_wallet:' || (o ->> 'user_id') || ':' || COALESCE(o ->> 'club_id','null'), (o ->> 'agent_wallet_balance')::numeric,
        'agent_wallet:' || (n ->> 'user_id') || ':' || COALESCE(n ->> 'club_id','null'), (n ->> 'agent_wallet_balance')::numeric);
      PERFORM public.fn_ca_tally_pair(
        'promo_wallet:' || (o ->> 'user_id') || ':' || COALESCE(o ->> 'club_id','null'), (o ->> 'promo_wallet_balance')::numeric,
        'promo_wallet:' || (n ->> 'user_id') || ':' || COALESCE(n ->> 'club_id','null'), (n ->> 'promo_wallet_balance')::numeric);
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
$function$
$body$),
('public.fn_ca_ledger_tally_key(text,uuid,uuid)','fn_ca_ledger_tally_key','7d8c761d9d43c0429448c4b8b588d6ac','ff30c09043719389496193946bbec15e',$body$CREATE OR REPLACE FUNCTION public.fn_ca_ledger_tally_key(p_type text, p_entity uuid, p_club uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_union uuid;
  v_club uuid;
BEGIN
  /* The account a ledger side belongs to, in the covered set, or NULL when the
     side is not a chip store. The conventions are the ones every live writer
     already meets (measured 2026-10-01, seven days, 1,946,078 legs; extended
     2026-10-02 over the same seven days): a player_wallet leg names the user
     and the club; a union leg names the wallet row (fn_ca_autoledger) or the
     union (a declaring payer); a bbj_pool leg names the pool row; a
     table_stack leg names the table; a promo or agent leg names its holder
     (user, club or union); a club wallet or insurance leg names the
     club_wallets row or the club; a spin_reserve leg names the pool (10 of 10
     entities in seven days); a prize or bounty liability leg names the
     tournament (20,169 of 20,169 entities in a day, every one with an escrow
     row); a ticket escrow leg names the ticket, and every issued ticket is one
     float (fn_ca_ticket_escrow_float). */
  CASE p_type
    WHEN 'player_wallet' THEN
      RETURN 'player_wallet:' || COALESCE(p_entity::text, 'null') || ':' || COALESCE(p_club::text, 'null');
    WHEN 'club_treasury' THEN
      RETURN 'club_treasury:' || COALESCE(p_entity::text, 'null');
    WHEN 'table_stack' THEN
      IF p_entity IS NULL OR public.fn_ca_felt_counts_table(p_entity) THEN
        RETURN 'table_stack';
      END IF;
      RETURN NULL;  -- a tournament or Diamond table is not on the cash felt
    WHEN 'union_bank', 'union_wallet' THEN
      SELECT w.union_id INTO v_union FROM public.union_wallets w WHERE w.id = p_entity;
      RETURN p_type || ':' || COALESCE(v_union, p_entity)::text;
    WHEN 'bbj_pool' THEN
      RETURN 'bbj_pool:' || COALESCE(p_entity::text, 'null');
    -- 2026-10-02: every remaining chip store
    WHEN 'agent_wallet' THEN
      RETURN p_type || ':' || COALESCE(p_entity::text, 'null') || ':' || COALESCE(p_club::text, 'null');
    WHEN 'promo_wallet' THEN
      -- Club and union promo banks retain their original global identities.
      -- A user's promo account is scoped to the club that holds its balance.
      IF p_entity IS NULL OR EXISTS(SELECT 1 FROM public.clubs WHERE id=p_entity)
        OR EXISTS(SELECT 1 FROM public.unions WHERE id=p_entity) THEN
        RETURN p_type || ':' || COALESCE(p_entity::text, 'null');
      END IF;
      RETURN p_type || ':' || p_entity::text || ':' || COALESCE(p_club::text, 'null');
    WHEN 'club_wallet', 'insurance_bank' THEN
      SELECT cw.club_id INTO v_club FROM public.club_wallets cw WHERE cw.id = p_entity;
      RETURN p_type || ':' || COALESCE(COALESCE(v_club, p_entity)::text, 'null');
    WHEN 'spin_reserve' THEN
      RETURN 'spin_reserve:' || COALESCE(p_entity::text, 'null');
    WHEN 'prize_liability', 'bounty_liability' THEN
      IF p_entity IS NOT NULL AND NOT public.fn_ca_tournament_counts(p_entity) THEN
        RETURN NULL;  -- a Diamond event's liability is Diamonds in custody
      END IF;
      RETURN 'tournament_liability:' || COALESCE(p_entity::text, 'null');
    WHEN 'escrow' THEN
      RETURN 'ticket_escrow';
    WHEN 'opening_setup', 'leaderboard_round' THEN
      RETURN p_type || ':' || COALESCE(p_entity::text, 'null');
    ELSE
      RETURN NULL;
  END CASE;
END;
$function$
$body$)
 )v(signature,name,before_md5,after_md5,body)LOOP
  SELECT pg_get_functiondef(x.oid)definition,pg_get_userbyid(x.proowner)owner,
   x.proacl::text acl,x.proconfig config,x.prosecdef secdef,x.provolatile volatility
  INTO p FROM pg_proc x WHERE x.oid=r.signature::regprocedure;
  IF md5(p.definition)<>r.before_md5 OR p.owner<>'postgres'
   OR p.acl IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
   OR p.config IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
   OR p.secdef IS DISTINCT FROM true
   OR p.volatility IS DISTINCT FROM(CASE WHEN r.name='fn_ca_ledger_tally_key' THEN 's' ELSE 'v' END)
   OR NOT EXISTS(SELECT FROM public.ca_guard_defs WHERE proname=r.name AND def_hash=r.before_md5)
  THEN RAISE EXCEPTION 'agent_club_journal_preimage_changed: %',r.signature;END IF;
  IF md5(r.body)<>r.after_md5 THEN RAISE EXCEPTION 'agent_club_journal_postimage_changed';END IF;
  EXECUTE r.body;
  SELECT md5(pg_get_functiondef(x.oid))hash,pg_get_userbyid(x.proowner)owner,
   x.proacl::text acl,x.proconfig config,x.prosecdef secdef,x.provolatile volatility
  INTO post FROM pg_proc x WHERE x.oid=r.signature::regprocedure;
  IF post.hash<>r.after_md5 OR(post.owner,post.acl,post.config,post.secdef,post.volatility)
   IS DISTINCT FROM(p.owner,p.acl,p.config,p.secdef,p.volatility)
  THEN RAISE EXCEPTION 'agent_club_journal_metadata_changed';END IF;
  IF public.fn_ca_declare_guard_redefinition(r.name,
   'migration 20261020151328_agent_wallet_journal_keys_preserve_their_club')<>r.after_md5
  THEN RAISE EXCEPTION 'agent_club_journal_declaration_failed';END IF;
 END LOOP;
END $change$;
REVOKE ALL ON FUNCTION public.fn_ca_tally_store_move() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_tally_store_move() TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_ledger_tally_key(text,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_ledger_tally_key(text,uuid,uuid) TO service_role;
COMMIT;
