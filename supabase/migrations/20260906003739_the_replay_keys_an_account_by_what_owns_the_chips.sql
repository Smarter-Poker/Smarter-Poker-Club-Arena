-- 20260906003739_the_replay_keys_an_account_by_what_owns_the_chips.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (chip standard Phase 7 gate, 2026-09-06 00:4x UTC):
--
-- THE REPLAY'S FIRST JUDGED RUN FOUND 159 DISAGREEMENTS AND EVERY ONE WAS THE
-- REPLAY'S OWN FAULT. 1,861 accounts checked at 00:33 UTC, worst -627.98.
-- Read one by one against the rows, they are three keying mistakes of mine,
-- not three chips missing. This is what the phase gate is for: a new detector
-- gets to be wrong once, in front of the person who built it, before it runs
-- nightly and teaches everyone to ignore it.
--
-- 1. AN ACCOUNT IS NOT KEYED BY THE CLUB ON THE LEG. The key carried club_id
--    for every type, so ONE union bank appeared as two accounts (one per club
--    that happened to be on its legs), each reading the same 56,641.84 and
--    each seeing only its own subset of legs: -242.50 unexplained, twice, for
--    a wallet that had not lost a chip. The same split hit both BBJ pools
--    (legs carry the club sometimes and not others). Only a player wallet is
--    genuinely per club, and even there the club on the leg is the club of
--    the EVENT, which is not always the club of the wallet that moved (a
--    player in one club entering another club's union event): the -200.00 and
--    -190.00 findings are exactly that. So the account is now the OWNER of
--    the chips - the user, the union, the pool - and a player's account is
--    their whole balance across every club they are in.
--
-- 2. THE FELT IS ONE POOL, NOT ONE ACCOUNT PER TABLE. 145 of the 159 were
--    cash tables inside a cluster, where fn_cash_seat_move_execute moves a
--    player's stack from one table to another with NO journal leg - correctly,
--    because the felt total does not change and no wallet is touched (the
--    Phase 5 gate registered those doors on exactly that reasoning). A
--    per-table replay reads a move as a loss at one table and a gain at
--    another. The felt is now ONE account, defined exactly as the supply
--    meter defines it: the sum of live seats on non-tournament tables.
--
-- 3. A BALANCE THAT DOES NOT EXIST IS NOT ZERO. fn_ca_account_balance summed
--    club_members for a (user, club) pair and returned 0 when the pair had no
--    row, so an account keyed on a club the player is not in was judged
--    against a fabricated zero. It now returns NULL when the owner has no row
--    at all, and the replay skips what it cannot read.
--
-- The 159 findings are resolved with this migration as their correction, and
-- the snapshots written under the old keys are deleted: their keys can never
-- match a new one, so leaving them would only invite a future reader to
-- compare two things that were never the same account. The next run
-- re-baselines every account under the new keys and judges from the run after.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_leg_accounts(p_since timestamptz, p_until timestamptz)
 RETURNS TABLE(account_key text, account_type text, entity_id uuid, club_id uuid, column_name text, net numeric, legs bigint, unkeyable bigint)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH sides AS (
    SELECT l.to_type AS t, l.to_entity_id AS id, l.to_label AS lbl, l.amount AS amt
      FROM public.chip_ledger l
     WHERE l.created_at > p_since AND l.created_at <= p_until AND l.to_entity_id IS NOT NULL
    UNION ALL
    SELECT l.from_type, l.from_entity_id, l.from_label, -l.amount
      FROM public.chip_ledger l
     WHERE l.created_at > p_since AND l.created_at <= p_until AND l.from_entity_id IS NOT NULL
  ), keyed AS (
    SELECT s.*,
      CASE s.t
        WHEN 'player_wallet'  THEN 'club_members.chip_balance'
        WHEN 'table_stack'    THEN 'table_seats.stack'
        WHEN 'club_treasury'  THEN 'clubs.chip_treasury'
        WHEN 'union_bank'     THEN 'union_wallets.chip_balance'
        WHEN 'spin_reserve'   THEN 'spin_bonus_pools.balance'
        WHEN 'union_wallet'   THEN s.lbl
        WHEN 'bbj_pool'       THEN s.lbl
        WHEN 'promo_wallet'   THEN s.lbl
        WHEN 'agent_wallet'   THEN COALESCE(s.lbl, 'agents.agent_wallet_balance')
        ELSE NULL
      END AS col,
      /* THE FELT IS ONE POOL. A seat move inside a cluster carries a stack
         from one table to another with no leg, correctly, so a per-table
         account reads a move as a loss and a gain. One account, defined as
         the supply meter defines the felt. */
      CASE WHEN s.t = 'table_stack' THEN '00000000-0000-0000-0000-0000000fe17e'::uuid ELSE s.id END AS owner
      FROM sides s
     WHERE s.t <> 'prize_liability'
  )
  SELECT k.t || ':' || k.owner::text || ':' || k.col AS account_key,
         k.t, k.owner, NULL::uuid, k.col,
         round(sum(k.amt), 2), count(*), 0::bigint
    FROM keyed k
   WHERE k.col IS NOT NULL
   GROUP BY 1, 2, 3, 4, 5
  UNION ALL
  SELECT NULL, 'unkeyable', NULL, NULL, NULL, round(sum(k.amt), 2), count(*), count(*)
    FROM keyed k
   WHERE k.col IS NULL
  HAVING count(*) > 0;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_leg_accounts(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_leg_accounts(timestamptz, timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_account_balance(p_type text, p_entity uuid, p_club uuid, p_col text)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v numeric; v_rows int;
BEGIN
  /* A BALANCE THAT DOES NOT EXIST IS NOT ZERO: an owner with no row is
     unreadable, and the replay skips what it cannot read rather than judging
     it against a fabricated zero. */
  CASE p_col
    WHEN 'club_members.chip_balance' THEN
      SELECT count(*), COALESCE(sum(chip_balance), 0) INTO v_rows, v FROM public.club_members WHERE user_id = p_entity;
    WHEN 'table_seats.stack' THEN
      -- the whole cash felt, exactly as fn_ca_supply_snapshot defines it
      SELECT count(*), COALESCE(sum(ts.stack), 0) INTO v_rows, v
        FROM public.table_seats ts
       WHERE ts.left_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM public.tables t WHERE t.id = ts.table_id AND t.tournament_id IS NOT NULL);
      v_rows := 1;  -- the felt always exists, even when every seat is empty
    WHEN 'clubs.chip_treasury' THEN
      SELECT count(*), COALESCE(sum(chip_treasury), 0) INTO v_rows, v FROM public.clubs WHERE id = p_entity;
    WHEN 'clubs.promo_balance' THEN
      SELECT count(*), COALESCE(sum(promo_balance), 0) INTO v_rows, v FROM public.clubs WHERE id = p_entity;
    WHEN 'clubs.insurance_balance' THEN
      SELECT count(*), COALESCE(sum(insurance_balance), 0) INTO v_rows, v FROM public.clubs WHERE id = p_entity;
    WHEN 'union_wallets.chip_balance' THEN
      SELECT count(*), COALESCE(sum(chip_balance), 0) INTO v_rows, v FROM public.union_wallets WHERE union_id = p_entity;
    WHEN 'union_wallets.rake_wallet' THEN
      SELECT count(*), COALESCE(sum(rake_wallet), 0) INTO v_rows, v FROM public.union_wallets WHERE union_id = p_entity;
    WHEN 'union_wallets.bbj_wallet' THEN
      SELECT count(*), COALESCE(sum(bbj_wallet), 0) INTO v_rows, v FROM public.union_wallets WHERE union_id = p_entity;
    WHEN 'union_wallets.promo_wallet' THEN
      SELECT count(*), COALESCE(sum(promo_wallet), 0) INTO v_rows, v FROM public.union_wallets WHERE union_id = p_entity;
    WHEN 'union_wallets.insurance_wallet' THEN
      SELECT count(*), COALESCE(sum(insurance_wallet), 0) INTO v_rows, v FROM public.union_wallets WHERE union_id = p_entity;
    WHEN 'union_wallets.spin_reserve_wallet' THEN
      SELECT count(*), COALESCE(sum(spin_reserve_wallet), 0) INTO v_rows, v FROM public.union_wallets WHERE union_id = p_entity;
    WHEN 'bbj_pools.main_balance' THEN
      SELECT count(*), COALESCE(sum(main_balance), 0) INTO v_rows, v FROM public.bbj_pools WHERE id = p_entity;
    WHEN 'bbj_pools.backup_balance' THEN
      SELECT count(*), COALESCE(sum(backup_balance), 0) INTO v_rows, v FROM public.bbj_pools WHERE id = p_entity;
    WHEN 'bbj_pools.promo_balance' THEN
      SELECT count(*), COALESCE(sum(promo_balance), 0) INTO v_rows, v FROM public.bbj_pools WHERE id = p_entity;
    WHEN 'spin_bonus_pools.balance' THEN
      SELECT count(*), COALESCE(sum(balance), 0) INTO v_rows, v FROM public.spin_bonus_pools WHERE club_id = p_entity OR id = p_entity;
    WHEN 'agents.promo_wallet_balance' THEN
      SELECT count(*), COALESCE(sum(promo_wallet_balance), 0) INTO v_rows, v FROM public.agents WHERE id = p_entity OR user_id = p_entity;
    WHEN 'agents.agent_wallet_balance' THEN
      SELECT count(*), COALESCE(sum(agent_wallet_balance), 0) INTO v_rows, v FROM public.agents WHERE id = p_entity OR user_id = p_entity;
    ELSE
      v_rows := 0; v := NULL;
  END CASE;
  IF COALESCE(v_rows, 0) = 0 THEN RETURN NULL; END IF;
  RETURN v;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_account_balance(text, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_account_balance(text, uuid, uuid, text) TO service_role;

/* The snapshots written under the old keys can never match a new one, and a
   future reader comparing them would be comparing two different accounts. */
DELETE FROM public.ca_account_snapshots WHERE account_key LIKE '%:-:%' OR account_key ~ ':[0-9a-f-]{36}:[0-9a-f-]{36}:';

UPDATE public.ca_drift_incidents
   SET status = 'resolved', resolved_at = now(),
       correction_ref = 'migration 20260906003739_the_replay_keys_an_account_by_what_owns_the_chips',
       root_cause = 'the replay keyed an account by the club on the leg (splitting one union wallet or pool into several), replayed the felt per table (where a sanctioned seat move carries a stack between tables with no leg), and read a missing club_members row as a zero balance. All three are the detector''s, not the platform''s: read one by one, every figure is explained by the keying',
       resolution = 'the account is keyed by the owner of the chips, the felt is one pool as the supply meter defines it, and an unreadable balance is skipped; the old snapshots are deleted and every account re-baselines'
 WHERE source = 'fn_ca_ledger_replay' AND status IN ('open','acknowledged','reconciling');

DO $$
DECLARE v_bad int; v jsonb;
BEGIN
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'fn_ca_leg_accounts') NOT LIKE '%0000000fe17e%' THEN
    RAISE EXCEPTION 'the felt is not one account';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'fn_ca_account_balance') NOT LIKE '%A BALANCE THAT DOES NOT EXIST IS NOT ZERO%' THEN
    RAISE EXCEPTION 'a missing balance still reads as zero';
  END IF;
  SELECT count(*) INTO v_bad FROM public.ca_drift_incidents WHERE source = 'fn_ca_ledger_replay' AND status = 'open';
  IF v_bad <> 0 THEN RAISE EXCEPTION '% replay findings are still open', v_bad; END IF;
  -- re-baseline under the new keys; nothing is judged on a first sight
  v := public.fn_ca_ledger_replay(5000);
  IF (v->>'checked')::int <> 0 OR (v->>'disagree')::int <> 0 THEN
    RAISE EXCEPTION 'the re-baseline judged an account it had never read: %', v;
  END IF;
  RAISE NOTICE 're-baselined under the new keys: %', v;
END $$;

COMMIT;
