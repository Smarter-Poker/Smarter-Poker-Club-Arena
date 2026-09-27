-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819193442 "midway_union_top_of_food_chain_oversight"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 dbe5d4e7950de81d6c209356a7f7cc8a of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- MIDWAY UNION OVERSIGHT (2026-08-19)
-- LAW: the union sits at the top of the food chain. Union overseers (union
-- owner, union_admins, house-club owner/admins) can see every player and all
-- club data in every member club. Membership-driven: a club that joins the
-- union later is covered automatically, with zero extra setup.
-- ============================================================================

-- 1. Helpers ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_is_union_overseer(p_union_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_union_id IS NULL OR p_user_id IS NULL THEN RETURN false; END IF;
  RETURN EXISTS (SELECT 1 FROM unions u WHERE u.id = p_union_id AND u.owner_id = p_user_id)
      OR EXISTS (SELECT 1 FROM union_admins a WHERE a.union_id = p_union_id AND a.user_id = p_user_id)
      OR EXISTS (SELECT 1 FROM clubs c WHERE c.id = p_union_id
                    AND COALESCE(c.is_union, false) AND c.owner_id = p_user_id)
      OR EXISTS (SELECT 1 FROM club_members m
                  WHERE m.club_id = p_union_id AND m.user_id = p_user_id
                    AND m.role IN ('owner','admin')
                    AND m.status IN ('active','approved'));
END $function$;

CREATE OR REPLACE FUNCTION public.fn_union_oversees_club(p_club_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_union uuid;
BEGIN
  IF p_club_id IS NULL OR p_user_id IS NULL THEN RETURN false; END IF;
  SELECT uc.union_id INTO v_union FROM union_clubs uc WHERE uc.club_id = p_club_id LIMIT 1;
  IF v_union IS NULL THEN
    SELECT c.union_id INTO v_union FROM clubs c WHERE c.id = p_club_id;
  END IF;
  RETURN public.fn_is_union_overseer(v_union, p_user_id);
END $function$;

-- 2. Union overseers read every club-scoped table (additive SELECT policies) ---
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'club_members','club_wallets','club_wallet_transactions','club_daily_stats',
    'club_member_daily_stats','club_financial_summary','player_agent_assignments',
    'agents','sub_agents','chip_transactions','settlement_invoices',
    'settlement_periods','settlement_journal','credit_requests','agent_commissions',
    'rake_records','bbj_contributions','club_agents','commander_members'
  ] LOOP
    IF EXISTS (
         SELECT 1 FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = t
          AND c.relkind = 'r' AND c.relrowsecurity
       )
       AND EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = t AND column_name = 'club_id'
       )
    THEN
      EXECUTE format('DROP POLICY IF EXISTS union_overseer_read ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY union_overseer_read ON public.%I FOR SELECT TO authenticated
           USING (public.fn_union_oversees_club(club_id, (SELECT auth.uid())))', t);
    END IF;
  END LOOP;
END $$;

-- Seated players are visible to overseers via the table's union stamp.
DROP POLICY IF EXISTS union_overseer_read ON public.table_seats;
CREATE POLICY union_overseer_read ON public.table_seats
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.tables t
     WHERE t.id = table_seats.table_id
       AND public.fn_is_union_overseer(t.union_id, (SELECT auth.uid()))
  ));

-- 3. Union-wide player directory -------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_union_player_directory(p_union_id uuid)
 RETURNS TABLE(
   user_id uuid, username text, display_name text, avatar_url text,
   club_id uuid, club_name text, member_role text, member_status text,
   joined_at timestamptz, currently_seated boolean
 )
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.fn_is_union_overseer(p_union_id, auth.uid()) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  RETURN QUERY
  WITH union_scope AS (
    SELECT uc.club_id AS id FROM union_clubs uc WHERE uc.union_id = p_union_id
    UNION
    SELECT c.id FROM clubs c WHERE c.id = p_union_id AND COALESCE(c.is_union, false)
  )
  SELECT cm.user_id,
         pr.username,
         pr.display_name,
         pr.avatar_url,
         cm.club_id,
         c.name,
         cm.role,
         cm.status,
         cm.joined_at,
         EXISTS (
           SELECT 1 FROM table_seats ts
             JOIN tables t ON t.id = ts.table_id
            WHERE ts.user_id = cm.user_id AND ts.left_at IS NULL
              AND t.union_id = p_union_id
         )
    FROM club_members cm
    JOIN union_scope us ON us.id = cm.club_id
    JOIN clubs c ON c.id = cm.club_id
    LEFT JOIN profiles pr ON pr.id = cm.user_id
   ORDER BY c.name, pr.username NULLS LAST;
END $function$;

GRANT EXECUTE ON FUNCTION public.fn_union_player_directory(uuid) TO authenticated;

-- 4. Codify -----------------------------------------------------------------------
INSERT INTO public.platform_policies (key, value, description) VALUES
  ('union.oversight', 'union_sees_all',
   'LAW: the union is the top of the food chain. Union overseers (union owner, union_admins, house-club owner/admins) can see every player and all club data (members, wallets, transactions, stats, settlements, agents, rake, BBJ) in every member club. Membership-driven via fn_union_oversees_club — a newly joined club is covered automatically. Directory: fn_union_player_directory(union_id).')
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value, description = EXCLUDED.description, updated_at = now();

