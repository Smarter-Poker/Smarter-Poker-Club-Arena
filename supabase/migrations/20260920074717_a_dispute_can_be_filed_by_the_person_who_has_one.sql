-- 20260920074717_a_dispute_can_be_filed_by_the_person_who_has_one
--
-- Applied to production as version 20260920060705 (the apply transport stamps
-- its own version; match by name, never by version).
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- RECORDED AFTER THE FACT. This change was applied to production through the
-- Supabase MCP and was never written into the repository. Every statement
-- below was read back out of the live catalog, the two function bodies with
-- pg_get_functiondef and the policy expression from pg_policy, and checked
-- byte for byte against what the catalog returned. Nothing here was retyped
-- from a branch, a transcript or memory. The repository records what the
-- database holds.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- public.disputes had held ZERO ROWS since the day it was created.
--
-- submitDispute wrote its row with a raw INSERT from the browser client. On
-- public.disputes the authenticated role holds SELECT and nothing else, row
-- level security is on, and the one policy on the table is SELECT only. There
-- was no grant for that INSERT to stand on and no policy that would have let
-- the row through if there had been, so the dispute button on the client has
-- never once produced a dispute. The queue an admin opens to see what players
-- are complaining about was empty because the complaints could not be written
-- down, not because nobody complained.
--
-- withdrawDispute had the mirror of the same defect and a worse symptom. It
-- was a client UPDATE against a table with no UPDATE grant, so it matched zero
-- rows and REPORTED SUCCESS. A player who withdrew a dispute was told it had
-- been withdrawn. Nothing had changed, because there was nothing there to
-- change.
--
-- This was already a solved problem on this table and the solution had only
-- been applied to half of it. fn_dispute_start_review, fn_resolve_dispute and
-- fn_dispute_escalate had each already been moved behind a SECURITY DEFINER
-- entry point, which is why the reviewer side of the workflow works. The two
-- doors a PLAYER uses were the two that were left as raw client writes. This
-- migration adds the two that were missing; it does not invent a new pattern.
--
-- ===========================================================================
-- WHAT THIS CHANGES
--
-- Two SECURITY DEFINER entry points, built the same way as the three that were
-- already here.
--
-- fn_dispute_submit takes the target, the club, the amount and the reason, and
-- takes NOTHING ELSE from the caller. submitted_by is auth.uid() read inside
-- the function, never a parameter, so a caller cannot file a dispute in
-- somebody else's name. submitter_name comes from fn_player_display_name for
-- the same reason: a display name supplied by the browser is a display name
-- the browser chose. status is always 'open'; there is no argument that could
-- open a dispute already resolved. Standing is checked before anything is
-- written, and it is the only authorisation question this entry point can
-- answer on its own: the caller must be a member of the club, an admin of it,
-- or platform staff. One live dispute per caller per target, so a second press
-- of the button returns already_open with the existing id rather than filling
-- a review queue with the same grievance five times.
--
-- fn_dispute_withdraw locks the row, refuses anyone who is not the submitter,
-- and refuses a status that is not open or under_review. A club admin closes a
-- dispute by RESOLVING it, which is on the record. Withdrawal is the submitter
-- saying they no longer press the claim, and an admin cannot say that on their
-- behalf.
--
-- The SELECT policy gains ONE DISJUNCT, submitted_by = auth.uid(). Until now a
-- player could file a dispute they would then be unable to read: the policy let
-- platform admins and club admins see the row and nobody else. The person who
-- filed it is a party to it. The two admin disjuncts are untouched.
--
-- NO NEW TRIGGER, DELIBERATELY. trg_notify_dispute already fires AFTER INSERT
-- OR UPDATE OF status on this table, so a dispute written through the new entry
-- point raises its notification by the path that was already there. Adding a
-- second notifier would have produced two alerts per dispute.
--
-- ===========================================================================
-- ONE DIFFERENCE FROM THE APPLIED TEXT, DELIBERATE
--
-- The verification below is STRUCTURAL ONLY and writes nothing. The behavioural
-- probe that would prove this best is to file a dispute and withdraw it, and
-- this file is a record of a change that is already live: running it must not
-- leave a test row in a real admin queue. The structure it does assert is the
-- part that was actually broken, which was never the function body but who was
-- allowed to reach it.
--
-- @live-proof: (SELECT count(*) = 2 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('fn_dispute_submit','fn_dispute_withdraw') AND p.prosecdef)
-- ===========================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.fn_dispute_submit(p_target_type text, p_target_id text, p_club_id uuid, p_amount numeric, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller   uuid := auth.uid();
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_amount   numeric := coalesce(p_amount, 0);
  v_existing uuid;
  v_id       uuid;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'a dispute must be filed by a signed-in account'
      USING ERRCODE = '42501';
  END IF;

  IF p_target_type IS NULL
     OR p_target_type NOT IN ('agent_settlement', 'cashout_request',
                              'credit_invoice', 'commission_payout') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_target_type');
  END IF;

  IF nullif(btrim(coalesce(p_target_id, '')), '') IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'target_required');
  END IF;

  IF v_reason IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'reason_required');
  END IF;

  -- An amount is what is in dispute, and fn_resolve_dispute caps any
  -- adjustment at it. A negative one would cap nothing.
  IF v_amount < 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_amount');
  END IF;

  IF p_club_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = p_club_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'club_not_found');
  END IF;

  -- Standing: a member of the club, an admin of it, or platform staff. A
  -- stranger cannot open a dispute against a club they have no relationship
  -- with, which is the only authorisation question this entry point can
  -- answer on its own. Whether the disputed target belongs to the caller is
  -- the reviewer's job, and fn_resolve_dispute already holds the money.
  IF NOT (public.fn_is_club_member_uid(p_club_id)
          OR public.fn_is_club_admin_uid(p_club_id)
          OR public.fn_is_platform_admin()) THEN
    RAISE EXCEPTION 'not a member of this club'
      USING ERRCODE = '42501';
  END IF;

  -- One live dispute per caller per target. A second press of the button is a
  -- duplicate, not a new grievance, and an admin queue full of the same row
  -- five times is how a real one gets missed.
  SELECT d.id INTO v_existing
    FROM public.disputes d
   WHERE d.submitted_by = v_caller
     AND d.target_type  = p_target_type
     AND d.target_id    = p_target_id
     AND d.status IN ('open', 'under_review')
   LIMIT 1;

  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_open',
                              'dispute_id', v_existing);
  END IF;

  INSERT INTO public.disputes (
    submitted_by, submitter_name, target_type, target_id,
    club_id, amount, reason, status
  ) VALUES (
    v_caller,
    coalesce(public.fn_player_display_name(v_caller), 'Unknown'),
    p_target_type, p_target_id,
    p_club_id, v_amount, v_reason, 'open'
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'dispute_id', v_id, 'status', 'open');
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_dispute_withdraw(p_dispute_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller    uuid := auth.uid();
  v_submitter uuid;
  v_status    text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'a dispute must be withdrawn by a signed-in account'
      USING ERRCODE = '42501';
  END IF;

  SELECT d.submitted_by, coalesce(d.status, 'open')
    INTO v_submitter, v_status
    FROM public.disputes d
   WHERE d.id = p_dispute_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'dispute not found' USING ERRCODE = 'P0002';
  END IF;

  -- Only the person who filed it. A club admin closes a dispute by resolving
  -- it, which is on the record; withdrawal is the submitter saying they no
  -- longer press the claim, and an admin cannot say that on their behalf.
  IF v_submitter IS DISTINCT FROM v_caller THEN
    RAISE EXCEPTION 'only the submitter may withdraw a dispute'
      USING ERRCODE = '42501';
  END IF;

  IF v_status NOT IN ('open', 'under_review') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_withdrawable',
                              'status', v_status);
  END IF;

  UPDATE public.disputes
     SET status = 'withdrawn',
         updated_at = now()
   WHERE id = p_dispute_id;

  RETURN jsonb_build_object('ok', true, 'status', 'withdrawn');
END;
$function$;

-- A REBUILD IS WHERE A DEFINER BECOMES BROWSER-REACHABLE BY ACCIDENT.
-- Against production these two statements are a no-op: the live ACL on both
-- functions is postgres, authenticated, service_role, with no PUBLIC and no
-- anon entry. On a FRESH rebuild CREATE OR REPLACE is a CREATE, and this
-- project carries ALTER DEFAULT PRIVILEGES granting EXECUTE on new functions
-- in schema public to anon as well, so silence here would hand an
-- unauthenticated caller a writer. The roles are named rather than trusting
-- REVOKE FROM PUBLIC, which does not close a function that also holds an
-- explicit grant.
REVOKE ALL ON FUNCTION public.fn_dispute_submit(text, text, uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_dispute_submit(text, text, uuid, numeric, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.fn_dispute_withdraw(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_dispute_withdraw(uuid) TO authenticated, service_role;

-- THE PERSON WHO FILED IT IS A PARTY TO IT. The two admin disjuncts are
-- exactly as they were; the third is the new one. Dropped and recreated rather
-- than altered because CREATE POLICY has no OR REPLACE, which is also what
-- makes this file safe to re-run against production, where it already exists.
DROP POLICY IF EXISTS disputes_party_or_admin_select ON public.disputes;

CREATE POLICY disputes_party_or_admin_select ON public.disputes
  FOR SELECT TO authenticated
  USING ((fn_is_platform_admin() OR fn_is_club_admin_uid(club_id) OR (submitted_by = auth.uid())));

DO $verify$
DECLARE
  v_qual text;
  v_def  text;
BEGIN
  ---------------------------------------------------------------------------
  -- THE TWO ENTRY POINTS EXIST AND RUN AS THE OWNER.
  ---------------------------------------------------------------------------
  IF to_regprocedure('public.fn_dispute_submit(text,text,uuid,numeric,text)') IS NULL THEN
    RAISE EXCEPTION 'failed: fn_dispute_submit was not created';
  END IF;
  IF to_regprocedure('public.fn_dispute_withdraw(uuid)') IS NULL THEN
    RAISE EXCEPTION 'failed: fn_dispute_withdraw was not created';
  END IF;
  IF NOT (SELECT bool_and(p.prosecdef)
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public'
             AND p.proname IN ('fn_dispute_submit', 'fn_dispute_withdraw')) THEN
    RAISE EXCEPTION 'failed: a dispute entry point is not SECURITY DEFINER, so it cannot write past the SELECT-only policy';
  END IF;

  ---------------------------------------------------------------------------
  -- WHO MAY CALL THEM. A signed-in player yes, an unauthenticated caller no.
  ---------------------------------------------------------------------------
  IF NOT has_function_privilege('authenticated', 'public.fn_dispute_submit(text,text,uuid,numeric,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fn_dispute_withdraw(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'failed: authenticated cannot execute a dispute entry point, so the button is still dead';
  END IF;
  IF has_function_privilege('anon', 'public.fn_dispute_submit(text,text,uuid,numeric,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_dispute_withdraw(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'failed: anon can execute a dispute entry point';
  END IF;

  ---------------------------------------------------------------------------
  -- THE OTHER DIRECTION. Granting authenticated INSERT and UPDATE on the table
  -- would also have made the button work, and it is the fix this migration
  -- exists to avoid: it would let the browser choose submitted_by, the status
  -- and the submitter name. If a later change widens the table grant, the
  -- definer has stopped being the only door and this must fail.
  ---------------------------------------------------------------------------
  IF has_table_privilege('authenticated', 'public.disputes', 'INSERT')
     OR has_table_privilege('authenticated', 'public.disputes', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.disputes', 'DELETE') THEN
    RAISE EXCEPTION 'failed: authenticated holds a direct write grant on public.disputes; the entry points are no longer the only door';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.disputes'::regclass) THEN
    RAISE EXCEPTION 'failed: row level security is off on public.disputes';
  END IF;

  ---------------------------------------------------------------------------
  -- THE POLICY GAINED ITS THIRD DISJUNCT AND KEPT THE OTHER TWO.
  ---------------------------------------------------------------------------
  SELECT pg_get_expr(pol.polqual, pol.polrelid) INTO v_qual
    FROM pg_policy pol
   WHERE pol.polrelid = 'public.disputes'::regclass
     AND pol.polname = 'disputes_party_or_admin_select';

  IF v_qual IS NULL THEN
    RAISE EXCEPTION 'failed: disputes_party_or_admin_select does not exist';
  END IF;
  IF position('submitted_by = auth.uid()' in v_qual) = 0 THEN
    RAISE EXCEPTION 'failed: the submitter cannot read their own dispute: %', v_qual;
  END IF;
  IF position('fn_is_platform_admin()' in v_qual) = 0
     OR position('fn_is_club_admin_uid(club_id)' in v_qual) = 0 THEN
    RAISE EXCEPTION 'failed: an admin disjunct was lost while adding the submitter: %', v_qual;
  END IF;

  ---------------------------------------------------------------------------
  -- THE NOTIFIER THAT WAS ALREADY HERE IS STILL THE ONLY ONE.
  ---------------------------------------------------------------------------
  SELECT pg_get_triggerdef(t.oid) INTO v_def
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.disputes'::regclass
     AND t.tgname = 'trg_notify_dispute';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'failed: trg_notify_dispute is gone, so a filed dispute notifies nobody';
  END IF;
  IF position('INSERT' in v_def) = 0 THEN
    RAISE EXCEPTION 'failed: trg_notify_dispute no longer fires on INSERT: %', v_def;
  END IF;

  RAISE NOTICE 'a dispute can be filed and withdrawn by the person who has one; the table grant was not widened';
END
$verify$;

COMMIT;
