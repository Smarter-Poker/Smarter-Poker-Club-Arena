-- 20261002085447_welcome_certification_retires_idle_orphan_tournaments
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-02 08:54:47 UTC.
--
-- The first-club welcome package activates a 200-chip Spin pool at maximum
-- stake 1.  TournamentRecurring deliberately uses that activation for both
-- the owner's always-open Spin board and Heads-Up SNG board.  At stake 1 the
-- deterministic board is eight Spins plus four Heads-Up games.  Each is born
-- atomically as an unscheduled REGISTERING tournament with one empty waiting
-- table.  The reserved Create Club certificate's stale-fixture retirement
-- knew only about the daily package schedule, so these twelve legitimate
-- board rows made the next certificate refuse before it could retire its own
-- abandoned account.
--
-- This is not a general tournament cleanup.  A new private helper accepts
-- only the exact reserved certification identity and untouched welcome seed,
-- fences the seat-first creator with its exclusive advisory lock, deactivates
-- that one pool, and recognizes only the twelve stake-1 board configurations
-- produced by the maintained engine.  A partial board is allowed because a
-- process can stop between atomic per-game creations; duplicate, unknown,
-- fresh, union, scheduled, started, occupied, financial, or played state
-- refuses the entire transaction.  The board tables and tournaments are
-- removed before the existing schedule and core fixture retirement helpers.
-- Ordinary clubs, board creation, schedules, players, and balances are not
-- changed.
--
-- @live-proof: (SELECT p.prosrc LIKE '%WELCOME_CERTIFICATION_BOARD_FIXTURE_HAS_ACTIVITY%' AND p.prosrc LIKE '%NLH Heads-Up 1 Turbo%' FROM pg_proc p WHERE p.oid='public.fn_ca_prepare_unused_welcome_certification_board_games(uuid)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';

-- Production's textual money-writer guard sees the balance fields used by
-- the refusal proofs below.  This helper never changes a balance: it only
-- verifies the untouched 200-chip Spin seed before retiring the exact idle
-- reserved-certificate board graph.  Declare that audited system role before
-- CREATE FUNCTION so the DDL event trigger can admit it atomically.
INSERT INTO public.ca_money_rpc_registry(proname,status,notes)
VALUES(
  'fn_ca_prepare_unused_welcome_certification_board_games','system',
  'Service-role-only reserved-certification cleanup. It reads and locks the exact untouched 200-chip Spin seed and its ledger proof, changes no balance, refuses any activity or non-certificate identity, and retires only the exact idle welcome board graph.'
)
ON CONFLICT(proname) DO UPDATE SET status=EXCLUDED.status,notes=EXCLUDED.notes;

CREATE FUNCTION public.fn_ca_prepare_unused_welcome_certification_board_games(
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

  -- The atomic seat-first creator holds the shared counterpart before either
  -- game row.  Once this lock is granted no new board row can race cleanup.
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

  -- Refuse every maintained FK-backed tournament child rather than naming a
  -- subset that can fall behind schema growth.  The one admitted child is the
  -- exact board table set already locked and validated above.
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
  DELETE FROM public.tables WHERE id=ANY(v_board_tables);
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
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_prepare_unused_welcome_certification_board_games(uuid)
  FROM service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_retire_welcome_certification_club(
  p_club_id uuid,p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_board jsonb;
  v_schedule jsonb;
  v_prepared jsonb;
  v_retired jsonb;
  v_child numeric := 0;
BEGIN
  v_board:=public.fn_ca_prepare_unused_welcome_certification_board_games(p_club_id);
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
      'board_tournaments_removed',COALESCE((v_board->>'tournaments_removed')::integer,0),
      'board_tables_removed',COALESCE((v_board->>'tables_removed')::integer,0),
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
   WHERE p.oid='public.fn_ca_prepare_unused_welcome_certification_board_games(uuid)'::regprocedure;
  IF v_body NOT LIKE '%pg_advisory_xact_lock(530090,1)%'
     OR v_body NOT LIKE '%NLH Heads-Up 1 Turbo%'
     OR v_body NOT LIKE '%1 Chip Deep Stack Spin PLO6%'
     OR v_body NOT LIKE '%WELCOME_CERTIFICATION_BOARD_FIXTURE_HAS_ACTIVITY%'
     OR v_body NOT LIKE '%tournament_registrations%'
     OR v_body NOT LIKE '%table_sessions%'
     OR v_body NOT LIKE '%hand_history%' THEN
    RAISE EXCEPTION 'ASSERT FAILED: reserved certification board cleanup guards are not installed';
  END IF;
END
$assert$;

COMMIT;
