-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424012813 "20260421160000_hg_anonymize_user_content_helper"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d890cc2031a9cefe5fa1f0a5f25e5c5b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- GDPR right-to-erasure helper for HG user content. Complements
-- fn_delete_user_gdpr by scrubbing HG content bodies that may contain
-- self-disclosed PII (posts, comments, RSVP messages, reviews,
-- photo captions). Replaces with '[removed]' placeholder so comment
-- threads, post context, and RSVP counts remain coherent.
--
-- Caller authority:
--   • User themselves: can scrub their own HG content
--   • platform admin/superadmin/god: can scrub anyone's
--
-- Design note: we do NOT delete rows, we scrub content text. This
-- preserves thread / relationship integrity (other users' comments
-- on the deleted user's posts still attach, just to an anonymized
-- post).

CREATE OR REPLACE FUNCTION public.fn_anonymize_hg_user_content(
  p_user_id uuid,
  p_requested_by uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_role text;
  v_counts jsonb := '{}'::jsonb;
  v_n int;
BEGIN
  IF p_user_id IS NULL OR p_requested_by IS NULL THEN
    RAISE EXCEPTION 'user_id and requested_by required'
          USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Authz: self OR platform admin
  SELECT role INTO v_role FROM public.profiles WHERE id = p_requested_by;
  IF p_user_id <> p_requested_by AND v_role NOT IN ('admin','superadmin','god') THEN
    RAISE EXCEPTION 'only the user or a platform admin may scrub HG content'
          USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Posts: blank content + media, keep row for thread continuity
  UPDATE public.commander_home_posts
     SET content = '[content removed]',
         image_urls = NULL,
         video_url = NULL,
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
     SET caption = NULL,
         photo_url = '[photo removed]',
         is_hidden = true
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

  -- Audit log
  INSERT INTO public.commander_home_audit_log
    (group_id, actor_id, target_type, target_id, action, metadata)
  SELECT DISTINCT
    g.id,
    p_requested_by,
    'user', p_user_id,
    'gdpr.hg_content_anonymized',
    v_counts
  FROM public.commander_home_groups g
  WHERE g.id IN (
    SELECT DISTINCT group_id FROM public.commander_home_members WHERE user_id = p_user_id
    UNION
    SELECT DISTINCT group_id FROM public.commander_home_posts WHERE author_id = p_user_id
  );

  RETURN jsonb_build_object(
    'success', true,
    'user_id', p_user_id,
    'requested_by', p_requested_by,
    'counts', v_counts
  );
END;
$fn$;

COMMENT ON FUNCTION public.fn_anonymize_hg_user_content(uuid, uuid) IS
  'GDPR right-to-erasure for HG user content. Scrubs post/comment/review/photo/RSVP bodies. Idempotent. Preserves row structure for thread coherence.';
