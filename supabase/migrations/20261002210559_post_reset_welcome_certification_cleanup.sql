-- 20261002210559_post_reset_welcome_certification_cleanup
--
-- A successful Remove All Preloaded Games operation leaves intentionally
-- durable welcome receipts/items and financial journals, while closing the
-- physical game graph.  The reserved production certificate then asks its
-- cleanup coordinator to retire that fixture.  The original coordinator only
-- recognizes state A (ten active welcome items and funded child stores), so it
-- refuses state B after the reset has already returned 100 BBJ + 200 Spin
-- principal and restored the club treasury to exactly 100,000.
--
-- Add a separate service-only state-B preparer.  It accepts only the reserved
-- certification namespace; one exact successful reset receipt; ten items all
-- retired by that one operation; exact returned-seed ledger lineage; a
-- 100,000 treasury; an unused closed/cancelled package graph; and zero-use
-- Diamond pools.  It consumes transaction-bound table-delete permits and
-- removes only mutable fixture rows.  Chip ledgers, Spin reserve ledger and
-- configuration audit history remain immutable evidence; the certification-
-- only package rows are removed after their complete preimage is proved, as
-- in the existing pristine cleanup.  Any ambiguity raises 55000.
--
-- The wrapper branches only when that successful reset receipt exists.  State
-- A continues through the five existing preparers byte-for-byte, and a preset
-- fixture without a welcome entitlement still reaches the unchanged core.
--
-- @live-proof: (SELECT p.prosrc LIKE '%fn_ca_prepare_post_reset_welcome_certification_fixture%' AND p.prosrc LIKE '%fn_ca_prepare_unused_welcome_certification_board_leases%' FROM pg_proc p WHERE p.oid='public.fn_ca_retire_welcome_certification_club(uuid,text)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';

CREATE FUNCTION public.fn_ca_prepare_post_reset_welcome_certification_fixture(
  p_club_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_club public.clubs%ROWTYPE;
  v_owner_email text;
  v_operation uuid;
  v_result jsonb;
  v_cash uuid[] := '{}';
  v_schedules uuid[] := '{}';
  v_tournaments uuid[] := '{}';
  v_schedule_tournaments uuid[] := '{}';
  v_board_tournaments uuid[] := '{}';
  v_tables uuid[] := '{}';
  v_initial_tables uuid[] := '{}';
  v_receipt_cash uuid[] := '{}';
  v_receipt_schedules uuid[] := '{}';
  v_receipt_tournaments uuid[] := '{}';
  v_receipt_tables uuid[] := '{}';
  v_changed integer := 0;
  v_origin_count integer := 0;
  v_expected_count integer := 0;
  v_lease_count integer := 0;
  v_cutoff timestamptz := clock_timestamp()-interval '10 minutes';
  v_fk record;
  v_fk_has_rows boolean;
BEGIN
  IF COALESCE(auth.role(),'') <> 'service_role'
     AND session_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'service_role_only' USING ERRCODE='42501';
  END IF;

  PERFORM pg_advisory_xact_lock(530090,1);
  SELECT * INTO v_club FROM public.clubs WHERE id=p_club_id FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS(
    SELECT 1 FROM public.club_welcome_entitlements e WHERE e.club_id=p_club_id
  ) THEN
    RETURN jsonb_build_object('prepared',false,'reason','no_welcome_fixture');
  END IF;
  SELECT u.email INTO v_owner_email FROM auth.users u
   WHERE u.id=v_club.owner_id FOR KEY SHARE;
  IF p_club_id=ANY(ARRAY[
       'a0000000-0000-0000-0000-000000000001'::uuid,
       'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid,
       '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid,
       'fade0000-0000-0000-0000-000000000001'::uuid])
     OR (v_club.name NOT LIKE 'Crest Cert %' AND v_club.name NOT LIKE 'Preset Crest Cert %')
     OR NOT (COALESCE(v_owner_email,'') LIKE 'club-create-cert-%@smarter-poker.invalid'
          OR COALESCE(v_owner_email,'') LIKE 'ca-customization-cert-postdeploy-%@example.invalid')
     OR COALESCE(v_club.is_union,false) OR v_club.union_id IS NOT NULL
     OR EXISTS(SELECT 1 FROM public.union_clubs u WHERE u.club_id=p_club_id) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_FIXTURE_IDENTITY_REFUSED' USING ERRCODE='42501';
  END IF;

  PERFORM 1 FROM public.club_welcome_package_items
   WHERE club_id=p_club_id ORDER BY slot_key FOR UPDATE;
  SELECT min(reset_operation_id),
         COALESCE(array_agg(entity_id ORDER BY entity_id)
           FILTER(WHERE entity_kind='cash_game'),'{}'),
         COALESCE(array_agg(initial_table_id ORDER BY initial_table_id)
           FILTER(WHERE entity_kind='cash_game'),'{}'),
         COALESCE(array_agg(entity_id ORDER BY entity_id)
           FILTER(WHERE entity_kind='tournament_schedule'),'{}')
    INTO v_operation,v_cash,v_initial_tables,v_schedules
    FROM public.club_welcome_package_items i WHERE i.club_id=p_club_id;
  IF (SELECT count(*) FROM public.club_welcome_package_items i WHERE i.club_id=p_club_id)<>10
     OR cardinality(v_cash)<>9 OR cardinality(v_initial_tables)<>9
     OR cardinality(v_schedules)<>1 OR v_operation IS NULL
     OR EXISTS(SELECT 1 FROM public.club_welcome_package_items i
                WHERE i.club_id=p_club_id
                  AND (i.retired_at IS NULL OR i.reset_operation_id IS DISTINCT FROM v_operation))
     OR (SELECT count(*) FROM public.club_welcome_package_receipts r
          WHERE r.club_id=p_club_id AND r.package_version='welcome-v1'
            AND r.actor_id=v_club.owner_id)<>1
     OR (SELECT count(*) FROM public.club_welcome_entitlements e
          WHERE e.club_id=p_club_id AND e.owner_id=v_club.owner_id
            AND e.package_version='welcome-v1')<>1
     OR (SELECT count(*) FROM public.club_owner_creation_history h
          WHERE h.owner_id=v_club.owner_id AND h.first_club_id=p_club_id
            AND h.welcome_eligible AND h.provenance='prospective')<>1
     OR (SELECT count(*) FROM public.club_welcome_package_funding f
          WHERE f.club_id=p_club_id AND
            ((f.destination='bbj_main' AND f.amount=100)
              OR (f.destination='spin_reserve' AND f.amount=200)))<>2 THEN
    RAISE EXCEPTION 'POST_RESET_CERTIFICATION_PACKAGE_LINEAGE_REFUSED' USING ERRCODE='55000';
  END IF;

  SELECT r.result INTO v_result FROM public.club_welcome_reset_receipts r
   WHERE r.club_id=p_club_id AND r.operation_id=v_operation
     AND r.actor_id=v_club.owner_id FOR UPDATE;
  IF NOT FOUND
     OR (SELECT count(*) FROM public.club_welcome_reset_receipts r WHERE r.club_id=p_club_id)<>1
     OR COALESCE((v_result->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_result->>'opening_grant_unwound')::boolean,true) IS NOT FALSE
     OR COALESCE((v_result#>>'{returned_to_treasury,bbj}')::numeric,-1)<>100
     OR COALESCE((v_result#>>'{returned_to_treasury,spin}')::numeric,-1)<>200
     OR COALESCE((v_result->>'owner_acceptance_receipts_preserved')::boolean,false) IS NOT TRUE
     OR (v_result->>'operation_id')::uuid IS DISTINCT FROM v_operation
     OR v_result->>'package_version' IS DISTINCT FROM 'welcome-v1' THEN
    RAISE EXCEPTION 'POST_RESET_CERTIFICATION_RECEIPT_REFUSED' USING ERRCODE='55000';
  END IF;
  SELECT COALESCE(array_agg(e.value::uuid ORDER BY e.value::uuid),'{}') INTO v_receipt_cash
    FROM jsonb_array_elements_text(
      COALESCE(v_result#>'{removed,cash_game_ids}','[]'::jsonb)
    ) AS e(value);
  SELECT COALESCE(array_agg(e.value::uuid ORDER BY e.value::uuid),'{}') INTO v_receipt_schedules
    FROM jsonb_array_elements_text(
      COALESCE(v_result#>'{removed,schedule_ids}','[]'::jsonb)
    ) AS e(value);
  SELECT COALESCE(array_agg(e.value::uuid ORDER BY e.value::uuid),'{}') INTO v_receipt_tournaments
    FROM jsonb_array_elements_text(
      COALESCE(v_result#>'{removed,tournament_ids}','[]'::jsonb)
    ) AS e(value);
  SELECT COALESCE(array_agg(e.value::uuid ORDER BY e.value::uuid),'{}') INTO v_receipt_tables
    FROM jsonb_array_elements_text(
      COALESCE(v_result#>'{removed,table_ids}','[]'::jsonb)
    ) AS e(value);
  IF v_receipt_cash IS DISTINCT FROM v_cash
     OR v_receipt_schedules IS DISTINCT FROM v_schedules THEN
    RAISE EXCEPTION 'POST_RESET_CERTIFICATION_RECEIPT_GRAPH_REFUSED' USING ERRCODE='55000';
  END IF;

  PERFORM 1 FROM public.cash_games WHERE id=ANY(v_cash) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.tournament_schedules WHERE id=ANY(v_schedules) ORDER BY id FOR UPDATE;
  SELECT * INTO v_club FROM public.clubs WHERE id=p_club_id FOR UPDATE;
  IF v_club.chip_treasury IS DISTINCT FROM 100000::numeric
     OR COALESCE(v_club.chip_pool,0)<>0 OR COALESCE(v_club.promo_balance,0)<>0
     OR COALESCE(v_club.insurance_balance,0)<>0
     OR COALESCE(v_club.spins_enabled,false) OR COALESCE(v_club.bbj_enabled,false)
     OR COALESCE(v_club.bbj_rake_enabled,false)
     OR (SELECT count(*) FROM public.club_members m WHERE m.club_id=p_club_id)<>1
     OR EXISTS(SELECT 1 FROM public.club_members m WHERE m.club_id=p_club_id
                AND (m.user_id IS DISTINCT FROM v_club.owner_id
                  OR COALESCE(m.chip_balance,0)<>0 OR COALESCE(m.promo_balance,0)<>0))
     OR EXISTS(SELECT 1 FROM public.agents a WHERE a.club_id=p_club_id) THEN
    RAISE EXCEPTION 'POST_RESET_CERTIFICATION_CLUB_STATE_REFUSED' USING ERRCODE='55000';
  END IF;

  IF (SELECT count(*) FROM public.cash_games g WHERE g.id=ANY(v_cash))<>9
     OR EXISTS(SELECT 1 FROM public.cash_games g WHERE g.id=ANY(v_cash)
                AND (g.club_id IS DISTINCT FROM p_club_id OR g.enabled
                  OR g.state IS DISTINCT FROM 'dormant' OR g.closed_at IS NULL))
     OR EXISTS(SELECT 1 FROM public.cash_games g WHERE g.club_id=p_club_id AND NOT(g.id=ANY(v_cash)))
     OR (SELECT count(*) FROM public.tournament_schedules s WHERE s.id=ANY(v_schedules))<>1
     OR EXISTS(SELECT 1 FROM public.tournament_schedules s WHERE s.id=ANY(v_schedules)
                AND (s.club_id IS DISTINCT FROM p_club_id OR s.active))
     OR EXISTS(SELECT 1 FROM public.tournament_schedules s
                WHERE s.club_id=p_club_id AND NOT(s.id=ANY(v_schedules))) THEN
    RAISE EXCEPTION 'POST_RESET_CERTIFICATION_PACKAGE_GRAPH_REFUSED' USING ERRCODE='55000';
  END IF;

  SELECT COALESCE(array_agg(t.id ORDER BY t.id),'{}') INTO v_schedule_tournaments
    FROM public.tournaments t
   WHERE t.schedule_id=ANY(v_schedules)
      OR EXISTS(SELECT 1 FROM public.tournament_schedule_spawns s
                 WHERE s.schedule_id=ANY(v_schedules) AND s.tournament_id=t.id);
  PERFORM 1 FROM public.tournament_schedule_spawns s
   WHERE s.schedule_id=ANY(v_schedules) ORDER BY s.id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.tournaments t
              WHERE t.id=ANY(v_schedule_tournaments)
                AND (t.club_id IS DISTINCT FROM p_club_id
                  OR t.union_id IS NOT NULL
                  OR (NOT(t.schedule_id=ANY(v_schedules)) AND NOT EXISTS(
                    SELECT 1 FROM public.tournament_schedule_spawns s
                     WHERE s.schedule_id=ANY(v_schedules) AND s.tournament_id=t.id))))
     OR EXISTS(SELECT 1 FROM public.tournament_schedule_spawns s
                WHERE s.schedule_id=ANY(v_schedules)
                  AND (s.tournament_id IS NULL
                    OR NOT(s.tournament_id=ANY(v_schedule_tournaments)))) THEN
    RAISE EXCEPTION 'POST_RESET_CERTIFICATION_SCHEDULE_LINEAGE_REFUSED' USING ERRCODE='55000';
  END IF;
  WITH expected(name,game_type,variant,tournament_type,buy_in_amount,buy_in_fee,seats,stack) AS (
    VALUES
      ('NLH Heads-Up 1','NLH','sng','SNG',.95::numeric,.05::numeric,2,1000),
      ('PLO4 Heads-Up 1','PLO4','sng','SNG',.95::numeric,.05::numeric,2,1000),
      ('NLH Heads-Up 1 Turbo','NLH','sng','SNG',.95::numeric,.05::numeric,2,300),
      ('PLO4 Heads-Up 1 Turbo','PLO4','sng','SNG',.95::numeric,.05::numeric,2,300),
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
     AND t.max_players=e.seats AND t.min_players=e.seats
     AND t.table_size=e.seats AND t.starting_chips=e.stack
   WHERE t.club_id=p_club_id AND t.union_id IS NULL AND t.schedule_id IS NULL
     AND t.restart_source_id IS NULL AND t.satellite_target_id IS NULL
     AND t.satellite_target IS NULL;
  v_tournaments:=v_schedule_tournaments||v_board_tournaments;
  SELECT COALESCE(array_agg(x ORDER BY x),'{}') INTO v_tournaments
    FROM unnest(v_tournaments) x;
  PERFORM 1 FROM public.tournaments WHERE id=ANY(v_tournaments) ORDER BY id FOR UPDATE;
  IF cardinality(v_board_tournaments)<>12 OR v_expected_count<>12
     OR v_receipt_tournaments IS DISTINCT FROM v_tournaments
     OR EXISTS(SELECT 1 FROM public.tournaments t WHERE t.club_id=p_club_id
                AND NOT(t.id=ANY(v_tournaments)))
     OR EXISTS(SELECT 1 FROM public.tournaments t WHERE t.id=ANY(v_tournaments)
                AND (upper(COALESCE(t.status,'')) NOT IN('CANCELLED','CANCELED')
                  OR t.ended_at IS NULL OR COALESCE(t.current_players,0)<>0
                  OR t.started_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'POST_RESET_CERTIFICATION_TOURNAMENT_GRAPH_REFUSED' USING ERRCODE='55000';
  END IF;

  SELECT COALESCE(array_agg(t.id ORDER BY t.id),'{}') INTO v_tables
    FROM public.tables t WHERE t.club_id=p_club_id;
  PERFORM 1 FROM public.tables WHERE id=ANY(v_tables) ORDER BY id FOR UPDATE;
  IF v_receipt_tables IS DISTINCT FROM v_tables
     OR NOT(v_initial_tables <@ v_tables)
     OR EXISTS(SELECT 1 FROM public.tables t WHERE t.id=ANY(v_tables)
                AND (t.union_id IS NOT NULL OR COALESCE(t.current_players,0)<>0
                  OR lower(COALESCE(t.status,''))<>'closed'
                  OR (t.cluster_id IS NULL AND t.tournament_id IS NULL)
                  OR (t.cluster_id IS NOT NULL AND NOT(t.cluster_id=ANY(v_cash)))
                  OR (t.tournament_id IS NOT NULL AND NOT(t.tournament_id=ANY(v_tournaments)))))
     OR EXISTS(SELECT 1 FROM public.table_seats s WHERE s.table_id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.table_sessions s WHERE s.table_id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.table_waitlist w WHERE w.table_id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.table_pending_addons a WHERE a.table_id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.table_hole_cards c WHERE c.table_id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.hand_state_snapshots s WHERE s.table_id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.table_cashout_history c WHERE c.table_id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.insurance_transactions i WHERE i.table_id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.hand_history h
                WHERE h.table_id=ANY(v_tables) OR h.tournament_id=ANY(v_tournaments))
     OR EXISTS(SELECT 1 FROM public.tournament_players p WHERE p.tournament_id=ANY(v_tournaments))
     OR EXISTS(SELECT 1 FROM public.tournament_escrow e WHERE e.tournament_id=ANY(v_tournaments))
     OR EXISTS(SELECT 1 FROM public.tournament_payouts p WHERE p.tournament_id=ANY(v_tournaments))
     OR EXISTS(SELECT 1 FROM public.tournament_obligations o WHERE o.tournament_id=ANY(v_tournaments))
     OR EXISTS(SELECT 1 FROM public.tournament_registrations r WHERE r.tournament_id=ANY(v_tournaments))
     OR EXISTS(SELECT 1 FROM public.tournament_registration_approvals a WHERE a.tournament_id=ANY(v_tournaments))
     OR EXISTS(SELECT 1 FROM public.tournament_waitlists w WHERE w.tournament_id=ANY(v_tournaments))
     OR EXISTS(SELECT 1 FROM public.tournament_tickets k
                WHERE k.club_id=p_club_id OR k.source_tournament_id=ANY(v_tournaments)
                   OR k.source_satellite_id=ANY(v_tournaments))
     OR EXISTS(SELECT 1 FROM public.cash_game_waitlist w WHERE w.game_id=ANY(v_cash))
     OR EXISTS(SELECT 1 FROM public.cash_seat_moves m WHERE m.game_id=ANY(v_cash))
     OR EXISTS(SELECT 1 FROM public.cash_seat_change_requests r WHERE r.game_id=ANY(v_cash))
     OR EXISTS(SELECT 1 FROM public.cash_game_roster r WHERE r.game_id=ANY(v_cash)) THEN
    RAISE EXCEPTION 'POST_RESET_CERTIFICATION_ACTIVITY_REFUSED' USING ERRCODE='55000';
  END IF;

  -- A reset may race only with prelaunch controller residue.  No active table
  -- lease or pending F06 custody is ever cleanup-eligible.
  IF EXISTS(SELECT 1 FROM public.engine_table_leases l WHERE l.table_id=ANY(v_tables))
     OR EXISTS(SELECT 1 FROM public.engine_tournament_leases l
                WHERE l.tournament_id=ANY(v_tournaments)
                  AND smarter_private.f06_lease_has_pending_custody(l.tournament_id,NULL)) THEN
    RAISE EXCEPTION 'POST_RESET_CERTIFICATION_ACTIVE_LEASE_REFUSED' USING ERRCODE='55000';
  END IF;
  BEGIN
    PERFORM l.tournament_id FROM public.engine_tournament_leases l
     WHERE l.tournament_id=ANY(v_tournaments)
     ORDER BY l.tournament_id FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'POST_RESET_CERTIFICATION_ACTIVE_LEASE_REFUSED' USING ERRCODE='55000';
  END;
  SELECT count(*) INTO v_lease_count FROM public.engine_tournament_leases l
   WHERE l.tournament_id=ANY(v_tournaments);
  IF EXISTS(SELECT 1 FROM public.engine_tournament_leases l
             WHERE l.tournament_id=ANY(v_tournaments)
               AND (l.protocol_version IS DISTINCT FROM 2
                 OR l.lease_generation IS NULL
                 OR NULLIF(btrim(l.instance_id),'') IS NULL
                 OR l.acquired_at IS NULL OR l.heartbeat_at IS NULL
                 OR l.acquired_at>=v_cutoff OR l.heartbeat_at>=v_cutoff)) THEN
    RAISE EXCEPTION 'POST_RESET_CERTIFICATION_ACTIVE_LEASE_REFUSED' USING ERRCODE='55000';
  END IF;

  -- Hold every mutable child store through its zero-state proof and deletion.
  -- Product writers lock these owning rows before appending activity, so a
  -- concurrent Spin, BBJ or Diamond mutation cannot slip between admission
  -- and cleanup.
  PERFORM 1 FROM public.bbj_pools b
   WHERE b.club_id=p_club_id AND b.union_id IS NULL ORDER BY b.id FOR UPDATE;
  PERFORM 1 FROM public.spin_bonus_pools s
   WHERE s.club_id=p_club_id ORDER BY s.club_id FOR UPDATE;
  PERFORM 1 FROM public.wheel_configs w
   WHERE w.host_id=p_club_id ORDER BY w.host_id FOR UPDATE;
  PERFORM 1 FROM public.wheel_pools w
   WHERE w.host_id=p_club_id ORDER BY w.host_id FOR UPDATE;
  PERFORM 1 FROM public.diamond_game_configs d
   WHERE d.host_id=p_club_id ORDER BY d.game FOR UPDATE;
  PERFORM 1 FROM public.diamond_game_pools d
   WHERE d.host_id=p_club_id ORDER BY d.game FOR UPDATE;

  PERFORM 1 FROM public.managed_game_schedules s
   WHERE (s.game_kind='tournament' AND s.game_id=ANY(v_tournaments))
      OR (s.game_kind='table' AND s.game_id=ANY(v_tables))
   ORDER BY s.schedule_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.managed_game_schedules s
              WHERE ((s.game_kind='tournament' AND s.game_id=ANY(v_tournaments))
                  OR (s.game_kind='table' AND s.game_id=ANY(v_tables)))
                AND (s.status IS DISTINCT FROM 'cancelled'
                  OR s.completed_at IS NULL
                  OR s.result->>'reason' IS DISTINCT FROM 'welcome_package_reset')) THEN
    RAISE EXCEPTION 'POST_RESET_CERTIFICATION_MANAGED_COMMAND_REFUSED' USING ERRCODE='55000';
  END IF;

  IF (SELECT count(*) FROM public.bbj_pools b WHERE b.club_id=p_club_id
       AND b.union_id IS NULL AND COALESCE(b.main_balance,0)=0
       AND COALESCE(b.backup_balance,0)=0 AND COALESCE(b.promo_balance,0)=0
       AND COALESCE(b.pool_amount,0)=0 AND COALESCE(b.hands_contributed,0)=0
       AND COALESCE(b.total_contributed,0)=0 AND COALESCE(b.total_paid_out,0)=0
       AND COALESCE(b.hit_count,0)=0 AND b.status='retired')<>1
     OR EXISTS(SELECT 1 FROM public.bbj_contributions c JOIN public.bbj_pools b ON b.id=c.pool_id
                WHERE b.club_id=p_club_id)
     OR EXISTS(SELECT 1 FROM public.bbj_payouts p JOIN public.bbj_pools b ON b.id=p.pool_id
                WHERE b.club_id=p_club_id) THEN
    RAISE EXCEPTION 'POST_RESET_CERTIFICATION_BBJ_LINEAGE_REFUSED' USING ERRCODE='55000';
  END IF;
  IF (SELECT count(*) FROM public.spin_bonus_pools s WHERE s.club_id=p_club_id
       AND NOT s.is_active AND s.deactivated_at IS NOT NULL
       AND COALESCE(s.balance,0)=0 AND COALESCE(s.seeded_amount,0)=0
       AND COALESCE(s.seed_returned_amount,0)=200
       AND COALESCE(s.total_deposited,0)=0 AND COALESCE(s.total_drawn,0)=0
       AND COALESCE(s.spin_count,0)=0 AND COALESCE(s.bonus_count,0)=0
       AND COALESCE(s.surplus_returned,0)=0)<>1
     OR (SELECT count(*) FROM public.spin_reserve_ledger l WHERE l.club_id=p_club_id)<>4
     OR (SELECT count(*) FROM public.spin_reserve_ledger l WHERE l.club_id=p_club_id
          AND l.kind='seed' AND l.amount=200 AND l.balance_after=200)<>1
     OR (SELECT count(*) FROM public.spin_reserve_ledger l WHERE l.club_id=p_club_id
          AND l.kind='activation' AND l.amount=0 AND l.balance_after=200)<>1
     OR (SELECT count(*) FROM public.spin_reserve_ledger l WHERE l.club_id=p_club_id
          AND l.kind='seed_return' AND l.amount=-200 AND l.balance_after=0)<>1
     OR (SELECT count(*) FROM public.spin_reserve_ledger l WHERE l.club_id=p_club_id
          AND l.kind='deactivation' AND l.amount=0 AND l.balance_after=0)<>1
     OR (SELECT count(*) FROM public.chip_ledger l JOIN public.spin_bonus_pools s
          ON s.id=l.from_entity_id WHERE s.club_id=p_club_id
           AND l.from_type='spin_reserve' AND l.to_type='club_treasury'
           AND l.to_entity_id=p_club_id AND l.amount=200 AND l.category='reversal'
           AND l.idempotency_key='spin-deactivation-seed-return:'||p_club_id::text||':200')<>1
     OR (SELECT count(*) FROM public.chip_transactions x WHERE x.club_id=p_club_id
          AND x.amount=100 AND x.transaction_type='bbj_promo_sweep'
          AND x.balance_after=100000
          AND x.metadata->>'reason'='welcome_package_reset'
          AND x.metadata->>'pool_id'=(SELECT b.id::text FROM public.bbj_pools b
                                      WHERE b.club_id=p_club_id AND b.union_id IS NULL)
          AND (x.metadata->>'operation_id')::uuid=v_operation)<>1 THEN
    RAISE EXCEPTION 'POST_RESET_CERTIFICATION_SEED_RETURN_LINEAGE_REFUSED' USING ERRCODE='55000';
  END IF;

  IF (SELECT count(*) FROM public.wheel_configs w WHERE w.host_id=p_club_id
       AND w.host_kind='club' AND NOT w.enabled)<>1
     OR (SELECT count(*) FROM public.wheel_pools w WHERE w.host_id=p_club_id
       AND w.spins=0 AND w.intake_diamonds=0 AND w.chips_minted=0
       AND w.chips_paid=0 AND w.diamonds_paid=0)<>1
     OR (SELECT count(*) FROM public.diamond_game_configs d WHERE d.host_id=p_club_id
       AND d.host_kind='club' AND NOT d.enabled AND d.game IN('plinko','crash','crossing','mines'))<>4
     OR (SELECT count(*) FROM public.diamond_game_pools d WHERE d.host_id=p_club_id
       AND d.game IN('plinko','crash','crossing','mines') AND d.rounds=0
       AND d.intake_diamonds=0 AND d.chips_minted=0 AND d.chips_paid=0
       AND d.reserved_chips=0)<>4
     OR EXISTS(SELECT 1 FROM public.wheel_spins w WHERE w.host_id=p_club_id)
     OR EXISTS(SELECT 1 FROM public.plinko_drops d WHERE d.host_id=p_club_id)
     OR EXISTS(SELECT 1 FROM public.crash_rounds r WHERE r.host_id=p_club_id)
     OR EXISTS(SELECT 1 FROM public.diamond_choice_rounds r WHERE r.host_id=p_club_id) THEN
    RAISE EXCEPTION 'POST_RESET_CERTIFICATION_DIAMOND_STATE_REFUSED' USING ERRCODE='55000';
  END IF;

  -- Refuse any new FK-bearing activity relation not explicitly owned below.
  FOR v_fk IN
    SELECT ns.nspname schema_name,c.relname relation_name,a.attname column_name
      FROM pg_constraint fk JOIN pg_class c ON c.oid=fk.conrelid
      JOIN pg_namespace ns ON ns.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=fk.conrelid AND a.attnum=fk.conkey[1]
     WHERE fk.contype='f' AND cardinality(fk.conkey)=1
       AND fk.confrelid='public.tournaments'::regclass
       AND NOT(ns.nspname='public' AND c.relname IN
         ('tables','tournament_table_origins','tournament_schedule_spawns','engine_tournament_leases'))
  LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.%I WHERE %I=ANY($1))',
      v_fk.schema_name,v_fk.relation_name,v_fk.column_name)
      INTO v_fk_has_rows USING v_tournaments;
    IF v_fk_has_rows THEN
      RAISE EXCEPTION 'POST_RESET_CERTIFICATION_UNKNOWN_TOURNAMENT_ACTIVITY: %.%',
        v_fk.schema_name,v_fk.relation_name USING ERRCODE='55000';
    END IF;
  END LOOP;

  DELETE FROM public.engine_tournament_leases l
   WHERE l.tournament_id=ANY(v_tournaments)
     AND l.protocol_version=2 AND l.lease_generation IS NOT NULL
     AND NULLIF(btrim(l.instance_id),'') IS NOT NULL
     AND l.acquired_at<v_cutoff AND l.heartbeat_at<v_cutoff
     AND NOT smarter_private.f06_lease_has_pending_custody(l.tournament_id,NULL);
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  IF v_changed<>v_lease_count THEN
    RAISE EXCEPTION 'POST_RESET_CERTIFICATION_LEASE_RETIREMENT_REFUSED' USING ERRCODE='55000';
  END IF;
  PERFORM 1 FROM public.tournament_table_origins o
   WHERE o.table_id=ANY(v_tables) ORDER BY o.table_id FOR UPDATE;
  SELECT count(*) INTO v_origin_count FROM public.tournament_table_origins o
   WHERE o.table_id=ANY(v_tables);
  IF v_origin_count<>(SELECT count(*) FROM public.tables t
                       WHERE t.id=ANY(v_tables) AND t.tournament_id IS NOT NULL)
     OR EXISTS(SELECT 1 FROM public.tables t
                WHERE t.id=ANY(v_tables) AND t.tournament_id IS NOT NULL
                  AND (SELECT count(*) FROM public.tournament_table_origins o
                        WHERE o.table_id=t.id)<>1)
     OR EXISTS(SELECT 1 FROM public.tournament_table_origins o
                JOIN public.tables t ON t.id=o.table_id
                WHERE o.table_id=ANY(v_tables)
                  AND (t.tournament_id IS NULL
                    OR o.tournament_id IS DISTINCT FROM t.tournament_id
                    OR o.origin_kind IS DISTINCT FROM 'prelaunch'
                    OR o.launch_id IS NOT NULL OR o.launch_lease_generation IS NOT NULL)) THEN
    RAISE EXCEPTION 'POST_RESET_CERTIFICATION_TABLE_ORIGIN_REFUSED' USING ERRCODE='55000';
  END IF;
  DELETE FROM public.tournament_table_origins WHERE table_id=ANY(v_tables)
    AND origin_kind='prelaunch' AND launch_id IS NULL AND launch_lease_generation IS NULL;
  IF EXISTS(SELECT 1 FROM public.tournament_table_origins WHERE table_id=ANY(v_tables)) THEN
    RAISE EXCEPTION 'POST_RESET_CERTIFICATION_TABLE_ORIGIN_REFUSED' USING ERRCODE='55000';
  END IF;
  PERFORM set_config('app.game_management_retention','on',true);
  PERFORM set_config('app.managed_game_lifecycle','on',true);
  DELETE FROM public.managed_game_schedules
   WHERE (game_kind='tournament' AND game_id=ANY(v_tournaments))
      OR (game_kind='table' AND game_id=ANY(v_tables));
  DELETE FROM public.tournament_schedule_spawns WHERE schedule_id=ANY(v_schedules);
  DELETE FROM public.cash_cluster_events WHERE game_id=ANY(v_cash);

  INSERT INTO smarter_private.ca_welcome_certification_table_delete_permits(
    transaction_id,table_id,tournament_id,club_id)
  SELECT pg_current_xact_id(),t.id,t.tournament_id,t.club_id
    FROM public.tables t
   WHERE t.id=ANY(v_tables) AND t.tournament_id IS NOT NULL
   ORDER BY t.id;
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  IF v_changed<>(SELECT count(*) FROM public.tables t
                  WHERE t.id=ANY(v_tables) AND t.tournament_id IS NOT NULL) THEN
    RAISE EXCEPTION 'POST_RESET_CERTIFICATION_TABLE_DELETE_PERMIT_REFUSED' USING ERRCODE='55000';
  END IF;
  DELETE FROM public.tables WHERE id=ANY(v_tables);
  IF EXISTS(SELECT 1 FROM smarter_private.ca_welcome_certification_table_delete_permits p
             WHERE p.transaction_id=pg_current_xact_id()
               AND p.table_id=ANY(v_tables) AND p.tournament_id IS NOT NULL) THEN
    RAISE EXCEPTION 'POST_RESET_CERTIFICATION_TABLE_DELETE_PERMIT_NOT_CONSUMED' USING ERRCODE='55000';
  END IF;
  DELETE FROM public.tournaments WHERE id=ANY(v_tournaments);
  DELETE FROM public.cash_games WHERE id=ANY(v_cash);
  DELETE FROM public.tournament_schedules WHERE id=ANY(v_schedules);

  -- Configuration history is immutable; only the exact unused live rows go.
  DELETE FROM public.wheel_pools WHERE host_id=p_club_id;
  DELETE FROM public.wheel_configs WHERE host_id=p_club_id;
  DELETE FROM public.diamond_game_pools WHERE host_id=p_club_id;
  DELETE FROM public.diamond_game_configs WHERE host_id=p_club_id;

  DELETE FROM public.club_welcome_package_funding WHERE club_id=p_club_id;
  DELETE FROM public.club_welcome_package_items WHERE club_id=p_club_id;
  DELETE FROM public.club_welcome_reset_receipts WHERE club_id=p_club_id;
  DELETE FROM public.club_welcome_package_receipts WHERE club_id=p_club_id;
  DELETE FROM public.club_welcome_entitlements WHERE club_id=p_club_id;
  DELETE FROM public.club_owner_creation_history
   WHERE owner_id=v_club.owner_id AND first_club_id=p_club_id
     AND welcome_eligible AND provenance='prospective';

  IF EXISTS(SELECT 1 FROM public.tables t WHERE t.club_id=p_club_id)
     OR EXISTS(SELECT 1 FROM public.tournaments t WHERE t.club_id=p_club_id)
     OR EXISTS(SELECT 1 FROM public.cash_games g WHERE g.club_id=p_club_id)
     OR EXISTS(SELECT 1 FROM public.tournament_schedules s WHERE s.club_id=p_club_id)
     OR EXISTS(SELECT 1 FROM public.wheel_configs w WHERE w.host_id=p_club_id)
     OR EXISTS(SELECT 1 FROM public.diamond_game_configs d WHERE d.host_id=p_club_id)
     OR EXISTS(SELECT 1 FROM public.club_welcome_entitlements e WHERE e.club_id=p_club_id) THEN
    RAISE EXCEPTION 'POST_RESET_CERTIFICATION_PREPARATION_INCOMPLETE' USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object('prepared',true,'state','post_reset','club_id',p_club_id,
    'tables_removed',cardinality(v_tables),'tournaments_removed',cardinality(v_tournaments),
    'cash_games_removed',cardinality(v_cash),'schedules_removed',cardinality(v_schedules),
    'financial_history_preserved',true);
END
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_prepare_post_reset_welcome_certification_fixture(uuid)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_retire_welcome_certification_club(
  p_club_id uuid,p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_post_reset boolean;
  v_leases jsonb; v_origins jsonb; v_board jsonb; v_schedule jsonb;
  v_prepared jsonb; v_retired jsonb; v_child numeric:=0;
BEGIN
  SELECT EXISTS(SELECT 1 FROM public.club_welcome_reset_receipts r
    WHERE r.club_id=p_club_id AND COALESCE((r.result->>'ok')::boolean,false))
    INTO v_post_reset;
  IF v_post_reset THEN
    v_prepared:=public.fn_ca_prepare_post_reset_welcome_certification_fixture(p_club_id);
    IF NOT COALESCE((v_prepared->>'prepared')::boolean,false) THEN
      RAISE EXCEPTION 'POST_RESET_CERTIFICATION_PREPARATION_REFUSED: %',
        COALESCE(v_prepared->>'reason','unknown') USING ERRCODE='55000';
    END IF;
  ELSE
    v_leases:=public.fn_ca_prepare_unused_welcome_certification_board_leases(p_club_id);
    v_origins:=public.fn_ca_prepare_unused_welcome_certification_board_origins(p_club_id);
    v_board:=public.fn_ca_prepare_unused_welcome_certification_board_games(p_club_id);
    v_schedule:=public.fn_ca_prepare_unused_welcome_certification_schedule_spawns(p_club_id);
    v_prepared:=public.fn_ca_prepare_unused_welcome_certification_fixture(p_club_id);
    v_child:=COALESCE((v_prepared->>'child_chips_retired')::numeric,0);
  END IF;
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
      'cleanup_state',CASE WHEN v_post_reset THEN 'post_reset' ELSE 'pristine' END,
      'board_tournament_leases_removed',COALESCE((v_leases->>'tournament_leases_removed')::integer,0),
      'board_origins_removed',COALESCE((v_origins->>'origins_removed')::integer,0),
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
GRANT EXECUTE ON FUNCTION public.fn_ca_retire_welcome_certification_club(uuid,text) TO service_role;

DO $assert$
DECLARE v_helper text; v_wrapper text;
BEGIN
  SELECT p.prosrc INTO v_helper FROM pg_proc p
   WHERE p.oid='public.fn_ca_prepare_post_reset_welcome_certification_fixture(uuid)'::regprocedure;
  SELECT p.prosrc INTO v_wrapper FROM pg_proc p
   WHERE p.oid='public.fn_ca_retire_welcome_certification_club(uuid,text)'::regprocedure;
  IF v_helper NOT LIKE '%POST_RESET_CERTIFICATION_RECEIPT_REFUSED%'
     OR v_helper NOT LIKE '%ca_welcome_certification_table_delete_permits%'
     OR v_helper NOT LIKE '%financial_history_preserved%'
     OR v_helper NOT LIKE '%DELETE FROM public.club_welcome_reset_receipts%'
     OR v_helper LIKE '%DELETE FROM public.spin_reserve_ledger%'
     OR v_helper LIKE '%DELETE FROM public.chip_ledger%'
     OR v_wrapper NOT LIKE '%fn_ca_prepare_post_reset_welcome_certification_fixture%'
     OR v_wrapper NOT LIKE '%fn_ca_prepare_unused_welcome_certification_board_leases%'
     OR has_function_privilege('anon','public.fn_ca_prepare_post_reset_welcome_certification_fixture(uuid)','EXECUTE')
     OR has_function_privilege('authenticated','public.fn_ca_prepare_post_reset_welcome_certification_fixture(uuid)','EXECUTE')
     OR has_function_privilege('service_role','public.fn_ca_prepare_post_reset_welcome_certification_fixture(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'POST_RESET_CERTIFICATION_CLEANUP_INSTALL_REFUSED';
  END IF;
END
$assert$;

COMMIT;
