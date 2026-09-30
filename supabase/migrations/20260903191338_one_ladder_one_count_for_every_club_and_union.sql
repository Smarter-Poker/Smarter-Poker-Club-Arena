-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260903191338; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260903191338   (the stamp IS the apply time, UTC: 2026-09-03 19:13:38)
--   name        one_ladder_one_count_for_every_club_and_union
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 15078 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260903191338 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     TRIGGER        trg_sync_club_member_count, trg_new_club_gets_the_ladder, trg_new_union_gets_the_ladder, trg_recompute_union_level_on_club_change
--     FUNCTION       public.fn_club_level_for_members, public.fn_club_level_min_members, public.fn_apply_club_ladder, public.fn_apply_union_ladder, public.fn_sync_club_member_count, public.recompute_club_levels, public.recompute_club_levels_silent, public.recompute_union_levels
--     TABLE          public.club_level_thresholds
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

SET LOCAL lock_timeout = '20s';

CREATE TABLE IF NOT EXISTS public.club_level_thresholds (
  level        smallint PRIMARY KEY,
  min_members  integer  NOT NULL,
  tier         text     NOT NULL,
  tier_label   text     NOT NULL
);

INSERT INTO public.club_level_thresholds (level, min_members, tier, tier_label) VALUES
  (1,0,'starter','Starter'),(2,5,'starter','Starter'),(3,10,'starter','Starter'),(4,15,'starter','Starter'),(5,20,'starter','Starter'),
  (6,25,'small','Small Club'),(7,30,'small','Small Club'),(8,35,'small','Small Club'),(9,40,'small','Small Club'),(10,45,'small','Small Club'),
  (11,50,'growing','Growing Club'),(12,60,'growing','Growing Club'),(13,70,'growing','Growing Club'),(14,80,'growing','Growing Club'),(15,90,'growing','Growing Club'),
  (16,100,'established','Established'),(17,110,'established','Established'),(18,125,'established','Established'),(19,140,'established','Established'),(20,160,'established','Established'),
  (21,180,'large','Large Club'),(22,200,'large','Large Club'),(23,230,'large','Large Club'),(24,270,'large','Large Club'),(25,310,'large','Large Club'),
  (26,360,'regional','Regional Operator'),(27,420,'regional','Regional Operator'),(28,490,'regional','Regional Operator'),(29,570,'regional','Regional Operator'),(30,660,'regional','Regional Operator'),
  (31,770,'major','Major Operator'),(32,900,'major','Major Operator'),(33,1050,'major','Major Operator'),(34,1200,'major','Major Operator'),(35,1400,'major','Major Operator'),
  (36,1650,'network','Network-Grade Club'),(37,1900,'network','Network-Grade Club'),(38,2200,'network','Network-Grade Club'),(39,2600,'network','Network-Grade Club'),(40,3000,'network','Network-Grade Club'),
  (41,3500,'enterprise','Enterprise Club'),(42,4100,'enterprise','Enterprise Club'),(43,4800,'enterprise','Enterprise Club'),(44,5600,'enterprise','Enterprise Club'),(45,6500,'enterprise','Enterprise Club'),
  (46,7600,'elite','Elite Network Operator'),(47,8900,'elite','Elite Network Operator'),(48,10500,'elite','Elite Network Operator'),(49,12500,'elite','Elite Network Operator'),(50,15000,'elite','Elite Network Operator'),
  (51,20000,'legendary','Legendary Network'),(52,30000,'legendary','Legendary Network'),(53,45000,'legendary','Legendary Network'),(54,70000,'legendary','Legendary Network'),(55,100000,'legendary','Legendary Network')
ON CONFLICT (level) DO UPDATE
  SET min_members = EXCLUDED.min_members, tier = EXCLUDED.tier, tier_label = EXCLUDED.tier_label;

GRANT SELECT ON public.club_level_thresholds TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_club_level_for_members(p_members integer)
RETURNS smallint
LANGUAGE sql STABLE
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT MAX(level) FROM public.club_level_thresholds
      WHERE min_members <= GREATEST(COALESCE(p_members, 0), 0)),
    1::smallint);
$function$;

CREATE OR REPLACE FUNCTION public.fn_club_level_min_members(p_level integer)
RETURNS integer
LANGUAGE sql STABLE
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT min_members FROM public.club_level_thresholds
      WHERE level = LEAST(GREATEST(COALESCE(p_level, 1), 1),
                          (SELECT MAX(level) FROM public.club_level_thresholds))),
    0);
$function$;

CREATE OR REPLACE FUNCTION public.fn_apply_club_ladder(p_club_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_members integer;
  v_level   smallint;
  v_admins integer; v_supers integer; v_agents integer;
  v_units numeric; v_units_up integer; v_hlevel integer; v_cursor integer;
BEGIN
  IF p_club_id IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.clubs WHERE id = p_club_id) THEN RETURN; END IF;

  SELECT public.fn_get_club_realtime_member_count(p_club_id) INTO v_members;
  v_level := public.fn_club_level_for_members(v_members::integer);

  SELECT count(*) FILTER (WHERE role IN ('admin','manager')),
         count(*) FILTER (WHERE role = 'super_agent'),
         count(*) FILTER (WHERE role IN ('agent','sub_agent'))
    INTO v_admins, v_supers, v_agents
    FROM public.club_members
   WHERE club_id = p_club_id
     AND (status IS NULL OR status IN ('active','approved'));
  v_units := (v_admins * 1.00) + (v_supers * 1.00) + (v_agents * 0.25);
  v_units_up := CEIL(v_units);
  v_hlevel := 1;
  FOR v_cursor IN 1..50 LOOP
    IF v_units_up >= ROUND(2 * POWER(1.086, v_cursor - 1)) THEN v_hlevel := v_cursor; ELSE EXIT; END IF;
  END LOOP;

  UPDATE public.clubs SET
    member_count               = v_members,
    level                      = v_level,
    player_level               = v_level,
    player_threshold_current   = public.fn_club_level_min_members(v_level),
    player_threshold_next      = public.fn_club_level_min_members(v_level + 1),
    admin_count                = v_admins,
    super_agent_count          = v_supers,
    agent_count                = v_agents,
    hierarchy_units            = v_units,
    hierarchy_units_rounded_up = v_units_up,
    hierarchy_level            = v_hlevel,
    hierarchy_threshold_current = ROUND(2 * POWER(1.086, v_hlevel - 1)),
    hierarchy_threshold_next    = ROUND(2 * POWER(1.086, LEAST(v_hlevel, 49))),
    updated_at                 = now()
  WHERE id = p_club_id
    AND (member_count IS DISTINCT FROM v_members
      OR level IS DISTINCT FROM v_level
      OR player_level IS DISTINCT FROM v_level
      OR admin_count IS DISTINCT FROM v_admins
      OR super_agent_count IS DISTINCT FROM v_supers
      OR agent_count IS DISTINCT FROM v_agents
      OR player_threshold_current IS DISTINCT FROM public.fn_club_level_min_members(v_level)
      OR player_threshold_next IS DISTINCT FROM public.fn_club_level_min_members(v_level + 1));
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_apply_union_ladder(p_union_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_members bigint;
  v_level   smallint;
  v_clubs integer; v_admins integer; v_supers integer; v_agents integer;
  v_units numeric; v_units_up integer; v_hlevel integer; v_cursor integer;
BEGIN
  IF p_union_id IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.unions WHERE id = p_union_id) THEN RETURN; END IF;

  SELECT member_count INTO v_members
    FROM public.fn_batch_union_realtime_member_counts(ARRAY[p_union_id]);
  v_members := COALESCE(v_members, 0);
  v_level := public.fn_club_level_for_members(v_members::integer);

  SELECT count(DISTINCT uc.club_id),
         COALESCE(sum(c.admin_count), 0),
         COALESCE(sum(c.super_agent_count), 0),
         COALESCE(sum(c.agent_count), 0)
    INTO v_clubs, v_admins, v_supers, v_agents
    FROM public.union_clubs uc
    JOIN public.clubs c ON c.id = uc.club_id
   WHERE uc.union_id = p_union_id;
  v_units := (v_admins * 1.00) + (v_supers * 1.00) + (v_agents * 0.25);
  v_units_up := CEIL(v_units);
  v_hlevel := 1;
  FOR v_cursor IN 1..50 LOOP
    IF v_units_up >= ROUND(2 * POWER(1.086, v_cursor - 1)) THEN v_hlevel := v_cursor; ELSE EXIT; END IF;
  END LOOP;

  UPDATE public.unions SET
    member_count               = v_members,
    total_players              = v_members,
    club_count                 = v_clubs,
    level                      = v_level,
    player_level               = v_level,
    player_threshold_current   = public.fn_club_level_min_members(v_level),
    player_threshold_next      = public.fn_club_level_min_members(v_level + 1),
    total_admins               = v_admins,
    total_super_agents         = v_supers,
    total_agents               = v_agents,
    hierarchy_units            = v_units,
    hierarchy_units_rounded_up = v_units_up,
    hierarchy_level            = v_hlevel,
    hierarchy_threshold_current = ROUND(2 * POWER(1.086, v_hlevel - 1)),
    hierarchy_threshold_next    = ROUND(2 * POWER(1.086, LEAST(v_hlevel, 49))),
    updated_at                 = now()
  WHERE id = p_union_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_apply_club_ladder(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_apply_union_ladder(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_apply_club_ladder(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_apply_union_ladder(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_sync_club_member_count()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_club uuid; v_union uuid;
BEGIN
  FOR v_club IN
    SELECT DISTINCT x FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.club_id END,
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.club_id END
    ]) AS t(x) WHERE x IS NOT NULL
  LOOP
    PERFORM public.fn_apply_club_ladder(v_club);
    FOR v_union IN
      SELECT uc.union_id FROM public.union_clubs uc WHERE uc.club_id = v_club
    LOOP
      PERFORM public.fn_apply_union_ladder(v_union);
    END LOOP;
  END LOOP;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE OR REPLACE FUNCTION public.recompute_club_levels(p_club_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_row public.clubs%ROWTYPE;
BEGIN
  IF current_setting('request.jwt.claims', true)::jsonb->>'role' = 'service_role'
     OR current_role IN ('postgres', 'service_role') THEN
    NULL;
  ELSIF NOT EXISTS (
      SELECT 1 FROM public.club_members
       WHERE club_id = p_club_id AND user_id = auth.uid()
         AND role IN ('owner','co_owner','admin','manager')
    ) AND NOT EXISTS (
      SELECT 1 FROM public.clubs WHERE id = p_club_id AND owner_id = auth.uid()
    ) THEN
    RETURN jsonb_build_object('success', false,
      'error', 'Unauthorized: Only club owners and admins can trigger level recalculation.');
  END IF;

  PERFORM public.fn_apply_club_ladder(p_club_id);
  SELECT * INTO v_row FROM public.clubs WHERE id = p_club_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Club not found.');
  END IF;
  RETURN jsonb_build_object('success', true, 'club_id', p_club_id,
    'level', v_row.level, 'member_count', v_row.member_count,
    'player_threshold_current', v_row.player_threshold_current,
    'player_threshold_next', v_row.player_threshold_next);
END;
$function$;

CREATE OR REPLACE FUNCTION public.recompute_club_levels_silent(p_club_id uuid DEFAULT NULL, p_force boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_id uuid;
BEGIN
  FOR v_id IN SELECT id FROM public.clubs WHERE p_club_id IS NULL OR id = p_club_id LOOP
    PERFORM public.fn_apply_club_ladder(v_id);
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.recompute_union_levels(p_union_id uuid DEFAULT NULL, p_force boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_id uuid;
BEGIN
  FOR v_id IN SELECT id FROM public.unions WHERE p_union_id IS NULL OR id = p_union_id LOOP
    PERFORM public.fn_apply_union_ladder(v_id);
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_auto_recompute_club_level()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  -- retired 2026-09-03: fn_sync_club_member_count is the only level writer.
  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_recompute_club_level_on_member_change()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  -- retired 2026-09-03: fn_sync_club_member_count is the only level writer.
  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE OR REPLACE TRIGGER trg_sync_club_member_count
  AFTER INSERT OR DELETE OR UPDATE OF status, club_id, role ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_sync_club_member_count();

CREATE OR REPLACE FUNCTION public.fn_new_club_gets_the_ladder()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.fn_apply_club_ladder(NEW.id);
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_new_union_gets_the_ladder()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.fn_apply_union_ladder(NEW.id);
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE TRIGGER trg_new_club_gets_the_ladder
  AFTER INSERT ON public.clubs
  FOR EACH ROW EXECUTE FUNCTION public.fn_new_club_gets_the_ladder();

CREATE OR REPLACE TRIGGER trg_new_union_gets_the_ladder
  AFTER INSERT ON public.unions
  FOR EACH ROW EXECUTE FUNCTION public.fn_new_union_gets_the_ladder();

CREATE OR REPLACE TRIGGER trg_recompute_union_level_on_club_change
  AFTER INSERT OR DELETE OR UPDATE OF union_id, club_id ON public.union_clubs
  FOR EACH ROW EXECUTE FUNCTION public.fn_recompute_union_level_on_club_change();

DO $backfill$
DECLARE v_id uuid;
BEGIN
  FOR v_id IN SELECT id FROM public.clubs LOOP
    PERFORM public.fn_apply_club_ladder(v_id);
  END LOOP;
  FOR v_id IN SELECT id FROM public.unions LOOP
    PERFORM public.fn_apply_union_ladder(v_id);
  END LOOP;
END;
$backfill$;

DO $assert$
DECLARE v_club_drift bigint; v_union_drift bigint; v_writers int;
BEGIN
  SELECT count(*) INTO v_club_drift
    FROM public.clubs c
    JOIN public.fn_batch_club_realtime_member_counts((SELECT array_agg(id) FROM public.clubs)) r
      ON r.club_id = c.id
   WHERE c.member_count IS DISTINCT FROM r.member_count
      OR c.level IS DISTINCT FROM public.fn_club_level_for_members(r.member_count::integer);

  SELECT count(*) INTO v_union_drift
    FROM public.unions u
    JOIN public.fn_batch_union_realtime_member_counts((SELECT array_agg(id) FROM public.unions)) r
      ON r.union_id = u.id
   WHERE u.member_count IS DISTINCT FROM r.member_count
      OR u.total_players IS DISTINCT FROM r.member_count
      OR u.level IS DISTINCT FROM public.fn_club_level_for_members(r.member_count::integer);

  SELECT count(*) INTO v_writers
    FROM pg_trigger t
    JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE t.tgrelid = 'public.club_members'::regclass
     AND NOT t.tgisinternal
     AND p.proname IN ('fn_sync_club_member_count',
                       'trg_auto_recompute_club_level',
                       'fn_recompute_club_level_on_member_change')
     AND position('retired 2026-09-03' IN p.prosrc) = 0;

  RAISE NOTICE 'club drift=% union drift=% level writers on club_members=%',
    v_club_drift, v_union_drift, v_writers;

  IF v_club_drift <> 0 THEN
    RAISE EXCEPTION '% clubs still disagree with the realtime count or the ladder', v_club_drift;
  END IF;
  IF v_union_drift <> 0 THEN
    RAISE EXCEPTION '% unions still disagree with the realtime count or the ladder', v_union_drift;
  END IF;
  IF v_writers <> 1 THEN
    RAISE EXCEPTION 'expected exactly one level writer on club_members, found %', v_writers;
  END IF;
  IF (SELECT count(*) FROM public.club_level_thresholds) <> 55 THEN
    RAISE EXCEPTION 'club_level_thresholds must have exactly 55 rungs';
  END IF;
END;
$assert$;
