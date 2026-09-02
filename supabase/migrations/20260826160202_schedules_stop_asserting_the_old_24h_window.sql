-- ═════════════════════════════════════════════════════════════════════════════
-- 60 SCHEDULES WERE STILL ASSERTING A 24 HOUR BOARD
-- Dan 2026-08-26, follow-up to 20260826151459_lobby_publishes_48h_of_card
-- ═════════════════════════════════════════════════════════════════════════════
--
-- FILENAME VERSION = THE APPLIED VERSION (the Supabase MCP stamps its own).
--
-- `spawnAheadMinutes` is a per-schedule look-ahead override. Every one of the
-- 60 active schedules carried the value 1440 -- 24 hours -- written back when
-- 24 hours WAS the house window. It is not a considered choice per schedule;
-- it is the old default, copied 60 times.
--
-- ScheduledTournamentService.spawnAheadMsFor now treats the override as a
-- FLOOR-RAISER (Math.max against the house window), so 1440 is already inert
-- and the board publishes 48 hours regardless. This migration removes the key
-- anyway, for one reason: DEFENCE IN DEPTH. As long as 60 rows say "24 hours",
-- a single future edit that restores override-wins semantics silently returns
-- the platform to the exact bug being fixed -- and it would do so with every
-- test green, because the tests exercise the function, not the data.
--
-- After this, the code and the data have to BOTH be wrong before the board
-- goes back to one day of card.
--
-- SCOPE, measured before writing (2026-08-26):
--   would_strip = 60, must_keep_larger = 0, smaller_than_old_default = 0
-- So this touches every row and preserves no genuine override, because there
-- is no genuine override. A schedule that later wants MORE than the house
-- window sets the key again and Math.max honours it.
--
-- NOT DESTRUCTIVE: `config` keeps every other key. Only the redundant
-- look-ahead is removed, and only where it equals exactly 1440.

DO $$
DECLARE
  v_larger integer;
BEGIN
  -- Refuse to run if a genuine larger override has appeared since the
  -- measurement above. Removing one of those WOULD change behaviour.
  SELECT count(*) INTO v_larger
  FROM public.tournament_schedules
  WHERE (config->>'spawnAheadMinutes')::numeric > 2880;

  IF v_larger > 0 THEN
    RAISE EXCEPTION
      'aborting: % schedule(s) carry a look-ahead longer than the 48h house window. Narrow the WHERE clause before re-running so their override survives.', v_larger;
  END IF;
END $$;

UPDATE public.tournament_schedules
SET config = config - 'spawnAheadMinutes',
    updated_at = now()
WHERE (config->>'spawnAheadMinutes')::numeric = 1440;

-- ── POST-APPLY ASSERTIONS ───────────────────────────────────────────────────

DO $$
DECLARE
  v_left integer;
  v_lost integer;
BEGIN
  SELECT count(*) INTO v_left
  FROM public.tournament_schedules
  WHERE (config->>'spawnAheadMinutes')::numeric = 1440;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'still % schedule(s) pinned to a 24 hour look-ahead', v_left;
  END IF;

  -- The rest of each config must be intact: buyIn is what the 6-day rule
  -- reads, so losing it would silently demote every big event.
  SELECT count(*) INTO v_lost
  FROM public.tournament_schedules
  WHERE active AND NOT (config ? 'buyIn');
  IF v_lost <> 0 THEN
    RAISE EXCEPTION 'config damage: % active schedule(s) lost their buyIn key', v_lost;
  END IF;
END $$;

-- ROLLBACK
--   UPDATE public.tournament_schedules
--   SET config = jsonb_set(config, '{spawnAheadMinutes}', '1440'::jsonb, true)
--   WHERE NOT (config ? 'spawnAheadMinutes');
