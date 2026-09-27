-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424001701 "20260421099000_bug23_24_25_trigger_sweep_fixes"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d51d13134285f0e81981767df0ef374c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG-23, BUG-24, BUG-25: trigger sweep fixes
--
-- BUG-23: Ambiguous recompute_club_levels overload blocks every
-- club_members change in prod.
--   Two overloads exist:
--     (p_club_id uuid) → jsonb (API-oriented, auth-checked)
--     (p_club_id uuid DEFAULT NULL, p_force boolean DEFAULT false) → void (batch)
--   Both trigger functions PERFORM recompute_club_levels(v_club_id) with
--   a single arg → Postgres can't resolve → 42725 → entire INSERT/UPDATE/
--   DELETE on club_members rolls back.
--   Fix: both triggers explicitly pass (v_club_id, false) so only the
--   void overload matches.
--
-- BUG-24: fn_update_user_storage_quota references user_dna_profiles
-- (table doesn't exist). Every media upload/delete would 42P01 → full
-- rollback of the insert into social_media. Stub to no-op until quota
-- tracking is rebuilt.
--
-- BUG-25: handle_tournament_leaderboard_points has 2 schema drifts:
--   commander_leaderboard_logs → table doesn't exist
--   commander_leaderboard_entries.profile_id → column is player_id;
--     plus 4 other column drifts (total_points, points_from_*, updated_at)
--   Currently only fires its broken branch when the venue has a
--   leaderboard row — otherwise the outer IF short-circuits. Fix by
--   dropping the logs INSERT and mapping entries to current schema.

-- ═══ BUG-23 ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.trg_auto_recompute_club_level()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE v_club_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN v_club_id := OLD.club_id;
  ELSE                     v_club_id := NEW.club_id;
  END IF;

  -- BUG-23: explicit (uuid, boolean) signature resolves unambiguously
  -- to the void batch overload (the jsonb API overload has no p_force).
  PERFORM public.recompute_club_levels(v_club_id, false);

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_recompute_club_level_on_member_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_club_id  uuid;
  v_union_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN v_club_id := OLD.club_id;
  ELSE                     v_club_id := NEW.club_id;
  END IF;

  -- BUG-23 disambiguation (same as above)
  PERFORM public.recompute_club_levels(v_club_id, false);

  SELECT uc.union_id INTO v_union_id
    FROM union_clubs uc
   WHERE uc.club_id = v_club_id
   LIMIT 1;

  IF v_union_id IS NOT NULL THEN
    PERFORM public.recompute_union_levels(v_union_id);
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

-- ═══ BUG-24 ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.fn_update_user_storage_quota()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  -- BUG-24: user_dna_profiles table was removed. Quota tracking is
  -- not enforced at this layer anymore. Pass-through to avoid blocking
  -- social_media INSERT/DELETE operations. If storage quotas come back,
  -- this trigger should be updated to target the replacement table.
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

-- ═══ BUG-25 ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.handle_tournament_leaderboard_points()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_leaderboard_id   uuid;
  v_points_per_entry int;
  v_placement_points int;
  v_point_structure  jsonb;
BEGIN
  SELECT id, point_for_entry, point_structure
    INTO v_leaderboard_id, v_points_per_entry, v_point_structure
    FROM commander_tournament_leaderboards
   WHERE venue_id = (SELECT venue_id FROM tournaments WHERE id = NEW.tournament_id)
     AND is_active = true
     AND (SELECT start_time::date FROM tournaments WHERE id = NEW.tournament_id)
         BETWEEN season_start AND season_end
   LIMIT 1;

  IF v_leaderboard_id IS NOT NULL THEN
    v_placement_points := 0;
    IF v_point_structure IS NOT NULL
       AND NEW.finish_rank IS NOT NULL
       AND jsonb_array_length(v_point_structure) >= NEW.finish_rank THEN
      SELECT (v_point_structure->>(NEW.finish_rank - 1))::int INTO v_placement_points;
    END IF;

    -- BUG-25: commander_leaderboard_logs table removed → skip log insert.
    -- Mapped commander_leaderboard_entries columns to current schema:
    --   profile_id            → player_id
    --   total_points          → points_earned
    --   points_from_placement → (dropped; rolled into points_earned)
    --   points_from_entry     → (dropped; rolled into points_earned)
    --   updated_at            → last_updated
    INSERT INTO commander_leaderboard_entries
      (leaderboard_id, player_id, points_earned)
    VALUES
      (v_leaderboard_id, NEW.user_id,
       COALESCE(v_placement_points, 0) + COALESCE(v_points_per_entry, 1))
    ON CONFLICT (leaderboard_id, player_id) DO UPDATE
      SET points_earned = commander_leaderboard_entries.points_earned + EXCLUDED.points_earned,
          last_updated  = now();
  END IF;

  RETURN NEW;
EXCEPTION
  -- Defensive: if ON CONFLICT target isn't uniquely indexed (44301) or
  -- columns drift again, don't block tournament registration.
  WHEN OTHERS THEN
    RAISE WARNING 'handle_tournament_leaderboard_points non-fatal error: %', SQLERRM;
    RETURN NEW;
END;
$function$;
