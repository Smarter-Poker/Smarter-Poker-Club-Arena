-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820020540 "club_table_count_reflects_reality"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 802d839ae4a2574fbbbe8df6b83704b2 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- clubs.table_count TOLD THE OPPOSITE OF THE TRUTH (2026-08-19)
--
-- Reported by Dan: "there are ZERO cash games and tournaments running from the
-- Midway Union". The games were in fact all running from the union — 36 live
-- cash tables carrying union_id = Midway, with 208 players seated. What was
-- wrong was the number next to each entry:
--
--     SHARK CLUB    table_count 254   actual live tables 0
--     Club JAQK     table_count 217   actual live tables 0
--     Midway Union  table_count   0   actual live tables 36
--
-- Exactly inverted. `table_count` was a lifetime counter: create-table
-- incremented it and NOTHING ever decremented it, so it accumulated forever
-- for the two member clubs (which no longer create their own games) and stayed
-- at zero for the union (whose tables are created by the engine fleet, which
-- never touched the counter).
--
-- So the union that runs every game displayed 0, and two clubs that run none
-- displayed hundreds.
--
-- FIX: table_count becomes a live count of joinable cash tables, maintained by
-- trigger instead of by one hopeful increment at creation time.
--
-- WHAT COUNTS FOR A UNION MEMBER: under the union rules, a member club's
-- players play the UNION's tables. So a member club counts the union's live
-- tables plus its own private games — which is what its lobby actually shows.
-- A standalone club counts its own. That makes the number mean "games you can
-- sit down at from here", which is what a player reads it as.
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_live_table_count(p_club_id uuid)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*)::int
    FROM tables t
   WHERE t.tournament_id IS NULL
     AND COALESCE(t.is_deleted, false) = false
     AND t.status NOT IN ('closed', 'deleted')
     AND (
       -- the club's own games (private club games included)
       t.club_id = p_club_id
       -- plus the union's games, if this club belongs to one
       OR t.union_id = (SELECT uc.union_id FROM union_clubs uc
                         WHERE uc.club_id = p_club_id LIMIT 1)
       -- the union's own container row: its games are keyed by union_id
       OR t.union_id = p_club_id
     );
$$;

CREATE OR REPLACE FUNCTION fn_refresh_all_club_table_counts()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer := 0;
BEGIN
  UPDATE clubs c
     SET table_count = fn_live_table_count(c.id)
   WHERE c.table_count IS DISTINCT FROM fn_live_table_count(c.id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- Keep it true from here on, rather than trusting a single increment at insert.
CREATE OR REPLACE FUNCTION fn_sync_club_table_counts() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_club uuid; v_union uuid;
BEGIN
  v_club  := COALESCE(NEW.club_id,  OLD.club_id);
  v_union := COALESCE(NEW.union_id, OLD.union_id);

  IF v_club IS NOT NULL THEN
    UPDATE clubs SET table_count = fn_live_table_count(id) WHERE id = v_club;
  END IF;

  -- Every club that can see this union's tables (members + the union's own row)
  IF v_union IS NOT NULL THEN
    UPDATE clubs SET table_count = fn_live_table_count(id)
     WHERE id = v_union
        OR id IN (SELECT club_id FROM union_clubs WHERE union_id = v_union);
  END IF;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_tables_sync_club_counts ON tables;
CREATE TRIGGER trg_tables_sync_club_counts
AFTER INSERT OR DELETE OR UPDATE OF status, is_deleted, club_id, union_id, tournament_id
ON tables
FOR EACH ROW EXECUTE FUNCTION fn_sync_club_table_counts();

REVOKE ALL ON FUNCTION fn_live_table_count(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_refresh_all_club_table_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_live_table_count(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION fn_refresh_all_club_table_counts() TO service_role;

-- Correct every existing row now.
SELECT fn_refresh_all_club_table_counts();

DO $$
DECLARE v_midway int; v_jaqk int; v_shark int;
BEGIN
  SELECT table_count INTO v_midway FROM clubs WHERE id = 'fade0000-0000-0000-0000-000000000001';
  SELECT table_count INTO v_jaqk   FROM clubs WHERE id = 'a0000000-0000-0000-0000-000000000001';
  SELECT table_count INTO v_shark  FROM clubs WHERE id = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
  IF v_midway = 0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: Midway Union still reports 0 live tables';
  END IF;
  RAISE NOTICE 'table_count now — Midway: %, JAQK: %, SHARK: %', v_midway, v_jaqk, v_shark;
END $$;
