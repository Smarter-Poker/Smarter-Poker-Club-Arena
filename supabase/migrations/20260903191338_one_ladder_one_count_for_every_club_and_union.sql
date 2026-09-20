-- 20260903191338_one_ladder_one_count_for_every_club_and_union.sql
-- Dan 2026-09-03: "HARDEN THIS FOR ALL CLUBS AND UNIONS GLOBALLY (AND NEW
-- ACCOUNTS AS WELL THAT HAVEN'T BEEN STARTED YET)."
--
-- WHAT WAS WRONG (measured in production before this migration)
--
--   * clubs.level was written by THREE triggers on club_members, two of them
--     running the retired 1-50 dual-axis ladder and one running the 1-55 member
--     ladder the app displays. Whichever fired last won. Result: Deep Stack
--     Society, 417 members, stored level 1 (should be 26); Shark 28 (29);
--     JAQK 26 (29); the Midway Union club row 21 (25).
--   * unions.level was written only by the 1-50 ladder (Midway 34, badge 33).
--   * unions.member_count / total_players summed the DENORMALISED
--     clubs.member_count, one hop away from truth, and nothing at all fired
--     when a union row was INSERTED, so a new union sat at 0 / level 1 until its
--     first club joined.
--   * The "Recalculate Level" button (recompute_club_levels) ran the 1-50
--     ladder too, so pressing it made the number WORSE.
--
-- WHAT THIS DOES
--
--   ONE ladder: public.club_level_thresholds (55 rungs) -> fn_club_level_for_members.
--   ONE count:  fn_get_club_realtime_member_count for a club,
--               fn_batch_union_realtime_member_counts for a union (sum of its clubs).
--   ONE writer per row: fn_apply_club_ladder(club) / fn_apply_union_ladder(union).
--
--   Every existing entry point is re-pointed at those two writers:
--     - fn_sync_club_member_count (club_members trigger)  -> club + its unions
--     - recompute_club_levels / recompute_club_levels_silent -> fn_apply_club_ladder
--     - recompute_union_levels                             -> fn_apply_union_ladder
--   The two redundant club_members triggers are retired (their functions
--   become no-ops; see LOCKING below for why not DROP). New triggers fire on
--   INSERT of clubs and unions so a brand-new account is correct from row one.
--   Every club and union is backfilled, and the migration asserts zero drift.
--
--   The ladder table and fn_club_level_for_members were only ever applied to
--   production by hand; they are declared here so a fresh database gets them.
--
--   Hierarchy statistics (admins / agents / hierarchy_units / hierarchy_level)
--   are still computed and stored as DATA, but they no longer decide `level`.
--   Deciding what a level REQUIRES is Dan's (CLAUDE.md 10.9); this migration
--   changes nothing about the ladder itself, it only makes every row obey the
--   one ladder the app already shows.
--
-- TIER 2/3 in one transaction (functions, triggers, data backfill).

BEGIN;

-- LOCKING (learned applying this: it deadlocked three times against live
-- seating traffic). DROP TRIGGER takes ACCESS EXCLUSIVE and blocks every
-- reader of the table; CREATE OR REPLACE TRIGGER takes only SHARE ROW
-- EXCLUSIVE, which lets reads through. So this migration never drops a
-- trigger: the two retired ones are turned into no-op functions (no table
-- lock at all), and every trigger it needs is CREATE OR REPLACE'd.
SET LOCAL lock_timeout = '20s';

-- ───────────────────────── the ladder ─────────────────────────

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

-- Minimum members for a level; the top rung is its own ceiling.
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

-- ───────────────────────── the two writers ─────────────────────────

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

  -- Hierarchy statistics are kept as data (same status basis as the count).
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

  -- The union's members are the sum of its clubs' members: the same number
  -- every union card shows, and the same basis as its active-player sum.
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

-- ───────────────────────── re-point every entry ─────────────────────────

-- club_members trigger: the club, then every union the club belongs to.
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

-- The "Recalculate Level" button. Same guard, one ladder.
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

-- Internal writers: the trigger chain and operators call these, browsers do
-- not. recompute_club_levels (the button) keeps its own owner/admin guard.
REVOKE ALL ON FUNCTION public.recompute_club_levels_silent(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recompute_union_levels(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_club_levels_silent(uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.recompute_union_levels(uuid, boolean) TO service_role;

-- Two of the three club_members level writers were the retired ladder. Their
-- trigger functions become no-ops (retiring them without a table lock); the
-- one writer that remains is trg_sync_club_member_count.
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

-- A brand-new club or union is correct from its first row.
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

-- A club joining or leaving a union re-sums that union (existing trigger
-- fn_recompute_union_level_on_club_change -> recompute_union_levels now lands
-- on fn_apply_union_ladder). Make sure it is attached.
CREATE OR REPLACE TRIGGER trg_recompute_union_level_on_club_change
  AFTER INSERT OR DELETE OR UPDATE OF union_id, club_id ON public.union_clubs
  FOR EACH ROW EXECUTE FUNCTION public.fn_recompute_union_level_on_club_change();

-- ───────────────────────── backfill everything ─────────────────────────

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

-- ───────────────────────── prove it ─────────────────────────

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

  -- Exactly one attached club_members trigger function still writes a level:
  -- the retired two must now be no-ops (their source carries the word).
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

COMMIT;
