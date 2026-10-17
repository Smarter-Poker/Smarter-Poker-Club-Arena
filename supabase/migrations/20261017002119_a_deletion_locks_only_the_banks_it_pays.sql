-- 20261017002119_a_deletion_locks_only_the_banks_it_pays.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT WAS WRONG, MEASURED ON PRODUCTION (2026-10-17 00:20 UTC):
--
-- Verifying 20261016224731 (a deleted account leaves every club), two
-- rolled-back deletions of live accounts were both refused with
--   could not obtain lock on row in relation "clubs"
-- - one an agent holding 10,183.67 club chips, the other a player holding
-- ZERO chips in three clubs. Nothing was deleted; nothing moved.
--
-- Two lines take the main-bank row of EVERY chip club the person belongs to,
-- whether or not a single chip is going there:
--   * fn_deleted_account_custody_settled (20261011051848) locks every such
--     bank FOR UPDATE NOWAIT before anything else;
--   * fn_ca_deleted_wallet_credit's profile branch calls
--     fn_ca_deleted_wallet_bank_return for every membership, and that function
--     locks the bank before it looks at the amount.
-- A house club's bank row is written by rake on nearly every hand, so NOWAIT
-- found it busy on both attempts: a deletion - Close Account included - of
-- anyone in Club JAQK, SHARK CLUB or Midway Union was refused far more often
-- than not, and the 20261016224731 lifecycle step behind it never ran.
--
-- WHAT THIS CHANGES (the two lines, nothing else):
--
--   1. The custody guard locks the person's own wallets first (agents, then
--      memberships, NOWAIT as before), reads what is free once nobody else can
--      change it, and only then takes the banks that will actually receive
--      chips. Every lock is still taken without queueing, so the October 11
--      no-deadlock property holds: a bank busy for a moment is retried in
--      place for up to two seconds (forty 50 ms polls, each its own NOWAIT,
--      never a wait in the lock queue) and then refused exactly as before.
--   2. The profile branch of fn_ca_deleted_wallet_credit returns chips only
--      from clubs where the person holds free chips. An empty wallet has
--      nothing to return, so its bank is not touched. The member and agent
--      credit branches are unchanged.
--
-- Every custody refusal (seated, tournament entry, pending cash-out, escrow,
-- held chips) is unchanged. No balance, receipt or ledger row is written here.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
--
-- @live-proof: position('fn_ca_try_lock_bank' in (SELECT prosrc FROM pg_proc WHERE oid='public.fn_deleted_account_custody_settled()'::regprocedure))>0 AND position('> 0' in (SELECT prosrc FROM pg_proc WHERE oid='public.fn_ca_deleted_wallet_credit()'::regprocedure))>0

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $preimage$
BEGIN
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.fn_deleted_account_custody_settled()'::regprocedure))
     <> '1053e01a49d88103f2ae097cde93223f' THEN
    RAISE EXCEPTION 'DELETION_BANK_LOCK_PREIMAGE_CHANGED: fn_deleted_account_custody_settled';
  END IF;
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.fn_ca_deleted_wallet_credit()'::regprocedure))
     <> 'a15faa154ce877b6d06786bcc144b643' THEN
    RAISE EXCEPTION 'DELETION_BANK_LOCK_PREIMAGE_CHANGED: fn_ca_deleted_wallet_credit';
  END IF;
END
$preimage$;

INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_deleted_account_custody_settled', 'system',
   'BEFORE UPDATE OF status on profiles, the account-deletion custody guard. Reads wallet balances only to decide which club banks to lock (only those receiving chips) and refuses while seats, entries, cash-outs, escrow or held chips remain. Writes no balance.')
ON CONFLICT (proname) DO NOTHING;

-- One bank row, taken without ever queueing: forty NOWAIT polls 50 ms apart.
CREATE OR REPLACE FUNCTION public.fn_ca_try_lock_bank(p_club uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE i integer;
BEGIN
  FOR i IN 1..40 LOOP
    BEGIN
      PERFORM 1 FROM public.clubs c WHERE c.id = p_club FOR UPDATE NOWAIT;
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      IF i = 40 THEN RAISE; END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_try_lock_bank(uuid) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.fn_ca_try_lock_bank(uuid) IS
  'Takes one club bank row without queueing behind it: NOWAIT, retried in place up to forty times 50 ms apart, then refuses with lock_not_available. Used by the account-deletion custody guard so a busy house bank does not refuse a deletion that has chips to return.';

CREATE OR REPLACE FUNCTION public.fn_deleted_account_custody_settled()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_bank uuid;
BEGIN
  -- Profile UPDATE already owns its row. Never wait for the inverse user/wallet
  -- order held by a credit, buy-in or cashier operation: refuse atomically instead.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('table_cap:' || OLD.id::text, 0)) THEN
    RAISE EXCEPTION 'ACCOUNT_CUSTODY_BUSY' USING ERRCODE = '55P03';
  END IF;
  -- Own the person's wallets first, without queueing. Once held, nobody can
  -- credit them, so what is free below is exactly what will be returned.
  PERFORM 1 FROM public.agents a WHERE a.user_id = OLD.id
    ORDER BY a.club_id FOR UPDATE NOWAIT;
  PERFORM 1 FROM public.club_members m WHERE m.user_id = OLD.id
    ORDER BY m.club_id FOR UPDATE NOWAIT;
  -- Then only the banks that will receive chips, still without queueing.
  -- An empty wallet never touches its club's bank.
  FOR v_bank IN
    SELECT c.id FROM public.clubs c
     WHERE c.asset = 'chips' AND c.lifecycle_status = 'active'
       AND (EXISTS (SELECT 1 FROM public.club_members m
                     WHERE m.club_id = c.id AND m.user_id = OLD.id
                       AND coalesce(m.chip_balance,0) - coalesce(m.held_chips,0) - coalesce(m.locked_chips,0) > 0)
            OR EXISTS (SELECT 1 FROM public.agents a
                        WHERE a.club_id = c.id AND a.user_id = OLD.id
                          AND coalesce(a.agent_wallet_balance,0) > 0))
     ORDER BY c.id
  LOOP
    PERFORM public.fn_ca_try_lock_bank(v_bank);
  END LOOP;

  IF EXISTS (SELECT 1 FROM public.table_seats s WHERE s.user_id = OLD.id AND s.left_at IS NULL) THEN
    RAISE EXCEPTION 'ACCOUNT_CUSTODY_UNSETTLED: seated' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_players p JOIN public.tournaments t ON t.id = p.tournament_id
    WHERE p.user_id = OLD.id AND p.status IN ('registered','playing')
      AND t.status NOT IN ('COMPLETED','CANCELLED')) THEN
    RAISE EXCEPTION 'ACCOUNT_CUSTODY_UNSETTLED: tournament_entry' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cashout_requests r
    WHERE (r.player_id = OLD.id OR r.agent_id = OLD.id)
      AND (r.status IN ('pending','cancelling','completing')
        OR (r.status = 'approved' AND r.completed_at IS NULL))) THEN
    RAISE EXCEPTION 'ACCOUNT_CUSTODY_UNSETTLED: pending_cashout' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.chip_escrow e WHERE e.player_id = OLD.id AND e.released_at IS NULL)
    OR EXISTS (SELECT 1 FROM public.chip_escrow_holds h WHERE h.user_id = OLD.id AND h.status = 'held') THEN
    RAISE EXCEPTION 'ACCOUNT_CUSTODY_UNSETTLED: escrow' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.club_members m WHERE m.user_id = OLD.id
    AND (coalesce(m.held_chips,0) <> 0 OR coalesce(m.locked_chips,0) <> 0)) THEN
    RAISE EXCEPTION 'ACCOUNT_CUSTODY_UNSETTLED: held_chips' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_deleted_wallet_credit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_club uuid;
BEGIN
 IF TG_TABLE_NAME='profiles' THEN
  -- Only clubs where the person holds free chips have anything to return.
  FOR v_club IN
   SELECT s.club_id FROM (
    SELECT m.club_id FROM public.club_members m WHERE m.user_id=NEW.id
      AND coalesce(m.chip_balance,0)-coalesce(m.held_chips,0)-coalesce(m.locked_chips,0) > 0
    UNION
    SELECT a.club_id FROM public.agents a WHERE a.user_id=NEW.id
      AND coalesce(a.agent_wallet_balance,0) > 0
   ) s ORDER BY s.club_id
  LOOP
   PERFORM public.fn_ca_deleted_wallet_bank_return(v_club,NEW.id,'wallets');
  END LOOP;
  RETURN NEW;
 END IF;
 IF EXISTS (SELECT 1 FROM public.profiles WHERE id=NEW.user_id AND status='deleted') THEN
  PERFORM public.fn_ca_deleted_wallet_bank_return(NEW.club_id,NEW.user_id,CASE WHEN TG_TABLE_NAME='agents' THEN 'agent_wallet' ELSE 'player_wallet' END);
 END IF;
 RETURN NEW;
END;
$function$;

COMMIT;
