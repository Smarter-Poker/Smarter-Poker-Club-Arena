-- 20261002115605_welcome_certification_may_delete_only_its_unused_board_tables
--
-- The reserved Create Club certificate now reaches the exact idle welcome
-- board cleanup, but production's irreversible tournament-table trigger
-- correctly rejects its DELETE.  Those twelve never-started tables are
-- certificate fixtures, not played event evidence, yet weakening the trigger
-- for service_role or for certificate-looking rows would create a permanent
-- deletion door that callers could imitate.
--
-- This migration keeps the global default denial and introduces one private,
-- transaction-bound, single-use permit.  The existing schedule and welcome-
-- board cleanup helpers may issue exact table/tournament/club permits only
-- after their maintained identity, package, age, shape, activity, row-lock,
-- and, for the board, dynamic-FK, seed, lease, provenance, and custody proofs
-- have all passed.  The durability trigger atomically
-- consumes the matching permit for the current transaction; absent that exact
-- row it raises the original error unchanged.  A later failure rolls the
-- permit and all earlier cleanup back with the transaction.  No application
-- role can read, create, reuse, or delete permits, and ordinary tournament
-- tables remain durable.

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';

DO $preimage$
DECLARE
  v_owner text;
  v_security_definer boolean;
  v_config text[];
  v_definition_md5 text;
  v_trigger_definition text;
  v_trigger_enabled "char";
BEGIN
  SELECT r.rolname,p.prosecdef,p.proconfig,md5(pg_get_functiondef(p.oid))
    INTO v_owner,v_security_definer,v_config,v_definition_md5
    FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
   WHERE p.oid='public.fn_tournament_table_terminal_close_is_irreversible()'::regprocedure;
  SELECT pg_get_triggerdef(t.oid,true),t.tgenabled
    INTO v_trigger_definition,v_trigger_enabled
    FROM pg_trigger t
   WHERE t.tgrelid='public.tables'::regclass
     AND t.tgname='tournament_table_terminal_close_is_irreversible'
     AND NOT t.tgisinternal;
  IF v_owner IS DISTINCT FROM 'postgres'
     OR v_security_definer IS DISTINCT FROM true
     OR v_config IS DISTINCT FROM ARRAY['search_path=public']::text[]
     OR v_definition_md5 IS DISTINCT FROM '7e67d3e09e9eadfc27e230f9b81c16b2'
     OR v_trigger_enabled IS DISTINCT FROM 'O'
     OR v_trigger_definition NOT LIKE
       'CREATE TRIGGER tournament_table_terminal_close_is_irreversible BEFORE INSERT OR DELETE OR UPDATE OF % ON %tables FOR EACH ROW EXECUTE FUNCTION fn_tournament_table_terminal_close_is_irreversible()'
     OR v_trigger_definition NOT LIKE '%id%'
     OR v_trigger_definition NOT LIKE '%tournament_id%'
     OR v_trigger_definition NOT LIKE '%status%'
     OR v_trigger_definition NOT LIKE '%current_players%'
     OR v_trigger_definition NOT LIKE '%lifecycle%'
     OR v_trigger_definition NOT LIKE '%terminal_closed_at%'
     OR has_function_privilege('anon',
          'public.fn_tournament_table_terminal_close_is_irreversible()','EXECUTE')
     OR has_function_privilege('authenticated',
          'public.fn_tournament_table_terminal_close_is_irreversible()','EXECUTE')
     OR has_function_privilege('service_role',
          'public.fn_tournament_table_terminal_close_is_irreversible()','EXECUTE') THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_DURABILITY_GUARD_PREIMAGE_REFUSED'
      USING ERRCODE='55000';
  END IF;
END
$preimage$;

CREATE TABLE smarter_private.ca_welcome_certification_table_delete_permits(
  transaction_id xid8 NOT NULL,
  table_id uuid NOT NULL,
  tournament_id uuid NOT NULL,
  club_id uuid NOT NULL,
  PRIMARY KEY(transaction_id,table_id)
);

ALTER TABLE smarter_private.ca_welcome_certification_table_delete_permits
  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE smarter_private.ca_welcome_certification_table_delete_permits
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_tournament_table_terminal_close_is_irreversible()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $terminal_table_guard$
DECLARE
  v_new_status text;
  v_ended_at timestamptz;
  v_permit_consumed boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Tournament tables remain durable by default.  The only exception is an
    -- exact one-shot permit created after the reserved certification helper's
    -- complete no-activity proof in this same transaction.
    IF OLD.tournament_id IS NOT NULL THEN
      DELETE FROM smarter_private.ca_welcome_certification_table_delete_permits p
       WHERE p.transaction_id=pg_current_xact_id()
         AND p.table_id=OLD.id
         AND p.tournament_id=OLD.tournament_id
         AND p.club_id=OLD.club_id
       RETURNING true INTO v_permit_consumed;
      IF NOT COALESCE(v_permit_consumed,false) THEN
        RAISE EXCEPTION 'tournament table % is durable and cannot be deleted',OLD.id
          USING ERRCODE = '55000';
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.terminal_closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'new table % cannot supply a terminal marker',NEW.id
        USING ERRCODE = '55000';
    END IF;
    IF NEW.tournament_id IS NOT NULL THEN
      SELECT upper(COALESCE(t.status::text,'')) INTO v_new_status
        FROM public.tournaments t
       WHERE t.id = NEW.tournament_id
       FOR SHARE;
      IF v_new_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
        RAISE EXCEPTION 'cannot add table % to terminal tournament %',
          NEW.id,NEW.tournament_id USING ERRCODE = '55000';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'table identity % is immutable',OLD.id
      USING ERRCODE = '55000';
  END IF;

  IF NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
     AND (NEW.tournament_id IS NOT NULL OR OLD.tournament_id IS NOT NULL) THEN
    RAISE EXCEPTION 'table % tournament association is immutable',OLD.id
      USING ERRCODE = '55000';
  END IF;

  IF OLD.terminal_closed_at IS NOT NULL THEN
    IF NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
       OR NEW.terminal_closed_at IS DISTINCT FROM OLD.terminal_closed_at
       OR lower(COALESCE(NEW.status::text,'')) <> 'closed'
       OR lower(COALESCE(NEW.lifecycle,'')) <> 'closed'
       OR NEW.current_players IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'terminal tournament table % cannot reopen or move',OLD.id
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.tournament_id IS NOT NULL THEN
    SELECT upper(COALESCE(t.status::text,'')),t.ended_at
      INTO v_new_status,v_ended_at
      FROM public.tournaments t WHERE t.id = NEW.tournament_id;
    IF v_new_status IN ('COMPLETED','CANCELLED','CANCELED') THEN
      IF NEW.current_players IS DISTINCT FROM 0 THEN
        RAISE EXCEPTION 'table % cannot reopen terminal tournament %',
          NEW.id,NEW.tournament_id USING ERRCODE = '55000';
      END IF;
      NEW.status := 'closed';
      NEW.lifecycle := 'closed';
      NEW.terminal_closed_at := COALESCE(v_ended_at,transaction_timestamp());
    ELSIF NEW.terminal_closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'live tournament table % cannot supply a terminal marker',NEW.id
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.terminal_closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'unscoped table % cannot supply a terminal marker',NEW.id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$terminal_table_guard$;

REVOKE ALL ON FUNCTION public.fn_tournament_table_terminal_close_is_irreversible()
  FROM PUBLIC,anon,authenticated,service_role;

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
  v_changed integer := 0;
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
  PERFORM 1 FROM public.tournament_schedule_spawns
   WHERE schedule_id=ANY(v_schedules) ORDER BY id FOR UPDATE;
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
                  AND ((s.tournament_id IS NULL
                        AND s.created_at > transaction_timestamp() - interval '5 minutes')
                    OR (s.tournament_id IS NOT NULL
                        AND NOT(s.tournament_id=ANY(v_tournaments))))) THEN
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

  INSERT INTO smarter_private.ca_welcome_certification_table_delete_permits(
    transaction_id,table_id,tournament_id,club_id
  )
  SELECT pg_current_xact_id(),t.id,t.tournament_id,t.club_id
    FROM public.tables t
   WHERE t.id=ANY(v_tables)
   ORDER BY t.id;
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  IF v_changed<>cardinality(v_tables) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_SCHEDULE_DELETE_PERMIT_REFUSED' USING ERRCODE='55000';
  END IF;

  DELETE FROM public.tournament_schedule_spawns WHERE schedule_id=ANY(v_schedules);
  DELETE FROM public.tables WHERE id=ANY(v_tables);
  IF EXISTS(
    SELECT 1 FROM smarter_private.ca_welcome_certification_table_delete_permits p
     WHERE p.transaction_id=pg_current_xact_id()
       AND p.table_id=ANY(v_tables)
  ) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_SCHEDULE_DELETE_PERMIT_NOT_CONSUMED'
      USING ERRCODE='55000';
  END IF;
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

CREATE OR REPLACE FUNCTION public.fn_ca_prepare_unused_welcome_certification_board_games(
  p_club_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_club public.clubs%ROWTYPE;
  v_owner_email text;
  v_schedules uuid[] := '{}';
  v_schedule_tournaments uuid[] := '{}';
  v_board_tournaments uuid[] := '{}';
  v_board_tables uuid[] := '{}';
  v_expected_count integer := 0;
  v_pool_count integer := 0;
  v_changed integer := 0;
  v_fk record;
  v_fk_has_rows boolean := false;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND session_user NOT IN ('postgres', 'supabase_admin') THEN
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

  PERFORM pg_advisory_xact_lock(530090,1);
  PERFORM 1 FROM public.club_welcome_package_items
   WHERE club_id=p_club_id ORDER BY slot_key FOR UPDATE;
  IF (SELECT count(*) FROM public.club_welcome_package_items i
       WHERE i.club_id=p_club_id AND i.retired_at IS NULL)<>10
     OR (SELECT count(*) FROM public.club_welcome_package_items i
          WHERE i.club_id=p_club_id AND i.entity_kind='cash_game'
            AND i.retired_at IS NULL)<>9
     OR (SELECT count(*) FROM public.club_welcome_package_items i
          WHERE i.club_id=p_club_id AND i.entity_kind='tournament_schedule'
            AND i.retired_at IS NULL)<>1 THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_BOARD_PACKAGE_LINEAGE_REFUSED' USING ERRCODE='55000';
  END IF;

  PERFORM 1 FROM public.spin_bonus_pools s
   WHERE s.club_id=p_club_id ORDER BY s.club_id FOR UPDATE;
  SELECT count(*) INTO v_pool_count FROM public.spin_bonus_pools s
   WHERE s.club_id=p_club_id
     AND s.is_active AND s.activated_at IS NOT NULL AND s.deactivated_at IS NULL
     AND s.owner_kind='club' AND s.seed_source_wallet='chip_treasury'
     AND COALESCE(s.offered_max_stake,0)=1 AND COALESCE(s.highest_stake,0)=1
     AND COALESCE(s.seeded_amount,0)=200 AND COALESCE(s.balance,0)=200
     AND COALESCE(s.total_deposited,0)=0 AND COALESCE(s.total_drawn,0)=0
     AND COALESCE(s.spin_count,0)=0 AND COALESCE(s.bonus_count,0)=0
     AND COALESCE(s.surplus_returned,0)=0
     AND (SELECT count(*) FROM public.spin_reserve_ledger l
           WHERE l.club_id=p_club_id)=2
     AND (SELECT count(*) FROM public.spin_reserve_ledger l
           WHERE l.club_id=p_club_id AND l.kind='seed'
             AND l.amount=200 AND l.balance_after=200)=1
     AND (SELECT count(*) FROM public.spin_reserve_ledger l
           WHERE l.club_id=p_club_id AND l.kind='activation'
             AND l.amount=0 AND l.balance_after=200)=1;
  IF v_pool_count<>1 THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_BOARD_SEED_CUSTODY_REFUSED' USING ERRCODE='55000';
  END IF;
  UPDATE public.spin_bonus_pools
     SET is_active=false,deactivated_at=now(),updated_at=now()
   WHERE club_id=p_club_id AND is_active AND activated_at IS NOT NULL
     AND deactivated_at IS NULL;
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  IF v_changed<>1 THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_BOARD_POOL_DEACTIVATION_REFUSED' USING ERRCODE='55000';
  END IF;

  SELECT COALESCE(array_agg(i.entity_id ORDER BY i.entity_id),'{}')
    INTO v_schedules
    FROM public.club_welcome_package_items i
   WHERE i.club_id=p_club_id AND i.entity_kind='tournament_schedule'
     AND i.retired_at IS NULL;
  PERFORM 1 FROM public.tournaments t
   WHERE t.club_id=p_club_id OR t.schedule_id=ANY(v_schedules)
      OR EXISTS(SELECT 1 FROM public.tournament_schedule_spawns s
                 WHERE s.schedule_id=ANY(v_schedules) AND s.tournament_id=t.id)
   ORDER BY t.id FOR UPDATE;
  PERFORM 1 FROM public.tables t
   WHERE t.club_id=p_club_id AND t.tournament_id IS NOT NULL
   ORDER BY t.id FOR UPDATE;

  SELECT COALESCE(array_agg(q.id ORDER BY q.id),'{}') INTO v_schedule_tournaments
    FROM (
      SELECT t.id FROM public.tournaments t WHERE t.schedule_id=ANY(v_schedules)
      UNION
      SELECT s.tournament_id FROM public.tournament_schedule_spawns s
       WHERE s.schedule_id=ANY(v_schedules) AND s.tournament_id IS NOT NULL
    ) q;

  WITH expected(name,game_type,variant,tournament_type,buy_in_amount,buy_in_fee,seats,stack) AS (
    VALUES
      ('NLH Heads-Up 1','NLH','sng','SNG',0.95::numeric,0.05::numeric,2,1000),
      ('PLO4 Heads-Up 1','PLO4','sng','SNG',0.95::numeric,0.05::numeric,2,1000),
      ('NLH Heads-Up 1 Turbo','NLH','sng','SNG',0.95::numeric,0.05::numeric,2,300),
      ('PLO4 Heads-Up 1 Turbo','PLO4','sng','SNG',0.95::numeric,0.05::numeric,2,300),
      ('1 Chip Spin NLH','NLH','spin','SPIN',1::numeric,0::numeric,3,300),
      ('1 Chip Spin PLO4','PLO4','spin','SPIN',1::numeric,0::numeric,3,300),
      ('1 Chip Spin PLO5','PLO5','spin','SPIN',1::numeric,0::numeric,3,300),
      ('1 Chip Spin PLO6','PLO6','spin','SPIN',1::numeric,0::numeric,3,300),
      ('1 Chip Deep Stack Spin NLH','NLH','spin','SPIN',1::numeric,0::numeric,3,1000),
      ('1 Chip Deep Stack Spin PLO4','PLO4','spin','SPIN',1::numeric,0::numeric,3,1000),
      ('1 Chip Deep Stack Spin PLO5','PLO5','spin','SPIN',1::numeric,0::numeric,3,1000),
      ('1 Chip Deep Stack Spin PLO6','PLO6','spin','SPIN',1::numeric,0::numeric,3,1000)
  )
  SELECT COALESCE(array_agg(t.id ORDER BY t.id),'{}'),count(DISTINCT t.name)
    INTO v_board_tournaments,v_expected_count
    FROM public.tournaments t JOIN expected e
      ON t.name=e.name AND upper(COALESCE(t.game_type,''))=e.game_type
     AND lower(COALESCE(t.variant,''))=e.variant
     AND upper(COALESCE(t.tournament_type,''))=e.tournament_type
     AND t.buy_in_amount=e.buy_in_amount AND t.buy_in_fee=e.buy_in_fee
     AND t.max_players=e.seats AND t.min_players=e.seats AND t.table_size=e.seats
     AND t.starting_chips=e.stack
   WHERE t.club_id=p_club_id AND t.union_id IS NULL AND t.schedule_id IS NULL
     AND t.restart_source_id IS NULL AND t.satellite_target_id IS NULL
     AND t.satellite_target IS NULL
     AND upper(COALESCE(t.status,''))='REGISTERING'
     AND t.current_players=0
     AND t.started_at IS NULL AND t.ended_at IS NULL
     AND COALESCE(t.created_at,'infinity'::timestamptz)
           <=transaction_timestamp()-interval '5 minutes'
     AND COALESCE(t.updated_at,'infinity'::timestamptz)
           <=transaction_timestamp()-interval '5 minutes';

  IF cardinality(v_board_tournaments)<>v_expected_count
     OR cardinality(v_board_tournaments)>12
     OR EXISTS(SELECT 1 FROM public.tournaments t
                WHERE t.club_id=p_club_id
                  AND NOT(t.id=ANY(v_schedule_tournaments))
                  AND NOT(t.id=ANY(v_board_tournaments)))
     OR EXISTS(SELECT 1 FROM public.tournament_schedule_spawns s
                WHERE s.tournament_id=ANY(v_board_tournaments)) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_BOARD_LINEAGE_REFUSED' USING ERRCODE='55000';
  END IF;

  PERFORM 1 FROM public.tables t
   WHERE t.tournament_id=ANY(v_board_tournaments)
   ORDER BY t.id FOR UPDATE;
  SELECT COALESCE(array_agg(t.id ORDER BY t.id),'{}') INTO v_board_tables
    FROM public.tables t WHERE t.tournament_id=ANY(v_board_tournaments);
  IF cardinality(v_board_tables)<>cardinality(v_board_tournaments)
     OR EXISTS(SELECT 1 FROM public.tables t
                JOIN public.tournaments g ON g.id=t.tournament_id
               WHERE t.tournament_id=ANY(v_board_tournaments)
                 AND (t.club_id IS DISTINCT FROM p_club_id
                   OR t.union_id IS NOT NULL OR t.cluster_id IS NOT NULL
                   OR t.game_type IS DISTINCT FROM 'tournament'
                   OR t.name IS DISTINCT FROM g.name
                   OR lower(COALESCE(t.status,''))<>'waiting'
                   OR t.current_players IS DISTINCT FROM 0
                   OR t.is_deleted IS DISTINCT FROM false
                   OR t.max_players IS DISTINCT FROM g.max_players
                   OR COALESCE(t.created_at,'infinity'::timestamptz)
                        >transaction_timestamp()-interval '5 minutes'
                   OR COALESCE(t.updated_at,'infinity'::timestamptz)
                        >transaction_timestamp()-interval '5 minutes')) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_BOARD_TABLE_LINEAGE_REFUSED' USING ERRCODE='55000';
  END IF;

  FOR v_fk IN
    SELECT child_ns.nspname AS schema_name,child.relname AS relation_name,
           child_col.attname AS column_name
      FROM pg_constraint fk
      JOIN pg_class child ON child.oid=fk.conrelid
      JOIN pg_namespace child_ns ON child_ns.oid=child.relnamespace
      JOIN pg_attribute child_col ON child_col.attrelid=fk.conrelid
                                 AND child_col.attnum=fk.conkey[1]
     WHERE fk.contype='f'
       AND fk.confrelid='public.tournaments'::regclass
       AND cardinality(fk.conkey)=1
       AND NOT (child_ns.nspname='public' AND child.relname='tables')
  LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.%I WHERE %I=ANY($1))',
                   v_fk.schema_name,v_fk.relation_name,v_fk.column_name)
       INTO v_fk_has_rows USING v_board_tournaments;
    IF v_fk_has_rows THEN
      RAISE EXCEPTION 'WELCOME_CERTIFICATION_BOARD_FIXTURE_HAS_ACTIVITY' USING ERRCODE='55000';
    END IF;
  END LOOP;

  PERFORM 1 FROM public.managed_game_schedules s
   WHERE (s.game_kind='tournament' AND s.game_id=ANY(v_board_tournaments))
      OR (s.game_kind='table' AND s.game_id=ANY(v_board_tables))
   ORDER BY s.schedule_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.tournament_players p
             WHERE p.tournament_id=ANY(v_board_tournaments))
     OR EXISTS(SELECT 1 FROM public.tournament_escrow e
                WHERE e.tournament_id=ANY(v_board_tournaments))
     OR EXISTS(SELECT 1 FROM public.tournament_payouts p
                WHERE p.tournament_id=ANY(v_board_tournaments))
     OR EXISTS(SELECT 1 FROM public.tournament_obligations o
                WHERE o.tournament_id=ANY(v_board_tournaments))
     OR EXISTS(SELECT 1 FROM public.tournament_registrations r
                WHERE r.tournament_id=ANY(v_board_tournaments))
     OR EXISTS(SELECT 1 FROM public.tournament_registration_approvals a
                WHERE a.tournament_id=ANY(v_board_tournaments))
     OR EXISTS(SELECT 1 FROM public.tournament_waitlists w
                WHERE w.tournament_id=ANY(v_board_tournaments))
     OR EXISTS(SELECT 1 FROM public.tournament_tickets k
                WHERE k.club_id=p_club_id
                   OR k.source_tournament_id=ANY(v_board_tournaments)
                   OR k.source_satellite_id=ANY(v_board_tournaments))
     OR EXISTS(SELECT 1 FROM public.table_seats s WHERE s.table_id=ANY(v_board_tables))
     OR EXISTS(SELECT 1 FROM public.table_sessions s WHERE s.table_id=ANY(v_board_tables))
     OR EXISTS(SELECT 1 FROM public.engine_table_leases l WHERE l.table_id=ANY(v_board_tables))
     OR EXISTS(SELECT 1 FROM public.engine_tournament_leases l
                WHERE l.tournament_id=ANY(v_board_tournaments))
     OR EXISTS(SELECT 1 FROM public.table_waitlist w WHERE w.table_id=ANY(v_board_tables))
     OR EXISTS(SELECT 1 FROM public.table_pending_addons a WHERE a.table_id=ANY(v_board_tables))
     OR EXISTS(SELECT 1 FROM public.table_hole_cards c WHERE c.table_id=ANY(v_board_tables))
     OR EXISTS(SELECT 1 FROM public.hand_state_snapshots s WHERE s.table_id=ANY(v_board_tables))
     OR EXISTS(SELECT 1 FROM public.table_cashout_history c WHERE c.table_id=ANY(v_board_tables))
     OR EXISTS(SELECT 1 FROM public.insurance_transactions i WHERE i.table_id=ANY(v_board_tables))
     OR EXISTS(SELECT 1 FROM public.hand_history h
                WHERE h.tournament_id=ANY(v_board_tournaments)
                   OR h.table_id=ANY(v_board_tables))
     OR EXISTS(SELECT 1 FROM public.managed_game_schedules s
                WHERE s.status='executing' AND
                  ((s.game_kind='tournament' AND s.game_id=ANY(v_board_tournaments))
                    OR (s.game_kind='table' AND s.game_id=ANY(v_board_tables)))) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_BOARD_FIXTURE_HAS_ACTIVITY' USING ERRCODE='55000';
  END IF;

  UPDATE public.managed_game_schedules SET status='cancelled',completed_at=now(),
         result=jsonb_build_object('ok',false,'reason','reserved_certification_retirement')
   WHERE status='scheduled' AND
     ((game_kind='tournament' AND game_id=ANY(v_board_tournaments))
       OR (game_kind='table' AND game_id=ANY(v_board_tables)));

  INSERT INTO smarter_private.ca_welcome_certification_table_delete_permits(
    transaction_id,table_id,tournament_id,club_id
  )
  SELECT pg_current_xact_id(),t.id,t.tournament_id,t.club_id
    FROM public.tables t
   WHERE t.id=ANY(v_board_tables)
   ORDER BY t.id;
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  IF v_changed<>cardinality(v_board_tables) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_BOARD_DELETE_PERMIT_REFUSED' USING ERRCODE='55000';
  END IF;

  DELETE FROM public.tables WHERE id=ANY(v_board_tables);
  IF EXISTS(
    SELECT 1 FROM smarter_private.ca_welcome_certification_table_delete_permits p
     WHERE p.transaction_id=pg_current_xact_id()
       AND p.table_id=ANY(v_board_tables)
  ) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_BOARD_DELETE_PERMIT_NOT_CONSUMED'
      USING ERRCODE='55000';
  END IF;
  DELETE FROM public.tournaments WHERE id=ANY(v_board_tournaments);
  IF EXISTS(SELECT 1 FROM public.tournaments WHERE id=ANY(v_board_tournaments))
     OR EXISTS(SELECT 1 FROM public.tables WHERE id=ANY(v_board_tables)) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_BOARD_PREPARATION_INCOMPLETE' USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object('prepared',true,'club_id',p_club_id,
    'tournaments_removed',cardinality(v_board_tournaments),
    'tables_removed',cardinality(v_board_tables));
END
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_prepare_unused_welcome_certification_board_games(uuid)
  FROM PUBLIC,anon,authenticated,service_role;

DO $assert$
DECLARE
  v_guard_body text;
  v_board_body text;
  v_schedule_body text;
BEGIN
  SELECT p.prosrc INTO v_guard_body FROM pg_proc p
   WHERE p.oid='public.fn_tournament_table_terminal_close_is_irreversible()'::regprocedure;
  SELECT p.prosrc INTO v_board_body FROM pg_proc p
   WHERE p.oid='public.fn_ca_prepare_unused_welcome_certification_board_games(uuid)'::regprocedure;
  SELECT p.prosrc INTO v_schedule_body FROM pg_proc p
   WHERE p.oid='public.fn_ca_prepare_unused_welcome_certification_schedule_spawns(uuid)'::regprocedure;
  IF v_guard_body NOT LIKE '%transaction_id=pg_current_xact_id()%'
     OR v_guard_body NOT LIKE '%p.table_id=OLD.id%'
     OR v_guard_body NOT LIKE '%p.tournament_id=OLD.tournament_id%'
     OR v_guard_body NOT LIKE '%p.club_id=OLD.club_id%'
     OR v_guard_body NOT LIKE '%tournament table % is durable and cannot be deleted%'
     OR v_board_body NOT LIKE '%WELCOME_CERTIFICATION_BOARD_FIXTURE_HAS_ACTIVITY%'
     OR v_board_body NOT LIKE '%INSERT INTO smarter_private.ca_welcome_certification_table_delete_permits%'
     OR v_board_body NOT LIKE '%WELCOME_CERTIFICATION_BOARD_DELETE_PERMIT_NOT_CONSUMED%'
     OR v_schedule_body NOT LIKE '%WELCOME_CERTIFICATION_SCHEDULE_FIXTURE_HAS_ACTIVITY%'
     OR v_schedule_body NOT LIKE '%INSERT INTO smarter_private.ca_welcome_certification_table_delete_permits%'
     OR v_schedule_body NOT LIKE '%WELCOME_CERTIFICATION_SCHEDULE_DELETE_PERMIT_NOT_CONSUMED%' THEN
    RAISE EXCEPTION 'ASSERT FAILED: exact certification table-delete permit is not installed';
  END IF;
  IF has_table_privilege('anon',
       'smarter_private.ca_welcome_certification_table_delete_permits','SELECT')
     OR has_table_privilege('authenticated',
       'smarter_private.ca_welcome_certification_table_delete_permits','SELECT')
     OR has_table_privilege('service_role',
       'smarter_private.ca_welcome_certification_table_delete_permits','SELECT')
     OR has_table_privilege('service_role',
       'smarter_private.ca_welcome_certification_table_delete_permits','INSERT')
     OR has_table_privilege('service_role',
       'smarter_private.ca_welcome_certification_table_delete_permits','DELETE') THEN
    RAISE EXCEPTION 'ASSERT FAILED: certification delete permits are exposed';
  END IF;
END
$assert$;

COMMIT;
