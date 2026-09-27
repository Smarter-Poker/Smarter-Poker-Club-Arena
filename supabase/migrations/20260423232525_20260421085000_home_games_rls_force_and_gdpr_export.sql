-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260423232525 "20260421085000_home_games_rls_force_and_gdpr_export"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8cf8f9ac75a647e806e5f29797e23797 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- PHASE 7 (GAP-G): FORCE Row Level Security on all Home Games tables
--
-- Before: relrowsecurity=true on every home table, but
-- relforcerowsecurity=false. `postgres` (table owner) and any service
-- running as table owner bypasses RLS. If a future migration or service
-- writes via postgres rather than supabase_admin/service_role, RLS
-- silently doesn't apply.
--
-- FORCE RLS means even the table owner is subject to policies. All
-- legitimate write paths already go through SECURITY DEFINER RPCs which
-- use auth.uid() themselves, so this is safe — only paths that would
-- have bypassed RLS by accident will now correctly be blocked.
--
-- The ban_appeals and user_tos_acceptances and platform_policies
-- tables added in earlier phases are also included.
--
-- PHASE 8 (GAP-H): GDPR right-to-access — fn_export_user_data_gdpr
-- Returns a JSONB dump of everything the platform knows about a user
-- that falls within Home Games scope. Pairs with the existing
-- fn_delete_user_gdpr (right-to-erasure, fixed in BUG-10).

BEGIN;

-- ═══ FORCE RLS ═══════════════════════════════════════════════════════

ALTER TABLE public.commander_home_audit_log             FORCE ROW LEVEL SECURITY;
ALTER TABLE public.commander_home_ban_appeals           FORCE ROW LEVEL SECURITY;
ALTER TABLE public.commander_home_content_reports       FORCE ROW LEVEL SECURITY;
ALTER TABLE public.commander_home_game_photos           FORCE ROW LEVEL SECURITY;
ALTER TABLE public.commander_home_game_reviews          FORCE ROW LEVEL SECURITY;
ALTER TABLE public.commander_home_game_tables           FORCE ROW LEVEL SECURITY;
ALTER TABLE public.commander_home_game_templates        FORCE ROW LEVEL SECURITY;
ALTER TABLE public.commander_home_games                 FORCE ROW LEVEL SECURITY;
ALTER TABLE public.commander_home_group_follows         FORCE ROW LEVEL SECURITY;
ALTER TABLE public.commander_home_group_promotion_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE public.commander_home_group_share_log       FORCE ROW LEVEL SECURITY;
ALTER TABLE public.commander_home_group_view_log        FORCE ROW LEVEL SECURITY;
ALTER TABLE public.commander_home_group_weekly_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE public.commander_home_groups                FORCE ROW LEVEL SECURITY;
ALTER TABLE public.commander_home_invite_tokens         FORCE ROW LEVEL SECURITY;
ALTER TABLE public.commander_home_join_attempts         FORCE ROW LEVEL SECURITY;
ALTER TABLE public.commander_home_members               FORCE ROW LEVEL SECURITY;
ALTER TABLE public.commander_home_poll_votes            FORCE ROW LEVEL SECURITY;
ALTER TABLE public.commander_home_polls                 FORCE ROW LEVEL SECURITY;
ALTER TABLE public.commander_home_post_comments         FORCE ROW LEVEL SECURITY;
ALTER TABLE public.commander_home_post_likes            FORCE ROW LEVEL SECURITY;
ALTER TABLE public.commander_home_posts                 FORCE ROW LEVEL SECURITY;
ALTER TABLE public.commander_home_rsvps                 FORCE ROW LEVEL SECURITY;
ALTER TABLE public.commander_home_seat_reservations     FORCE ROW LEVEL SECURITY;
ALTER TABLE public.commander_home_seats                 FORCE ROW LEVEL SECURITY;
ALTER TABLE public.user_tos_acceptances                 FORCE ROW LEVEL SECURITY;
ALTER TABLE public.platform_policies                    FORCE ROW LEVEL SECURITY;

-- ═══ fn_export_user_data_gdpr ═════════════════════════════════════════
-- Returns every row in the Home Games surface that belongs to, was
-- authored by, or references the caller (or, for admins, the target
-- user). Output is JSONB, suitable for download as a .json file.
-- Complements fn_delete_user_gdpr for GDPR/CCPA right-to-access.

CREATE OR REPLACE FUNCTION public.fn_export_user_data_gdpr(
  p_user_id        uuid,
  p_requested_by   uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_req_role text;
  v_export   jsonb := '{}'::jsonb;
BEGIN
  IF p_user_id IS NULL OR p_requested_by IS NULL THEN
    RAISE EXCEPTION 'user_id and requested_by required'
          USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Auth: user-self, or admin
  SELECT role INTO v_req_role FROM public.profiles WHERE id = p_requested_by;
  IF p_user_id <> p_requested_by AND v_req_role NOT IN ('admin','superadmin','god') THEN
    RAISE EXCEPTION 'only the user or a platform admin may request data export'
          USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- profile ------------------------------------------------------------
  v_export := v_export || jsonb_build_object('profile',
    (SELECT to_jsonb(p) FROM public.profiles p WHERE p.id = p_user_id)
  );

  -- groups owned ------------------------------------------------------
  v_export := v_export || jsonb_build_object('groups_owned',
    COALESCE((SELECT jsonb_agg(to_jsonb(g)) FROM public.commander_home_groups g
               WHERE g.owner_id = p_user_id), '[]'::jsonb)
  );

  -- group memberships -------------------------------------------------
  v_export := v_export || jsonb_build_object('group_memberships',
    COALESCE((SELECT jsonb_agg(to_jsonb(m)) FROM public.commander_home_members m
               WHERE m.user_id = p_user_id), '[]'::jsonb)
  );

  -- groups followed ---------------------------------------------------
  v_export := v_export || jsonb_build_object('groups_followed',
    COALESCE((SELECT jsonb_agg(to_jsonb(f)) FROM public.commander_home_group_follows f
               WHERE f.user_id = p_user_id), '[]'::jsonb)
  );

  -- games hosted ------------------------------------------------------
  v_export := v_export || jsonb_build_object('games_hosted',
    COALESCE((SELECT jsonb_agg(to_jsonb(g)) FROM public.commander_home_games g
               WHERE g.host_id = p_user_id), '[]'::jsonb)
  );

  -- rsvps -------------------------------------------------------------
  v_export := v_export || jsonb_build_object('rsvps',
    COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM public.commander_home_rsvps r
               WHERE r.user_id = p_user_id), '[]'::jsonb)
  );

  -- posts authored ----------------------------------------------------
  v_export := v_export || jsonb_build_object('posts',
    COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM public.commander_home_posts p
               WHERE p.author_id = p_user_id), '[]'::jsonb)
  );

  -- comments authored -------------------------------------------------
  v_export := v_export || jsonb_build_object('post_comments',
    COALESCE((SELECT jsonb_agg(to_jsonb(c)) FROM public.commander_home_post_comments c
               WHERE c.author_id = p_user_id), '[]'::jsonb)
  );

  -- post likes --------------------------------------------------------
  v_export := v_export || jsonb_build_object('post_likes',
    COALESCE((SELECT jsonb_agg(to_jsonb(pl)) FROM public.commander_home_post_likes pl
               WHERE pl.user_id = p_user_id), '[]'::jsonb)
  );

  -- poll votes --------------------------------------------------------
  v_export := v_export || jsonb_build_object('poll_votes',
    COALESCE((SELECT jsonb_agg(to_jsonb(v)) FROM public.commander_home_poll_votes v
               WHERE v.user_id = p_user_id), '[]'::jsonb)
  );

  -- reviews authored --------------------------------------------------
  v_export := v_export || jsonb_build_object('game_reviews',
    COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM public.commander_home_game_reviews r
               WHERE r.reviewer_id = p_user_id), '[]'::jsonb)
  );

  -- game photos uploaded ---------------------------------------------
  v_export := v_export || jsonb_build_object('game_photos',
    COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM public.commander_home_game_photos p
               WHERE p.uploader_id = p_user_id), '[]'::jsonb)
  );

  -- seats claimed -----------------------------------------------------
  v_export := v_export || jsonb_build_object('seats',
    COALESCE((SELECT jsonb_agg(to_jsonb(s)) FROM public.commander_home_seats s
               WHERE s.user_id = p_user_id), '[]'::jsonb)
  );

  -- seat reservations -------------------------------------------------
  v_export := v_export || jsonb_build_object('seat_reservations',
    COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM public.commander_home_seat_reservations r
               WHERE r.user_id = p_user_id OR r.claimed_by_user_id = p_user_id), '[]'::jsonb)
  );

  -- content reports filed --------------------------------------------
  v_export := v_export || jsonb_build_object('content_reports_filed',
    COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM public.commander_home_content_reports r
               WHERE r.reporter_id = p_user_id), '[]'::jsonb)
  );

  -- moderation actions taken against this user -----------------------
  v_export := v_export || jsonb_build_object('content_reports_about_me',
    COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM public.commander_home_content_reports r
               WHERE r.content_author_id = p_user_id), '[]'::jsonb)
  );

  -- ban appeals ------------------------------------------------------
  v_export := v_export || jsonb_build_object('ban_appeals',
    COALESCE((SELECT jsonb_agg(to_jsonb(a)) FROM public.commander_home_ban_appeals a
               WHERE a.user_id = p_user_id), '[]'::jsonb)
  );

  -- invite tokens created -------------------------------------------
  v_export := v_export || jsonb_build_object('invite_tokens_created',
    COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM public.commander_home_invite_tokens t
               WHERE t.created_by = p_user_id), '[]'::jsonb)
  );

  -- join attempts ---------------------------------------------------
  v_export := v_export || jsonb_build_object('join_attempts',
    COALESCE((SELECT jsonb_agg(to_jsonb(j)) FROM public.commander_home_join_attempts j
               WHERE j.user_id = p_user_id), '[]'::jsonb)
  );

  -- group promotion requests ---------------------------------------
  v_export := v_export || jsonb_build_object('promotion_requests',
    COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM public.commander_home_group_promotion_requests r
               WHERE r.requested_by = p_user_id), '[]'::jsonb)
  );

  -- TOS acceptances ------------------------------------------------
  v_export := v_export || jsonb_build_object('tos_acceptances',
    COALESCE((SELECT jsonb_agg(to_jsonb(a)) FROM public.user_tos_acceptances a
               WHERE a.user_id = p_user_id), '[]'::jsonb)
  );

  -- audit log entries about this user's actions -------------------
  v_export := v_export || jsonb_build_object('audit_log_as_actor',
    COALESCE((SELECT jsonb_agg(to_jsonb(a)) FROM public.commander_home_audit_log a
               WHERE a.actor_id = p_user_id), '[]'::jsonb)
  );

  -- Export envelope
  RETURN jsonb_build_object(
    'success',     true,
    'user_id',     p_user_id,
    'requested_by', p_requested_by,
    'generated_at', now(),
    'scope',       'home_games',
    'data',        v_export
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_export_user_data_gdpr(uuid,uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.fn_export_user_data_gdpr(uuid,uuid) TO authenticated;

COMMIT;
