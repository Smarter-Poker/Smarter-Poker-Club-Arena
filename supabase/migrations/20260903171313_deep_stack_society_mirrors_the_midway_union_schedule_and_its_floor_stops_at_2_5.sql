-- ═══════════════════════════════════════════════════════════════════════════════
--  DEEP STACK SOCIETY MIRRORS THE MIDWAY UNION SCHEDULE, AND ITS FLOOR STOPS AT 2/5
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Dan, 2026-09-03: "CREATE A MTT TOURNEY SCHEDULE THAT MIRRORS THE MIDWAY UNION"
-- and "CLOSE ANY TABLES OVER 2/5".
--
-- 1. THE SCHEDULE. Every active Midway Union schedule row that is not a spin
--    (the union's one spin row is inactive; spins come from the board, not the
--    schedule) is copied to Deep Stack Society as a standalone club row: same
--    name, same days, same UTC times, same config, union_id NULL, club_id the
--    club. Satellite rows resolve their target by name inside the same owner
--    (ScheduledTournamentService.resolveSatelliteTarget scopes by club_id when
--    union_id is null), so "Sunday Deep Stack Satellite $5" at Deep Stack feeds
--    Deep Stack's own "Sunday $200 Deep Stack". The club's existing 84 rows are
--    left as they are; a row is copied only when the club has no row of that
--    name, so this file can run again and add nothing.
--
--    Measured before this ran: 64 Midway rows, 84 Deep Stack rows, 0 in common.
--
-- 2. THE FLOOR. Deep Stack Society carried a cash ladder from $0.01/$0.02 to
--    $50/$100. Everything above 2/5 had never seated a horse and never could
--    (HorseBankroll needs 12 to 40 buy-ins to sit and the club's horses hold a
--    median of 10,000 chips), so 40 of those tables sat empty as furniture.
--    Empty ones close here. The handful that are running (fixed-limit $3/$6 and
--    $4/$8 with horses seated) are flagged `settings.retire_when_empty`; the
--    fleet stops seeding them, the session rotator walks their horses out at
--    the end of a hand, and the retire pass closes them once they are empty.
--    Closing a live table from SQL would cash seats out under a hand in
--    progress, which is why the running ones are drained by the engine and not
--    by this file.
--
--    "Over 2/5" is read off the stakes label: any label whose second number is
--    greater than 5 (so $3/$6 counts, $2/$5 does not), with big_blind > 5 as
--    the fallback when a label does not parse.

-- ── 1. Schedule mirror ────────────────────────────────────────────────────────
INSERT INTO public.tournament_schedules
  (union_id, club_id, name, description, active, days_of_week, start_times_utc,
   interval_minutes, config, created_by)
SELECT
  NULL,
  '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid,   -- Deep Stack Society
  s.name, s.description, s.active, s.days_of_week, s.start_times_utc,
  s.interval_minutes, s.config, s.created_by
FROM public.tournament_schedules s
WHERE s.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid   -- Midway Union
  AND s.active = true
  AND COALESCE(s.config->>'type', 'mtt') <> 'spin'
  AND NOT EXISTS (
    SELECT 1 FROM public.tournament_schedules d
    WHERE d.club_id = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid
      AND d.union_id IS NULL
      AND d.name = s.name
  );

-- ── 2. The floor stops at 2/5 ─────────────────────────────────────────────────
WITH over AS (
  SELECT t.id,
         COALESCE(
           NULLIF(regexp_replace(COALESCE(t.stakes, ''), '^.*/\s*\$?([0-9]+(\.[0-9]+)?).*$', '\1'), COALESCE(t.stakes, ''))::numeric,
           t.big_blind
         ) AS top_number,
         t.current_players,
         EXISTS (SELECT 1 FROM public.table_seats s WHERE s.table_id = t.id AND s.left_at IS NULL) AS seated
  FROM public.tables t
  WHERE t.club_id = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid
    AND t.tournament_id IS NULL
    AND t.is_deleted IS NOT TRUE
    AND t.is_template IS NOT TRUE
    AND t.status IN ('waiting', 'running')
),
empty_over AS (
  SELECT id FROM over WHERE top_number > 5 AND NOT seated AND COALESCE(current_players, 0) = 0
),
closed AS (
  UPDATE public.tables t
     SET status = 'closed', current_players = 0, updated_at = now()
    FROM empty_over e
   WHERE t.id = e.id
  RETURNING t.id
)
UPDATE public.tables t
   SET settings = COALESCE(t.settings, '{}'::jsonb) || jsonb_build_object('retire_when_empty', true),
       updated_at = now()
  FROM over o
 WHERE t.id = o.id
   AND o.top_number > 5
   AND t.id NOT IN (SELECT id FROM closed);
