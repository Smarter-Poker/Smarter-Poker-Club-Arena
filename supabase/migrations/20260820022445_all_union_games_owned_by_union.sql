-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820022445 "all_union_games_owned_by_union"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8e2d6905ae7061c8cbb55f79aa7ab0ad of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- ALL GAME TYPES ARE CREATED BY THE UNION (2026-08-19)
--
-- Dan: "MAKE SURE THAT THE GAMES ARE CREATED BY MIDWAY UNION FOR ALL CASH
-- GAMES, MTT, SIT N GO'S AND SPINS."
--
-- Cash tables already spawned from the union. The recurring MTT / SNG / Spin
-- schedulers did not: TournamentRecurringService round-robined club_id between
-- SHARK and JAQK and never set union_id at all. The ownership trigger added
-- earlier back-filled union_id afterwards, so those games LOOKED union-owned
-- while their club_id still named a member club — which is why one MTT was
-- still sitting under Club JAQK.
--
-- The scheduler is fixed to name the union explicitly. This migration does the
-- other two halves:
--   1. repoint any existing live game that is union-scoped but still attributed
--      to a member club, so the current schedule matches the rule;
--   2. make the rule structural, so a future writer that forgets cannot
--      reintroduce the drift — the ownership trigger now also normalises
--      club_id to the union's own container row for non-private games.
--
-- Private club games are untouched: they keep their club_id and carry no
-- union_id, which is exactly what makes them private.
-- ============================================================================

-- 1. Normalise ownership on creation AND update, for tables and tournaments.
CREATE OR REPLACE FUNCTION fn_stamp_table_union_ownership() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_union uuid;
BEGIN
  IF COALESCE(NEW.is_private, false) THEN
    NEW.union_id := NULL;               -- private games are never union-visible
    RETURN NEW;
  END IF;

  IF NEW.union_id IS NULL AND NEW.club_id IS NOT NULL THEN
    SELECT uc.union_id INTO v_union FROM union_clubs uc WHERE uc.club_id = NEW.club_id LIMIT 1;
    IF v_union IS NOT NULL THEN NEW.union_id := v_union; END IF;
  END IF;

  -- A union game belongs to the UNION, not to whichever member club happened to
  -- create it. Point club_id at the union's own container row so every surface
  -- agrees on who runs the game.
  IF NEW.union_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM clubs c WHERE c.id = NEW.union_id) THEN
    NEW.club_id := NEW.union_id;
  END IF;

  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION fn_stamp_tournament_union_ownership() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_union uuid;
BEGIN
  IF COALESCE(NEW.is_private, false) THEN
    NEW.union_id := NULL;
    RETURN NEW;
  END IF;

  IF NEW.union_id IS NULL AND NEW.club_id IS NOT NULL THEN
    SELECT uc.union_id INTO v_union FROM union_clubs uc WHERE uc.club_id = NEW.club_id LIMIT 1;
    IF v_union IS NOT NULL THEN NEW.union_id := v_union; END IF;
  END IF;

  IF NEW.union_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM clubs c WHERE c.id = NEW.union_id) THEN
    NEW.club_id := NEW.union_id;
  END IF;

  RETURN NEW;
END $$;

-- The UPDATE-side guards must apply the same normalisation.
CREATE OR REPLACE FUNCTION fn_enforce_table_union_ownership_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_union uuid;
BEGIN
  IF COALESCE(NEW.is_private, false) THEN
    NEW.union_id := NULL;
    RETURN NEW;
  END IF;
  IF NEW.club_id IS NOT NULL THEN
    SELECT uc.union_id INTO v_union FROM union_clubs uc WHERE uc.club_id = NEW.club_id LIMIT 1;
    IF v_union IS NOT NULL AND NEW.union_id IS DISTINCT FROM v_union THEN
      NEW.union_id := v_union;
    END IF;
  END IF;
  IF NEW.union_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM clubs c WHERE c.id = NEW.union_id) THEN
    NEW.club_id := NEW.union_id;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION fn_enforce_tournament_union_ownership_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_union uuid;
BEGIN
  IF COALESCE(NEW.is_private, false) THEN
    NEW.union_id := NULL;
    RETURN NEW;
  END IF;
  IF NEW.club_id IS NOT NULL THEN
    SELECT uc.union_id INTO v_union FROM union_clubs uc WHERE uc.club_id = NEW.club_id LIMIT 1;
    IF v_union IS NOT NULL AND NEW.union_id IS DISTINCT FROM v_union THEN
      NEW.union_id := v_union;
    END IF;
  END IF;
  IF NEW.union_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM clubs c WHERE c.id = NEW.union_id) THEN
    NEW.club_id := NEW.union_id;
  END IF;
  RETURN NEW;
END $$;

-- 2. Repoint the games that are already live.
UPDATE tournaments t
   SET club_id = t.union_id
 WHERE t.union_id IS NOT NULL
   AND COALESCE(t.is_private, false) = false
   AND t.club_id IS DISTINCT FROM t.union_id
   AND EXISTS (SELECT 1 FROM clubs c WHERE c.id = t.union_id)
   AND t.status IN ('ANNOUNCED','SCHEDULED','REGISTERING','LATE_REG','RUNNING');

UPDATE tables tb
   SET club_id = tb.union_id
 WHERE tb.union_id IS NOT NULL
   AND COALESCE(tb.is_private, false) = false
   AND tb.club_id IS DISTINCT FROM tb.union_id
   AND EXISTS (SELECT 1 FROM clubs c WHERE c.id = tb.union_id)
   AND COALESCE(tb.is_deleted, false) = false
   AND tb.status NOT IN ('closed','deleted');

SELECT fn_refresh_all_club_table_counts();

-- 3. Assert the rule holds for every live game, of every type.
DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad FROM tournaments
   WHERE union_id IS NOT NULL AND COALESCE(is_private,false) = false
     AND club_id IS DISTINCT FROM union_id
     AND status IN ('ANNOUNCED','SCHEDULED','REGISTERING','LATE_REG','RUNNING');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: % live union tournament(s) not owned by the union', v_bad;
  END IF;

  SELECT count(*) INTO v_bad FROM tables
   WHERE union_id IS NOT NULL AND COALESCE(is_private,false) = false
     AND club_id IS DISTINCT FROM union_id
     AND COALESCE(is_deleted,false) = false AND status NOT IN ('closed','deleted');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: % live union table(s) not owned by the union', v_bad;
  END IF;
END $$;
