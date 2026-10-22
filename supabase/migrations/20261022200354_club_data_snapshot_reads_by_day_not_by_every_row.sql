-- 20261022200354_club_data_snapshot_reads_by_day_not_by_every_row.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- ca_club_data_snapshot_v2 (the club Data dashboard) hit the 8 s statement
-- timeout for the large clubs (31 times on 2026-10-22 after 06:00 UTC);
-- successful calls averaged about 4 s. Measured read-only for KINGS CLUB over
-- 30 days (about 650k fact rows):
--   1. 'data_updated_at' was max(last_at) over every game row in the range:
--      364,697 index entries plus heap visits, 7.3 s cold / 0.6 s warm, to
--      return one timestamp. Every game row's last_at falls on its own
--      Chicago stat_date (checked for all 1,074,147 rows), so the latest day
--      per club holds the maximum: read that day only. 30 ms. Same value.
--   2. The cash page read ca_club_data_game_ct through (club_id, game_id,
--      stat_date), so stat_date was not a leading range: 364,684 entries read
--      to keep 5,435 CASH rows, 8.3 s cold. A partial covering index on
--      (club_id, stat_date) INCLUDE (game_id, fee, winnings) WHERE kind='CASH'
--      serves it directly. Built CONCURRENTLY on 2026-10-22; recorded here.
--   3. ca_club_data_screen probed facts with stat_date = ANY (v_days), which
--      stopped the planner probing per game (574 ms); v_days is exactly every
--      date from v_start to v_end, so BETWEEN v_start AND v_end is the same
--      predicate and plans as a range (90 ms).
-- Results are identical; only plans change.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS ca_club_data_game_ct_cash_day_idx
    ON public.ca_club_data_game_ct (club_id, stat_date) INCLUDE (game_id, fee, winnings)
 WHERE kind = 'CASH';

DO $migration$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  -- 1. data_updated_at reads each club's latest day in the range.
  v_old := $o$(SELECT max(g.last_at) FROM public.ca_club_data_game_ct g WHERE g.club_id = ANY (public.fn_ca_club_data_clubs(p_club_id)) AND g.stat_date BETWEEN v_start AND v_end)$o$;
  v_new := $n$(SELECT max(x.m) FROM unnest(public.fn_ca_club_data_clubs(p_club_id)) c(id)
       CROSS JOIN LATERAL (SELECT max(g.last_at) m FROM public.ca_club_data_game_ct g
         WHERE g.club_id = c.id AND g.stat_date = (SELECT max(d.stat_date) FROM public.ca_club_data_game_ct d
           WHERE d.club_id = c.id AND d.stat_date BETWEEN v_start AND v_end)) x)$n$;
  v_def := pg_get_functiondef('public.ca_club_data_snapshot_v2(uuid,date,date,text,text,text,integer)'::regprocedure);
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'snapshot data_updated_at statement not found exactly once';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);

  -- 3. the screen probes facts by date range, not by a date array.
  v_old := 'f.stat_date = ANY (v_days)';
  v_new := 'f.stat_date BETWEEN v_start AND v_end';
  v_def := pg_get_functiondef('public.ca_club_data_screen(uuid,date,date,text,text,text,integer)'::regprocedure);
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 4 THEN
    RAISE EXCEPTION 'screen v_days probes not found exactly four times';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END
$migration$;

COMMIT;
