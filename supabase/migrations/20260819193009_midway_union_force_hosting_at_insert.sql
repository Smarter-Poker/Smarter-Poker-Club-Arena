-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819193009 "midway_union_force_hosting_at_insert"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 eed65fd26d51cf9c1e33f99bcbf132ae of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- MIDWAY UNION: FORCE HOSTING AT THE DATABASE GATE (2026-08-19)
-- The external game engine keeps spawning/reviving games under member club
-- lobbies. The database now enforces the law itself:
--   1. Any non-private game INSERTed for a union member club is REHOMED to the
--      union's house club (Midway Union) before it hits disk.
--   2. Deleted tables cannot be revived by engine writes.
--   3. Existing club-lobby live tables are closed, deleted, and their engine
--      leases dropped. The engine's own spawner will repopulate — and every
--      new row now lands in Midway.
-- ============================================================================

-- 1. Rehome-at-insert (tables) ------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_stamp_table_union_ownership()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_union uuid;
  v_live_count integer;
BEGIN
  -- Private club games are never union-visible and stay in their club.
  IF COALESCE(NEW.is_private, false) THEN
    NEW.union_id := NULL;
    RETURN NEW;
  END IF;

  IF NEW.club_id IS NOT NULL THEN
    SELECT uc.union_id INTO v_union FROM union_clubs uc WHERE uc.club_id = NEW.club_id LIMIT 1;
    IF v_union IS NULL THEN
      SELECT c.union_id INTO v_union FROM clubs c WHERE c.id = NEW.club_id;
    END IF;
  END IF;

  IF v_union IS NOT NULL THEN
    NEW.union_id := v_union;
    -- LAW: union games run FROM the union. If the union has a house club
    -- (clubs row sharing the union id), the game is rehomed into it.
    IF TG_OP = 'INSERT'
       AND NEW.club_id <> v_union
       AND EXISTS (SELECT 1 FROM clubs hc WHERE hc.id = v_union AND COALESCE(hc.is_union, false)) THEN
      -- Safety valve against a runaway external spawner.
      SELECT count(*) INTO v_live_count
        FROM tables t
       WHERE t.club_id = v_union
         AND t.status IN ('running','waiting','active','open')
         AND COALESCE(t.is_deleted, false) = false;
      IF v_live_count >= 150 THEN
        INSERT INTO financial_alerts (severity, source, message, context)
        VALUES ('warning', 'fn_stamp_table_union_ownership',
                'Union house club table cap reached; rejecting spawn',
                jsonb_build_object('union_id', v_union, 'live_count', v_live_count,
                                   'attempted_club', NEW.club_id, 'name', NEW.name));
        RAISE EXCEPTION 'union_table_cap_reached: % live tables in union house club', v_live_count;
      END IF;
      NEW.club_id := v_union;
    END IF;
  END IF;

  RETURN NEW;
END $function$;

-- 2. Rehome-at-insert (tournaments) --------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_stamp_tournament_union_ownership()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_union uuid;
BEGIN
  IF COALESCE(NEW.is_private, false) THEN
    NEW.union_id := NULL;
    RETURN NEW;
  END IF;
  IF NEW.club_id IS NOT NULL THEN
    SELECT uc.union_id INTO v_union FROM union_clubs uc WHERE uc.club_id = NEW.club_id LIMIT 1;
    IF v_union IS NULL THEN
      SELECT c.union_id INTO v_union FROM clubs c WHERE c.id = NEW.club_id;
    END IF;
  END IF;
  IF v_union IS NOT NULL THEN
    NEW.union_id := v_union;
    IF TG_OP = 'INSERT'
       AND NEW.club_id <> v_union
       AND EXISTS (SELECT 1 FROM clubs hc WHERE hc.id = v_union AND COALESCE(hc.is_union, false)) THEN
      NEW.club_id := v_union;
    END IF;
  END IF;
  RETURN NEW;
END $function$;

-- 3. Deleted tables stay dead ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_block_deleted_table_revival()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(OLD.is_deleted, false)
     AND NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status IN ('running','waiting','active','open') THEN
    NEW.status := OLD.status;      -- refuse the revival, keep it closed
    NEW.is_deleted := true;
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trg_tables_block_deleted_revival ON public.tables;
CREATE TRIGGER trg_tables_block_deleted_revival
  BEFORE UPDATE ON public.tables
  FOR EACH ROW EXECUTE FUNCTION public.fn_block_deleted_table_revival();

-- 4. Kill the club-lobby games for good -------------------------------------------
DO $$
DECLARE
  v_midway uuid := 'fade0000-0000-0000-0000-000000000001';
  v_ids uuid[];
  v_n integer;
BEGIN
  SELECT array_agg(t.id) INTO v_ids
    FROM public.tables t
    JOIN public.union_clubs uc ON uc.club_id = t.club_id
   WHERE uc.union_id = v_midway
     AND t.status IN ('running','waiting','active','open')
     AND COALESCE(t.is_deleted, false) = false
     AND COALESCE(t.is_private, false) = false;

  IF v_ids IS NULL THEN
    RAISE NOTICE 'no club-lobby tables to kill';
    RETURN;
  END IF;

  -- Close (fires auto-cashout for seated players) and tombstone.
  UPDATE public.tables
     SET status = 'closed', is_deleted = true, deleted_at = now(), updated_at = now()
   WHERE id = ANY(v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- Drop the engine's leases so it releases them instead of reviving.
  DELETE FROM public.engine_table_leases WHERE table_id = ANY(v_ids);

  RAISE NOTICE 'killed % club-lobby tables and dropped their leases', v_n;
END $$;

