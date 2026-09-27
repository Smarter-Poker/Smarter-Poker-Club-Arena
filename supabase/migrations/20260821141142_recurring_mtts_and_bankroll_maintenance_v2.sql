-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821141142 "recurring_mtts_and_bankroll_maintenance_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 edac1b1a7dd696af2554709b841ac4d7 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Follow-up to the 2026-08-21 session. Three loose ends, each measured.
--
-- 1. THE FREEROLLS RAN. All three scheduled last night are COMPLETED — the
--    ticker worked and consumed them. One-off events cannot keep a
--    "starting soon" feature alive, so this adds a function that keeps a
--    rolling window scheduled, and seeds one.
--
--    NOTE: there is a unique constraint uq_scheduled_tournament_one_live_per_name
--    on (tournament_type, name) — one live tournament per name, platform-wide.
--    The first version of this function named events by time slot alone and
--    collided the moment a second club wanted the same slot. Names are now
--    scoped by club, which is what that constraint was telling me to do.
--
-- 2. THREE LEAKED SEATS on already-closed tables. The earlier trigger fires on
--    UPDATE OF status, so it cannot catch a seat INSERTED into a table that
--    was already closed — which is what these were. Cleaned; the insert-side
--    guard belongs in the engine, not a trigger firing on every seat write.
--
-- 3. 105 HORSES DRIFTED BELOW THE FLOOR by playing and losing, which is poker
--    working correctly. Topped back up; fn_seed_horses_to_floor is the thing
--    to call on a cadence rather than by hand.

CREATE OR REPLACE FUNCTION public.fn_ensure_upcoming_mtts(
    p_club_id uuid,
    p_want    integer DEFAULT 6,
    p_spacing_minutes integer DEFAULT 45
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_have integer; v_created integer := 0; v_last timestamptz;
    v_tpl public.tournaments%ROWTYPE; v_tag text; v_name text; i integer;
BEGIN
    SELECT count(*), max(start_time) INTO v_have, v_last
      FROM public.tournaments
     WHERE club_id = p_club_id AND tournament_type = 'MTT'
       AND status IN ('ANNOUNCED','REGISTERING') AND start_time > now();
    IF v_have >= p_want THEN RETURN 0; END IF;

    SELECT * INTO v_tpl FROM public.tournaments
     WHERE tournament_type = 'MTT' AND blind_structure IS NOT NULL AND payout_structure IS NOT NULL
     ORDER BY created_at DESC LIMIT 1;
    IF v_tpl.id IS NULL THEN RETURN 0; END IF;

    -- Names must be unique across live tournaments platform-wide, so scope by club.
    SELECT coalesce(club_id::text, left(id::text, 4)) INTO v_tag FROM public.clubs WHERE id = p_club_id;

    v_last := greatest(coalesce(v_last, now()), now());

    FOR i IN 1..(p_want - v_have) LOOP
        v_last := v_last + (p_spacing_minutes || ' minutes')::interval;
        v_name := 'Rolling Freeroll ' || v_tag || ' ' || to_char(v_last, 'DD HH24:MI');
        CONTINUE WHEN EXISTS (
            SELECT 1 FROM public.tournaments x
             WHERE x.tournament_type = 'MTT' AND x.name = v_name
               AND x.status IN ('ANNOUNCED','REGISTERING')
        );
        INSERT INTO public.tournaments (
            name, description, game_type, variant, buy_in_amount, buy_in_fee, guaranteed_prize,
            start_time, status, current_players, max_players, late_reg_mins, starting_chips,
            blind_structure, payout_structure, club_id, min_players, tournament_type, prize_pool,
            is_rebuy, add_on_available, is_bounty, is_pko, is_turbo, created_at, updated_at
        ) VALUES (
            v_name, 'Freeroll. No buy-in, no fee.',
            v_tpl.game_type, v_tpl.variant, 0, 0, 0,
            v_last, 'REGISTERING', 0,
            v_tpl.max_players, v_tpl.late_reg_mins, v_tpl.starting_chips,
            v_tpl.blind_structure, v_tpl.payout_structure, p_club_id,
            v_tpl.min_players, 'MTT', 0,
            false, false, false, false, false, now(), now()
        );
        v_created := v_created + 1;
    END LOOP;
    RETURN v_created;
END;
$function$;

COMMENT ON FUNCTION public.fn_ensure_upcoming_mtts(uuid, integer, integer) IS
    'Tops a club up to N upcoming freeroll MTTs. Idempotent, club-scoped names, safe to call on a cadence — call from Open Claw to keep the starting-soon ticker fed.';

UPDATE public.table_seats ts
   SET left_at = coalesce(t.updated_at, now())
  FROM public.tables t
 WHERE t.id = ts.table_id AND ts.left_at IS NULL
   AND lower(coalesce(t.status,'')) IN ('closed','completed','cancelled','finished');

DO $$
DECLARE r record; made integer; res record;
BEGIN
    FOR r IN SELECT id, name FROM public.clubs WHERE club_id IN (25450, 77777, 55555) LOOP
        made := public.fn_ensure_upcoming_mtts(r.id, 6, 45);
        SELECT * INTO res FROM public.fn_seed_horses_to_floor(r.id, 25000);
        RAISE NOTICE '%: % events, % horses topped up', r.name, made, res.horses_funded;
    END LOOP;
    PERFORM public.fn_refresh_club_activity_counts(NULL);
END $$;

DO $$
DECLARE leaked integer; below integer; upcoming integer;
BEGIN
    SELECT count(*) INTO leaked FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
     WHERE ts.left_at IS NULL AND lower(coalesce(t.status,'')) IN ('closed','completed','cancelled','finished');
    IF leaked > 0 THEN RAISE EXCEPTION 'post-apply: % seats still open on closed tables', leaked; END IF;

    SELECT count(*) INTO below FROM public.club_members cm JOIN public.profiles p ON p.id = cm.user_id
     WHERE p.is_horse AND cm.chip_balance < 25000;
    IF below > 0 THEN RAISE EXCEPTION 'post-apply: % horses still below the floor', below; END IF;

    SELECT count(*) INTO upcoming FROM public.tournaments
     WHERE tournament_type='MTT' AND status IN ('ANNOUNCED','REGISTERING') AND start_time > now();
    IF upcoming < 6 THEN RAISE EXCEPTION 'post-apply: only % upcoming MTTs', upcoming; END IF;
END $$;
