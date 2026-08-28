-- THE UNCREDITED-STACK GUARD LETS GO WHEN THE EVENT IS OVER.
--
-- fn_refuse_zero_chip_field_elimination protects a LIVE table: if two or more
-- players are still 'playing' and every one of them reads 0 chips, the stacks
-- have not been credited yet and nobody has actually busted, so it returns NULL
-- and the elimination write is silently dropped. That is the right call while a
-- tournament is running.
--
-- It never let go. For a tournament that reached COMPLETED weeks ago there is
-- no pending credit and there never will be one; the stacks read 0 because the
-- event is over. The guard still fired, so those players could not be ranked,
-- and a place with no identifiable holder is a place fn_tournament_payout_
-- reconcile refuses to pay. The money stayed put and the guard was the reason.
--
-- Found while backfilling the 146 events that finished before
-- guard_completed_ranks_survivors existed: 1,009 of 1,013 rows ranked, and the
-- last 4 would not move - two players each in Night Owl Special (NLH) and
-- Afternoon Bounty (NLH), both events long finished, both pairs at 0 chips.
-- fn_rank_survivors reported 0 rows ranked with 2 free places and 2 survivors
-- to put in them, because a BEFORE trigger returning NULL looks exactly like
-- "nothing matched".
--
-- The guard now checks the tournament's status. While it is REGISTERING or
-- RUNNING the behaviour is unchanged, warning and all. Once the row is
-- terminal, the write goes through - and it says so at WARNING level rather
-- than passing in silence, because a bust recorded after the fact is worth a
-- line in the log.
--
-- ROLLBACK
--   Re-apply the previous body from the migration that created it; the only
--   difference is the terminal-status branch added here.

CREATE OR REPLACE FUNCTION public.fn_refuse_zero_chip_field_elimination()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_live int;
  v_zero int;
  v_status text;
BEGIN
  -- Only a transition INTO elimination, from a live seat, at zero chips.
  IF NEW.status <> 'eliminated' OR OLD.status <> 'playing' THEN
    RETURN NEW;
  END IF;
  IF COALESCE(OLD.chips, 0) > 0 THEN
    RETURN NEW;
  END IF;

  SELECT count(*), count(*) FILTER (WHERE COALESCE(chips, 0) <= 0)
    INTO v_live, v_zero
    FROM public.tournament_players
   WHERE tournament_id = NEW.tournament_id
     AND status = 'playing';

  -- More than one player left and NONE of them has a chip: the table has not
  -- been credited. Bust nobody. (At exactly one remaining player this is the
  -- legitimate "everybody busted in the same hand" tail, which the engine
  -- resolves by naming the last one out the winner - leave that alone.)
  IF v_live > 1 AND v_zero = v_live THEN
    SELECT upper(COALESCE(t.status, '')) INTO v_status
      FROM public.tournaments t WHERE t.id = NEW.tournament_id;

    -- ...unless the event is already over. Nothing is going to credit those
    -- stacks now, and holding the write means the place stays unowned and
    -- unpayable forever. Refusing to bust somebody in a finished tournament
    -- does not protect them; it withholds their money.
    IF v_status IN ('COMPLETED', 'CANCELLED', 'CANCELED') THEN
      RAISE WARNING
        'allowing elimination in % (%): all % live player(s) read 0 chips, but the event is terminal - recording the finish',
        NEW.tournament_id, v_status, v_live;
      RETURN NEW;
    END IF;

    RAISE WARNING
      'refused elimination in %: all % live player(s) read 0 chips - uncredited stacks, not a bust',
      NEW.tournament_id, v_live;
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$function$;

DO $post$
DECLARE v_def text;
BEGIN
  v_def := pg_get_functiondef('public.fn_refuse_zero_chip_field_elimination()'::regprocedure);
  -- Assert on the executable definition. Both halves must be present: the live
  -- refusal AND the terminal release. A version with only one of them is a
  -- regression in one direction or the other.
  IF position('RETURN NULL' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the live-table refusal was lost';
  END IF;
  IF position('COMPLETED' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the terminal-status release was not applied';
  END IF;
END
$post$;
