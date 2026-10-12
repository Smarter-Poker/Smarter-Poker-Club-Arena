-- The core welcome-package schema deliberately commits before this
-- certification-only rewrite.  Live club creation takes
-- club_creation_requests then auth.users through its FK check, while reserved
-- account cleanup can take auth.users before clubs.  Combining both hot-table
-- families in one DDL transaction has no safe lock-order permutation.

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';

-- Club Create Certification owns disposable production fixtures, but the
-- long-standing retirement door deliberately refuses every club with a table.
-- A welcome-v1 fixture now has nine empty package tables by construction.  Do
-- not weaken that door: prepare only the exact reserved fixture, prove every
-- game row is one of its unused package rows, remove those rows and their
-- package metadata, then let the existing retirement function re-run all of
-- its protected-estate, member, custody and journal checks unchanged.
CREATE FUNCTION public.fn_ca_prepare_unused_welcome_certification_fixture(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_club public.clubs%ROWTYPE;
  v_owner_email text;
  v_cash uuid[] := '{}';
  v_tables uuid[] := '{}';
  v_schedules uuid[] := '{}';
  v_item_count integer := 0;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'service_role_only' USING ERRCODE='42501';
  END IF;

  SELECT * INTO v_club FROM public.clubs WHERE id=p_club_id FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.club_welcome_entitlements e WHERE e.club_id=p_club_id
  ) THEN
    RETURN jsonb_build_object('prepared',false,'reason','no_welcome_fixture');
  END IF;

  SELECT u.email INTO v_owner_email FROM auth.users u WHERE u.id=v_club.owner_id;
  IF p_club_id=ANY(ARRAY[
       'a0000000-0000-0000-0000-000000000001'::uuid,
       'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid,
       '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid,
       'fade0000-0000-0000-0000-000000000001'::uuid
     ])
     OR (v_club.name NOT LIKE 'Crest Cert %' AND v_club.name NOT LIKE 'Preset Crest Cert %')
     OR NOT (
       COALESCE(v_owner_email,'') LIKE 'club-create-cert-%@smarter-poker.invalid'
       OR COALESCE(v_owner_email,'') LIKE 'ca-customization-cert-postdeploy-%@example.invalid'
     )
     OR COALESCE(v_club.is_union,false)
     OR v_club.union_id IS NOT NULL
     OR EXISTS(SELECT 1 FROM public.union_clubs u WHERE u.club_id=p_club_id) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_FIXTURE_IDENTITY_REFUSED' USING ERRCODE='42501';
  END IF;

  IF (SELECT count(*) FROM public.club_members m WHERE m.club_id=p_club_id) <> 1
     OR EXISTS (
       SELECT 1 FROM public.club_members m
       WHERE m.club_id=p_club_id
         AND (m.user_id IS DISTINCT FROM v_club.owner_id
           OR COALESCE(m.chip_balance,0)<>0 OR COALESCE(m.promo_balance,0)<>0)
     )
     OR EXISTS(SELECT 1 FROM public.agents a WHERE a.club_id=p_club_id) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_FIXTURE_MEMBER_OR_AGENT_REFUSED' USING ERRCODE='55000';
  END IF;

  SELECT count(*),
         COALESCE(array_agg(entity_id ORDER BY entity_id) FILTER(WHERE entity_kind='cash_game'),'{}'),
         COALESCE(array_agg(initial_table_id ORDER BY initial_table_id) FILTER(WHERE entity_kind='cash_game'),'{}'),
         COALESCE(array_agg(entity_id ORDER BY entity_id) FILTER(WHERE entity_kind='tournament_schedule'),'{}')
    INTO v_item_count,v_cash,v_tables,v_schedules
    FROM public.club_welcome_package_items
   WHERE club_id=p_club_id AND retired_at IS NULL;

  IF v_item_count<>10 OR cardinality(v_cash)<>9 OR cardinality(v_tables)<>9
     OR cardinality(v_schedules)<>1
     OR NOT EXISTS(SELECT 1 FROM public.club_welcome_package_receipts r
                   WHERE r.club_id=p_club_id AND r.package_version='welcome-v1')
     OR (SELECT count(*) FROM public.club_welcome_package_funding f
         WHERE f.club_id=p_club_id AND f.destination IN('bbj_main','spin_reserve'))<>2
     OR EXISTS(SELECT 1 FROM public.club_welcome_reset_receipts r WHERE r.club_id=p_club_id)
     OR EXISTS(SELECT 1 FROM public.club_welcome_package_items i
               WHERE i.club_id=p_club_id AND i.retired_at IS NOT NULL) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_PACKAGE_SHAPE_REFUSED' USING ERRCODE='55000';
  END IF;

  IF EXISTS(SELECT 1 FROM public.cash_games g WHERE g.club_id=p_club_id AND NOT(g.id=ANY(v_cash)))
     OR EXISTS(SELECT 1 FROM public.tournament_schedules s
               WHERE s.club_id=p_club_id AND NOT(s.id=ANY(v_schedules)))
     OR EXISTS(SELECT 1 FROM public.tables t
               WHERE t.club_id=p_club_id AND NOT(t.id=ANY(v_tables)))
     OR EXISTS(SELECT 1 FROM public.tables t
               WHERE t.id=ANY(v_tables)
                 AND (t.club_id IS DISTINCT FROM p_club_id OR NOT(t.cluster_id=ANY(v_cash)))) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_HAS_NONPACKAGE_GAMES' USING ERRCODE='55000';
  END IF;

  IF EXISTS(SELECT 1 FROM public.table_seats s WHERE s.table_id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.table_sessions s WHERE s.table_id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.table_waitlist w WHERE w.table_id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.cash_game_waitlist w WHERE w.game_id=ANY(v_cash))
     OR EXISTS(SELECT 1 FROM public.cash_seat_moves m WHERE m.game_id=ANY(v_cash))
     OR EXISTS(SELECT 1 FROM public.cash_seat_change_requests r WHERE r.game_id=ANY(v_cash))
     OR EXISTS(SELECT 1 FROM public.hand_history h WHERE h.table_id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.tournaments t WHERE t.club_id=p_club_id OR t.schedule_id=ANY(v_schedules))
     OR EXISTS(SELECT 1 FROM public.tournament_schedule_spawns s WHERE s.schedule_id=ANY(v_schedules))
     OR EXISTS(SELECT 1 FROM public.managed_game_schedules s
               WHERE (s.game_kind='table' AND s.game_id=ANY(v_tables))) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_FIXTURE_HAS_ACTIVITY' USING ERRCODE='55000';
  END IF;

  PERFORM set_config('app.game_management_retention','on',true);
  PERFORM set_config('app.managed_game_lifecycle','on',true);
  DELETE FROM public.tables WHERE id=ANY(v_tables);
  DELETE FROM public.cash_games WHERE id=ANY(v_cash);
  DELETE FROM public.tournament_schedules WHERE id=ANY(v_schedules);
  DELETE FROM public.club_welcome_package_funding WHERE club_id=p_club_id;
  DELETE FROM public.club_welcome_package_items WHERE club_id=p_club_id;
  DELETE FROM public.club_welcome_reset_receipts WHERE club_id=p_club_id;
  DELETE FROM public.club_welcome_package_receipts WHERE club_id=p_club_id;
  DELETE FROM public.club_welcome_entitlements WHERE club_id=p_club_id;
  DELETE FROM public.club_owner_creation_history
   WHERE owner_id=v_club.owner_id AND first_club_id=p_club_id
     AND welcome_eligible AND provenance='prospective';

  IF EXISTS(SELECT 1 FROM public.tables t WHERE t.club_id=p_club_id)
     OR EXISTS(SELECT 1 FROM public.cash_games g WHERE g.club_id=p_club_id)
     OR EXISTS(SELECT 1 FROM public.tournament_schedules s WHERE s.club_id=p_club_id)
     OR EXISTS(SELECT 1 FROM public.club_welcome_entitlements e WHERE e.club_id=p_club_id) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_PREPARATION_INCOMPLETE' USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object('prepared',true,'club_id',p_club_id,
    'cash_games_removed',cardinality(v_cash),'tables_removed',cardinality(v_tables),
    'schedules_removed',cardinality(v_schedules));
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_prepare_unused_welcome_certification_fixture(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_prepare_unused_welcome_certification_fixture(uuid)
  TO service_role;

-- Keep the long-standing retirement function byte-for-byte unchanged.  The
-- certification caller uses this narrow coordinator so package preparation
-- and the existing protected retirement door still share one runtime
-- transaction, without re-CREATEing a function that spans auth and tournament
-- relations during installation.
CREATE FUNCTION public.fn_ca_retire_welcome_certification_club(
  p_club_id uuid,p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  PERFORM public.fn_ca_prepare_unused_welcome_certification_fixture(p_club_id);
  RETURN public.fn_ca_retire_certification_club(p_club_id,p_reason);
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_retire_welcome_certification_club(uuid,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_retire_welcome_certification_club(uuid,text)
  TO service_role;

COMMIT;
