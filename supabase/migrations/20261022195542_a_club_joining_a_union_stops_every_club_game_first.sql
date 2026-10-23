-- A CLUB JOINING A UNION STOPS EVERY CLUB GAME FIRST (2026-10-22)
--
-- Owner hard rule (Dan, 2026-10-22): when a club joins a union, all of that
-- club's previous tournaments and cash games stop. Every club cash game and
-- tournament is removed before the club can join the union.
--
-- What was wrong: Club Savage joined the Midway union at 2026-10-21 19:03 UTC.
-- Its registering events were cancelled, but its own tournament schedule
-- (90bc5da5, "Daily 25 Chip Freezeout") stayed active. The engine kept
-- spawning it, and fn_stamp_tournament_union_ownership restamped each spawn
-- into the union, so a club schedule was publishing events in the union lobby
-- (78336d8c for Oct 25). Nothing in the database enforced the rule.
--
-- This change:
-- 1. BEFORE INSERT/UPDATE on union_clubs: before a club enters a union, every
--    schedule it owns is switched off, every not-started event of the club
--    (its own or spawned from its schedules) with no entrants is cancelled
--    through atomic_cancel_tournament (immutable receipt),
--    and its cash tables are closed through fn_union_close_club_tables_for_join.
--    A club event that is running or has entrants refuses the join: removing
--    it would move players' money, so it must finish or be cancelled first.
-- 2. tournament_schedules: a schedule owned by a union member club cannot be
--    active.
-- 3. tournaments: an event cannot be spawned from a schedule owned by a union
--    member club (runs before the union ownership stamp).
-- 4. Data: switches off Club Savage's schedule. Its Oct 25 spawn (0 entrants)
--    is cancelled right after, in its own transaction (see the end of file).
-- No chips move.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- Lock order: public.tournaments first, then tournament_schedules, then
-- union_clubs, the same order the settlement paths take them.
CREATE OR REPLACE FUNCTION public.fn_ca_union_member_schedule_cannot_spawn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NEW.schedule_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.tournament_schedules s
         JOIN public.union_clubs uc ON uc.club_id = s.club_id AND uc.club_id <> uc.union_id
        WHERE s.id = NEW.schedule_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'A club in a union cannot spawn events from its own schedule.';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.fn_ca_union_member_schedule_cannot_spawn() FROM PUBLIC, anon, authenticated;

INSERT INTO public.ca_declared_money_triggers(table_name, trigger_name, note)
VALUES ('tournaments', 'a00_union_member_schedule_cannot_spawn',
  'Reviewed 2026-10-22: refuses inserting an event spawned from a schedule owned by a union member club (owner rule: club games stop when a club joins a union). Moves no money; it only refuses the insert.')
ON CONFLICT (table_name, trigger_name) DO UPDATE SET note = EXCLUDED.note;

DROP TRIGGER IF EXISTS a00_union_member_schedule_cannot_spawn ON public.tournaments;
CREATE TRIGGER a00_union_member_schedule_cannot_spawn
  BEFORE INSERT ON public.tournaments
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_union_member_schedule_cannot_spawn();


CREATE OR REPLACE FUNCTION public.fn_ca_union_member_schedule_stays_off()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NEW.active AND EXISTS (SELECT 1 FROM public.union_clubs uc
                             WHERE uc.club_id = NEW.club_id AND uc.club_id <> uc.union_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'A club in a union cannot run its own tournament schedule.',
      HINT    = 'Club games stop when a club joins a union; the union runs the schedule.';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.fn_ca_union_member_schedule_stays_off() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_union_member_schedule_stays_off ON public.tournament_schedules;
CREATE TRIGGER trg_union_member_schedule_stays_off
  BEFORE INSERT OR UPDATE OF active, club_id ON public.tournament_schedules
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_union_member_schedule_stays_off();

CREATE OR REPLACE FUNCTION public.fn_ca_union_join_removes_club_games()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_blocking integer;
  v_tables jsonb;
  r record;
BEGIN
  IF NEW.club_id IS NULL OR NEW.club_id = NEW.union_id THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
     AND NEW.union_id IS NOT DISTINCT FROM OLD.union_id THEN
    RETURN NEW;
  END IF;

  -- Club events that cannot be removed without moving players' money.
  SELECT count(*) INTO v_blocking
    FROM public.tournaments t
   WHERE (t.club_id = NEW.club_id
          OR t.schedule_id IN (SELECT s.id FROM public.tournament_schedules s WHERE s.club_id = NEW.club_id))
     AND upper(coalesce(t.status, '')) NOT IN ('COMPLETED','COMPLETING','CANCELLED','CANCELED','FAILED')
     AND (upper(coalesce(t.status, '')) IN ('RUNNING','STARTING','PAUSED','FINAL_TABLE','BREAK')
          OR EXISTS (SELECT 1 FROM public.tournament_players p WHERE p.tournament_id = t.id));
  IF v_blocking > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'This club still has tournaments with players and cannot join a union yet.',
      DETAIL  = format('%s club tournament(s) are running or have entrants.', v_blocking),
      HINT    = 'Every club cash game and tournament is removed before a club joins a union. Let them finish or cancel them first.';
  END IF;

  UPDATE public.tournament_schedules
     SET active = false
   WHERE club_id = NEW.club_id AND active;

  -- Every not-started club event goes through the one cancellation authority,
  -- which writes the immutable receipt (none of these has an entrant).
  FOR r IN
    SELECT t.id FROM public.tournaments t
     WHERE (t.club_id = NEW.club_id
            OR t.schedule_id IN (SELECT s.id FROM public.tournament_schedules s WHERE s.club_id = NEW.club_id))
       AND upper(coalesce(t.status, '')) NOT IN ('COMPLETED','COMPLETING','CANCELLED','CANCELED','FAILED')
     ORDER BY t.id
  LOOP
    BEGIN
      PERFORM set_config('app.managed_game_lifecycle', 'on', true);
      PERFORM public.atomic_cancel_tournament(r.id, NULL);
      PERFORM set_config('app.managed_game_lifecycle', '', true);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'A club tournament could not be removed, so the club cannot join a union yet.',
        DETAIL  = format('tournament %s: %s', r.id, SQLERRM),
        HINT    = 'Every club cash game and tournament is removed before a club joins a union. Cancel it first.';
    END;
  END LOOP;

  -- Closing tables marks them deleted: the sanctioned managed-game lifecycle
  -- door (fn_guard_managed_game_lifecycle), open for this step only.
  PERFORM set_config('app.managed_game_lifecycle', 'on', true);
  v_tables := public.fn_union_close_club_tables_for_join(NEW.club_id);
  IF NOT coalesce((v_tables->>'success')::boolean, false) THEN
    RAISE EXCEPTION 'Club cash games could not be closed before the union join: %', v_tables
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('app.managed_game_lifecycle', '', true);

  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.fn_ca_union_join_removes_club_games() FROM PUBLIC, anon, authenticated;

-- Runs after trg_club_enters_a_union_empty (chips check) by name order.
DROP TRIGGER IF EXISTS trg_union_join_removes_club_games ON public.union_clubs;
CREATE TRIGGER trg_union_join_removes_club_games
  BEFORE INSERT OR UPDATE OF club_id, union_id ON public.union_clubs
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_union_join_removes_club_games();

-- Data: the one schedule and spawn that broke the rule.
UPDATE public.tournament_schedules s
   SET active = false
 WHERE s.active AND EXISTS (SELECT 1 FROM public.union_clubs uc
                             WHERE uc.club_id = s.club_id AND uc.club_id <> uc.union_id);

-- The not-started spawn of that schedule (Oct 25, 0 entrants) is cancelled
-- through atomic_cancel_tournament in its own transaction after this one:
-- the cancellation authority takes the global settlement lock, which must not
-- be taken while this migration holds DDL locks on public.tournaments.

COMMIT;
