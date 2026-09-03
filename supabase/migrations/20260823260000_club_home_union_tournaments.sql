-- ═══════════════════════════════════════════════════════════════════════════
--  SUPERSEDED 2026-08-23 — DO NOT COPY ANYTHING BELOW THIS LINE
-- ═══════════════════════════════════════════════════════════════════════════
--
--  The get_club_home body in this file COULD NOT RUN. It was applied to
--  production and committed without the function ever being called once, and
--  every call raised from the first:
--
--      union_clubs.status          does not exist (42703) — hit first
--      clubs.short_id              does not exist (the integer key is club_id)
--      club_members.profile_id     does not exist (it is user_id)
--      tables.time_bank_seconds / time_bank_rounds / min_buyin as projected
--      WHERE tables.status IN ('RUNNING','WAITING')   the column is lowercase
--
--  and it returned no `found` key, which the caller in ClubHomePage.tsx
--  requires. The lobby's one-round-trip fast path therefore never painted a
--  single time, every club fell back to six sequential queries, and for those
--  seconds every tab read "No Tournaments Yet" — which is what Dan reported as
--  "sometimes it displays, then it disappears".
--
--  THE LIVE DEFINITION IS IN 20260823280000_get_club_home_was_never_run.sql,
--  whose assertions EXECUTE the function against every club and refuse to
--  apply if any call raises. Replaying this file alone re-installs a broken
--  function; the later migration repairs it, so the ORDER matters and this
--  file must never be applied on its own.
--
--  Kept rather than deleted because it is the record of what happened, and
--  because CLAUDE.md is explicit that the files in this directory are history,
--  not truth. Read it as evidence, not as an example.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_club_home_in_scope(p_club_id uuid, p_is_private boolean, p_union_id uuid, p_viewer_union_id uuid, p_viewer_club_id uuid, p_viewer_union_club_ids uuid[])
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN p_viewer_union_id IS NOT NULL THEN
      (p_union_id = p_viewer_union_id OR (p_club_id = p_viewer_club_id AND p_is_private = true))
    ELSE
      p_club_id = ANY(p_viewer_union_club_ids)
  END;
$$;

CREATE OR REPLACE FUNCTION public.get_club_home(p_club_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
AS $$
DECLARE
  v_club public.clubs%ROWTYPE;
  v_union_id uuid;
  v_union_club_ids uuid[];
  v_scope_ids uuid[];
  v_member_count integer;
  v_membership jsonb;
  v_tables jsonb;
  v_tournaments jsonb;
  v_bbj jsonb;
BEGIN
  IF p_club_key ~ '^[0-9a-fA-F]{8}-' THEN
    SELECT * INTO v_club FROM public.clubs WHERE id = p_club_key::uuid;
  ELSIF p_club_key ~ '^[0-9]+$' THEN
    SELECT * INTO v_club FROM public.clubs WHERE short_id = p_club_key::integer;
  ELSE
    SELECT * INTO v_club FROM public.clubs WHERE slug = p_club_key;
  END IF;

  IF v_club.id IS NULL THEN RETURN NULL; END IF;

  SELECT union_id INTO v_union_id FROM public.union_clubs WHERE club_id = v_club.id AND status = 'active';

  IF v_union_id IS NOT NULL THEN
    SELECT array_agg(club_id) INTO v_union_club_ids FROM public.union_clubs WHERE union_id = v_union_id AND status = 'active';
  ELSE
    v_union_club_ids := ARRAY[v_club.id];
  END IF;

  SELECT COUNT(*) INTO v_member_count FROM public.club_members WHERE club_id = v_club.id;
  SELECT to_jsonb(cm) INTO v_membership FROM public.club_members cm WHERE cm.club_id = v_club.id AND cm.profile_id = auth.uid();

  SELECT COALESCE(jsonb_agg(x ORDER BY x.created_at DESC), '[]'::jsonb) INTO v_tables FROM (
    SELECT id, name, variant, stakes, min_buyin, max_buyin, max_players, current_players, status, club_id, created_at, insurance_enabled, time_bank_seconds, time_bank_rounds
    FROM public.tables
    WHERE status IN ('RUNNING', 'WAITING')
      AND public.fn_club_home_in_scope(club_id, is_private, union_id, v_union_id, v_club.id, v_union_club_ids)
    ORDER BY created_at DESC LIMIT 100
  ) x;

  SELECT COALESCE(jsonb_agg(x ORDER BY x.start_time ASC), '[]'::jsonb) INTO v_tournaments FROM (
    SELECT id, name, game_type, variant, buy_in_amount, buy_in_fee, guaranteed_prize, start_time, status, current_players, max_players, starting_chips, club_id, late_reg_mins, late_reg_levels, started_at, current_level, union_id, is_xmtt
    FROM public.tournaments
    WHERE status IN ('REGISTERING', 'RUNNING')
      AND public.fn_club_home_in_scope(club_id, is_private, union_id, v_union_id, v_club.id, v_union_club_ids)
    ORDER BY start_time ASC LIMIT 100
  ) x;

  SELECT to_jsonb(bbj) INTO v_bbj FROM public.bbj_pools bbj WHERE club_id = v_club.id;
  IF v_bbj IS NULL AND v_union_id IS NOT NULL THEN
    SELECT to_jsonb(bbj) INTO v_bbj FROM public.bbj_pools bbj WHERE union_id = v_union_id;
  END IF;

  RETURN jsonb_build_object(
    'club', jsonb_build_object('id', v_club.id, 'name', v_club.name, 'short_id', v_club.short_id, 'slug', v_club.slug, 'avatar_url', v_club.avatar_url, 'banner_url', v_club.banner_url, 'description', v_club.description, 'is_private', v_club.is_private, 'owner_id', v_club.owner_id),
    'membership', v_membership,
    'union_id', v_union_id,
    'union_club_ids', to_jsonb(v_union_club_ids),
    'member_count', v_member_count,
    'tables', v_tables,
    'tournaments', v_tournaments,
    'bbj', v_bbj
  );
END;
$$;
