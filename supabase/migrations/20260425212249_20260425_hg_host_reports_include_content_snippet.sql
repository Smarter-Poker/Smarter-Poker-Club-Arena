-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260425212249 "20260425_hg_host_reports_include_content_snippet"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 753397117a36225b678ef30269ebd242 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Enhance list_home_group_reports_for_host to include the actual content
-- text being reported. The dashboard Moderation tab bundle expects
-- e.content || e.text on each row, plus e.author_display / e.author_name.
--
-- Strategy: LATERAL join to the appropriate content table per reported_type
-- and project a single 'content' field. Keep all existing fields intact.
CREATE OR REPLACE FUNCTION public.list_home_group_reports_for_host(
  p_group_id uuid,
  p_status   text    DEFAULT NULL,
  p_limit    integer DEFAULT 50,
  p_offset   integer DEFAULT 0
)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' SET row_security = off
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_is_staff boolean;
  v_rows jsonb;
  v_total int;
  v_safe_limit int;
  v_safe_offset int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE='42501'; END IF;

  v_is_staff := EXISTS (SELECT 1 FROM public.commander_home_groups
       WHERE id = p_group_id AND owner_id = v_uid)
    OR EXISTS (SELECT 1 FROM public.commander_home_members
       WHERE group_id = p_group_id AND user_id = v_uid
         AND role IN ('admin','co_host') AND status='approved');
  IF NOT v_is_staff THEN RAISE EXCEPTION 'NOT_GROUP_STAFF' USING ERRCODE='42501'; END IF;

  v_safe_limit  := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_safe_offset := GREATEST(COALESCE(p_offset, 0), 0);

  SELECT COUNT(*) INTO v_total
    FROM public.commander_home_content_reports r
   WHERE r.reason_category NOT IN ('illegal','self_harm','doxxing')
     AND r.content_author_id <> (SELECT owner_id FROM public.commander_home_groups WHERE id = p_group_id)
     AND (p_status IS NULL OR r.status = p_status)
     AND (
       (r.reported_type IN ('post','comment')
         AND r.reported_id IN (SELECT p.id FROM public.commander_home_posts p WHERE p.group_id = p_group_id))
       OR (r.reported_type = 'game'
         AND r.reported_id IN (SELECT g.id FROM public.commander_home_games g WHERE g.group_id = p_group_id))
       OR (r.reported_type = 'review'
         AND r.reported_id IN (SELECT rv.id FROM public.commander_home_game_reviews rv
           JOIN public.commander_home_games g ON g.id = rv.game_id WHERE g.group_id = p_group_id))
       OR (r.reported_type = 'member'
         AND r.reported_id IN (SELECT m.id FROM public.commander_home_members m WHERE m.group_id = p_group_id))
     );

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'id',                  r.id,
             'reporter_id',         r.reporter_id,
             'reporter_name',       COALESCE(p_rep.display_name, p_rep.username, 'Unknown'),
             'reported_type',       r.reported_type,
             'reported_id',         r.reported_id,
             'content_author_id',   r.content_author_id,
             'content_author_name', COALESCE(p_auth.display_name, p_auth.username, 'Unknown'),
             'author_display',      COALESCE(p_auth.display_name, p_auth.username, 'Unknown'),
             'author_name',         COALESCE(p_auth.display_name, p_auth.username, 'Unknown'),
             'reason_category',     r.reason_category,
             'reason_text',         r.reason_text,
             'content',             COALESCE(content_snippet.snippet, '(content unavailable)'),
             'text',                COALESCE(content_snippet.snippet, '(content unavailable)'),
             'status',              r.status,
             'created_at',          r.created_at,
             'reviewed_at',         r.reviewed_at,
             'action_taken',        r.action_taken
           ) ORDER BY r.created_at DESC
         ), '[]'::jsonb) INTO v_rows
    FROM (
      SELECT * FROM public.commander_home_content_reports r
       WHERE r.reason_category NOT IN ('illegal','self_harm','doxxing')
         AND r.content_author_id <> (SELECT owner_id FROM public.commander_home_groups WHERE id = p_group_id)
         AND (p_status IS NULL OR r.status = p_status)
         AND (
           (r.reported_type IN ('post','comment')
             AND r.reported_id IN (SELECT p.id FROM public.commander_home_posts p WHERE p.group_id = p_group_id))
           OR (r.reported_type = 'game'
             AND r.reported_id IN (SELECT g.id FROM public.commander_home_games g WHERE g.group_id = p_group_id))
           OR (r.reported_type = 'review'
             AND r.reported_id IN (SELECT rv.id FROM public.commander_home_game_reviews rv
               JOIN public.commander_home_games g ON g.id = rv.game_id WHERE g.group_id = p_group_id))
           OR (r.reported_type = 'member'
             AND r.reported_id IN (SELECT m.id FROM public.commander_home_members m WHERE m.group_id = p_group_id))
         )
       ORDER BY r.created_at DESC
       LIMIT v_safe_limit OFFSET v_safe_offset
    ) r
    LEFT JOIN public.profiles p_rep  ON p_rep.id  = r.reporter_id
    LEFT JOIN public.profiles p_auth ON p_auth.id = r.content_author_id
    LEFT JOIN LATERAL (
      SELECT CASE r.reported_type
        WHEN 'post'    THEN (SELECT LEFT(content, 500) FROM public.commander_home_posts WHERE id = r.reported_id)
        WHEN 'comment' THEN (SELECT LEFT(content, 500) FROM public.commander_home_post_comments WHERE id = r.reported_id)
        WHEN 'review'  THEN (SELECT LEFT(COALESCE(review_text, ''), 500) FROM public.commander_home_game_reviews WHERE id = r.reported_id)
        WHEN 'game'    THEN (SELECT LEFT(COALESCE(title, '') || COALESCE(' — ' || description, ''), 500) FROM public.commander_home_games WHERE id = r.reported_id)
        WHEN 'member'  THEN '(member report — see profile)'
        ELSE NULL
      END AS snippet
    ) content_snippet ON TRUE;

  RETURN jsonb_build_object('success', true, 'total', v_total,
    'limit', v_safe_limit, 'offset', v_safe_offset, 'reports', v_rows);
END;
$fn$;
