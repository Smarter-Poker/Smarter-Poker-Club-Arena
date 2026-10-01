-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260820120810 as "union_law_seat_provenance_trigger_and_horse_home_club"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--

-- ============================================================================
-- UNION LAW — GUARANTEE SEAT PROVENANCE AT THE DATABASE (2026-08-20)
--
-- Two gaps found after enabling club-scoped chips:
--
-- (1) BYPASS: HydraService.seatHorse (and other legacy seating paths) INSERT
--     into table_seats directly instead of calling atomic_table_buyin, so those
--     seats carried no club stamp at all. Chasing every client path is fragile;
--     the stamp is now enforced by the database, so ANY insert gets provenance
--     regardless of which code path created it.
--
-- (2) ONE-SIDED ECONOMY: with no club context, every player fell back to their
--     first-joined club. Every horse joined SHARK first, so SHARK funded and
--     earned 100% of simulated play while JAQK sat idle — the opposite of two
--     genuinely separate club wallets.
--     Horses (simulated players only — never real users) now get a STABLE home
--     club derived from their own id, reproducing the launcher's original
--     even shark/jaqk split. A horse always returns to the same club, so its
--     chips and rake stay consistent hand after hand.
--     REAL players are untouched: they keep the first-joined fallback and are
--     normally resolved by the club card they entered through.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_seat_club_for_user(p_user_id uuid, p_table_id uuid, p_preferred_club uuid DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_union uuid; v_table_club uuid; v_club uuid;
  v_is_horse boolean := false; v_n int; v_idx int;
BEGIN
  SELECT t.union_id, t.club_id INTO v_union, v_table_club
    FROM tables t WHERE t.id = p_table_id;

  IF v_union IS NULL THEN
    RETURN v_table_club;                       -- standalone club game
  END IF;

  -- Honour the club the player entered through, when they really are a member.
  IF p_preferred_club IS NOT NULL
     AND EXISTS (SELECT 1 FROM club_members m
                  JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = v_union
                 WHERE m.user_id = p_user_id AND m.club_id = p_preferred_club
                   AND m.status IN ('active','approved'))
  THEN
    RETURN p_preferred_club;
  END IF;

  SELECT COALESCE(p.is_horse, false) INTO v_is_horse FROM profiles p WHERE p.id = p_user_id;

  IF v_is_horse THEN
    -- Stable home club for a simulated player: deterministic from its own id,
    -- so the same horse always plays on the same club's chips.
    SELECT count(*) INTO v_n
      FROM club_members m
      JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = v_union
     WHERE m.user_id = p_user_id AND m.status IN ('active','approved');

    IF v_n > 1 THEN
      v_idx := (abs(hashtextextended(p_user_id::text, 0)) % v_n)::int;
      SELECT m.club_id INTO v_club
        FROM club_members m
        JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = v_union
       WHERE m.user_id = p_user_id AND m.status IN ('active','approved')
       ORDER BY m.club_id
       OFFSET v_idx LIMIT 1;
      IF v_club IS NOT NULL THEN RETURN v_club; END IF;
    END IF;
  END IF;

  -- Real players: oldest membership.
  SELECT m.club_id INTO v_club
    FROM club_members m
    JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = v_union
   WHERE m.user_id = p_user_id AND m.status IN ('active','approved')
   ORDER BY m.joined_at ASC NULLS LAST, m.club_id
   LIMIT 1;

  RETURN v_club;
END $function$;

-- Any seat, from any code path, carries its club --------------------------
CREATE OR REPLACE FUNCTION public.fn_stamp_seat_club()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.club_id IS NULL AND NEW.user_id IS NOT NULL AND NEW.table_id IS NOT NULL THEN
    NEW.club_id := public.fn_seat_club_for_user(NEW.user_id, NEW.table_id, NULL);
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trg_table_seats_stamp_club ON public.table_seats;
CREATE TRIGGER trg_table_seats_stamp_club
  BEFORE INSERT ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.fn_stamp_seat_club();

-- Backfill provenance for seats currently in play -------------------------
UPDATE public.table_seats ts
   SET club_id = public.fn_seat_club_for_user(ts.user_id, ts.table_id, NULL)
 WHERE ts.left_at IS NULL
   AND ts.club_id IS NULL
   AND ts.user_id IS NOT NULL;

