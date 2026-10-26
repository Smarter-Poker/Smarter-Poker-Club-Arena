-- Read-only production preimages observed 2026-10-26; no production data.
SET check_function_bodies = off;
CREATE OR REPLACE FUNCTION public.fn_ca_prepare_post_reset_welcome_certification_fixture(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
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

  /* A CERTIFICATION FIXTURE NEVER QUEUES IN FRONT OF THE PLATFORM (2026-10-03).
     Every buy-in, registration, seat and launch takes this gate SHARED. A
     waiting exclusive request sits in the lock queue and every later shared
     request queues behind it, so while this fixture waited for the gate the
     whole platform's purchases waited for the fixture (in the 24 h to 00:30
     UTC 2026-10-04: 79 fixture waits of 1 s or more, up to 7.6 s, with about
     4,500 purchase waits of 1 s or more on the gate). The fixture now asks
     without queueing, every 50 ms for up to 30 s, and still holds the gate
     exclusively to the end of its transaction once it has it. */
  DECLARE
    v_gate_tries integer := 0;
  BEGIN
    WHILE NOT pg_try_advisory_xact_lock(530090,1) LOOP
      v_gate_tries := v_gate_tries + 1;
      IF v_gate_tries >= 600 THEN
        RAISE EXCEPTION 'CERTIFICATION_FIXTURE_GATE_BUSY' USING ERRCODE = '55P03';
      END IF;
      PERFORM pg_sleep(0.05);
    END LOOP;
  END;
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
  SELECT (array_agg(reset_operation_id ORDER BY reset_operation_id))[1],
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
  IF cardinality(v_board_tournaments) NOT IN(0,12)
     OR v_expected_count IS DISTINCT FROM cardinality(v_board_tournaments)
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
           AND l.idempotency_key='spin-deactivation-seed-return:'||p_club_id::text||':200.00')<>1
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

REVOKE ALL ON FUNCTION public.fn_ca_prepare_post_reset_welcome_certification_fixture(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_prepare_post_reset_welcome_certification_fixture(uuid) TO postgres;

CREATE OR REPLACE FUNCTION public.fn_ca_prepare_unused_welcome_certification_board_games(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
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

  /* A CERTIFICATION FIXTURE NEVER QUEUES IN FRONT OF THE PLATFORM (2026-10-03).
     Every buy-in, registration, seat and launch takes this gate SHARED. A
     waiting exclusive request sits in the lock queue and every later shared
     request queues behind it, so while this fixture waited for the gate the
     whole platform's purchases waited for the fixture (in the 24 h to 00:30
     UTC 2026-10-04: 79 fixture waits of 1 s or more, up to 7.6 s, with about
     4,500 purchase waits of 1 s or more on the gate). The fixture now asks
     without queueing, every 50 ms for up to 30 s, and still holds the gate
     exclusively to the end of its transaction once it has it. */
  DECLARE
    v_gate_tries integer := 0;
  BEGIN
    WHILE NOT pg_try_advisory_xact_lock(530090,1) LOOP
      v_gate_tries := v_gate_tries + 1;
      IF v_gate_tries >= 600 THEN
        RAISE EXCEPTION 'CERTIFICATION_FIXTURE_GATE_BUSY' USING ERRCODE = '55P03';
      END IF;
      PERFORM pg_sleep(0.05);
    END LOOP;
  END;
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
  -- 2026-10-22: the rows to lock come from three index-served sets; the
  -- OR over the whole table read all 819k tournaments under the platform gate.
  PERFORM 1 FROM public.tournaments t
   WHERE t.id IN (SELECT x.id FROM public.tournaments x WHERE x.club_id=p_club_id
                  UNION SELECT x.id FROM public.tournaments x
                         WHERE x.schedule_id=ANY(v_schedules)
                  UNION SELECT s.tournament_id FROM public.tournament_schedule_spawns s
                         WHERE s.schedule_id=ANY(v_schedules) AND s.tournament_id IS NOT NULL)
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
;

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
)) THEN
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

REVOKE ALL ON FUNCTION public.fn_ca_prepare_unused_welcome_certification_board_games(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_prepare_unused_welcome_certification_board_games(uuid) TO postgres;

CREATE OR REPLACE FUNCTION public.fn_ca_prepare_unused_welcome_certification_board_leases(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_club public.clubs%ROWTYPE;
  v_owner_email text;
  v_board_tournaments uuid[] := '{}';
  v_board_tables uuid[] := '{}';
  v_expected_count integer := 0;
  v_lease_count integer := 0;
  v_deleted integer := 0;
  v_cutoff timestamptz := clock_timestamp() - interval '10 minutes';
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'service_role_only' USING ERRCODE='42501';
  END IF;

  SELECT * INTO v_club FROM public.clubs WHERE id=p_club_id;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.club_welcome_entitlements e WHERE e.club_id=p_club_id
  ) THEN
    RETURN jsonb_build_object('prepared',false,'reason','no_welcome_fixture',
      'tournament_leases_removed',0);
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

  -- The atomic seat-first creator holds the shared counterpart.  This lock is
  -- transaction-scoped, so it remains held through the existing full cleanup.
  /* A CERTIFICATION FIXTURE NEVER QUEUES IN FRONT OF THE PLATFORM (2026-10-03).
     Every buy-in, registration, seat and launch takes this gate SHARED. A
     waiting exclusive request sits in the lock queue and every later shared
     request queues behind it, so while this fixture waited for the gate the
     whole platform's purchases waited for the fixture (in the 24 h to 00:30
     UTC 2026-10-04: 79 fixture waits of 1 s or more, up to 7.6 s, with about
     4,500 purchase waits of 1 s or more on the gate). The fixture now asks
     without queueing, every 50 ms for up to 30 s, and still holds the gate
     exclusively to the end of its transaction once it has it. */
  DECLARE
    v_gate_tries integer := 0;
  BEGIN
    WHILE NOT pg_try_advisory_xact_lock(530090,1) LOOP
      v_gate_tries := v_gate_tries + 1;
      IF v_gate_tries >= 600 THEN
        RAISE EXCEPTION 'CERTIFICATION_FIXTURE_GATE_BUSY' USING ERRCODE = '55P03';
      END IF;
      PERFORM pg_sleep(0.05);
    END LOOP;
  END;

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
     AND t.current_players=0 AND t.started_at IS NULL AND t.ended_at IS NULL
;

  IF cardinality(v_board_tournaments)=0 THEN
    RETURN jsonb_build_object('prepared',true,'club_id',p_club_id,
      'tournament_leases_removed',0);
  END IF;
  IF cardinality(v_board_tournaments)<>v_expected_count
     OR cardinality(v_board_tournaments)>12 THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_BOARD_LEASE_LINEAGE_REFUSED'
      USING ERRCODE='55000';
  END IF;

  PERFORM 1 FROM public.tournaments t
   WHERE t.id=ANY(v_board_tournaments) ORDER BY t.id FOR UPDATE;
  PERFORM 1 FROM public.tables t
   WHERE t.tournament_id=ANY(v_board_tournaments) ORDER BY t.id FOR UPDATE;
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
)) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_BOARD_LEASE_TABLE_LINEAGE_REFUSED'
      USING ERRCODE='55000';
  END IF;

  -- Tournament-backed tables must never carry cash-table authority.
  IF EXISTS(SELECT 1 FROM public.engine_table_leases l
             WHERE l.table_id=ANY(v_board_tables)) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_BOARD_UNEXPECTED_TABLE_LEASE_REFUSED'
      USING ERRCODE='55000';
  END IF;

  -- A claimant takes lease -> parent locks.  We already hold the parents, so
  -- NOWAIT avoids reversing that order and turns any overlap into a refusal.
  BEGIN
    PERFORM l.tournament_id FROM public.engine_tournament_leases l
     WHERE l.tournament_id=ANY(v_board_tournaments)
     ORDER BY l.tournament_id FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_BOARD_ACTIVE_OR_AMBIGUOUS_LEASE_REFUSED'
      USING ERRCODE='55000';
  END;

  IF EXISTS(
    SELECT 1 FROM public.engine_tournament_leases l
     WHERE l.tournament_id=ANY(v_board_tournaments)
       AND (l.protocol_version IS DISTINCT FROM 2
         OR l.lease_generation IS NULL
         OR NULLIF(btrim(l.instance_id),'') IS NULL
         OR l.acquired_at IS NULL OR l.heartbeat_at IS NULL
         OR l.acquired_at>=v_cutoff OR l.heartbeat_at>=v_cutoff)
  ) OR EXISTS(
    SELECT 1 FROM public.engine_tournament_leases l
     WHERE l.tournament_id=ANY(v_board_tournaments)
       AND smarter_private.f06_lease_has_pending_custody(l.tournament_id,NULL)
  ) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_BOARD_ACTIVE_OR_AMBIGUOUS_LEASE_REFUSED'
      USING ERRCODE='55000';
  END IF;

  SELECT count(*) INTO v_lease_count FROM public.engine_tournament_leases l
   WHERE l.tournament_id=ANY(v_board_tournaments);
  DELETE FROM public.engine_tournament_leases l
   WHERE l.tournament_id=ANY(v_board_tournaments)
     AND l.protocol_version=2 AND l.lease_generation IS NOT NULL
     AND NULLIF(btrim(l.instance_id),'') IS NOT NULL
     AND l.acquired_at<v_cutoff AND l.heartbeat_at<v_cutoff
     AND NOT smarter_private.f06_lease_has_pending_custody(l.tournament_id,NULL);
  GET DIAGNOSTICS v_deleted=ROW_COUNT;
  IF v_deleted<>v_lease_count
     OR EXISTS(SELECT 1 FROM public.engine_tournament_leases l
                WHERE l.tournament_id=ANY(v_board_tournaments)) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_BOARD_LEASE_RETIREMENT_INCOMPLETE'
      USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object('prepared',true,'club_id',p_club_id,
    'tournament_leases_removed',v_deleted);
END
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_prepare_unused_welcome_certification_board_leases(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_prepare_unused_welcome_certification_board_leases(uuid) TO postgres;

CREATE OR REPLACE FUNCTION public.fn_ca_prepare_unused_welcome_certification_board_origins(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_club public.clubs%ROWTYPE;
  v_owner_email text;
  v_board_tournaments uuid[] := '{}';
  v_board_tables uuid[] := '{}';
  v_expected_count integer := 0;
  v_origin_count integer := 0;
  v_deleted integer := 0;
  v_cutoff timestamptz := clock_timestamp() - interval '10 minutes';
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'service_role_only' USING ERRCODE='42501';
  END IF;

  SELECT * INTO v_club FROM public.clubs WHERE id=p_club_id;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.club_welcome_entitlements e WHERE e.club_id=p_club_id
  ) THEN
    RETURN jsonb_build_object('prepared',false,'reason','no_welcome_fixture',
      'origins_removed',0);
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

  /* A CERTIFICATION FIXTURE NEVER QUEUES IN FRONT OF THE PLATFORM (2026-10-03).
     Every buy-in, registration, seat and launch takes this gate SHARED. A
     waiting exclusive request sits in the lock queue and every later shared
     request queues behind it, so while this fixture waited for the gate the
     whole platform's purchases waited for the fixture (in the 24 h to 00:30
     UTC 2026-10-04: 79 fixture waits of 1 s or more, up to 7.6 s, with about
     4,500 purchase waits of 1 s or more on the gate). The fixture now asks
     without queueing, every 50 ms for up to 30 s, and still holds the gate
     exclusively to the end of its transaction once it has it. */
  DECLARE
    v_gate_tries integer := 0;
  BEGIN
    WHILE NOT pg_try_advisory_xact_lock(530090,1) LOOP
      v_gate_tries := v_gate_tries + 1;
      IF v_gate_tries >= 600 THEN
        RAISE EXCEPTION 'CERTIFICATION_FIXTURE_GATE_BUSY' USING ERRCODE = '55P03';
      END IF;
      PERFORM pg_sleep(0.05);
    END LOOP;
  END;

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
     AND t.current_players=0 AND t.started_at IS NULL AND t.ended_at IS NULL
;

  IF cardinality(v_board_tournaments)=0 THEN
    RETURN jsonb_build_object('prepared',true,'club_id',p_club_id,'origins_removed',0);
  END IF;
  IF cardinality(v_board_tournaments)<>v_expected_count
     OR cardinality(v_board_tournaments)>12 THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_BOARD_ORIGIN_LINEAGE_REFUSED'
      USING ERRCODE='55000';
  END IF;

  PERFORM 1 FROM public.tournaments t
   WHERE t.id=ANY(v_board_tournaments) ORDER BY t.id FOR UPDATE;
  PERFORM 1 FROM public.tables t
   WHERE t.tournament_id=ANY(v_board_tournaments) ORDER BY t.id FOR UPDATE;
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
)) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_BOARD_ORIGIN_LINEAGE_REFUSED'
      USING ERRCODE='55000';
  END IF;

  PERFORM 1 FROM public.tournament_table_origins o
   WHERE o.table_id=ANY(v_board_tables) ORDER BY o.table_id FOR UPDATE;
  SELECT count(*) INTO v_origin_count FROM public.tournament_table_origins o
   WHERE o.table_id=ANY(v_board_tables);
  IF v_origin_count<>cardinality(v_board_tables)
     OR EXISTS(
       SELECT 1 FROM public.tables b
       LEFT JOIN public.tournament_table_origins o ON o.table_id=b.id
        WHERE b.id=ANY(v_board_tables)
          AND (o.table_id IS NULL
            OR o.tournament_id IS DISTINCT FROM b.tournament_id
            OR o.origin_kind IS DISTINCT FROM 'prelaunch'
            OR o.launch_id IS NOT NULL
            OR o.launch_lease_generation IS NOT NULL)
     ) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_BOARD_ORIGIN_LINEAGE_REFUSED'
      USING ERRCODE='55000';
  END IF;

  DELETE FROM public.tournament_table_origins o
   WHERE o.table_id=ANY(v_board_tables)
     AND o.origin_kind='prelaunch'
     AND o.launch_id IS NULL AND o.launch_lease_generation IS NULL;
  GET DIAGNOSTICS v_deleted=ROW_COUNT;
  IF v_deleted<>v_origin_count
     OR EXISTS(SELECT 1 FROM public.tournament_table_origins o
                WHERE o.table_id=ANY(v_board_tables)) THEN
    RAISE EXCEPTION 'WELCOME_CERTIFICATION_BOARD_ORIGIN_RETIREMENT_INCOMPLETE'
      USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object('prepared',true,'club_id',p_club_id,
    'origins_removed',v_deleted);
END
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_prepare_unused_welcome_certification_board_origins(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_prepare_unused_welcome_certification_board_origins(uuid) TO postgres;

CREATE OR REPLACE FUNCTION public.sp_prune_hand_history(p_batch integer DEFAULT 2500)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_budget constant interval := interval '20 seconds';
  v_deadline timestamptz := clock_timestamp()+v_budget;
  v_days integer;
  v_window interval;
  v_doomed uuid[];
  v_keepers uuid[];
  v_deleted integer := 0;
  v_round integer;
  -- THE SCAN RESUMES WHERE IT LEFT OFF (2026-10-26, migration 20261026133101).
  -- v_resume_after is the newest created_at this pass has examined; the
  -- candidate scan starts after it, so a row a guard retains is evaluated
  -- once per pass rather than once per round. Measured before: 219,000
  -- retained rows re-read every round, 7.2 s of each round, 90% of the day.
  v_pass_length constant interval := interval '60 minutes';
  v_resume_after timestamptz;
  v_pass_started timestamptz;
  v_reached timestamptz;
BEGIN
  -- Retention never holds the maintenance lane while the platform is frozen.
  IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RETURN 0; END IF;
  -- Preserve the original maintenance/settlement owner before any ledger read.
  IF pg_catalog.pg_try_advisory_xact_lock_shared(530090,1) IS NOT TRUE THEN RETURN 0; END IF;
  -- Recheck after admission before the policy and accounting reads.
  IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RETURN 0; END IF;
  SELECT greatest(coalesce(horse_retention_days,8),1)
    INTO v_days FROM public.hand_history_retention_policy LIMIT 1;
  IF v_days IS NULL THEN v_days := 8; END IF;
  v_window := make_interval(days=>v_days);
  INSERT INTO smarter_private.hand_history_prune_cursor(singleton) VALUES(true) ON CONFLICT DO NOTHING;
  SELECT c.resume_after,c.pass_started_at INTO v_resume_after,v_pass_started
    FROM smarter_private.hand_history_prune_cursor c WHERE c.singleton FOR UPDATE;
  IF v_pass_started IS NULL OR v_pass_started<clock_timestamp()-v_pass_length THEN
    v_resume_after := NULL;
    v_pass_started := clock_timestamp();
  END IF;

  LOOP
    v_doomed := NULL;
    v_keepers := NULL;
    WITH candidates AS (
      SELECT hh.id,hh.players,hh.created_at,
             (hh.table_id IS NULL AND hh.tournament_id IS NULL
              AND hh.players = '[]'::jsonb) AS unattached
        FROM public.hand_history hh
       WHERE hh.has_human IS FALSE
         AND NOT EXISTS (SELECT 1 FROM smarter_private.hand_submissions original
           WHERE original.table_id=hh.table_id AND original.hand_number=hh.hand_number
             AND (original.request#>'{p_hand_row,has_human}') IS DISTINCT FROM 'false'::jsonb)
         AND NOT EXISTS (SELECT 1 FROM public.poker_diamond_jackpot_hits dj
           WHERE dj.table_id=hh.table_id AND dj.hand_number=hh.hand_number AND dj.paid)
         AND hh.reported IS NOT true
         AND smarter_private.horse_cash_retention_accounting_ready(hh.table_id,hh.hand_number)
         AND (hh.table_id IS NULL OR EXISTS (SELECT 1 FROM public.hand_atomic_commits a WHERE a.hand_id=hh.id AND a.table_id=hh.table_id AND a.hand_number=hh.hand_number AND isfinite(a.post_commit_completed_at) AND a.post_commit_completed_at<now()-v_window AND a.post_commit_result->>'ok'='true'))
         AND hh.created_at<now()-v_window
         -- Resume after the newest row this pass has already examined
         -- (migration 20261026133101). NULL is a fresh pass from the oldest row.
         AND hh.created_at>COALESCE(v_resume_after,'-infinity'::timestamptz)
         -- A SEALED RESTORATION CASE KEEPS THE HANDS IT CITES (2026-10-14). The
         -- finite witness re-reads the atomic commit of every cited hand; a pruned
         -- hand voids the case and halts the weekly union accounting for ever.
         AND NOT EXISTS (SELECT 1 FROM smarter_private.original_inventory_restoration_cases rc,
                               jsonb_array_elements(rc.source_refs) sr
                         WHERE sr->>'kind' IN ('atomic_economics','signed_economics')
                           AND sr->>'id'=hh.id::text)
         AND NOT EXISTS (
           SELECT 1 FROM public.bbj_payouts bp
            WHERE bp.table_id=hh.table_id AND bp.hand_number=hh.hand_number)
         AND NOT EXISTS (
           SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id=hh.id)
         AND NOT EXISTS (
           SELECT 1 FROM public.tournament_knockout_candidates c
            WHERE c.hand_id=hh.id AND c.state='pending')
         -- AN UNSETTLED TOURNAMENT KEEPS ITS HANDS (2026-10-02). A tournament
         -- hand is evidence until its event's money is settled: the event is
         -- COMPLETED or CANCELLED, its bounty pool is fully paid, and its
         -- escrow, when it has one, is closed. PKO 3f19bd70 lost the only record
         -- of who knocked out whom while 2,310.00 of its bounty pool was unpaid.
         -- Cash rake records are never deleted here (20260925143224), so a cash
         -- week keeps its per-player rakeback basis settled or not.
         -- Migration 20261002082452.
         AND (hh.tournament_id IS NULL OR NOT EXISTS (
           SELECT 1 FROM public.tournaments ut
            WHERE ut.id=hh.tournament_id
              AND (upper(COALESCE(ut.status::text,'')) NOT IN ('COMPLETED','CANCELLED','CANCELED')
                   OR COALESCE(ut.bounty_pool,0)>COALESCE(ut.bounty_pool_paid,0)
                   OR EXISTS (SELECT 1 FROM public.tournament_escrow ue
                               WHERE ue.tournament_id=ut.id AND ue.closed_at IS NULL))))
         -- A hand whose F06 permit is still 'reserved' is unresolved, and this
         -- row is original evidence for it:
         -- smarter_private.f06_retired_origin_snapshot and
         -- smarter_private.f06_retained_mtt_abort_snapshot both read
         -- public.hand_history and public.hand_atomic_commits. All four DELETEs
         -- below key off the ids chosen here, so excluding the hand at this one
         -- point retains its history, atomic commit, rake attribution and
         -- player-index rows together. Excluding it from the candidate set
         -- rather than from each DELETE also keeps it out of v_keepers, so no
         -- has_human=true is written that would retain it past its permit, and
         -- it never consumes a p_batch slot. Retention ends when the permit
         -- leaves 'reserved'; every other row prunes on the same boundary as
         -- before. The lookup goes through the SECURITY DEFINER helper added by
         -- migration 20260920232341, because this function is SECURITY INVOKER
         -- and its search_path does not include smarter_private.
         AND NOT smarter_private.f06_hand_cards_unresolved(hh.table_id,hh.hand_number::bigint)
         -- AND the hand that IS the table's current movement boundary, for a
         -- table F06 can still be asked to move. The guard above protects the
         -- unresolved HAND -- which never started and has no row here -- so it
         -- reached straight past the hands the table already dealt, and
         -- smarter_private.f06_movement_prior loads the last of those by
         -- max(hand_number) and validates its post-commit payload hash,
         -- request hash and stack receipt out of it. Delete it and that table
         -- raises F06_MOVEMENT_PRIOR_INCOMPLETE for ever: on 2026-09-25 one
         -- seated player in a RUNNING freeroll was about six retention runs
         -- from exactly that. One hand per live table, and it stops being the
         -- boundary as soon as the table deals another. Migration
         -- 20260925210126.
         AND NOT smarter_private.f06_movement_boundary_retained(hh.table_id,hh.hand_number::bigint)
         -- Missing/blank classification or conflicting ownership stays retained.
         -- A known Spin's history remains evidence until canonical terminal
         -- state commits; do not require a first legacy receipt to exist.
         -- AN UNATTACHED ROW IS NOT A HAND ANYBODY PLAYED (2026-10-05). A row
         -- with no table, no tournament and nobody dealt in is the settled-hand
         -- fixture tests/e2e/production-daily-missions.spec.ts inserts and
         -- deletes; a run killed before its finally block leaves it behind.
         -- The engine never writes one. tb.id=hh.table_id is never true for a
         -- NULL table_id, so the EXISTS below excluded such a row from every
         -- run, and even admitted, an empty player list classifies as human
         -- below and would be kept for ever. Every guard above still governs
         -- it (both f06 helpers read false for a NULL table_id, measured on
         -- all eight such rows). Migration 20261005111120.
         AND ((hh.table_id IS NULL AND hh.tournament_id IS NULL
               AND hh.players = '[]'::jsonb) OR EXISTS (
           SELECT 1 FROM public.tables tb
           LEFT JOIN public.tournaments t ON t.id=tb.tournament_id
            WHERE tb.id=hh.table_id
              AND (hh.tournament_id IS NULL
                   OR hh.tournament_id=tb.tournament_id)
              AND (
                (hh.tournament_id IS NULL AND tb.tournament_id IS NULL)
                OR (
                  t.id IS NOT NULL
                  AND NULLIF(btrim(t.variant::text),'') IS NOT NULL
                  AND NULLIF(btrim(t.tournament_type::text),'') IS NOT NULL
                  AND (
                    (lower(t.variant::text)<>'spin'
                     AND upper(t.tournament_type::text)<>'SPIN')
                    OR (upper(COALESCE(t.status::text,''))='COMPLETED'
                        AND EXISTS (
                          SELECT 1 FROM public.tournament_terminal_settlements terminal
                           WHERE terminal.tournament_id=t.id))
                    OR (upper(COALESCE(t.status::text,'')) IN ('CANCELLED','CANCELED')
                        AND EXISTS (
                          SELECT 1 FROM public.tournament_cancellation_receipts cancellation
                           WHERE cancellation.tournament_id=t.id))
                  )
                )
              )
         ))
       ORDER BY hh.created_at
       LIMIT LEAST(GREATEST(p_batch,1),250)
       FOR UPDATE SKIP LOCKED
    ), classified AS (
      SELECT c.id,c.created_at,
        CASE
          WHEN c.unattached THEN false
          WHEN jsonb_typeof(c.players) IS DISTINCT FROM 'array' THEN true
          WHEN jsonb_array_length(c.players)=0 THEN true
          ELSE EXISTS (
            SELECT 1
              FROM jsonb_array_elements(c.players) e
              LEFT JOIN public.profiles p ON p.id=(CASE
                WHEN length(e.value->>'userId')=36
                 AND (e.value->>'userId') ~
                   '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                THEN (e.value->>'userId')::uuid END)
             WHERE p.id IS NULL OR p.is_horse IS NOT true)
        END AS is_human
        FROM candidates c
    )
    SELECT array_agg(id) FILTER (WHERE is_human IS false),
           array_agg(id) FILTER (WHERE is_human IS DISTINCT FROM false),
           max(created_at)
      INTO v_doomed,v_keepers,v_reached FROM classified;

    IF v_doomed IS NULL AND v_keepers IS NULL THEN
      v_resume_after := now()-v_window;
      EXIT;
    END IF;
    v_resume_after := GREATEST(COALESCE(v_resume_after,'-infinity'::timestamptz),v_reached);
    IF v_keepers IS NOT NULL AND cardinality(v_keepers)>0 THEN
      UPDATE public.hand_history SET has_human=true WHERE id=ANY(v_keepers);
    END IF;
    IF v_doomed IS NOT NULL AND cardinality(v_doomed)>0 THEN
      -- A RECORDED EARNING SOURCE IS NOT HAND HISTORY (2026-09-25).
      -- This line used to delete the pruned hands rake attributions, and
      -- every run of sp_prune_hand_history_10m raised
      -- recorded_cash_earning_source_is_immutable for it: the trigger
      -- accounting_cash_source_immutable refuses to move an attribution once
      -- accounting_cash_accrual_batches holds a batch for its rake record.
      -- The trigger is right and the DELETE was never required: there is no
      -- foreign key from rake_attributions.hand_id to hand_history.id. It
      -- also fired trg_ca_club_rake_daily_user_del, which would have
      -- decremented the per-club per-user daily rake rollup - the rakeback
      -- basis - for every horse in every pruned hand (CLAUDE.md 10.5).
      -- Retention is a storage decision about hand HISTORY (10.5, eight
      -- days); the money ledger is not pruned, so attributions are kept.
      -- RETENTION CLOSES THE SETTLEMENT REQUEST IT PRUNES (2026-09-28).
      -- The commit row below is how fn_ca_resume_hand_submission knows a
      -- hand finished. Deleting it without closing the request leaves the
      -- table looking mid-hand for ever, and the next successor refuses to
      -- start it (HAND_SUBMISSION_HANDOFF_STATE_CHANGED). Receipted here,
      -- in the same transaction, while table_id and hand_number are still
      -- readable from the rows about to go.
      PERFORM smarter_private.hand_submission_retention_disposal(v_doomed,
        'Retention pruned this settled hand under the horse hand-history policy; its durable record (atomic commit and history) has aged out, so the retained settlement request is closed here and must never be applied again. Zero credit: the hand settled when it was played.');
      PERFORM smarter_private.compact_horse_settlement_keys(v_doomed);
      PERFORM smarter_private.compact_horse_cash_play_contents(v_doomed);
      PERFORM smarter_private.archive_pruned_hand_index(v_doomed);
      DELETE FROM public.hand_atomic_commits WHERE hand_id=ANY(v_doomed);
      DELETE FROM public.hand_history WHERE id=ANY(v_doomed);
      GET DIAGNOSTICS v_round=ROW_COUNT;
      v_deleted := v_deleted+v_round;
    END IF;
    EXIT WHEN clock_timestamp()>=v_deadline;
  END LOOP;
  UPDATE smarter_private.hand_history_prune_cursor
     SET resume_after=v_resume_after,pass_started_at=v_pass_started,updated_at=clock_timestamp()
   WHERE singleton;
  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION public.sp_prune_hand_history(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sp_prune_hand_history(integer) TO postgres;
