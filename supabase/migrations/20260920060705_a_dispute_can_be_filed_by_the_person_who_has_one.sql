-- a_dispute_can_be_filed_by_the_person_who_has_one
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- public.disputes has held ZERO rows since the table was created. Not one
-- dispute has ever been filed on this platform, by anyone.
--
-- DisputeService.submitDispute does a raw client INSERT:
--
--     await supabase.from('disputes').insert({ ... })
--
-- and the table's grants are:
--
--     authenticated -> SELECT, REFERENCES, TRIGGER
--     anon          -> SELECT, REFERENCES, TRIGGER
--
-- No INSERT. RLS is on and the single policy, disputes_party_or_admin_select,
-- is SELECT only. So the insert was refused for every user who ever pressed
-- the button, and the empty table is the proof.
--
-- The rest of the lifecycle was already repaired. startReview, resolve and
-- escalate were each moved to a SECURITY DEFINER entry point after the same
-- discovery was made about them:
--
--     fn_dispute_start_review, fn_resolve_dispute, fn_dispute_escalate
--
-- All three are granted to authenticated and all three work. They have simply
-- never had anything to act on, because the front door was still shut. Fixing
-- the middle of a workflow while its entry point refuses every caller is how a
-- feature comes to look finished and be entirely inert.
--
-- withdrawDispute is the other half of the same defect: a client UPDATE
-- against a table with no UPDATE grant and no UPDATE policy. It would have
-- matched zero rows and reported success, because a filtered UPDATE that
-- matches nothing is not an error.
--
-- ===========================================================================
-- WHAT THIS DOES
--
-- Two definer entry points, in the house style already set by
-- fn_dispute_start_review: a jsonb envelope with ok/reason, exceptions only
-- for authorisation and for genuinely absent rows.
--
--   fn_dispute_submit   - the caller files against a club they belong to
--   fn_dispute_withdraw - the submitter withdraws their own open dispute
--
-- Three things are deliberately NOT taken from the client:
--
--   submitted_by    - auth.uid(), never a caller-supplied user id. The old
--                     client INSERT passed userId in from the browser, so a
--                     working version of that code would have let anyone file
--                     a dispute in somebody else's name. It never worked, so
--                     it was never exploitable, and this does not reintroduce
--                     it.
--   submitter_name  - fn_player_display_name, which is fn_arena_name: the
--                     handle, never a legal name. src/utils/playerDisplayName
--                     is emphatic that a real name is a privacy leak on a
--                     poker surface, and a name posted into an admin queue by
--                     the browser could say anything at all.
--   status          - always 'open'. A dispute does not get to be born
--                     resolved.
--
-- The SELECT policy is widened by exactly one disjunct so that a submitter can
-- read their own dispute. Today the policy admits platform admins and club
-- admins only, which means DisputeService.getMyDisputes returns an empty list
-- for an ordinary member even once filing works. Nobody else's rows become
-- visible: submitted_by = auth.uid() is the narrowest possible addition.
--
-- No new trigger (CLAUDE.md 10.85). trg_notify_dispute already fires on
-- INSERT and on a status change, so the club owner is told by the existing
-- path the moment a row can finally exist.
--
-- No watcher, no repair job, no backfill. There is nothing to back-fill: the
-- table is empty because the feature never ran, not because rows went astray.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_dispute_submit(
  p_target_type text,
  p_target_id   text,
  p_club_id     uuid,
  p_amount      numeric,
  p_reason      text
) RETURNS jsonb
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

CREATE OR REPLACE FUNCTION public.fn_dispute_withdraw(
  p_dispute_id uuid
) RETURNS jsonb
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

-- A definer function is created with EXECUTE to PUBLIC, and this database also
-- carries ALTER DEFAULT PRIVILEGES that hand EXECUTE to anon and authenticated.
-- Revoke first, then grant exactly who may call these. anon must not: filing a
-- dispute is an act by an account.
REVOKE ALL ON FUNCTION public.fn_dispute_submit(text, text, uuid, numeric, text)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_dispute_withdraw(uuid)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fn_dispute_submit(text, text, uuid, numeric, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_dispute_withdraw(uuid)
  TO authenticated, service_role;

-- The submitter reads their own. One disjunct, nothing else changes.
ALTER POLICY disputes_party_or_admin_select ON public.disputes
  USING (
    fn_is_platform_admin()
    OR fn_is_club_admin_uid(club_id)
    OR submitted_by = auth.uid()
  );

DO $verify$
DECLARE
  v_acl   text;
  v_using text;
  v_out   jsonb;
BEGIN
  -- The table itself must still refuse a direct client write. The RPC is the
  -- only door, and if a later migration hands out INSERT this assertion is
  -- what says so.
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND table_name = 'disputes'
       AND grantee IN ('anon', 'authenticated')
       AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
  ) THEN
    RAISE EXCEPTION 'a browser role now holds a direct write on disputes';
  END IF;

  FOR v_acl IN
    SELECT unnest(coalesce(p.proacl, '{}'::aclitem[]))::text
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('fn_dispute_submit', 'fn_dispute_withdraw')
  LOOP
    IF v_acl LIKE 'anon=%' THEN
      RAISE EXCEPTION 'anon may call a dispute writer: %', v_acl;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_dispute_submit'
       AND p.prosecdef AND array_to_string(p.proconfig, ',') LIKE '%search_path=public%'
  ) THEN
    RAISE EXCEPTION 'fn_dispute_submit is not a pinned definer';
  END IF;

  SELECT pg_get_expr(polqual, polrelid) INTO v_using
    FROM pg_policy WHERE polrelid = 'public.disputes'::regclass
     AND polname = 'disputes_party_or_admin_select';
  IF v_using NOT LIKE '%submitted_by = auth.uid()%' THEN
    RAISE EXCEPTION 'the submitter still cannot read their own dispute: %', v_using;
  END IF;

  -- Behavioural, not structural. Every one of these refusals happens before
  -- any row is written, so the probe leaves nothing behind. auth.uid() is
  -- NULL here, so the first call proves the signed-out refusal directly.
  BEGIN
    v_out := public.fn_dispute_submit('agent_settlement', 'x',
               '00000000-0000-0000-0000-000000000000'::uuid, 1, 'probe');
    RAISE EXCEPTION 'a signed-out caller was allowed to file: %', v_out;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: a signed-out caller cannot file a dispute';
  END;

  BEGIN
    v_out := public.fn_dispute_withdraw(gen_random_uuid());
    RAISE EXCEPTION 'a signed-out caller was allowed to withdraw: %', v_out;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: a signed-out caller cannot withdraw a dispute';
  END;

  RAISE NOTICE 'PASS: dispute filing has a door, and it is the only one';
END;
$verify$;