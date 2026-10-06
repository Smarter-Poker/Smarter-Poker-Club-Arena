-- ===========================================================================
--  EVERY CHIP STORE BALANCES WITH ITS LEDGER ROW
-- ===========================================================================
--
-- Dan, 2026-10-01: "fix any and all issues with the chip drift ... chip
-- drifts should not be possible."
--
-- 20261001160611 installed the commit-time check (a balance moves only by
-- exactly the net of the chip_ledger legs written in the same transaction) on
-- six stores, and 20261002015339 made it refuse. Every OTHER store that holds
-- chips was still journalled after the fact by fn_ca_autoledger and compared to
-- the journal hours later by snapshot: a net, not a constraint. This migration
-- extends the same tally and the same commit-time check to every remaining
-- chip store, in OBSERVE, so live traffic on each one is measured before any
-- transaction is refused. The six proven stores keep refusing, untouched.
--
-- THE STORES, read from the catalog on 2026-10-02 (fn_ca_supply_snapshot's
-- basis, the fn_ca_autoledger trigger arguments, and ca_chip_store_coverage):
--
--   account key               balance                                          ledger types
--   ------------------------  -----------------------------------------------  --------------------------------
--   promo_wallet:<holder>     club_members.promo_balance (user)                promo_wallet
--                             agents.promo_wallet_balance (user)
--                             clubs.promo_balance (club)
--                             unions.promo_fund_balance (union)
--   agent_wallet:<user>       agents.agent_wallet_balance                      agent_wallet
--   club_wallet:<club>        club_wallets.chip_balance                        club_wallet
--   insurance_bank:<club>     clubs.insurance_balance,                         insurance_bank
--                             club_wallets.insurance_balance,
--                             unions.insurance_balance (union)
--   spin_reserve:<pool>       spin_bonus_pools.balance                         spin_reserve
--   tournament_liability:<t>  tournament_escrow prize + bounty + fee balance   prize_liability, bounty_liability
--   ticket_escrow             tournament_tickets.value while status = issued   escrow
--   opening_setup:<club>      club_opening_setups.leaderboard_seed_remaining   opening_setup (a clearing store)
--   leaderboard_round:<club>  none: a clearing store, nets to zero per txn     leaderboard_round
--   union_bank / union_wallet / bbj_pool: the legacy unions row, which its own
--                             autoledger already journals into those covered
--                             accounts; every balance on it is 0.00 and no
--                             function writes it.
--
--   Not chip stores, by design: public.wallets (dead pool, frozen 2026-08-21);
--   Diamond custody (its own asset and its own zzz_diamond_* constraints; a
--   Diamond event's escrow shadow is excluded exactly as the supply meter
--   excludes it); agents.business_balance / promo_balance / player_balance /
--   player_wallet_balance (mirror columns sync_agent_wallet_columns keeps equal
--   to the two agent wallets; player_* is 0.00 on every row and in no basis);
--   club_members.held_chips / locked_chips / credit_used (never in the supply
--   basis, 0 on every row; credit is not chips); tournament_players.chips (a
--   tournament stack is carried by its event's escrow); settlement_suspense,
--   issuance_reserve, chip_retirement, system_mint/burn (journal labels with no
--   balance column; the issuance ones are outside circulation by definition
--   and guarded by zz_ca_issuance_leg_is_registered).
--
-- HOW, WITHOUT TOUCHING WHAT ALREADY REFUSES
--   * fn_ca_tally_balance_move and its fourteen triggers are not changed. A new
--     function, fn_ca_tally_store_move, feeds the SAME transaction tally from
--     new triggers (zy_ca_tally_store_move) on the store tables. On club_members
--     and clubs, which already carry the six-store triggers, the new triggers
--     name only the new columns and the new function counts only the new
--     accounts, so nothing is counted twice.
--   * Every store table also gets the deferred commit check
--     (zz_ca_store_has_its_ledger_row -> the same fn_ca_balance_has_its_ledger_row),
--     so a balance that moves with NO leg at all still queues its own check.
--   * fn_ca_ledger_tally_key learns the new ledger types; the six it already
--     knew return exactly what they returned before (asserted below).
--   * The mode becomes per store: ca_ledger_invariant_store_mode. The six
--     proven stores are written as refuse (their state today), the nine new
--     ones as observe. The one global row stays refuse and is the fallback for
--     a store with no row. A mismatch is judged by its own store's mode, so an
--     observed store records a finding while a refusing store still refuses.
--
-- LOCKS. Nothing is dropped (DROP TRIGGER on a hot table lets supautils take
-- AccessExclusive on every auth/storage/realtime table; it deadlocked the
-- applier twice on 2026-10-01). All nine tables' ShareRowExclusive locks are
-- taken in ONE LOCK TABLE under a 250 ms lock_timeout, rolled back and retried
-- after 100 ms, before any DDL - so no live transaction waits on this file
-- longer than 250 ms and none can be chosen as a deadlock victim by it.
--
-- CLAUDE.md section 2: one migration, one transaction. Applied once, by
-- apply-merged-migration.yml, outside :50-:03 UTC.
-- ===========================================================================
-- @live-proof: (SELECT count(*) FROM public.ca_ledger_invariant_store_mode WHERE mode = 'observe') = 9

BEGIN;

SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 0. Preimage: the bodies this file builds on are the ones read on 2026-10-02
-- ---------------------------------------------------------------------------

DO $pre$
DECLARE
  r record;
  v_live text;
  v_present text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('fn_ca_balance_has_its_ledger_row', 'ccefb89cce8bd126fbf79884df6475ba'),
      ('fn_ca_ledger_tally_key',           'f24b89cf9da14a788a435e9a90e01b22'),
      ('fn_ca_guard_watchlist',            'fdfd7f2919658c85cd23a6c4f1df9821')) AS x(f, m)
  LOOP
    SELECT md5(pg_get_functiondef(p.oid)) INTO v_live
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.f;
    IF v_live IS DISTINCT FROM r.m THEN
      RAISE EXCEPTION 'preimage: % is not the body read on 2026-10-02 (md5 %, expected %); re-read it before redefining it', r.f, v_live, r.m;
    END IF;
  END LOOP;

  IF (SELECT mode FROM public.ca_ledger_invariant_mode) IS DISTINCT FROM 'refuse' THEN
    RAISE EXCEPTION 'preimage: ca_ledger_invariant_mode must be refuse (the six proven stores keep refusing)';
  END IF;

  SELECT string_agg(c.relname || '.' || tg.tgname, ', ') INTO v_present
    FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
   WHERE c.relnamespace = 'public'::regnamespace
     AND tg.tgname IN ('zy_ca_tally_store_move', 'zz_ca_store_has_its_ledger_row');
  IF v_present IS NOT NULL THEN
    RAISE EXCEPTION 'preimage: the store invariant is already partly installed (%); read the live catalog, this file does not DROP TRIGGER', v_present;
  END IF;
END $pre$;

-- ---------------------------------------------------------------------------
-- 1. The mode, per store
-- ---------------------------------------------------------------------------

CREATE TABLE public.ca_ledger_invariant_store_mode (
  store      text PRIMARY KEY,
  mode       text NOT NULL CHECK (mode IN ('observe', 'refuse')),
  changed_at timestamptz NOT NULL DEFAULT now(),
  reason     text NOT NULL
);
COMMENT ON TABLE public.ca_ledger_invariant_store_mode IS
  'One row per chip store covered by the ledger invariant (the account-key prefix fn_ca_ledger_tally_key and the tally functions build). observe: a disagreement at commit is recorded in ca_ledger_invariant_findings and warned; refuse: the transaction is aborted (REFUSED: balance_moved_without_its_ledger_row). A store with no row falls back to ca_ledger_invariant_mode. Changed only by a migration.';
REVOKE ALL ON public.ca_ledger_invariant_store_mode FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ca_ledger_invariant_store_mode TO service_role;

INSERT INTO public.ca_ledger_invariant_store_mode (store, mode, reason)
SELECT x.s, x.m, x.r
  FROM (VALUES
    ('player_wallet',        'refuse',  '20261002015339: refusing since 02:31:54 UTC, carried here unchanged'),
    ('club_treasury',        'refuse',  '20261002015339: refusing since 02:31:54 UTC, carried here unchanged'),
    ('table_stack',          'refuse',  '20261002015339: refusing since 02:31:54 UTC, carried here unchanged'),
    ('union_bank',           'refuse',  '20261002015339: refusing since 02:31:54 UTC, carried here unchanged'),
    ('union_wallet',         'refuse',  '20261002015339: refusing since 02:31:54 UTC, carried here unchanged'),
    ('bbj_pool',             'refuse',  '20261002015339: refusing since 02:31:54 UTC, carried here unchanged'),
    ('promo_wallet',         'observe', '20261002030942: measurement window before refuse'),
    ('agent_wallet',         'observe', '20261002030942: measurement window before refuse'),
    ('club_wallet',          'observe', '20261002030942: measurement window before refuse'),
    ('insurance_bank',       'observe', '20261002030942: measurement window before refuse'),
    ('spin_reserve',         'observe', '20261002030942: measurement window before refuse'),
    ('tournament_liability', 'observe', '20261002030942: measurement window before refuse'),
    ('ticket_escrow',        'observe', '20261002030942: measurement window before refuse'),
    ('opening_setup',        'observe', '20261002030942: measurement window before refuse'),
    ('leaderboard_round',    'observe', '20261002030942: measurement window before refuse')
  ) AS x(s, m, r);

-- ---------------------------------------------------------------------------
-- 2. A tournament's liability is chips unless the event is a Diamond event
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_counts(p_tournament uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  /* Exactly fn_ca_supply_snapshot's tournament_liability scope: an event whose
     club is the Diamond Arena holds Diamonds in custody, never chips. */
  SELECT NOT EXISTS (
    SELECT 1
      FROM public.tournaments t
      JOIN public.clubs c ON c.id = t.club_id
     WHERE t.id = p_tournament
       AND c.asset = 'diamonds');
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_counts(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The ledger side learns the new stores
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ca_ledger_tally_key(p_type text, p_entity uuid, p_club uuid)
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
    WHEN 'promo_wallet', 'agent_wallet' THEN
      RETURN p_type || ':' || COALESCE(p_entity::text, 'null');
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
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_ledger_tally_key(text, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The balance side of the new stores
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ca_tally_pair(p_k_old text, p_v_old numeric, p_k_new text, p_v_new numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  /* One balance column of one row, before and after. A row that changes
     account (a membership changing club, a ticket leaving 'issued') leaves one
     account and arrives in another; both sides are counted. A NULL key is a
     side that does not exist (an INSERT's OLD, a DELETE's NEW, a Diamond
     event), and fn_ca_ledger_tally_add ignores it. */
  IF p_k_old IS NOT DISTINCT FROM p_k_new THEN
    PERFORM public.fn_ca_ledger_tally_add(p_k_new, 'b', COALESCE(p_v_new, 0) - COALESCE(p_v_old, 0));
  ELSE
    PERFORM public.fn_ca_ledger_tally_add(p_k_old, 'b', -COALESCE(p_v_old, 0));
    PERFORM public.fn_ca_ledger_tally_add(p_k_new, 'b', COALESCE(p_v_new, 0));
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_tally_pair(text, numeric, text, numeric) FROM PUBLIC, anon, authenticated;

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
REVOKE ALL ON FUNCTION public.fn_ca_tally_store_move() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. The check, judged by each store's own mode
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ca_balance_has_its_ledger_row()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_ver text := NULLIF(current_setting('ca.ledger_tally_ver', true), '');
  v_checked text := NULLIF(current_setting('ca.ledger_tally_checked', true), '');
  v_mode text;
  t jsonb;
  r record;
  v_b numeric; v_l numeric;
BEGIN
  /* Deferred to commit. Every queued event re-enters here, so the tally is
     verified once per version: when nothing has been added since the last
     verification this is one setting read and out. A deferred trigger that
     writes money after us bumps the version and queues its own event, which
     verifies again, so the last word is always on the complete tally. */
  IF v_ver IS NULL OR v_ver = v_checked THEN
    RETURN NULL;
  END IF;

  t := COALESCE(NULLIF(current_setting('ca.ledger_tally', true), '')::jsonb, '{}'::jsonb);

  FOR r IN SELECT key, value FROM jsonb_each(t) LOOP
    v_b := round(COALESCE((r.value ->> 'b')::numeric, 0), 2);
    v_l := round(COALESCE((r.value ->> 'l')::numeric, 0), 2);
    IF v_b = v_l THEN
      CONTINUE;
    END IF;

    /* 2026-10-02: each store is judged by its own mode
       (ca_ledger_invariant_store_mode, keyed by the account-key prefix), so a
       store still being measured records a finding while a proven store
       refuses. A store with no row falls back to the one global row. */
    v_mode := COALESCE(
      (SELECT sm.mode FROM public.ca_ledger_invariant_store_mode sm WHERE sm.store = split_part(r.key, ':', 1)),
      (SELECT m.mode FROM public.ca_ledger_invariant_mode m LIMIT 1),
      'refuse');

    IF v_mode = 'refuse' THEN
      RAISE EXCEPTION 'REFUSED: balance_moved_without_its_ledger_row account=% balance_delta=% ledger_net=%',
        r.key, v_b, v_l
        USING ERRCODE = '23514',
              DETAIL  = CASE
                          WHEN v_l = 0 THEN 'the balance column moved and no chip_ledger leg in this transaction accounts for it'
                          WHEN v_b = 0 THEN 'a chip_ledger leg names this account and its balance column did not move in this transaction'
                          ELSE 'the balance column and the chip_ledger legs in this transaction disagree on how much moved'
                        END || '; first written in this transaction by: ' || COALESCE(r.value ->> 'q', '(unknown statement)'),
              HINT    = 'Every chip movement is written by its door as balance + leg in one transaction. If the door stood the autoledger down (app.ledger_autoskip_<table>), its own leg must equal the delta and name the same user, club, union, pool, table, tournament or ticket float. Nothing is corrected here; the transaction is refused whole.';
    END IF;

    INSERT INTO public.ca_ledger_invariant_findings
      (txid, account_key, balance_delta, ledger_net, mode, actor_service, db_role, statement)
    VALUES
      (pg_current_xact_id(), r.key, v_b, v_l, v_mode,
       current_setting('application_name', true), current_user,
       COALESCE(r.value ->> 'q', left(current_query(), 300)))
    ON CONFLICT (txid, account_key) DO UPDATE
      SET balance_delta = EXCLUDED.balance_delta,
          ledger_net    = EXCLUDED.ledger_net,
          found_at      = EXCLUDED.found_at,
          statement     = EXCLUDED.statement;
    RAISE WARNING 'OBSERVED: balance_moved_without_its_ledger_row account=% balance_delta=% ledger_net=% (store mode observe; this transaction would be refused)',
      r.key, v_b, v_l;
  END LOOP;

  PERFORM set_config('ca.ledger_tally_checked', v_ver, true);
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_balance_has_its_ledger_row() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. The triggers: the nine locks first, together, or not at all
-- ---------------------------------------------------------------------------

DO $m$
DECLARE v_tries int := 0;
BEGIN
  PERFORM set_config('lock_timeout', '250ms', true);
  LOOP
    BEGIN
      LOCK TABLE public.club_members, public.clubs, public.agents, public.club_wallets,
                 public.spin_bonus_pools, public.tournament_escrow, public.tournament_tickets,
                 public.unions, public.club_opening_setups
        IN SHARE ROW EXCLUSIVE MODE;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      v_tries := v_tries + 1;
      IF v_tries >= 240 THEN
        RAISE EXCEPTION 'the nine ShareRowExclusive locks could not be taken together in % tries (about 90 s); nothing was applied - apply once more when the platform is quieter, never in a loop', v_tries;
      END IF;
      PERFORM pg_sleep(0.1);
    END;
  END LOOP;
  PERFORM set_config('lock_timeout', '8s', true);
  RAISE NOTICE 'store invariant: nine ShareRowExclusive locks taken together after % failed tries', v_tries;
END $m$;

-- club_members and clubs: the new columns only (the six-store triggers keep theirs)
CREATE TRIGGER zy_ca_tally_store_move
  AFTER INSERT OR UPDATE OF promo_balance, user_id, club_id OR DELETE ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_tally_store_move();
CREATE CONSTRAINT TRIGGER zz_ca_store_has_its_ledger_row
  AFTER INSERT OR UPDATE OF promo_balance, user_id, club_id OR DELETE ON public.club_members
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_balance_has_its_ledger_row();

CREATE TRIGGER zy_ca_tally_store_move
  AFTER INSERT OR UPDATE OF promo_balance, insurance_balance OR DELETE ON public.clubs
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_tally_store_move();
CREATE CONSTRAINT TRIGGER zz_ca_store_has_its_ledger_row
  AFTER INSERT OR UPDATE OF promo_balance, insurance_balance OR DELETE ON public.clubs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_balance_has_its_ledger_row();

-- the store tables: every write (a column list would miss a BEFORE trigger's move)
CREATE TRIGGER zy_ca_tally_store_move
  AFTER INSERT OR UPDATE OR DELETE ON public.agents
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_tally_store_move();
CREATE CONSTRAINT TRIGGER zz_ca_store_has_its_ledger_row
  AFTER INSERT OR UPDATE OR DELETE ON public.agents
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_balance_has_its_ledger_row();

CREATE TRIGGER zy_ca_tally_store_move
  AFTER INSERT OR UPDATE OR DELETE ON public.club_wallets
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_tally_store_move();
CREATE CONSTRAINT TRIGGER zz_ca_store_has_its_ledger_row
  AFTER INSERT OR UPDATE OR DELETE ON public.club_wallets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_balance_has_its_ledger_row();

CREATE TRIGGER zy_ca_tally_store_move
  AFTER INSERT OR UPDATE OR DELETE ON public.spin_bonus_pools
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_tally_store_move();
CREATE CONSTRAINT TRIGGER zz_ca_store_has_its_ledger_row
  AFTER INSERT OR UPDATE OR DELETE ON public.spin_bonus_pools
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_balance_has_its_ledger_row();

CREATE TRIGGER zy_ca_tally_store_move
  AFTER INSERT OR UPDATE OR DELETE ON public.tournament_escrow
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_tally_store_move();
CREATE CONSTRAINT TRIGGER zz_ca_store_has_its_ledger_row
  AFTER INSERT OR UPDATE OR DELETE ON public.tournament_escrow
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_balance_has_its_ledger_row();

CREATE TRIGGER zy_ca_tally_store_move
  AFTER INSERT OR UPDATE OR DELETE ON public.tournament_tickets
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_tally_store_move();
CREATE CONSTRAINT TRIGGER zz_ca_store_has_its_ledger_row
  AFTER INSERT OR UPDATE OR DELETE ON public.tournament_tickets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_balance_has_its_ledger_row();

CREATE TRIGGER zy_ca_tally_store_move
  AFTER INSERT OR UPDATE OR DELETE ON public.unions
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_tally_store_move();
CREATE CONSTRAINT TRIGGER zz_ca_store_has_its_ledger_row
  AFTER INSERT OR UPDATE OR DELETE ON public.unions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_balance_has_its_ledger_row();

CREATE TRIGGER zy_ca_tally_store_move
  AFTER INSERT OR UPDATE OR DELETE ON public.club_opening_setups
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_tally_store_move();
CREATE CONSTRAINT TRIGGER zz_ca_store_has_its_ledger_row
  AFTER INSERT OR UPDATE OR DELETE ON public.club_opening_setups
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_balance_has_its_ledger_row();

-- ---------------------------------------------------------------------------
-- 7. Declarations: a trigger on a money table declares itself; a guard is watched
-- ---------------------------------------------------------------------------

INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
SELECT x.t, g.g,
       CASE g.g
         WHEN 'zy_ca_tally_store_move' THEN
           'every_chip_store_balances_with_its_ledger_row: adds the ' || x.what || ' delta to the transaction tally (setting ca.ledger_tally). Writes nothing; never refuses.'
         ELSE
           'every_chip_store_balances_with_its_ledger_row: deferred to commit; when ' || x.what || ' moved by a different amount than its chip_ledger legs in the same transaction, records a finding (store mode observe) or refuses REFUSED: balance_moved_without_its_ledger_row (store mode refuse).'
       END
  FROM (VALUES
    ('club_members',        'member promo wallet'),
    ('clubs',               'club promo wallet and insurance bank'),
    ('agents',              'agent wallet and agent promo wallet'),
    ('club_wallets',        'club wallet and its insurance bank'),
    ('spin_bonus_pools',    'Spin reserve pool'),
    ('tournament_escrow',   'tournament liability (prize + bounty + fee escrow)'),
    ('tournament_tickets',  'ticket escrow float (issued tickets)'),
    ('unions',              'legacy union balances'),
    ('club_opening_setups', 'opening leaderboard seed')
  ) AS x(t, what)
  CROSS JOIN (VALUES ('zy_ca_tally_store_move'), ('zz_ca_store_has_its_ledger_row')) AS g(g)
ON CONFLICT (table_name, trigger_name) DO UPDATE SET note = EXCLUDED.note;

CREATE OR REPLACE FUNCTION public.fn_ca_guard_watchlist()
RETURNS text[]
LANGUAGE sql
STABLE
AS $function$
  SELECT ARRAY(
    SELECT DISTINCT x FROM unnest(ARRAY[
      'fn_ca_raise_drift_incident','fn_ca_incident_notify','fn_ca_incident_action',
      'fn_ca_incident_escalation_tick','fn_ca_incident_recipient_ids',
      'fn_ca_quick_reconcile','fn_ca_supply_snapshot','fn_ca_diamond_snapshot',
      'fn_ca_suspense_regression_check','fn_ca_settlement_correctness_check',
      'fn_ca_autoledger','fn_ca_autoledger_delete','fn_ca_chip_ledger_enrich',
      'fn_ca_journal_append_only','fn_ca_is_midway_scope',
      'fn_ca_negative_balance_watch','fn_ca_mint_velocity_watch',
      'fn_ca_cron_failure_watch','fn_ca_burnin_gate_tick','fn_ca_midway_burnin_gate',
      'fn_ca_epoch3_preflight','fn_ca_execute_epoch3_reset',
      'fn_club_members_ledger_writer','fn_ca_financial_alert_to_incident',
      'fn_ca_settlement_transition_guard','fn_ca_guard_defs_watch',
      'fn_ca_post_correction','fn_ca_repair_write_failure',
      -- The Diamond money doors (2026-09-12).
      'fn_poker_diamond_reserve','fn_poker_diamond_release',
      'fn_poker_diamond_cashout','fn_poker_diamond_settle_cash_hand',
      'fn_poker_diamond_buyin','fn_poker_diamond_top_up',
      'fn_poker_diamond_seat_keeps_custody','fn_poker_diamond_plain_cash_table',
      -- The unit rules (2026-09-12).
      'fn_ca_unit_floor_cents','fn_ca_tournament_unit_cents',
      'fn_ca_prize_ladder','fn_ca_recovery_fee_cents',
      -- The seat guards that know a tournament seat (2026-09-13).
      'fn_poker_guard_chip_seat','fn_poker_bind_diamond_seat',
      'fn_poker_diamond_entry_custody_is_the_entry',
      -- The Diamond tournament money doors (Phase 8, 2026-09-14): an entry
      -- into custody, an add to it, its refund, its unregistration and
      -- cancellation, the drain, the prize, the fee, the close, the shadow.
      'fn_poker_diamond_tournament_charge','fn_poker_diamond_tournament_custody_add',
      'fn_poker_diamond_tournament_refund','fn_poker_diamond_tournament_unregister',
      'fn_poker_diamond_tournament_cancel','fn_poker_diamond_tournament_drain',
      'fn_poker_diamond_tournament_pay','fn_poker_diamond_tournament_settle_fee',
      'fn_poker_diamond_tournament_close_custody','fn_poker_diamond_tournament_open_shadow',
      -- The two guards Phase 8 taught new names, and the two chip readers it
      -- routes by asset. The wallet guard is the one thing between a browser
      -- and profiles.diamonds.
      'fn_guard_profile_privileged_columns','fn_poker_guard_arena_structure',
      'fn_ca_escrow_can_pay','fn_ca_tournament_escrow',
      -- The Diamond satellite seat door (Phase 9, 2026-09-21): a satellite
      -- seat moved custody to custody, out of one prize bank into an entry.
      'fn_poker_diamond_tournament_seat_transfer',
      -- A balance never moves without its ledger row (2026-10-01): the tally,
      -- its two sides, the account key and the commit-time check.
      'fn_ca_ledger_tally_add','fn_ca_ledger_tally_key','fn_ca_felt_counts_table',
      'fn_ca_tally_balance_move','fn_ca_tally_ledger_leg','fn_ca_balance_has_its_ledger_row',
      -- Every chip store balances with its ledger row (2026-10-02): the store
      -- side of the tally, its pair helper and the Diamond-event scope.
      'fn_ca_tally_store_move','fn_ca_tally_pair','fn_ca_tournament_counts',
      -- And the list itself.
      'fn_ca_guard_watchlist'
    ]) x)
$function$;

SELECT public.fn_ca_declare_guard_redefinition('fn_ca_guard_watchlist', 'migration 20261002030942_every_chip_store_balances_with_its_ledger_row');
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_ledger_tally_key', 'migration 20261002030942_every_chip_store_balances_with_its_ledger_row');
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_balance_has_its_ledger_row', 'migration 20261002030942_every_chip_store_balances_with_its_ledger_row');
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_tally_store_move', 'migration 20261002030942_every_chip_store_balances_with_its_ledger_row');
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_tally_pair', 'migration 20261002030942_every_chip_store_balances_with_its_ledger_row');
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_tournament_counts', 'migration 20261002030942_every_chip_store_balances_with_its_ledger_row');

-- ---------------------------------------------------------------------------
-- 8. The migration refuses to commit unless the store invariant is installed whole
-- ---------------------------------------------------------------------------

DO $m$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(x.t || '.' || g.g, ', ') INTO v_missing
    FROM (VALUES ('club_members'), ('clubs'), ('agents'), ('club_wallets'), ('spin_bonus_pools'),
                 ('tournament_escrow'), ('tournament_tickets'), ('unions'), ('club_opening_setups')) AS x(t)
    CROSS JOIN (VALUES ('zy_ca_tally_store_move'), ('zz_ca_store_has_its_ledger_row')) AS g(g)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
      WHERE c.relnamespace = 'public'::regnamespace AND c.relname = x.t AND tg.tgname = g.g
        AND tg.tgenabled <> 'D'
        AND (g.g NOT LIKE 'zz_%' OR (tg.tgdeferrable AND tg.tginitdeferred)));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'the store invariant is not installed whole: %', v_missing;
  END IF;
  IF (SELECT count(*) FROM public.ca_ledger_invariant_store_mode WHERE mode = 'refuse') <> 6
     OR (SELECT count(*) FROM public.ca_ledger_invariant_store_mode WHERE mode = 'observe') <> 9 THEN
    RAISE EXCEPTION 'ca_ledger_invariant_store_mode must hold the six refusing stores and the nine observed ones';
  END IF;
  -- the keys the refusing check already judged are unchanged
  IF public.fn_ca_ledger_tally_key('player_wallet', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002')
       IS DISTINCT FROM 'player_wallet:00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000002'
     OR public.fn_ca_ledger_tally_key('club_treasury', '00000000-0000-0000-0000-000000000003', NULL)
       IS DISTINCT FROM 'club_treasury:00000000-0000-0000-0000-000000000003'
     OR public.fn_ca_ledger_tally_key('bbj_pool', '00000000-0000-0000-0000-000000000004', NULL)
       IS DISTINCT FROM 'bbj_pool:00000000-0000-0000-0000-000000000004'
     OR public.fn_ca_ledger_tally_key('table_stack', NULL, NULL) IS DISTINCT FROM 'table_stack'
     OR public.fn_ca_ledger_tally_key('settlement_suspense', NULL, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'fn_ca_ledger_tally_key changed a key the refusing stores already judge';
  END IF;
  RAISE NOTICE 'every chip store balances with its ledger row: tally and commit-time check on the promo, agent, club wallet, insurance, Spin reserve, tournament liability, ticket escrow, opening and leaderboard clearing stores (observe); the six proven stores still refuse';
END $m$;

COMMIT;
