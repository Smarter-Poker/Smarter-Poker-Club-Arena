-- 20261002065156_welcome_certification_retires_idle_schedule_spawns
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-02 06:51:56 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
-- Say what was wrong, what this changes, and what you measured. A
-- migration whose header is its own filename is the next agent's mystery.
-- A reserved Create Club certificate can outlive one execution when its final
-- cleanup is interrupted.  Its welcome-v1 daily schedule remains active and
-- may legitimately materialize future tournament rows before the stale-account
-- recovery runs.  The certification preparer previously treated every such
-- schedule-derived tournament table as an unrelated game and permanently
-- wedged every later brand-new-player certificate.
--
-- Remove only the unused tournament graph derived from the fixture's one exact
-- package schedule, then pass the still-exact cash/package graph through the
-- existing hardened preparer.  This helper refuses protected estates, any
-- non-reserved owner, union membership, extra tournament lineage, players,
-- seats, sessions, waits, leases, add-ons, cards, snapshots, cashouts,
-- insurance, hands, a started/running tournament, or an executing command.
-- All rows are locked parent-before-child and the complete cleanup remains in
-- the retirement wrapper's single transaction.
--
-- @live-proof: (SELECT p.prosrc LIKE '%WELCOME_CERTIFICATION_SCHEDULE_LINEAGE_REFUSED%' AND p.prosrc LIKE '%table_hole_cards%' FROM pg_proc p WHERE p.oid='public.fn_ca_prepare_unused_welcome_certification_schedule_spawns(uuid)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';

CREATE OR REPLACE FUNCTION public.fn_ca_prepare_unused_welcome_certification_schedule_spawns(
  p_club_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_club public.clubs%ROWTYPE;
  v_owner_email text;
  v_cash uuid[] := '{}';
  v_schedules uuid[] := '{}';
  v_tournaments uuid[] := '{}';
  v_tables uuid[] := '{}';
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'service_role_only' USING ERRCODE='42501';
  END IF;

  SELECT * INTO v_club FROM public.clubs WHERE id=p_club_id;
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

  PERFORM 1 FROM public.club_welcome_package_items
   WHERE club_id=p_club_id ORDER BY slot_key FOR UPDATE;
  SELECT COALESCE(array_agg(i.entity_id ORDER BY i.entity_id),'{}')
    INTO v_schedules
    FROM public.club_welcome_package_items i
   WHERE i.club_id=p_club_id
     AND i.entity_kind='tournament_schedule'
     AND i.retired_at IS NULL;
  IF cardinality(v_schedules)<>1
     OR (SELECT count(*) FROM public.tournament_schedules s
          WHERE s.club_id=p_club_id AND s.id=ANY(v_schedules))<>1
     OR EXISTS(SELECT 1 FROM public.tournament_schedules s
                WHERE s.club_id=p_club_id AND NOT(s.id=ANY(v_schedules))) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_SCHEDULE_LINEAGE_REFUSED' USING ERRCODE='55000';
  END IF;

  PERFORM 1 FROM public.tournament_schedules
   WHERE id=ANY(v_schedules) ORDER BY id FOR UPDATE;
  PERFORM set_config('app.game_management_retention','on',true);
  UPDATE public.tournament_schedules SET active=false,updated_at=now()
   WHERE id=ANY(v_schedules);

  SELECT COALESCE(array_agg(i.entity_id ORDER BY i.entity_id),'{}')
    INTO v_cash
    FROM public.club_welcome_package_items i
   WHERE i.club_id=p_club_id
     AND i.entity_kind='cash_game'
     AND i.retired_at IS NULL;
  IF cardinality(v_cash)<>9 THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_CASH_LINEAGE_REFUSED' USING ERRCODE='55000';
  END IF;
  PERFORM 1 FROM public.cash_games WHERE id=ANY(v_cash) ORDER BY id FOR UPDATE;

  SELECT COALESCE(array_agg(q.id ORDER BY q.id),'{}') INTO v_tournaments
    FROM (
      SELECT t.id FROM public.tournaments t WHERE t.schedule_id=ANY(v_schedules)
      UNION
      SELECT s.tournament_id FROM public.tournament_schedule_spawns s
       WHERE s.schedule_id=ANY(v_schedules) AND s.tournament_id IS NOT NULL
    ) q;
  PERFORM 1 FROM public.tournaments WHERE id=ANY(v_tournaments) ORDER BY id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.tournaments t
             WHERE t.club_id=p_club_id AND NOT(t.id=ANY(v_tournaments)))
     OR EXISTS(SELECT 1 FROM public.tournaments t
                WHERE t.id=ANY(v_tournaments)
                  AND (t.club_id IS DISTINCT FROM p_club_id
                    OR t.union_id IS NOT NULL
                    OR NOT(t.schedule_id=ANY(v_schedules)) AND NOT EXISTS(
                      SELECT 1 FROM public.tournament_schedule_spawns s
                       WHERE s.schedule_id=ANY(v_schedules) AND s.tournament_id=t.id
                    )))
     OR EXISTS(SELECT 1 FROM public.tournament_schedule_spawns s
                WHERE s.schedule_id=ANY(v_schedules)
                  AND (s.tournament_id IS NULL OR NOT(s.tournament_id=ANY(v_tournaments)))) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_TOURNAMENT_LINEAGE_REFUSED' USING ERRCODE='55000';
  END IF;

  SELECT COALESCE(array_agg(t.id ORDER BY t.id),'{}') INTO v_tables
    FROM public.tables t WHERE t.tournament_id=ANY(v_tournaments);
  PERFORM 1 FROM public.tables WHERE id=ANY(v_tables) ORDER BY id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.tables t
             WHERE t.club_id=p_club_id AND t.tournament_id IS NOT NULL
               AND NOT(t.id=ANY(v_tables)))
     OR EXISTS(SELECT 1 FROM public.tables t
                WHERE t.id=ANY(v_tables)
                  AND (t.club_id IS DISTINCT FROM p_club_id
                    OR t.union_id IS NOT NULL OR t.cluster_id IS NOT NULL
                    OR t.game_type IS DISTINCT FROM 'tournament')) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_TOURNAMENT_TABLE_LINEAGE_REFUSED' USING ERRCODE='55000';
  END IF;

  IF EXISTS(SELECT 1 FROM public.tournaments t WHERE t.id=ANY(v_tournaments)
             AND (t.started_at IS NOT NULL
               OR upper(COALESCE(t.status::text,'')) IN('RUNNING','BREAK','COMPLETING','COMPLETED')))
     OR EXISTS(SELECT 1 FROM public.tournament_players p WHERE p.tournament_id=ANY(v_tournaments))
     OR EXISTS(SELECT 1 FROM public.tournament_escrow e WHERE e.tournament_id=ANY(v_tournaments))
     OR EXISTS(SELECT 1 FROM public.tournament_payouts p WHERE p.tournament_id=ANY(v_tournaments))
     OR EXISTS(SELECT 1 FROM public.tournament_obligations o WHERE o.tournament_id=ANY(v_tournaments))
     OR EXISTS(SELECT 1 FROM public.tournament_registrations r
                WHERE r.tournament_id=ANY(v_tournaments))
     OR EXISTS(SELECT 1 FROM public.tournament_registration_approvals a
                WHERE a.tournament_id=ANY(v_tournaments))
     OR EXISTS(SELECT 1 FROM public.tournament_waitlists w WHERE w.tournament_id=ANY(v_tournaments))
     OR EXISTS(SELECT 1 FROM public.tournament_tickets k
                WHERE k.club_id=p_club_id
                   OR k.source_tournament_id=ANY(v_tournaments)
                   OR k.source_satellite_id=ANY(v_tournaments))
     OR EXISTS(SELECT 1 FROM public.tables t WHERE t.id=ANY(v_tables)
                AND COALESCE(t.current_players,0)<>0)
     OR EXISTS(SELECT 1 FROM public.table_seats s WHERE s.table_id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.table_sessions s WHERE s.table_id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.engine_table_leases l WHERE l.table_id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.engine_tournament_leases l
                WHERE l.tournament_id=ANY(v_tournaments))
     OR EXISTS(SELECT 1 FROM public.table_waitlist w WHERE w.table_id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.table_pending_addons a WHERE a.table_id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.table_hole_cards c WHERE c.table_id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.hand_state_snapshots s WHERE s.table_id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.table_cashout_history c WHERE c.table_id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.insurance_transactions i WHERE i.table_id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.hand_history h
                WHERE h.tournament_id=ANY(v_tournaments) OR h.table_id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.managed_game_schedules s
                WHERE s.status='executing' AND
                  ((s.game_kind='tournament' AND s.game_id=ANY(v_tournaments))
                    OR (s.game_kind='table' AND s.game_id=ANY(v_tables)))) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_SCHEDULE_FIXTURE_HAS_ACTIVITY' USING ERRCODE='55000';
  END IF;

  UPDATE public.managed_game_schedules SET status='cancelled',completed_at=now(),
         result=jsonb_build_object('ok',false,'reason','reserved_certification_retirement')
   WHERE status='scheduled' AND
     ((game_kind='tournament' AND game_id=ANY(v_tournaments))
       OR (game_kind='table' AND game_id=ANY(v_tables)));
  DELETE FROM public.tournament_schedule_spawns WHERE schedule_id=ANY(v_schedules);
  DELETE FROM public.tables WHERE id=ANY(v_tables);
  DELETE FROM public.tournaments WHERE id=ANY(v_tournaments);

  IF EXISTS(SELECT 1 FROM public.tournaments t
             WHERE t.club_id=p_club_id OR t.schedule_id=ANY(v_schedules))
     OR EXISTS(SELECT 1 FROM public.tournament_schedule_spawns s
                WHERE s.schedule_id=ANY(v_schedules))
     OR EXISTS(SELECT 1 FROM public.tables t WHERE t.tournament_id=ANY(v_tournaments)) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_SCHEDULE_PREPARATION_INCOMPLETE' USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object('prepared',true,'club_id',p_club_id,
    'tournaments_removed',cardinality(v_tournaments),
    'tables_removed',cardinality(v_tables));
END
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_prepare_unused_welcome_certification_schedule_spawns(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_prepare_unused_welcome_certification_schedule_spawns(uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_retire_welcome_certification_club(
  p_club_id uuid,p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_schedule jsonb;
  v_prepared jsonb;
  v_retired jsonb;
  v_child numeric := 0;
BEGIN
  v_schedule:=public.fn_ca_prepare_unused_welcome_certification_schedule_spawns(p_club_id);
  v_prepared:=public.fn_ca_prepare_unused_welcome_certification_fixture(p_club_id);
  v_child:=COALESCE((v_prepared->>'child_chips_retired')::numeric,0);
  v_retired:=public.fn_ca_retire_certification_club(p_club_id,p_reason);
  IF COALESCE((v_prepared->>'prepared')::boolean,false)
     AND NOT COALESCE((v_retired->>'success')::boolean,false) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_RETIREMENT_REFUSED: %',
      COALESCE(v_retired->>'error','unknown') USING ERRCODE='55000';
  END IF;
  IF COALESCE((v_retired->>'success')::boolean,false)
     AND NOT COALESCE((v_retired->>'already_gone')::boolean,false) THEN
    v_retired:=jsonb_set(v_retired,'{chips_retired}',
      to_jsonb(round(COALESCE((v_retired->>'chips_retired')::numeric,0)+v_child,2)),true);
    v_retired:=v_retired||jsonb_build_object('child_chips_retired',v_child,
      'schedule_tournaments_removed',COALESCE((v_schedule->>'tournaments_removed')::integer,0),
      'schedule_tables_removed',COALESCE((v_schedule->>'tables_removed')::integer,0));
  END IF;
  RETURN v_retired;
END
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_retire_welcome_certification_club(uuid,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_retire_welcome_certification_club(uuid,text)
  TO service_role;

DO $assert$
DECLARE v_body text;
BEGIN
  SELECT p.prosrc INTO v_body FROM pg_proc p
   WHERE p.oid='public.fn_ca_prepare_unused_welcome_certification_schedule_spawns(uuid)'::regprocedure;
  IF v_body NOT LIKE '%WELCOME_CERTIFICATION_SCHEDULE_LINEAGE_REFUSED%'
     OR v_body NOT LIKE '%table_hole_cards%'
     OR v_body NOT LIKE '%hand_state_snapshots%'
     OR v_body NOT LIKE '%table_cashout_history%'
     OR v_body NOT LIKE '%insurance_transactions%' THEN
    RAISE EXCEPTION 'ASSERT FAILED: schedule-derived certification cleanup lacks its lineage or activity guards';
  END IF;
END
$assert$;

COMMIT;
