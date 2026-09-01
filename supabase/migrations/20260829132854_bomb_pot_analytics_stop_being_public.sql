-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829132854; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- 2026-08-29: the bomb-pot analytics were readable by anon and useless to the
-- club owner they were built for. Full rationale in
-- supabase/migrations/20260829_bomb_pot_analytics_stop_being_public.sql
ALTER VIEW public.v_bomb_pot_daily SET (security_invoker = true);
ALTER VIEW public.v_bomb_pot_vs_normal SET (security_invoker = true);
ALTER VIEW public.v_bomb_pot_outcomes SET (security_invoker = true);

REVOKE ALL ON public.v_bomb_pot_daily FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.v_bomb_pot_vs_normal FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.v_bomb_pot_outcomes FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.v_bomb_pot_daily TO service_role;
GRANT SELECT ON public.v_bomb_pot_vs_normal TO service_role;
GRANT SELECT ON public.v_bomb_pot_outcomes TO service_role;

DROP POLICY IF EXISTS bomb_pot_award_units_read ON public.bomb_pot_award_units;
CREATE POLICY bomb_pot_award_units_read ON public.bomb_pot_award_units
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM public.tables t
      JOIN public.club_members cm ON cm.club_id = t.club_id
      WHERE t.id = bomb_pot_award_units.table_id
        AND cm.user_id = auth.uid()
    )
  );

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.bomb_pot_award_units
  FROM PUBLIC, anon, authenticated;
REVOKE SELECT ON public.bomb_pot_award_units FROM anon;
REVOKE ALL ON public.bomb_pot_manual_requests FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_club_bomb_pot_report(
  p_club_id uuid,
  p_days integer DEFAULT 30
)
RETURNS TABLE (
  table_id            uuid,
  table_name          text,
  trigger_reason      text,
  board_count         integer,
  variant             text,
  hands               bigint,
  avg_players         numeric,
  avg_pot             numeric,
  total_pot           numeric,
  total_rake          numeric,
  total_antes         numeric,
  scoops              bigint,
  splits              bigint,
  unrecorded_hands    bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_authorized boolean := false;
  v_days integer := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT
    EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = p_club_id AND c.owner_id = v_uid)
    OR EXISTS (
      SELECT 1 FROM public.club_members cm
      WHERE cm.club_id = p_club_id AND cm.user_id = v_uid
        AND lower(cm.role) IN ('owner', 'co_owner', 'admin')
    )
  INTO v_authorized;

  IF NOT v_authorized THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH bomb_hands AS (
    SELECT
      h.id,
      h.table_id,
      t.name AS table_name,
      h.bomb_pot ->> 'trigger_reason'          AS trigger_reason,
      (h.bomb_pot ->> 'board_count')::int      AS board_count,
      h.bomb_pot ->> 'variant'                 AS variant,
      COALESCE((h.bomb_pot ->> 'ante_amount')::numeric, 0) AS ante_amount,
      COALESCE(h.pot_size, 0)                  AS pot_size,
      COALESCE(h.rake_amount, 0)               AS rake_amount,
      COALESCE(jsonb_array_length(h.players), 0) AS seats
    FROM public.hand_history h
    JOIN public.tables t ON t.id = h.table_id
    WHERE t.club_id = p_club_id
      AND h.bomb_pot IS NOT NULL
      AND h.created_at > now() - make_interval(days => v_days)
  ),
  per_hand_units AS (
    SELECT a.hand_history_id,
           count(DISTINCT a.user_id) AS distinct_winners,
           count(*)                  AS units
    FROM public.bomb_pot_award_units a
    JOIN bomb_hands b ON b.id = a.hand_history_id
    GROUP BY a.hand_history_id
  )
  SELECT
    b.table_id,
    b.table_name,
    b.trigger_reason,
    b.board_count,
    b.variant,
    count(*)::bigint,
    round(avg(b.seats), 2),
    round(avg(b.pot_size), 2),
    round(sum(b.pot_size), 2),
    round(sum(b.rake_amount), 2),
    round(sum(b.ante_amount * b.seats), 2),
    count(*) FILTER (WHERE u.distinct_winners = 1)::bigint,
    count(*) FILTER (WHERE u.distinct_winners > 1)::bigint,
    count(*) FILTER (WHERE u.hand_history_id IS NULL)::bigint
  FROM bomb_hands b
  LEFT JOIN per_hand_units u ON u.hand_history_id = b.id
  GROUP BY b.table_id, b.table_name, b.trigger_reason, b.board_count, b.variant
  ORDER BY 6 DESC;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_club_bomb_pot_report(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_bomb_pot_report(uuid, integer)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_club_bomb_pot_report(uuid, integer) IS
  'Bomb-pot performance for ONE club the caller owns or administers: per table, per trigger mode, per board count.';

DO $chk$
DECLARE
  v_open int;
BEGIN
  SELECT count(*) INTO v_open
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name IN ('v_bomb_pot_daily', 'v_bomb_pot_vs_normal', 'v_bomb_pot_outcomes',
                       'bomb_pot_manual_requests')
    AND grantee IN ('anon', 'authenticated', 'PUBLIC');
  IF v_open > 0 THEN
    RAISE EXCEPTION 'assertion failed: % anon/authenticated grant(s) still on the bomb analytics', v_open;
  END IF;

  SELECT count(*) INTO v_open
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND table_name = 'bomb_pot_award_units'
    AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  IF v_open > 0 THEN
    RAISE EXCEPTION 'assertion failed: % write grant(s) still on bomb_pot_award_units', v_open;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('v_bomb_pot_daily', 'v_bomb_pot_vs_normal', 'v_bomb_pot_outcomes')
      AND NOT COALESCE(array_to_string(c.reloptions, ',') LIKE '%security_invoker=true%', false)
  ) THEN
    RAISE EXCEPTION 'assertion failed: a v_bomb_pot_* view is still SECURITY DEFINER';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'fn_club_bomb_pot_report'
  ) THEN
    RAISE EXCEPTION 'assertion failed: fn_club_bomb_pot_report missing';
  END IF;
END $chk$;
