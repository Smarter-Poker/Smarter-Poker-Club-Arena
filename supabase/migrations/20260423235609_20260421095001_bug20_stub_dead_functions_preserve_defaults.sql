-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260423235609 "20260421095001_bug20_stub_dead_functions_preserve_defaults"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 048a05426f833fdee687f68c7e100062 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG-20 (retry): preserve existing parameter defaults. Previous attempt
-- dropped them, which CREATE OR REPLACE FUNCTION rejects.

-- ─── XP ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_award_xp(
  p_user_id uuid, p_amount integer, p_source text,
  p_multiplier numeric DEFAULT 1.0,
  p_context    jsonb   DEFAULT '{}'::jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $function$
BEGIN
  -- STUB: xp_transactions table no longer exists.
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_get_user_xp(p_user_id uuid)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $function$
BEGIN
  -- STUB: xp_transactions gone. Read profiles.xp as a substitute.
  RETURN COALESCE((SELECT xp FROM public.profiles WHERE id = p_user_id), 0);
END;
$function$;

-- ─── Media ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_complete_media_upload(p_upload_id uuid, p_url text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $function$
BEGIN RETURN; END;
$function$;

-- ─── Old poker engine ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_get_available_seats(p_table_id uuid)
 RETURNS TABLE(seat_number integer) LANGUAGE plpgsql SECURITY DEFINER AS $function$
BEGIN RETURN; END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_leave_table(p_table_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $function$
BEGIN
  RETURN jsonb_build_object('success', false, 'error', 'not_implemented',
    'note', 'Old engine; use current club-arena leave flow.');
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_leave_table(p_table_id uuid, p_user_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $function$
BEGIN
  RETURN jsonb_build_object('success', false, 'error', 'not_implemented',
    'note', 'Old engine; use current club-arena leave flow.');
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_seat_player(
  p_table_id uuid, p_seat_number integer, p_buy_in_amount integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $function$
BEGIN
  RETURN jsonb_build_object('success', false, 'error', 'not_implemented',
    'note', 'Old engine; use atomic_table_buyin.');
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_seat_player(
  p_table_id uuid, p_user_id uuid, p_seat_number integer, p_buy_in_amount integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $function$
BEGIN
  RETURN jsonb_build_object('success', false, 'error', 'not_implemented',
    'note', 'Old engine; use atomic_table_buyin.');
END;
$function$;

-- ─── Social leaderboard ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_get_social_leaderboard(
  p_limit     integer DEFAULT 10,
  p_timeframe text    DEFAULT '24h'::text
)
 RETURNS TABLE(
   rank integer, user_id uuid, username text, avatar_url text,
   level integer, tier text, is_verified boolean,
   xp_earned integer, posts_count integer,
   reactions_received integer, diamonds_earned integer
 )
 LANGUAGE plpgsql SECURITY DEFINER AS $function$
BEGIN RETURN; END;
$function$;

-- ─── Profile picture history ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_profile_picture_history(p_user_id uuid)
 RETURNS TABLE(
   media_id uuid, public_url text, thumbnail_url text,
   set_at timestamptz, removed_at timestamptz, is_current boolean
 )
 LANGUAGE plpgsql SECURITY DEFINER AS $function$
BEGIN
  -- STUB: profile_picture_history gone. Return single current avatar row.
  RETURN QUERY
  SELECT NULL::uuid AS media_id,
         p.avatar_url AS public_url,
         NULL::text AS thumbnail_url,
         p.updated_at AS set_at,
         NULL::timestamptz AS removed_at,
         true AS is_current
    FROM public.profiles p
   WHERE p.id = p_user_id AND p.avatar_url IS NOT NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_profile_picture(p_media_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $function$
BEGIN RETURN; END;
$function$;

-- ─── Achievements ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_user_achievements(p_user_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $function$
BEGIN RETURN '[]'::jsonb; END;
$function$;

CREATE OR REPLACE FUNCTION public.unlock_achievement(p_user_id uuid, p_achievement_id text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $function$
BEGIN
  RETURN jsonb_build_object('success', false, 'error', 'not_implemented',
    'note', 'Achievements subsystem (memory_achievements) not present.');
END;
$function$;

-- ─── Scheduled content ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.publish_scheduled_content(p_content_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $function$
BEGIN
  RETURN jsonb_build_object('success', false, 'error', 'not_implemented',
    'note', 'scheduled_content table not present.');
END;
$function$;
