-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424040209 "20260421192000_hg_anonymize_caller_identity_check"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 226637449f304c66bd2d3b720680b5e9 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- SECURITY: fn_anonymize_hg_user_content checked the role of
-- p_requested_by but never verified auth.uid() = p_requested_by.
-- An attacker could pass p_requested_by = <any admin's uuid> and
-- nuke anyone's HG content. Add caller-identity check.
--
-- Fail-closed semantics: NULL auth.role()/auth.uid() rejected
-- via IS DISTINCT FROM pattern.

CREATE OR REPLACE FUNCTION public.fn_anonymize_hg_user_content(
  p_user_id uuid, p_requested_by uuid
)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role text;
  v_counts jsonb := '{}'::jsonb;
  v_n int;
BEGIN
  IF p_user_id IS NULL OR p_requested_by IS NULL THEN
    RAISE EXCEPTION 'user_id and requested_by required'
          USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- ★ NEW: caller-identity check — prevents impersonation where Bob
  -- claims p_requested_by = Alice (admin)'s uuid to scrub anyone.
  -- service_role bypasses (server-side tooling).
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_requested_by THEN
      RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Authz: self OR platform admin (of the authenticated caller)
  SELECT role INTO v_role FROM public.profiles WHERE id = p_requested_by;
  IF p_user_id <> p_requested_by AND v_role NOT IN ('admin','superadmin','god') THEN
    RAISE EXCEPTION 'only the user or a platform admin may scrub HG content'
          USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- ── Anonymization sweeps ──
  UPDATE public.commander_home_posts
     SET content = '[content removed]',
         image_urls = NULL, video_url = NULL,
         is_hidden = true,
         hidden_at = COALESCE(hidden_at, now()),
         hidden_reason = 'gdpr_user_erasure'
   WHERE author_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('posts', v_n);

  UPDATE public.commander_home_post_comments
     SET content = '[comment removed]',
         is_hidden = true,
         hidden_at = COALESCE(hidden_at, now()),
         hidden_reason = 'gdpr_user_erasure'
   WHERE author_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('comments', v_n);

  UPDATE public.commander_home_rsvps
     SET message = NULL
   WHERE user_id = p_user_id AND message IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('rsvp_messages', v_n);

  UPDATE public.commander_home_game_reviews
     SET review_text = '[review removed]',
         is_hidden = true,
         hidden_at = COALESCE(hidden_at, now()),
         hidden_reason = 'gdpr_user_erasure'
   WHERE reviewer_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('reviews', v_n);

  UPDATE public.commander_home_game_photos
     SET caption = NULL, photo_url = '[photo removed]', is_hidden = true
   WHERE uploader_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('photos', v_n);

  UPDATE public.commander_home_members
     SET host_private_note = NULL
   WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('member_notes_cleared_as_subject', v_n);

  UPDATE public.commander_home_ban_appeals
     SET appeal_text = '[removed]'
   WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('ban_appeals', v_n);

  UPDATE public.commander_home_group_promotion_requests
     SET reason = NULL
   WHERE requested_by = p_user_id AND reason IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('promotion_reasons', v_n);

  -- Audit each affected group
  INSERT INTO public.commander_home_audit_log
    (group_id, actor_id, target_type, target_id, action, metadata)
  SELECT DISTINCT
    g.id, p_requested_by, 'user', p_user_id,
    'gdpr.hg_content_anonymized', v_counts
  FROM public.commander_home_groups g
  WHERE g.id IN (
    SELECT DISTINCT group_id FROM public.commander_home_members WHERE user_id = p_user_id
    UNION
    SELECT DISTINCT group_id FROM public.commander_home_posts   WHERE author_id = p_user_id
  );

  -- ★ Also log user-scope audit row (useful when user has no group memberships)
  INSERT INTO public.commander_home_audit_log
    (group_id, actor_id, target_type, target_id, action, metadata)
  VALUES (NULL, p_requested_by, 'user', p_user_id,
          'gdpr.hg_content_anonymized.summary', v_counts);

  RETURN jsonb_build_object(
    'success', true, 'user_id', p_user_id,
    'requested_by', p_requested_by, 'counts', v_counts
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_anonymize_hg_user_content(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_anonymize_hg_user_content(uuid, uuid) TO authenticated, service_role;
