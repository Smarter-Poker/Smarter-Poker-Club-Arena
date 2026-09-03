-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826202819; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- A CLUB ENTERS A UNION EMPTY, AND IS REFUSED UNTIL IT IS.
-- Dan 2026-08-26, binding: "ONCE A CLUB JOINS A UNION, THEY NEED TO START WITH
-- ZERO CHIPS, AND THE CHIPS THEY RECEIVE ARE FUNDED FROM THE UNION ONLY" and
-- "they must remove any and all chips balances from all players and agents
-- before moving to the union, then once accepted, reload all the balances with
-- chips from inside the union." The club settles first; the join is refused
-- until it is actually empty; nothing here wipes a player's balance for them.
-- The "funded by the union only" half already existed (fn_mint_club_chips and
-- fn_mint_chips_from_diamonds both refuse a club with clubs.union_id set, Dan
-- 2026-08-22). Forward only. Full rationale and ROLLBACK in
-- supabase/migrations/20260826_a_club_enters_a_union_empty.sql

CREATE OR REPLACE FUNCTION public.fn_club_union_join_blockers(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_treasury    numeric := 0;
  v_club_promo  numeric := 0;
  v_people      numeric := 0;
  v_people_n    int     := 0;
  v_horses      numeric := 0;
  v_horses_n    int     := 0;
  v_agents      numeric := 0;
  v_agents_n    int     := 0;
  v_felt        numeric := 0;
  v_felt_n      int     := 0;
  v_bbj         numeric := 0;
  v_total       numeric := 0;
BEGIN
  SELECT COALESCE(chip_treasury, 0), COALESCE(promo_balance, 0)
    INTO v_treasury, v_club_promo
    FROM clubs WHERE id = p_club_id;

  SELECT COALESCE(SUM(bal), 0), COUNT(*) FILTER (WHERE bal <> 0)
    INTO v_people, v_people_n
    FROM (
      SELECT COALESCE(cm.chip_balance,0) + COALESCE(cm.held_chips,0)
           + COALESCE(cm.locked_chips,0) + COALESCE(cm.promo_balance,0) AS bal
        FROM club_members cm
        LEFT JOIN profiles p ON p.id = cm.user_id
       WHERE cm.club_id = p_club_id
         AND NOT COALESCE(cm.is_bot, false)
         AND NOT COALESCE(p.is_horse, false)
    ) s;

  SELECT COALESCE(SUM(bal), 0), COUNT(*) FILTER (WHERE bal <> 0)
    INTO v_horses, v_horses_n
    FROM (
      SELECT COALESCE(cm.chip_balance,0) + COALESCE(cm.held_chips,0)
           + COALESCE(cm.locked_chips,0) + COALESCE(cm.promo_balance,0) AS bal
        FROM club_members cm
        LEFT JOIN profiles p ON p.id = cm.user_id
       WHERE cm.club_id = p_club_id
         AND (COALESCE(cm.is_bot, false) OR COALESCE(p.is_horse, false))
    ) s;

  SELECT COALESCE(SUM(bal), 0), COUNT(*) FILTER (WHERE bal <> 0)
    INTO v_agents, v_agents_n
    FROM (
      SELECT COALESCE(a.business_balance,0) + COALESCE(a.player_balance,0)
           + COALESCE(a.promo_balance,0) AS bal
        FROM agents a WHERE a.club_id = p_club_id
    ) s;

  SELECT COALESCE(SUM(ts.stack), 0), COUNT(*)
    INTO v_felt, v_felt_n
    FROM table_seats ts
    JOIN tables t ON t.id = ts.table_id
   WHERE t.club_id = p_club_id
     AND ts.left_at IS NULL
     AND COALESCE(ts.stack, 0) <> 0;

  SELECT COALESCE(SUM(COALESCE(main_balance,0) + COALESCE(backup_balance,0)
                    + COALESCE(promo_balance,0)), 0)
    INTO v_bbj
    FROM bbj_pools WHERE club_id = p_club_id AND union_id IS NULL;

  v_total := v_treasury + v_club_promo + v_people + v_horses + v_agents + v_felt + v_bbj;

  RETURN jsonb_build_object(
    'club_id',         p_club_id,
    'is_empty',        (v_total = 0),
    'total',           v_total,
    'club_treasury',   v_treasury,
    'club_promo',      v_club_promo,
    'member_wallets',  v_people,
    'member_count',    v_people_n,
    'horse_wallets',   v_horses,
    'horse_count',     v_horses_n,
    'agent_wallets',   v_agents,
    'agent_count',     v_agents_n,
    'chips_on_felt',   v_felt,
    'open_seats',      v_felt_n,
    'bbj_pool',        v_bbj
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_club_union_join_blockers(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_club_union_join_blockers(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_club_union_join_blockers(uuid) IS
  'Itemises every chip balance that must be cleared before a club may join a union. Read it to show an owner what is left; the BEFORE INSERT trigger on union_clubs enforces it.';

CREATE OR REPLACE FUNCTION public.fn_enforce_club_enters_union_empty()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  b jsonb;
BEGIN
  IF NEW.club_id = NEW.union_id THEN
    RETURN NEW;
  END IF;

  b := public.fn_club_union_join_blockers(NEW.club_id);

  IF (b->>'is_empty')::boolean THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = 'check_violation',
    MESSAGE = 'This club still holds chips and cannot join a union yet.',
    DETAIL  = format(
      'treasury %s, club promo %s, member wallets %s across %s members, horse bankrolls %s across %s horses, agent wallets %s across %s agents, %s on the felt in %s open seats, BBJ pool %s. Total %s.',
      b->>'club_treasury', b->>'club_promo',
      b->>'member_wallets', b->>'member_count',
      b->>'horse_wallets', b->>'horse_count',
      b->>'agent_wallets', b->>'agent_count',
      b->>'chips_on_felt', b->>'open_seats',
      b->>'bbj_pool', b->>'total'),
    HINT    = 'Cash your players and agents down to zero, close the tables and empty the treasury first. Once the club is in the union, the union funds it.';
END;
$function$;

DROP TRIGGER IF EXISTS trg_club_enters_a_union_empty ON public.union_clubs;
CREATE TRIGGER trg_club_enters_a_union_empty
  BEFORE INSERT ON public.union_clubs
  FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_club_enters_union_empty();

COMMENT ON FUNCTION public.fn_enforce_club_enters_union_empty() IS
  'Dan 2026-08-26, binding: a club joins a union at zero and is funded by the union from then on. Refuses the union_clubs INSERT while the club still holds chips anywhere. It never zeroes anything itself - the club settles its own players and agents first, on purpose.';

CREATE OR REPLACE FUNCTION public.fn_grant_first_club_bonus()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_owner boolean;
  v_claimed  boolean;
BEGIN
  IF NEW.role IS DISTINCT FROM 'owner' THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT EXISTS (
      SELECT 1 FROM clubs WHERE id = NEW.club_id AND owner_id = NEW.user_id
    ) INTO v_is_owner;
    IF NOT v_is_owner THEN
      RETURN NEW;
    END IF;

    -- Dan 2026-08-26: a self-run club may be founded with 100,000, up from
    -- 10,000. It mints its own chips anyway; this is only a problem once the
    -- club is in a union, which trg_club_enters_a_union_empty now prevents.
    INSERT INTO club_creation_bonuses (user_id, club_id, amount)
    VALUES (NEW.user_id, NEW.club_id, 100000)
    ON CONFLICT (user_id) DO NOTHING
    RETURNING true INTO v_claimed;

    IF v_claimed THEN
      UPDATE club_members
         SET chip_balance = COALESCE(chip_balance, 0) + 100000
       WHERE club_id = NEW.club_id AND user_id = NEW.user_id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_grant_first_club_bonus failed for user=% club=%: % (%)',
      NEW.user_id, NEW.club_id, SQLERRM, SQLSTATE;
  END;

  RETURN NEW;
END;
$function$;

DO $$
DECLARE
  v_blockers jsonb;
  v_src text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid='public.union_clubs'::regclass
                    AND tgname='trg_club_enters_a_union_empty') THEN
    RAISE EXCEPTION 'the union join guard was not created';
  END IF;

  v_blockers := public.fn_club_union_join_blockers('a41434bb-8d0c-400a-8f0d-e8b3d65afed4');
  IF (v_blockers->>'is_empty')::boolean THEN
    RAISE EXCEPTION 'blocker reports SHARK CLUB empty, which cannot be true: %', v_blockers;
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_grant_first_club_bonus';
  IF v_src NOT LIKE '%100000%' THEN
    RAISE EXCEPTION 'fn_grant_first_club_bonus does not carry the 100000 grant';
  END IF;
END $$;

