-- ═══════════════════════════════════════════════════════════════════════════
--  THE MAINTENANCE BREAK OUTLIVES THE PROCESS THAT DECLARED IT
--  Dan, 2026-09-01
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan: "A SCHEDULED PAUSE (LIKE A TOURNAMENT BREAK) WHERE 2 MIN BEFORE THE
-- RESTART ALL TABLES FINISH THE HAND THEY ARE ON ... ALL GAMES ARE THEN PAUSED
-- (NOTHING IS LOST OR CORRUPTED) HANDS FINISH, ENGINE RESTARTS AS SCHEDULED
-- AND THE HANDS PICK RIGHT BACK UP AS SOON AS THE RESTART IS OVER."
--
-- The whole point of this break is that the engine DIES in the middle of it.
-- So the break cannot live in the engine's memory, which is exactly where
-- `adminPauseLock` and `maintenanceLock` live today (ServerTableEngineBase),
-- and exactly why neither of them survives a deploy. Two readers need the
-- break after the process holding it is gone:
--
--   1. THE NEW ENGINE, on boot. Without this row it would rehydrate its tables
--      and immediately deal into a break players are still watching a
--      countdown for. It re-parks every engine it builds until break_ends_at.
--
--   2. THE BROWSER, during the ~2 minutes of 4404 while tables rehydrate. A
--      client that was connected when the break was announced keeps counting
--      down locally, but a player who opens a table DURING the outage has
--      never seen the announcement and, without this row, sees only a dead
--      felt and "This Table Is No Longer Running". This row is why they get a
--      break screen instead.
--
-- WHY NOT `tables.status = 'paused'`, which already exists as a legal enum
-- value: `cash_tables_needing_engine` (20260822b) matches only
-- status IN ('waiting','running'), so writing 'paused' does not pause a table,
-- it makes the engine ABANDON it - no engine, permanent 4404, dead felt. It is
-- the same trap TableConfigPage documents for 'active'. The break is platform
-- state, not table state, so it gets its own single row.

BEGIN;

-- ---------------------------------------------------------------------------
-- One row, forever. `id` is a boolean pinned true, so a second INSERT collides
-- on the primary key instead of quietly creating a second, contradictory break.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.engine_maintenance_break (
  id                BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),

  -- 'last_hand'     : announced, tables are finishing the hand in front of them,
  --                   no new hand starts. break_ends_at is NULL because the
  --                   countdown has not started yet and we refuse to show
  --                   players a number we would have to take back.
  -- 'counting_down' : every table parked, the 5:00 countdown is running,
  --                   break_ends_at is authoritative.
  phase             TEXT NOT NULL CHECK (phase IN ('last_hand', 'counting_down')),

  announced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  break_started_at  TIMESTAMPTZ,
  break_ends_at     TIMESTAMPTZ,

  -- Shown to players verbatim. Title Case with no em dashes, per CLAUDE.md
  -- sections 5.7 and 10.7 - this string reaches a popup and an overlay.
  reason            TEXT NOT NULL DEFAULT 'Scheduled Engine Maintenance',

  -- Which engine build declared it, for post-mortems that ask "who paused the
  -- platform at 04:53 and did the restart that followed actually land".
  declared_by       TEXT,

  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A counting_down break without an end time is a break nothing can ever end.
  CONSTRAINT counting_down_has_an_end
    CHECK (phase <> 'counting_down' OR break_ends_at IS NOT NULL)
);

COMMENT ON TABLE public.engine_maintenance_break IS
  'Single-row platform maintenance break. Written by the engine at :53 before a scheduled restart window and deleted when the break ends. Survives the restart on purpose: the booting engine re-parks its tables until break_ends_at, and browsers seeing 4404 during rehydration read it to show a break screen instead of a dead table. Never gate a table on tables.status = paused instead - cash_tables_needing_engine would abandon the table.';

-- ---------------------------------------------------------------------------
-- Readable by everyone, writable by the engine only.
--
-- A break is public information: it is announced on the felt, so there is
-- nothing here to protect. Anonymous read matters because a logged-out visitor
-- watching a table must see the break too.
-- ---------------------------------------------------------------------------
ALTER TABLE public.engine_maintenance_break ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS maintenance_break_is_public ON public.engine_maintenance_break;
CREATE POLICY maintenance_break_is_public
  ON public.engine_maintenance_break
  FOR SELECT
  TO anon, authenticated
  USING (TRUE);

-- No INSERT/UPDATE/DELETE policy at all: service_role bypasses RLS, everyone
-- else is refused by default. The engine is the only writer by construction.
GRANT SELECT ON public.engine_maintenance_break TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- One stable call for the client, so the browser never has to know the shape
-- of the table or reason about a stale row.
--
-- Returns NOTHING once the break has expired, even if the row is still there.
-- That matters: the engine deletes the row when the break ends, but the engine
-- is also the component that just died, so a crash mid-break would otherwise
-- strand every player on a break screen forever. An expired break is no break.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_maintenance_break_state()
RETURNS TABLE (
  phase            TEXT,
  break_ends_at    TIMESTAMPTZ,
  remaining_ms     INTEGER,
  reason           TEXT
)
LANGUAGE sql
STABLE
-- SECURITY INVOKER (the default), DELIBERATELY.
--
-- The pre-push definer-authorization guard blocked the first version of this,
-- and it was right to: a SECURITY DEFINER function a browser can reach runs
-- with the owner's rights and never asks who is calling. The guard offers an
-- allowlist entry for genuine public surface, but the better answer here is
-- not to need one. The table's own RLS policy already grants anon and
-- authenticated a SELECT, so this reads exactly what the caller could have
-- read for themselves; it exists to give the client one stable shape and the
-- self-expiry rule, not to lend it any rights.
SET search_path = public, pg_temp
AS $$
  SELECT
    b.phase,
    b.break_ends_at,
    GREATEST(
      0,
      LEAST(
        -- Hard ceiling. A row claiming a break ends nine hours from now is a
        -- bug or a clock skew, and it must not black out the platform: the
        -- longest legitimate break is 5 minutes plus the 2 minute last-hand
        -- wait, so anything past 15 minutes is capped rather than trusted.
        15 * 60 * 1000,
        COALESCE(EXTRACT(EPOCH FROM (b.break_ends_at - NOW())) * 1000, 0)
      )
    )::INTEGER AS remaining_ms,
    b.reason
  FROM public.engine_maintenance_break b
  WHERE
    -- last_hand has no end time yet; it is bounded by the announcement instead,
    -- so a crash between announce and countdown cannot strand anyone either.
    (b.phase = 'last_hand' AND b.announced_at > NOW() - INTERVAL '4 minutes')
    OR (b.phase = 'counting_down' AND b.break_ends_at > NOW());
$$;

COMMENT ON FUNCTION public.fn_maintenance_break_state() IS
  'The live maintenance break, or no rows when none is running. Self-expiring: a stale row left behind by a crashed engine reports nothing rather than stranding players on a break screen.';

GRANT EXECUTE ON FUNCTION public.fn_maintenance_break_state() TO anon, authenticated, service_role;

COMMIT;
