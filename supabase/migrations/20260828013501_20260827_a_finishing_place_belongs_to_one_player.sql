-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828013501; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ============================================================================
-- A FINISHING PLACE BELONGS TO ONE PLAYER.
--
-- The prize idempotency key is
--     tourney:{tournament_id}:prize:{user_id}:{position}
-- (TournamentManagerEliminations.ts). It includes the USER, so two players
-- stamped with the same position produce two different keys and BOTH are paid
-- the full place prize. computePlacePrize is a pure function of
-- (pool, structure, place) - it has no idea a place is contested.
--
-- This is not theoretical. Every over-paid tournament in the database has
-- duplicate places, with no exceptions:
--
--   Sunday Freeroll Special          pool 300.00  credited 600.00  (+300.00, 9 dup places)
--   Coffee Break Freeroll (PLO4)     pool  80.00  credited 128.00  (+48.00)
--   Union Mystery Bounty (PLO5)      pool 800.00  credited 832.00  (+32.00)
--   Bounty Builder Turbo             pool  30.00  credited  57.90  (+27.90)
--   ...                                            total     +454.82
--
-- Sunday Freeroll Special paid 200% of its own pool: all nine places were held
-- by two players and both collected. Population at risk right now: 206
-- duplicate (tournament_id, position) rows across 138 tournaments.
--
-- A guard for this already exists and it does not guard. trg_tournament_place_
-- collision detects the collision perfectly and then INSERTs a log row and
-- returns NEW - it watches the money leave. The table it writes to,
-- tournament_place_collisions, has ZERO rows, because the trigger post-dates
-- every collision it was built for. It has never even observed one.
--
-- Detection without enforcement is not a guard. Raise instead.
--
-- Why raising is the right failure here, and not a new hazard: a collision means
-- the engine computed the same place twice, which it does when playingCount is
-- read before a rebuy filter removes somebody from the busted set. The elimination
-- write is already a CAS with an explicit failure path -
-- 'Tournament.elimination_write_failed' reports loudly and the comment there says
-- "the next sweep sees the player still 'playing' with 0 chips and retries".
-- That retry re-reads the field and produces a distinct place. So the failure
-- mode of raising is one logged retry; the failure mode of logging is paying a
-- prize twice out of a pool that does not contain it.
--
-- THE 206 EXISTING ROWS ARE LEFT ALONE. Renumbering somebody's recorded
-- finishing position in a settled tournament is a decision about their record,
-- not a code fix, and an agent does not get to make it quietly. They are
-- reported to Dan with the money figures instead.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.trg_tournament_place_collision()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_existing uuid;
BEGIN
  IF NEW.position IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.position IS NOT DISTINCT FROM OLD.position THEN
    RETURN NEW;
  END IF;

  SELECT tp.user_id INTO v_existing
    FROM tournament_players tp
   WHERE tp.tournament_id = NEW.tournament_id
     AND tp.position = NEW.position
     AND tp.user_id <> NEW.user_id
   LIMIT 1;

  IF v_existing IS NOT NULL THEN
    -- Keep the forensic row: it is how the next reader learns this happened
    -- and which two players raced. Written before the raise so the INSERT is
    -- in a separate autonomous-ish path? It is not - it rolls back with the
    -- statement. That is acceptable: the RAISE below carries both user ids and
    -- the elimination path reports it as elimination_write_failed, which is a
    -- louder signal than a row in a table nobody queries.
    INSERT INTO tournament_place_collisions
      (tournament_id, place, user_id, existing_user_id, db_role, application)
    VALUES
      (NEW.tournament_id, NEW.position, NEW.user_id, v_existing,
       current_user, current_setting('application_name', true));

    RAISE EXCEPTION
      'finishing place % in tournament % is already held by % - refusing to stamp % on it (a contested place is paid TWICE, the prize idempotency key includes the user id)',
      NEW.position, NEW.tournament_id, v_existing, NEW.user_id
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.trg_tournament_place_collision() IS
  'REFUSES a second player on an already-taken finishing place. Was a watcher that only logged; a contested place is paid twice because the prize idempotency key includes the user id. See migration 20260827_a_finishing_place_belongs_to_one_player.';
