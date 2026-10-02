-- 20261001204507_the_push_deliverability_finding_is_not_a_chip_amount.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- ca_drift_incidents 134a2dd1-8411-42b3-b2a1-6415139513ee has sat on the
-- board since 2026-09-28 14:40 UTC as "fn_ca_negative_balance_watch, 1.00",
-- re-touched 456 times, counted by every reader as one chip of unexplained
-- drift. It is not a chip. Read from rows on 2026-10-01 20:10 UTC: no
-- club_members.chip_balance, clubs.chip_treasury, union_wallets.* or agents.*
-- balance is below zero, the watch has never raised a negative-balance:* key
-- in its life, and the row's own fields say so (entity_type
-- push_subscriptions, dedupe_key push-deliverability:2026-09-28,
-- ledger_balanced true, metadata.recipients_without_fresh_receipts = 1).
--
-- The cause is one argument. The watch's "power light" branch - a registered
-- incident recipient has no push subscription with a delivery receipt in 48
-- hours - passes v_stale (a COUNT of recipients) in the p_discrepancy position
-- of fn_ca_raise_drift_incident, so a count of phones lands in
-- discrepancy_amount, a money column, and the board reports it as 1.00 of
-- chip drift. The count already travels in metadata, where it belongs.
--
-- Fix at the line (CLAUDE.md 10.11): the finding is raised with NULL
-- discrepancy, expected and actual. Nothing else about the watch changes.
-- The function is on fn_ca_guard_watchlist, so the redefinition is declared
-- in the same transaction; the live body is pinned by md5 so a changed
-- function is not overwritten blind.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '60s';

DO $m$
DECLARE v_live text;
BEGIN
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_live
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'fn_ca_negative_balance_watch';
  IF v_live IS DISTINCT FROM 'fe7ccdb6dcfb35c4cde9775b516c6a57' THEN
    RAISE EXCEPTION 'fn_ca_negative_balance_watch is not the body read on 2026-10-01 (md5 %); re-read it before redefining it', v_live;
  END IF;
END $m$;

CREATE OR REPLACE FUNCTION public.fn_ca_negative_balance_watch()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_hits int := 0; r record; v_stale int;
BEGIN
  FOR r IN
    SELECT 'club_members' AS store, user_id::text AS who, club_id, chip_balance AS bal
      FROM club_members WHERE chip_balance < 0
    UNION ALL
    SELECT 'clubs', id::text, id, chip_treasury FROM clubs WHERE chip_treasury < 0
    UNION ALL
    SELECT 'union_wallets', union_id::text, NULL,
           LEAST(chip_balance, rake_wallet, bbj_wallet, promo_wallet, insurance_wallet,
                 COALESCE(spin_reserve_wallet,0))
      FROM union_wallets
     WHERE LEAST(chip_balance, rake_wallet, bbj_wallet, promo_wallet, insurance_wallet,
                 COALESCE(spin_reserve_wallet,0)) < 0
    UNION ALL
    SELECT 'agents', user_id::text, club_id,
           LEAST(COALESCE(agent_wallet_balance,0), COALESCE(promo_wallet_balance,0))
      FROM agents
     WHERE COALESCE(agent_wallet_balance,0) < 0 OR COALESCE(promo_wallet_balance,0) < 0
    LIMIT 20
  LOOP
    v_hits := v_hits + 1;
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_negative_balance_watch', 'ledger_imbalance', 'critical',
      'negative-balance:' || r.store || ':' || r.who,
      r.bal, 0, r.bal, 'ledger', r.store, NULL, r.club_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'a balance store went below zero - a debit path is missing its floor check; nothing was blocked, review the store''s recent ledger rows',
      false, jsonb_build_object('store', r.store, 'entity', r.who, 'balance', r.bal));
  END LOOP;

  -- the siren's own power light
  SELECT count(*) INTO v_stale FROM ca_incident_recipients rec
   WHERE rec.active
     AND NOT EXISTS (
       SELECT 1 FROM push_subscriptions s
        WHERE s.user_id = rec.user_id AND s.is_active
          AND COALESCE(s.last_receipt_at, s.created_at) > now() - interval '48 hours');
  IF v_stale > 0 THEN
    /* A count of recipients is not a chip amount (2026-10-01). It travels in
       metadata; discrepancy_amount stays NULL so the board does not report a
       phone with no receipt as 1.00 of chip drift. */
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_negative_balance_watch', 'unknown', 'warning',
      'push-deliverability:' || to_char(now(), 'YYYY-MM-DD'),
      NULL, NULL, NULL, 'reporting', 'push_subscriptions',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'a registered incident recipient has no push subscription with a delivery receipt in 48h - alerts may not be reaching a phone; check the device''s notification permissions',
      true, jsonb_build_object('recipients_without_fresh_receipts', v_stale));
  END IF;

  RETURN v_hits;
END $function$;

-- Operator telemetry, run by the scheduler as its owner: nothing a browser
-- role should be able to call (pre-push check-definer-authorization, 2026-10-01;
-- the grant it found was pre-existing, closed here in the same transaction).
REVOKE ALL ON FUNCTION public.fn_ca_negative_balance_watch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_negative_balance_watch() TO service_role;

SELECT public.fn_ca_declare_guard_redefinition('fn_ca_negative_balance_watch', 'migration 20261001204507_the_push_deliverability_finding_is_not_a_chip_amount');

DO $m$
BEGIN
  IF (SELECT prosrc FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'fn_ca_negative_balance_watch')
     !~ $q$'push-deliverability:' \|\| to_char\(now\(\), 'YYYY-MM-DD'\),\s+NULL, NULL, NULL, 'reporting'$q$ THEN
    RAISE EXCEPTION 'the push-deliverability finding still carries a count in the discrepancy position';
  END IF;
END $m$;

COMMIT;
