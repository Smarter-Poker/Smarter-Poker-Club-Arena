-- 20260923031831_a_tombstone_does_not_need_owner_rights_and_the_admission_pre.sql
--
-- Version reserved by scripts/new-migration.mjs against this tree, origin/main
-- and every remote branch, so it cannot collide with another agent's in-flight
-- work (club-arena CLAUDE.md 4.5).
--
-- ALL DDL FOR THIS CHANGE IS IN ONE TRANSACTION. Every DDL statement fires
-- Supabase's pgrst_ddl_watch, and one PostgREST schema reload costs ~28s on
-- this database. Postgres coalesces the reload NOTIFYs inside one transaction,
-- so three loose ALTERs would be three reloads (CLAUDE.md section 2, rule 1).
--
-- WHY
-- `Telemetry Exposure` (run 35785525756) has been failing on main. Its reader,
-- public.fn_ca_browser_reachable_telemetry(), reported three routines that are
-- SECURITY DEFINER, take no identity argument, never consult auth.uid() /
-- auth.role() / auth.jwt(), and that a logged-in browser role may execute:
--
--   fn_ca_new_tournament_is_unlimited(p_config jsonb)   volatile  authenticated
--   fn_cashout_approve(uuid, text, uuid)                volatile  authenticated
--   fn_cashout_release(uuid, text, uuid)                volatile  authenticated
--
-- Both halves were read from pg_proc before anything was decided.
--
-- 1. THE TWO CASHIER ROUTINES ARE TOMBSTONES, AND OWNER RIGHTS BUY THEM
--    NOTHING. Their entire body, read live on 2026-09-23, is
--
--      BEGIN RAISE EXCEPTION 'cashier_v2_intent_required' USING ERRCODE='22023';END
--
--    (md5(prosrc) = aaf5c377a2a6b0e13ac95b5f11366bd3 for all three cashier
--    tombstones). They were retired in favour of the v2 intent route by
--    supabase/accounting/weekly-v3/components/
--    20260914164700_cashier_cashout_documents_share_the_existing_invoice_authority.sql.
--    They read no table, write no row and move no chips; a caller gets the
--    error that tells it to use the v2 route. A function that only raises does
--    not need to run as its owner, and the sibling tombstones written in the
--    very same statement block - fn_approve_cashout_atomic,
--    fn_cancel_cashout_atomic, fn_cancel_cashout, fn_request_cashout - carry no
--    SECURITY DEFINER at all. The definer attribute on these three is a
--    leftover of the CREATE OR REPLACE that retired them, and it is the only
--    reason they appear on an operator-console report at all.
--
--    So the fix is to take the privilege away, not to record an exception:
--    ALTER FUNCTION ... SECURITY INVOKER. They leave the report on their own
--    merits. `authenticated` KEEPS EXECUTE deliberately, so a stale client
--    still receives 'cashier_v2_intent_required' rather than a bare permission
--    error that says nothing about what to call instead. Nobody's access is
--    widened: PUBLIC and anon hold nothing here and are not given anything.
--
--    fn_cashout_request(uuid, numeric, text, uuid) is the third tombstone from
--    the same block, with the same body. The report does not name it only
--    because the word "club" inside p_club_id trips the identity-argument
--    filter in fn_ca_browser_reachable_telemetry(). Leaving it SECURITY DEFINER
--    would leave the identical latent finding behind a naming accident, so it
--    is corrected here with its two siblings.
--
-- 2. fn_ca_new_tournament_is_unlimited(jsonb) GENUINELY NEEDS BOTH. It is a
--    read-only boolean predicate: it takes a shared advisory lock, reads the
--    platform's own MTT admission contract through
--    fn_ca_lock_mtt_admission_contract(), and answers whether a config the
--    CALLER ALREADY HOLDS is a new unlimited MTT. It writes nothing and returns
--    no row of anybody's data.
--
--    It has to stay SECURITY DEFINER: fn_ca_lock_mtt_admission_contract() and
--    fn_ca_is_new_mtt(jsonb) are both granted to postgres alone, so as an
--    invoker it would fail for every browser role.
--
--    And `authenticated` has to keep EXECUTE. Two SECURITY INVOKER trigger
--    functions on public.tournaments call it -
--      tournaments_creation_guard             -> fn_tournaments_creation_guard()
--      tournaments_short_formats_never_break  -> fn_short_formats_never_break()
--    - and a trigger function that is SECURITY INVOKER runs as the role doing
--    the INSERT. `authenticated` holds INSERT on public.tournaments, so
--    revoking EXECUTE here would not close a console: it would make every
--    logged-in tournament creation fail with "permission denied for function".
--    That is exactly the outage shape check-telemetry-exposure.mjs records for
--    2026-09-06, when the first remedy it printed would have taken the public
--    video feed offline.
--
--    So this one is a written decision, recorded where the reader looks, with
--    the triggers named as the reason - the path the check itself prescribes.
--
-- Nothing here weakens either audit's assertion: no allowlist entry is added
-- for the cashier routines, and no grant is widened for anyone.

BEGIN;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '30s';

-- Refuse if the board moved underneath this migration. Each tombstone must
-- still be the unconditional raise that makes SECURITY INVOKER safe, and the
-- admission predicate must still be the definer that its triggers need.
DO $$
DECLARE v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.fn_cashout_request(uuid,numeric,text,uuid)',
    'public.fn_cashout_approve(uuid,text,uuid)',
    'public.fn_cashout_release(uuid,text,uuid)'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.oid = v_sig::regprocedure
         AND md5(p.prosrc) = 'aaf5c377a2a6b0e13ac95b5f11366bd3'
    ) THEN
      RAISE EXCEPTION
        '% is no longer the cashier_v2 tombstone; re-read it before changing its security attribute', v_sig;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_ca_new_tournament_is_unlimited(jsonb)'::regprocedure
       AND p.prosecdef
       AND p.prosrc ~ 'fn_ca_lock_mtt_admission_contract'
  ) THEN
    RAISE EXCEPTION 'fn_ca_new_tournament_is_unlimited is not the definer admission predicate this migration reviewed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.proname IN ('fn_tournaments_creation_guard','fn_short_formats_never_break')
       AND NOT p.prosecdef
       AND p.prosrc ~ 'fn_ca_new_tournament_is_unlimited'
  ) THEN
    RAISE EXCEPTION 'the invoker triggers that need EXECUTE on the admission predicate are gone; re-derive the grant decision';
  END IF;
END $$;

-- 1. A tombstone runs as whoever called it. It only raises.
ALTER FUNCTION public.fn_cashout_request(uuid, numeric, text, uuid) SECURITY INVOKER;
ALTER FUNCTION public.fn_cashout_approve(uuid, text, uuid) SECURITY INVOKER;
ALTER FUNCTION public.fn_cashout_release(uuid, text, uuid) SECURITY INVOKER;

-- 2. The admission predicate is a trigger helper, and the decision is written
--    down where fn_ca_browser_reachable_telemetry() reads it.
INSERT INTO public.ca_browser_definer_allowlist (proname, reason) VALUES (
  'fn_ca_new_tournament_is_unlimited',
  'Read-only boolean predicate over a config the caller already holds, plus the '
  'platform''s own MTT admission contract. It writes nothing and returns no row '
  'of anybody''s data. It must stay SECURITY DEFINER because '
  'fn_ca_lock_mtt_admission_contract() and fn_ca_is_new_mtt(jsonb) are granted to '
  'postgres alone, and authenticated must keep EXECUTE because two SECURITY '
  'INVOKER triggers on public.tournaments call it - tournaments_creation_guard '
  'and tournaments_short_formats_never_break - and a SECURITY INVOKER trigger '
  'runs as the role doing the INSERT. authenticated holds INSERT on '
  'public.tournaments, so revoking EXECUTE would fail every logged-in tournament '
  'creation with permission denied rather than close a console.'
) ON CONFLICT (proname) DO NOTHING;

-- Prove it took, in the same transaction, rather than assuming it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('fn_cashout_request','fn_cashout_approve','fn_cashout_release')
       AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'a cashier tombstone is still SECURITY DEFINER';
  END IF;

  -- The tombstones still answer a stale client with the v2 instruction rather
  -- than a bare permission error, and no pre-login role was handed anything.
  IF NOT has_function_privilege('authenticated','public.fn_cashout_approve(uuid,text,uuid)','EXECUTE')
  OR NOT has_function_privilege('authenticated','public.fn_cashout_release(uuid,text,uuid)','EXECUTE')
  OR has_function_privilege('anon','public.fn_cashout_approve(uuid,text,uuid)','EXECUTE')
  OR has_function_privilege('anon','public.fn_cashout_release(uuid,text,uuid)','EXECUTE')
  OR has_function_privilege('anon','public.fn_cashout_request(uuid,numeric,text,uuid)','EXECUTE')
  THEN
    RAISE EXCEPTION 'the cashier tombstone grants are not what this migration intended';
  END IF;

  -- And the four routines this migration is about have left the report. Only
  -- these four: a concurrent agent's unrelated finding is that agent's to
  -- settle, and aborting on it would cost a schema reload and fix nothing.
  IF EXISTS (
    SELECT 1 FROM public.fn_ca_browser_reachable_telemetry() r
     WHERE r.proname IN ('fn_ca_new_tournament_is_unlimited','fn_cashout_request',
                         'fn_cashout_approve','fn_cashout_release')
  ) THEN
    RAISE EXCEPTION 'a routine this migration closed is still reachable from a browser: %',
      (SELECT string_agg(r.proname, ', ') FROM public.fn_ca_browser_reachable_telemetry() r
        WHERE r.proname IN ('fn_ca_new_tournament_is_unlimited','fn_cashout_request',
                            'fn_cashout_approve','fn_cashout_release'));
  END IF;
END $$;

COMMIT;
