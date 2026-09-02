-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826204123; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- HORSES KEEP THEIR CHIPS WHEN A CLUB JOINS A UNION
--
-- Dan, 2026-08-26: "horses keep all there chips."
--
-- The first cut of fn_club_union_join_blockers counted horse bankrolls toward
-- the total, which meant a club running a fleet had to de-stock every horse
-- before it could join a union. Horses are the club's own stock, not a
-- person's money, and the rule Dan set is about players and agents settling up.
--
-- The horse figures are STILL REPORTED -- horse_wallets and horse_count remain
-- in the payload, so a union owner can see what is walking in with the club --
-- they simply no longer block the join or count toward `total`.
--
-- ROLLBACK: re-add v_horses to the v_total sum in this function.

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

  -- Reported, never blocking. Dan 2026-08-26: "horses keep all there chips."
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

  -- Chips on the felt still block: a hand in progress is a player's money.
  -- A horse's seat is excluded along with the rest of its bankroll.
  SELECT COALESCE(SUM(ts.stack), 0), COUNT(*)
    INTO v_felt, v_felt_n
    FROM table_seats ts
    JOIN tables t ON t.id = ts.table_id
    LEFT JOIN profiles p ON p.id = ts.user_id
   WHERE t.club_id = p_club_id
     AND ts.left_at IS NULL
     AND COALESCE(ts.stack, 0) <> 0
     AND NOT COALESCE(p.is_horse, false);

  SELECT COALESCE(SUM(COALESCE(main_balance,0) + COALESCE(backup_balance,0)
                    + COALESCE(promo_balance,0)), 0)
    INTO v_bbj
    FROM bbj_pools WHERE club_id = p_club_id AND union_id IS NULL;

  -- v_horses is deliberately absent from this sum.
  v_total := v_treasury + v_club_promo + v_people + v_agents + v_felt + v_bbj;

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
    'horses_block',    false,
    'agent_wallets',   v_agents,
    'agent_count',     v_agents_n,
    'chips_on_felt',   v_felt,
    'open_seats',      v_felt_n,
    'bbj_pool',        v_bbj
  );
END;
$function$;

COMMENT ON FUNCTION public.fn_club_union_join_blockers(uuid) IS
  'Itemises every chip balance that must be cleared before a club may join a union. Horse bankrolls are reported but never block - Dan 2026-08-26, horses keep all their chips. Read it to show an owner what is left; the BEFORE INSERT trigger on union_clubs enforces it.';

DO $$
DECLARE
  b jsonb;
BEGIN
  b := public.fn_club_union_join_blockers('a41434bb-8d0c-400a-8f0d-e8b3d65afed4');
  IF (b->>'horses_block')::boolean THEN
    RAISE EXCEPTION 'horses are still blocking the union join';
  END IF;
  IF (b->>'horse_wallets')::numeric = 0 THEN
    RAISE EXCEPTION 'horse bankrolls stopped being reported, they must stay visible: %', b;
  END IF;
END $$;

