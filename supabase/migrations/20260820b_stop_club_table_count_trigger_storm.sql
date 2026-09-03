-- Mirror of the live catalog (applied 2026-08-20 via mcp apply_migration).
-- ═══════════════════════════════════════════════════════════════════════════════
-- ONE TRIGGER WAS 40% OF THE ENTIRE DATABASE
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Measured from pg_stat_statements, 8h45m of production since the last Postgres
-- restart:
--
--   UPDATE public.tables SET current_players = $, status = $ WHERE id = $
--     calls 91,678   total 16,123.8s   mean 175.87ms   sd 361.72ms   max 7,720ms
--     = 40.12% of ALL database execution time.
--
-- A two-column UPDATE by primary key on a 67 MB table. The UPDATE is not the
-- cost — the trigger cascade behind it is.
--
-- The engine writes current_players AND status together once per hand per
-- table. `AFTER UPDATE OF status` fires when status is in the SET list, NOT
-- when its value changes — so trg_tables_sync_club_counts fired on all 91,678
-- of those writes even though status changed on almost none of them. Each
-- firing ran fn_live_table_count() for the club, for the union, and for every
-- club in that union, then UPDATE'd each of those clubs rows.
--
-- fn_live_table_count is a seq scan: `COALESCE(is_deleted,false)=false` is not
-- indexable, and neither is the club_id/union_id OR-chain. Measured: 19.5ms and
-- 1,880 buffers per call against 58,037 rows in `tables`. Three calls per hand
-- x 238,583 hands a day = ~41 BILLION row examinations a day to maintain a
-- table-count badge.
--
-- Worse than the CPU: all 52 live tables UPDATE the SAME clubs rows on every
-- hand, so they serialize on those row locks. That is why the platform stalls
-- in correlated bursts across every table at once — the same bursts in which
-- hand_history inserts hit the statement timeout (218 of the 710 timeouts in
-- 23h are that insert) and hands were lost with no history row.
--
-- RESULT, measured on live traffic immediately after this migration:
--   UPDATE tables ... : 175.67ms -> 2.31ms mean  (76x)
--   hand_history INSERT: 21.60ms -> 9.86ms mean
--   clubs.table_count verified unchanged and still exact for every club
--   (Midway Union / Club JAQK / SHARK CLUB all 38 = 38).
--
-- Three fixes, in increasing order of how much they matter:
--
--   1. Make fn_live_table_count indexable (is_deleted IS NOT TRUE instead of
--      COALESCE, plus two partial indexes so the OR-chain is a BitmapOr of two
--      index scans instead of a seq scan).
--   2. Only recompute when a watched value ACTUALLY CHANGED. Postgres cannot
--      express that in one trigger across INSERT/UPDATE/DELETE, because a WHEN
--      clause may not reference OLD on INSERT or NEW on DELETE — so the single
--      trigger is split into three, and only the UPDATE one carries the
--      IS DISTINCT FROM guard. This is what removes ~99% of the firings.
--   3. Nothing else changes: same function, same counts, same result.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1. Indexes that fn_live_table_count can actually use ────────────────────
CREATE INDEX IF NOT EXISTS idx_tables_live_by_club
  ON public.tables (club_id)
  WHERE tournament_id IS NULL
    AND is_deleted IS NOT TRUE
    AND status NOT IN ('closed', 'deleted');

CREATE INDEX IF NOT EXISTS idx_tables_live_by_union
  ON public.tables (union_id)
  WHERE tournament_id IS NULL
    AND is_deleted IS NOT TRUE
    AND status NOT IN ('closed', 'deleted');

COMMENT ON INDEX public.idx_tables_live_by_club IS
  'Serves fn_live_table_count. Predicate must stay character-identical to that function''s WHERE clause or the planner falls back to a seq scan of 58k rows. Added 2026-08-20.';
COMMENT ON INDEX public.idx_tables_live_by_union IS
  'Serves fn_live_table_count. Predicate must stay character-identical to that function''s WHERE clause or the planner falls back to a seq scan of 58k rows. Added 2026-08-20.';

-- ── 2. The function, made index-matchable ───────────────────────────────────
-- Only change: COALESCE(t.is_deleted, false) = false  ->  t.is_deleted IS NOT TRUE.
-- Identical semantics (both exclude only rows where is_deleted is true), but the
-- COALESCE form is an opaque expression the index predicate cannot be proven
-- to imply. Counts are unchanged.
CREATE OR REPLACE FUNCTION public.fn_live_table_count(p_club_id uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT count(*)::int
    FROM tables t
   WHERE t.tournament_id IS NULL
     AND t.is_deleted IS NOT TRUE
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
$function$;

-- ── 2b. The trigger function this file's triggers reference ─────────────────
--
-- REVIEW FIX 2026-08-20: this migration created three triggers pointing at
-- fn_sync_club_table_counts() and commented on it, but no migration in the repo
-- ever CREATEd it — it only existed in the live catalog. On a fresh database
-- (`supabase db reset`, a preview branch, CI) this file failed outright with
-- `function public.fn_sync_club_table_counts() does not exist`. Dumped from the
-- live catalog and included so the repo can actually rebuild the schema.
--
-- NOTE: 20260820f replaces this body — it recomputes BOTH sides of a club/union
-- move, which this version does not. This is the historical body, kept so the
-- migration sequence applies cleanly in order.
CREATE OR REPLACE FUNCTION public.fn_sync_club_table_counts()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
END $function$;

-- ── 3. Fire only on a real change ───────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_tables_sync_club_counts ON public.tables;

CREATE TRIGGER trg_tables_sync_club_counts_ins
  AFTER INSERT ON public.tables
  FOR EACH ROW EXECUTE FUNCTION public.fn_sync_club_table_counts();

CREATE TRIGGER trg_tables_sync_club_counts_del
  AFTER DELETE ON public.tables
  FOR EACH ROW EXECUTE FUNCTION public.fn_sync_club_table_counts();

CREATE TRIGGER trg_tables_sync_club_counts_upd
  AFTER UPDATE OF status, is_deleted, club_id, union_id ON public.tables
  FOR EACH ROW
  WHEN (
    NEW.status     IS DISTINCT FROM OLD.status
    OR NEW.is_deleted IS DISTINCT FROM OLD.is_deleted
    OR NEW.club_id    IS DISTINCT FROM OLD.club_id
    OR NEW.union_id   IS DISTINCT FROM OLD.union_id
  )
  EXECUTE FUNCTION public.fn_sync_club_table_counts();

COMMENT ON FUNCTION public.fn_sync_club_table_counts() IS
  'Recomputes clubs.table_count. Reached by three triggers on public.tables (ins/del/upd). The UPDATE one carries an IS DISTINCT FROM guard: `AFTER UPDATE OF status` fires whenever status is in the SET list, and the engine writes status alongside current_players once per hand, which made this trigger 40% of all database time on 2026-08-20. Do not merge these back into one trigger.';
