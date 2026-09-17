CREATE OR REPLACE FUNCTION public.credit_agent_commission_from_rake(p_agent_user_id uuid, p_club_id uuid, p_rake_credit numeric, p_source_type text DEFAULT 'rake_settlement'::text, p_source_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent_id          UUID;
  v_agent_user_id     UUID;
  v_commission_rate   NUMERIC;
  v_parent_agent_id   UUID;
  v_parent_user_id    UUID;
  v_parent_rate       NUMERIC;
  v_direct_commission NUMERIC;
  v_parent_commission NUMERIC;
  v_remaining         NUMERIC;
  v_book_club         UUID;
  v_inserted_direct   INTEGER := 0;
BEGIN
  -- UNION LAW: the agent follows the PLAYER's club, not the table's club.
  v_book_club := public.fn_resolve_player_club_for_agent(p_agent_user_id, p_club_id, NULL);

  SELECT a.id, a.user_id, a.commission_rate, a.parent_agent_id
    INTO v_agent_id, v_agent_user_id, v_commission_rate, v_parent_agent_id
    FROM club_members cm
    JOIN agents a ON a.user_id = cm.agent_id AND a.club_id = cm.club_id AND a.status = 'active'
   WHERE cm.user_id = p_agent_user_id AND cm.club_id = v_book_club
   LIMIT 1;

  -- The caller may itself be an agent generating rake.
  IF v_agent_id IS NULL THEN
    SELECT id, user_id, commission_rate, parent_agent_id
      INTO v_agent_id, v_agent_user_id, v_commission_rate, v_parent_agent_id
      FROM agents WHERE user_id = p_agent_user_id AND status = 'active'
     ORDER BY (club_id = v_book_club) DESC
     LIMIT 1;
  END IF;

  IF v_agent_id IS NULL THEN RETURN; END IF;

  -- Idempotency is per AGENT and source, never per source alone: a hand has
  -- one row per agent in the chain of every contributing player, and only a
  -- retry for the same agent returns here (Chip Standard P4, lane 2.2).
  IF p_source_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM agent_commissions
     WHERE source_id = p_source_id AND source_type = p_source_type
       AND user_id = v_agent_user_id
     LIMIT 1
  ) THEN
    RETURN;
  END IF;

  v_direct_commission := ROUND(p_rake_credit * COALESCE(v_commission_rate, 0), 2);
  v_remaining         := p_rake_credit - v_direct_commission;

  IF v_direct_commission > 0 THEN
    INSERT INTO agent_commissions (
      club_id, user_id, amount, commission_rate, source_type, source_id, notes
    ) VALUES (
      COALESCE(v_book_club, p_club_id), v_agent_user_id, v_direct_commission, v_commission_rate,
      p_source_type, p_source_id, COALESCE(p_notes, 'agent slice (accrual)')
    )
    ON CONFLICT (user_id, source_id, source_type) WHERE source_id IS NOT NULL
    DO NOTHING;
    GET DIAGNOSTICS v_inserted_direct = ROW_COUNT;

    IF v_inserted_direct > 0 THEN
      UPDATE agents SET
        weekly_rake_generated   = COALESCE(weekly_rake_generated, 0)   + p_rake_credit,
        lifetime_rake_generated = COALESCE(lifetime_rake_generated, 0) + p_rake_credit,
        last_active_at          = NOW(),
        updated_at              = NOW()
      WHERE id = v_agent_id;
    END IF;
  END IF;

  -- Super-agent override on the downstream volume (PokerBros model).
  IF v_parent_agent_id IS NOT NULL AND v_remaining > 0 THEN
    SELECT id, user_id, commission_rate
      INTO v_parent_agent_id, v_parent_user_id, v_parent_rate
      FROM agents WHERE id = v_parent_agent_id AND status = 'active'
     LIMIT 1;

    IF v_parent_agent_id IS NOT NULL AND v_parent_rate IS NOT NULL THEN
      v_parent_commission := ROUND(v_remaining * v_parent_rate, 2);
      IF v_parent_commission > 0 THEN
        INSERT INTO agent_commissions (
          club_id, user_id, amount, commission_rate, source_type, source_id, notes
        ) VALUES (
          COALESCE(v_book_club, p_club_id), v_parent_user_id, v_parent_commission, v_parent_rate,
          p_source_type, p_source_id, 'super-agent slice (accrual)'
        )
        ON CONFLICT (user_id, source_id, source_type) WHERE source_id IS NOT NULL
        DO NOTHING;
      END IF;
    END IF;
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.calculate_cascading_commission(p_hand_id uuid DEFAULT NULL::uuid, p_club_id uuid DEFAULT NULL::uuid, p_player_user_id uuid DEFAULT NULL::uuid, p_rake_amount numeric DEFAULT 0, p_rake_record_id uuid DEFAULT NULL::uuid, p_table_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_book_club     uuid;
  v_agent_user    uuid;
  v_cur_id        uuid;
  v_cur_user      uuid;
  v_cur_rate      numeric;
  v_cur_role      text;
  v_parent        uuid;
  v_remaining     numeric;
  v_slice         numeric;
  v_rate          numeric;
  v_results       jsonb := '[]'::jsonb;
  v_commission_id uuid;
  v_club_owner_id uuid;
  v_depth         int := 0;
BEGIN
  IF p_rake_amount IS NULL OR p_rake_amount <= 0 OR p_club_id IS NULL OR p_player_user_id IS NULL THEN
    RETURN jsonb_build_object('success', true, 'commissions', v_results, 'skipped', 'missing_inputs');
  END IF;

  v_remaining := p_rake_amount;

  -- UNION LAW: attribute to the player's own club, not the union house club.
  v_book_club := COALESCE(
    public.fn_resolve_player_club_for_agent(p_player_user_id, p_club_id, p_table_id),
    p_club_id);

  -- The player's direct upline.
  SELECT cm.agent_id INTO v_agent_user
    FROM club_members cm
   WHERE cm.user_id = p_player_user_id AND cm.club_id = v_book_club
     AND cm.agent_id IS NOT NULL
   LIMIT 1;

  IF v_agent_user IS NOT NULL THEN
    SELECT a.id, a.user_id, a.commission_rate, a.role, a.parent_agent_id
      INTO v_cur_id, v_cur_user, v_cur_rate, v_cur_role, v_parent
      FROM agents a
     WHERE a.user_id = v_agent_user AND a.status = 'active'
     ORDER BY (a.club_id = v_book_club) DESC
     LIMIT 1;
  END IF;

  -- Climb: sub_agent -> agent -> super_agent, each taking its override on
  -- what remains below it.
  WHILE v_cur_id IS NOT NULL AND v_depth < 10 AND v_remaining > 0 LOOP
    v_depth := v_depth + 1;

    v_rate := CASE WHEN COALESCE(v_cur_rate,0) > 1 THEN v_cur_rate / 100.0
                   ELSE COALESCE(v_cur_rate,0) END;
    v_slice := ROUND(v_remaining * v_rate, 4);

    IF v_slice > 0 THEN
      INSERT INTO public.agent_commissions
        (club_id, user_id, amount, commission_rate, source_type, source_id, notes)
      VALUES
        (v_book_club, v_cur_user, v_slice, v_cur_rate, 'rake',
         COALESCE(p_rake_record_id, p_hand_id),
         COALESCE(v_cur_role,'agent') || ' slice (tier ' || v_depth || ')')
      RETURNING id INTO v_commission_id;

      v_results := v_results || jsonb_build_object(
        'tier', COALESCE(v_cur_role,'agent'), 'depth', v_depth,
        'user_id', v_cur_user, 'amount', v_slice, 'commission_id', v_commission_id);

      v_remaining := v_remaining - v_slice;
    END IF;

    -- step up to the override holder
    IF v_parent IS NULL THEN
      v_cur_id := NULL;
    ELSE
      SELECT a.id, a.user_id, a.commission_rate, a.role, a.parent_agent_id
        INTO v_cur_id, v_cur_user, v_cur_rate, v_cur_role, v_parent
        FROM agents a WHERE a.id = v_parent AND a.status = 'active';
      IF NOT FOUND THEN v_cur_id := NULL; END IF;
    END IF;
  END LOOP;

  -- Whatever survives the chain belongs to the club.
  SELECT owner_id INTO v_club_owner_id FROM public.clubs WHERE id = v_book_club;
  IF v_club_owner_id IS NOT NULL AND v_remaining > 0 THEN
    INSERT INTO public.agent_commissions
      (club_id, user_id, amount, commission_rate, source_type, source_id, notes)
    VALUES
      (v_book_club, v_club_owner_id, v_remaining, NULL, 'rake',
       COALESCE(p_rake_record_id, p_hand_id), 'club owner residual')
    RETURNING id INTO v_commission_id;
    v_results := v_results || jsonb_build_object('tier','owner',
      'user_id', v_club_owner_id, 'amount', v_remaining, 'commission_id', v_commission_id);
  END IF;

  UPDATE public.club_wallets
     SET period_commission_paid   = period_commission_paid   + p_rake_amount,
         lifetime_commission_paid = lifetime_commission_paid + p_rake_amount,
         updated_at = NOW()
   WHERE club_id = v_book_club;

  RETURN jsonb_build_object('success', true, 'hand_id', p_hand_id, 'club_id', v_book_club,
    'player_user_id', p_player_user_id, 'rake_amount', p_rake_amount,
    'tiers_paid', v_depth, 'commissions', v_results);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_process_weekly_accounting(p_union_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_club record; v_pass int; v_batch jsonb; v_credit jsonb; v_started timestamptz; 
  v_now timestamptz := clock_timestamp();
  v_to timestamptz := public.fn_union_week_start(v_now);
  v_from timestamptz;
  v_first timestamptz;
  v_end timestamptz;
  v_due timestamptz;
  v_union record;
  v_previous jsonb;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_orphans integer;
  v_orphan_amount numeric;
  v_complete boolean;
  v_failed integer := 0;
  v_checked integer := 0;
  v_msg text; v_detail text; v_state text;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'not_authorised' USING ERRCODE = '42501';
  END IF;
  -- Transaction locks release on errors and also work in reused connections.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN
    RETURN jsonb_build_object('success',true,'skipped',true,'reason','already_running');
  END IF;
  IF public.fn_platform_frozen() OR extract(minute FROM v_now) >= 45 THEN
    RETURN jsonb_build_object('success',true,'skipped',true,'reason','maintenance_window');
  END IF;

  FOR v_union IN SELECT u.id, f.earliest_period_start
    FROM public.unions u LEFT JOIN public.union_settlement_floor f ON f.union_id=u.id WHERE p_union_id IS NULL OR u.id=p_union_id ORDER BY u.id
  LOOP
    -- Catch up chronologically from the explicit clean-data floor. A union
    -- without one starts at the just-closed week, never an invented history.
    v_first := COALESCE(public.fn_union_week_start(v_union.earliest_period_start),
                        public.fn_union_prev_week_start(v_now));
    IF v_first < v_union.earliest_period_start THEN
      v_first := public.fn_union_week_start(v_first + interval '8 days');
    END IF;
    v_from := v_first;
    WHILE v_from < v_to LOOP
      v_end := public.fn_union_week_start(v_from + interval '8 days');
      v_due := public.fn_union_accounting_run_at(v_end);
      IF v_now < v_due THEN EXIT; END IF;

      SELECT result INTO v_previous FROM public.union_accounting_runs
       WHERE union_id=v_union.id AND period_start=v_from AND period_end=v_end;
      SELECT count(*), COALESCE(sum(rakeback_amount),0) INTO v_orphans,v_orphan_amount
        FROM public.rakeback_periods rp
       WHERE rp.club_id=v_union.id AND rp.status='pending' AND rp.rakeback_amount>0
         AND (rp.period_start::timestamp AT TIME ZONE 'UTC') < v_end
         AND ((rp.period_end+1)::timestamp AT TIME ZONE 'UTC') > v_from;

      SELECT NOT EXISTS (
        SELECT 1 FROM generate_series(1,4) n
        WHERE NOT EXISTS (SELECT 1 FROM public.union_settlement_rounds r
          WHERE r.union_id=v_union.id AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=n
            AND CASE
              WHEN n=1 THEN r.detail->>'success'='true'
              WHEN n IN(2,3) THEN
                COALESCE(r.detail->'latest_attempt',r.detail)->>'amount' IS NOT NULL
                AND COALESCE(r.detail->'latest_attempt',r.detail)->>'payees' IS NOT NULL
                AND COALESCE(r.detail->'latest_attempt',r.detail)->'shortfalls'='0'::jsonb
                AND COALESCE(COALESCE(r.detail->'latest_attempt',r.detail)->>'success','true')='true'
              ELSE r.detail->>'success'='true' AND COALESCE(r.detail->>'skipped','false')='false'
            END)) INTO v_complete;

      v_complete := v_complete AND NOT EXISTS (
        SELECT 1 FROM public.rakeback_periods rp
        JOIN public.union_clubs uc ON uc.club_id=rp.club_id AND uc.union_id=v_union.id
        WHERE rp.status='pending' AND rp.rakeback_amount>0
          AND rp.period_start >= (v_from AT TIME ZONE 'UTC')::date
          AND ((rp.period_end+1)::timestamp AT TIME ZONE 'UTC') <= v_end)
        AND NOT EXISTS (SELECT 1 FROM public.union_clubs uc
          WHERE uc.union_id=v_union.id AND uc.club_id<>v_union.id
            AND NOT EXISTS (SELECT 1 FROM public.settlement_invoices si
              WHERE si.club_id=uc.club_id AND si.invoice_type='union_weekly_squareup'
                AND si.breakdown->>'union_id'=v_union.id::text
                AND (si.breakdown->>'period_start')::timestamptz=v_from
                AND (si.breakdown->>'period_end')::timestamptz=v_end
                AND si.message_sent=true AND si.status<>'cancelled'));

      v_complete:=v_complete AND NOT EXISTS(SELECT 1 FROM public.union_clubs uc
        WHERE uc.union_id=v_union.id AND uc.club_id<>v_union.id AND NOT EXISTS(
          SELECT 1 FROM public.settlement_invoices i JOIN public.settlement_periods sp ON sp.id=i.period_id
          WHERE i.club_id=uc.club_id AND i.invoice_type='club_weekly_accounting' AND i.message_sent
            AND sp.start_at=v_from AND sp.end_at=v_end));
      IF v_complete AND v_orphans=0 AND v_previous->>'success'='true' AND v_previous->>'accounting_version'='2' THEN
        v_from:=v_end; CONTINUE;
      END IF;
      -- Bounded recovery: never let a large history monopolize live wallets.
      IF v_checked>=8 OR clock_timestamp()-v_now>interval '15 minutes'
        OR extract(minute FROM clock_timestamp())>=45 OR public.fn_platform_frozen() THEN
        RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,
          'more_remaining',true,'detail',v_results);
      END IF;
      INSERT INTO public.union_accounting_runs
        (union_id,period_start,period_end,scheduled_at,status,attempts,started_at)
      VALUES (v_union.id,v_from,v_end,v_due,'running',1,clock_timestamp())
      ON CONFLICT(union_id,period_start,period_end) DO UPDATE
        SET status='running',attempts=union_accounting_runs.attempts+1,started_at=clock_timestamp();

      -- Only this block may move chips. Any refused downstream stage raises
      -- and rolls back the whole union attempt, while the failure record below
      -- survives. Other unions have independent ledgers and transaction scopes.
      BEGIN
        IF EXISTS(SELECT 1 FROM public.rake_records rr LEFT JOIN public.daemon_state ds ON ds.daemon='rakeback_settler'
          WHERE NOT COALESCE(rr.is_tournament,false) AND rr.tournament_id IS NULL AND rr.rake_amount>0
            AND rr.created_at>=v_from AND rr.created_at<v_end
            AND (rr.club_id=v_union.id OR EXISTS(SELECT 1 FROM public.union_clubs uc WHERE uc.union_id=v_union.id AND uc.club_id=rr.club_id))
            AND (ds.high_water_mark IS NULL OR rr.created_at>ds.high_water_mark OR
              (rr.created_at=ds.high_water_mark AND (ds.high_water_mark_id IS NULL OR rr.id>ds.high_water_mark_id)))) THEN
          RAISE EXCEPTION 'weekly_rake_source_not_fully_accrued';
        END IF;
        IF v_orphans>0 THEN
          RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='union_rakeback_wrong_club',
            DETAIL=jsonb_build_object('pending_periods',v_orphans,'pending_amount',v_orphan_amount)::text;
        END IF;
        IF v_complete AND v_previous->>'accounting_version'='2' THEN
          v_result:=jsonb_build_object('success',true,'already_posted',true);
        ELSE
          v_result:=public.fn_union_settlement_cascade(v_union.id,v_from,v_end);
          IF v_result->>'success' IS DISTINCT FROM 'true' THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='union_settlement_incomplete',DETAIL=v_result::text;
          END IF;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT,v_detail=PG_EXCEPTION_DETAIL,v_state=RETURNED_SQLSTATE;
        v_result:=jsonb_build_object('success',false,'error',v_msg,'sqlstate',v_state,'detail',v_detail);
      END;

      IF v_result->>'success'='true' THEN v_result:=v_result||jsonb_build_object('accounting_version',2); END IF;
      v_checked:=v_checked+1;
      UPDATE public.union_accounting_runs
         SET status=CASE WHEN v_result->>'success'='true' THEN 'complete' ELSE 'failed' END,
             finished_at=clock_timestamp(),result=v_result
       WHERE union_id=v_union.id AND period_start=v_from AND period_end=v_end;
      IF v_result->>'success' IS DISTINCT FROM 'true' THEN
        v_failed:=v_failed+1;
        -- Report a new failure or a changed failure, not the same alert every tick.
        IF v_previous IS DISTINCT FROM v_result THEN
          INSERT INTO public.financial_alerts(source,severity,message,context)
          VALUES ('union_accounting_scheduler','critical','Weekly union accounting is incomplete',
            jsonb_build_object('union_id',v_union.id,'period_start',v_from,'period_end',v_end,
                               'scheduled_at',v_due,'result',v_result));
        END IF;
      END IF;
      v_results:=v_results||jsonb_build_array(jsonb_build_object('union_id',v_union.id,
        'period_start',v_from,'period_end',v_end,'result',v_result));
      -- Resolve an older period before posting a later one for the same union.
      IF v_result->>'success' IS DISTINCT FROM 'true' THEN EXIT; END IF;
      v_from:=v_end;
    END LOOP;
  END LOOP;

  -- Standalone clubs use the same schedule and caller. Existing payout rules
  -- remain scoped to that club; no standalone batch can bypass union stages.
  IF p_union_id IS NULL AND v_now>=public.fn_union_accounting_run_at(v_to) THEN
    v_from:=public.fn_union_prev_week_start(v_now);
    FOR v_club IN SELECT c.id FROM public.clubs c
      WHERE NOT EXISTS(SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=c.id)
        AND NOT EXISTS(SELECT 1 FROM public.unions u WHERE u.id=c.id)
        AND (EXISTS(SELECT 1 FROM public.rakeback_periods rp WHERE rp.club_id=c.id AND rp.status='pending' AND rp.period_end<(v_to AT TIME ZONE 'America/Los_Angeles')::date)
          OR EXISTS(SELECT 1 FROM public.agents a WHERE a.club_id=c.id AND NOT COALESCE(a.is_prepaid,false) AND a.credit_used>0))
      ORDER BY c.id
    LOOP
      IF extract(minute FROM clock_timestamp())>=45 OR public.fn_platform_frozen() THEN
        RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,'more_remaining',true,'detail',v_results);
      END IF;
      BEGIN
        v_started:=clock_timestamp();v_pass:=0;
        LOOP
          v_batch:=public.fn_settle_club_rakeback_batch(v_club.id,40,4.0,2);
          IF v_batch->>'success' IS DISTINCT FROM 'true' OR COALESCE((v_batch->>'errors')::int,0)>0 THEN
            RAISE EXCEPTION 'standalone_weekly_payout_failed' USING DETAIL=(v_batch-'elapsed_seconds'-'clock_ran_out')::text; END IF;
          EXIT WHEN COALESCE((v_batch->>'periods_remaining')::int,0)=0;
          v_pass:=v_pass+1;
          IF COALESCE((v_batch->>'periods_settled')::int,0)=0 OR v_pass>=250 OR clock_timestamp()-v_started>interval '30 seconds' THEN
            RAISE EXCEPTION 'standalone_weekly_payout_incomplete' USING DETAIL=(v_batch-'elapsed_seconds'-'clock_ran_out')::text; END IF;
        END LOOP;
        v_credit:=public.fn_generate_scope_credit_invoices(v_club.id,v_from,v_to);
        INSERT INTO public.daemon_state(daemon,high_water_mark,updated_at)
         VALUES('weekly_accounting:'||v_club.id::text,v_to,clock_timestamp())
         ON CONFLICT(daemon) DO UPDATE SET high_water_mark=excluded.high_water_mark,updated_at=excluded.updated_at;
        v_result:=jsonb_build_object('success',true,'credit_invoices',v_credit,'accounting_version',2);
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT,v_detail=PG_EXCEPTION_DETAIL,v_state=RETURNED_SQLSTATE;
        v_result:=jsonb_build_object('success',false,'error',v_msg,'sqlstate',v_state,'detail',v_detail);
        v_failed:=v_failed+1;
        INSERT INTO public.financial_alerts(source,severity,message,context)
          SELECT 'weekly_club_accounting','critical','Weekly club accounting is incomplete',
            jsonb_build_object('club_id',v_club.id,'period_start',v_from,'period_end',v_to,'result',v_result)
          WHERE NOT EXISTS(SELECT 1 FROM public.financial_alerts a WHERE a.source='weekly_club_accounting'
            AND a.context->>'club_id'=v_club.id::text AND a.context->>'period_end'=to_jsonb(v_to)#>>'{}'
            AND a.context->'result'=v_result);
      END;
      v_checked:=v_checked+1;
      v_results:=v_results||jsonb_build_array(jsonb_build_object('club_id',v_club.id,'period_start',v_from,'period_end',v_to,'result',v_result));
    END LOOP;
  END IF;
  RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,
    'observed_at',clock_timestamp(),'detail',v_results);
END $function$
;

CREATE OR REPLACE FUNCTION public.atomic_distribute_rake(p_table_id uuid, p_club_id uuid, p_hand_id uuid, p_hand_number integer, p_rake numeric, p_bbj numeric DEFAULT 0, p_pot numeric DEFAULT NULL::numeric, p_num_players integer DEFAULT (NULL::numeric)::integer, p_contributions jsonb DEFAULT NULL::jsonb, p_tournament_id uuid DEFAULT NULL::uuid, p_returned_uncalled jsonb DEFAULT NULL::jsonb, p_rake_method text DEFAULT 'DEALT_EQUAL'::text)
 RETURNS TABLE(applied boolean, already_processed boolean, recovered boolean, rake_record_id uuid, club_net_credit numeric, spendable_route text, spendable_amount numeric, union_id_out uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_union_id     uuid;
  v_g_union      uuid;
  v_is_private   boolean := false;
  v_club_name    text;
  v_net          numeric;
  v_bbj          numeric := COALESCE(p_bbj, 0);
  v_rr_id        uuid;
  v_first_claim  boolean := false;
  v_recovered    boolean := false;
  v_leg_key      uuid;
  v_n            integer;
  v_cw_after     numeric;
  v_union_rake   numeric;
  v_route        text;
  v_method       text;
  v_alloc_sum    numeric;
  v_st           text;
  v_msg          text;
  v_dup_id       uuid;
BEGIN
  IF p_club_id IS NULL OR p_rake IS NULL OR p_rake <= 0 THEN
    RETURN QUERY SELECT false, false, false, NULL::uuid, 0::numeric,
                        NULL::text, 0::numeric, NULL::uuid;
    RETURN;
  END IF;

  /* ZERO-DRIFT (2026-08-31): declare the ledger context for this transaction
     so every auto-journaled balance delta below is categorized as rake coming
     off the felt, not an anonymous adjustment against suspense. */
  PERFORM set_config('app.ledger_category', 'rake', true);
  PERFORM set_config('app.ledger_counterparty', 'table_stack', true);
  PERFORM set_config('app.ledger_counterparty_entity', COALESCE(p_table_id::text, ''), true);
  -- PHASE 6.4 (2026-09-05): the rake's legs name the hand when it is known.
  PERFORM set_config('app.ledger_hand_id', COALESCE(p_hand_id::text, ''), true);

  v_method := CASE WHEN p_rake_method = 'WEIGHTED_CONTRIBUTED'
                   THEN 'WEIGHTED_CONTRIBUTED' ELSE 'DEALT_EQUAL' END;

  v_net := p_rake - v_bbj;

  SELECT c.name INTO v_club_name FROM public.clubs c WHERE c.id = p_club_id;

  -- UNION LAW (Dan, restored 2026-08-30): route by the GAME's union stamp,
  -- not club membership. A private club game's rake NEVER touches the union.
  IF p_table_id IS NOT NULL THEN
    SELECT COALESCE(t.is_private, false), t.union_id
      INTO v_is_private, v_g_union
      FROM public.tables t WHERE t.id = p_table_id;
  END IF;
  IF p_tournament_id IS NOT NULL AND NOT v_is_private AND v_g_union IS NULL THEN
    SELECT COALESCE(tr.is_private, false), tr.union_id
      INTO v_is_private, v_g_union
      FROM public.tournaments tr WHERE tr.id = p_tournament_id;
  END IF;

  IF v_is_private THEN
    v_union_id := NULL;
  ELSE
    v_union_id := v_g_union;
    IF v_union_id IS NULL THEN
      SELECT c.union_id INTO v_union_id FROM public.clubs c WHERE c.id = p_club_id;
    END IF;
  END IF;

  /* A HAND THAT CANNOT NAME ITSELF BY ID STILL NAMES ITSELF BY TABLE AND
     NUMBER (2026-09-06). Both idempotency guards below key on p_hand_id, and
     both are disabled when it is NULL: ON CONFLICT (hand_id) WHERE hand_id IS
     NOT NULL matches nothing, and v_leg_key fell back to a FRESH RANDOM uuid,
     so rake_distribution_legs could not dedupe either. The engine calls this
     before logHandHistory has produced a hand row and again after, and the
     second call was treated as a new hand: a duplicate rake_records row, and
     a second increment of the club wallet's period and lifetime rake. 4,452
     such rows exist, 2026-04-16 to 2026-09-05, carrying 16,426.46 of rake and
     2,068.82 of BBJ contribution that no hand ever dropped - measured against
     hand_history and bbj_contributions, which agree with the LINKED rows alone
     in 283 of the 284 cases where the hand still exists.

     So: ask hand_history for the id first, and if it genuinely is not there
     yet, key on what the caller always knows - the table and the hand number. */
  IF p_hand_id IS NULL AND p_table_id IS NOT NULL AND p_hand_number IS NOT NULL THEN
    SELECT h.id INTO p_hand_id
      FROM public.hand_history h
     WHERE h.table_id = p_table_id
       AND h.hand_number = p_hand_number
     ORDER BY h.created_at DESC
     LIMIT 1;
    -- Phase 6.4: the legs name the hand as soon as we know it.
    PERFORM set_config('app.ledger_hand_id', COALESCE(p_hand_id::text, ''), true);
  END IF;

  IF p_hand_id IS NULL AND p_table_id IS NOT NULL AND p_hand_number IS NOT NULL THEN
    SELECT rr.id INTO v_dup_id
      FROM public.rake_records rr
     WHERE rr.table_id = p_table_id
       AND rr.hand_id IS NULL
       AND (rr.metadata->>'hand_number') = p_hand_number::text
       AND rr.created_at > now() - interval '2 days'
     ORDER BY rr.created_at
     LIMIT 1;
    IF v_dup_id IS NOT NULL THEN
      RETURN QUERY SELECT false, true, false, v_dup_id, 0::numeric,
                          NULL::text, 0::numeric, v_union_id;
      RETURN;
    END IF;
  END IF;

  INSERT INTO public.rake_records (
    hand_id, table_id, club_id, rake_amount, bbj_contribution, pot_size,
    num_players, player_contributions, is_tournament, tournament_id, source,
    metadata, rake_method, returned_uncalled
  ) VALUES (
    p_hand_id, p_table_id, p_club_id, p_rake, v_bbj, p_pot,
    p_num_players, p_contributions, (p_tournament_id IS NOT NULL), p_tournament_id,
    'atomic_distribute_rake',
    jsonb_build_object('hand_number', p_hand_number, 'is_private', v_is_private),
    v_method, p_returned_uncalled
  )
  ON CONFLICT (hand_id) WHERE hand_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_rr_id;

  IF v_rr_id IS NOT NULL THEN
    v_first_claim := true;
  ELSE
    SELECT id INTO v_rr_id FROM public.rake_records
      WHERE hand_id = p_hand_id ORDER BY created_at LIMIT 1;
  END IF;

  IF v_first_claim AND p_hand_id IS NOT NULL
     AND p_contributions IS NOT NULL AND jsonb_typeof(p_contributions) = 'object' THEN
    INSERT INTO public.rake_attributions (
      hand_id, player_id, rake_amount, rake_record_id, table_id, club_id,
      gross_contribution, returned_uncalled, eligible_contribution,
      contribution_weight, weighted_rake_credit, bbj_attributed_contribution,
      rake_method
    )
    SELECT p_hand_id,
           a.user_id,
           a.credit,
           v_rr_id, p_table_id,
           COALESCE((SELECT ts.club_id FROM public.table_seats ts
                      WHERE ts.table_id = p_table_id AND ts.user_id = a.user_id
                      ORDER BY ts.joined_at DESC NULLS LAST LIMIT 1), p_club_id),
           (p_contributions ->> a.user_id::text)::numeric
             + COALESCE((p_returned_uncalled ->> a.user_id::text)::numeric, 0),
           COALESCE((p_returned_uncalled ->> a.user_id::text)::numeric, 0),
           (p_contributions ->> a.user_id::text)::numeric,
           a.weight,
           a.credit,
           COALESCE(b.credit, 0),
           v_method
      FROM public.fn_allocate_rake_credits(p_rake, p_contributions, v_method) a
      LEFT JOIN public.fn_allocate_rake_credits(v_bbj, p_contributions, v_method) b
        ON b.user_id = a.user_id
    ON CONFLICT (hand_id, player_id) DO NOTHING;

    SELECT COALESCE(SUM(a.credit), 0) INTO v_alloc_sum
      FROM public.fn_allocate_rake_credits(p_rake, p_contributions, v_method) a;
    IF v_alloc_sum <> round(p_rake, 2) AND v_alloc_sum <> 0 THEN
      INSERT INTO public.financial_alerts (severity, source, message, context)
      VALUES ('critical', 'atomic_distribute_rake', 'RAKE_ALLOCATION_MISMATCH',
        jsonb_build_object('hand_id', p_hand_id, 'rake', p_rake,
          'allocated', v_alloc_sum, 'method', v_method));
    END IF;
  END IF;

  /* THE LEG KEY IS DERIVED, NEVER RANDOM (2026-09-06). A random key made
     rake_distribution_legs' ON CONFLICT (leg_key, leg) unreachable, so the
     club wallet's period and lifetime rake were incremented again for a hand
     already counted. When the hand has no id, the key is the table and the
     hand number - the same hand always produces the same key. */
  v_leg_key := COALESCE(
    p_hand_id,
    CASE WHEN p_table_id IS NOT NULL AND p_hand_number IS NOT NULL
         THEN md5('rake:' || p_table_id::text || ':' || p_hand_number::text)::uuid
    END,
    gen_random_uuid());
  PERFORM set_config('app.ledger_settlement', 'rake:' || v_leg_key::text, true);

  INSERT INTO public.rake_distribution_legs (leg_key, leg, club_id, union_id, amount)
  VALUES (v_leg_key, 'club_accumulator', p_club_id, v_union_id, v_net)
  ON CONFLICT (leg_key, leg) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    UPDATE public.club_wallets
       SET period_rake_collected     = period_rake_collected     + p_rake,
           period_bbj_contribution   = period_bbj_contribution   + v_bbj,
           lifetime_rake_collected   = lifetime_rake_collected   + p_rake,
           lifetime_bbj_contribution = lifetime_bbj_contribution + v_bbj,
           chip_balance              = chip_balance,  -- 2026-09-02 ruling: the club share is paid weekly from the rake treasury, not per hand
           updated_at                = NOW()
     WHERE club_id = p_club_id
     RETURNING chip_balance INTO v_cw_after;

    IF v_cw_after IS NULL THEN
      INSERT INTO public.club_wallets (
        club_id, chip_balance, period_rake_collected, period_bbj_contribution,
        lifetime_rake_collected, lifetime_bbj_contribution
      ) VALUES (
        p_club_id, 0, p_rake, v_bbj, p_rake, v_bbj
      )
      ON CONFLICT (club_id) DO UPDATE SET
        period_rake_collected     = club_wallets.period_rake_collected     + EXCLUDED.period_rake_collected,
        period_bbj_contribution   = club_wallets.period_bbj_contribution   + EXCLUDED.period_bbj_contribution,
        lifetime_rake_collected   = club_wallets.lifetime_rake_collected   + EXCLUDED.lifetime_rake_collected,
        lifetime_bbj_contribution = club_wallets.lifetime_bbj_contribution + EXCLUDED.lifetime_bbj_contribution,
        chip_balance              = club_wallets.chip_balance              + EXCLUDED.chip_balance,
        updated_at                = NOW()
      RETURNING chip_balance INTO v_cw_after;
    END IF;

    INSERT INTO public.club_wallet_transactions (
      club_id, type, amount, balance_after, related_id, reason
    ) VALUES (
      p_club_id, 'rake_in', v_net, v_cw_after, p_hand_id,
      'Rake collected (hand ' || COALESCE('#' || p_hand_number::text, 'unknown') ||
        ', BBJ contribution ' || v_bbj::text || ')'
    );

    IF NOT v_first_claim THEN v_recovered := true; END IF;
  END IF;

  IF v_union_id IS NOT NULL THEN
    v_route := 'union_rake_wallet';
    INSERT INTO public.rake_distribution_legs (leg_key, leg, club_id, union_id, amount)
    VALUES (v_leg_key, 'union_rake', p_club_id, v_union_id, p_rake)
    ON CONFLICT (leg_key, leg) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
      -- UNION LAW (restored 2026-08-30): RAKE TREASURY ONLY. chip_balance
      -- (Union Bank) is deliberately NOT touched.
      INSERT INTO public.union_wallets (union_id, chip_balance, rake_wallet, total_rake_collected)
           VALUES (v_union_id, 0, p_rake, p_rake)
      ON CONFLICT (union_id) DO UPDATE SET
           rake_wallet          = public.union_wallets.rake_wallet + p_rake,
           total_rake_collected = COALESCE(public.union_wallets.total_rake_collected, 0) + p_rake,
           updated_at           = NOW()
      RETURNING rake_wallet INTO v_union_rake;

      INSERT INTO public.union_wallet_transactions (
        union_id, club_id, amount, tx_type, wallet, direction, balance_after, notes
      ) VALUES (
        v_union_id, p_club_id, p_rake, 'rake', 'rake_wallet', 'credit', v_union_rake,
        'Cash game rake: hand #' || COALESCE(p_hand_number::text, '?') ||
          ' (' || COALESCE(v_club_name, 'club') || ')'
      );

      IF NOT v_first_claim THEN v_recovered := true; END IF;
    END IF;
  ELSE
    v_route := 'club_chip_treasury';
    INSERT INTO public.rake_distribution_legs (leg_key, leg, club_id, union_id, amount)
    VALUES (v_leg_key, 'chip_treasury', p_club_id, NULL, p_rake)
    ON CONFLICT (leg_key, leg) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
      /* ZERO-DRIFT: this leg writes its own chip_ledger row below; suppress
         the clubs auto-journal for this one statement. */
      PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
      UPDATE public.clubs
         SET chip_treasury = COALESCE(chip_treasury, 0) + p_rake,
             total_rake    = COALESCE(total_rake, 0) + p_rake,
             updated_at    = NOW()
       WHERE id = p_club_id;
      PERFORM set_config('app.ledger_autoskip_clubs', '0', true);

      /* JOURNAL THE TREASURY LEG (2026-08-31). Inside the leg_key first-claim
         guard, so a replayed hand credits once and journals once. Journal failure rolls back this distribution. */
      BEGIN
        INSERT INTO public.chip_ledger
          (performed_by, from_type, from_entity_id, to_type, to_entity_id,
           amount, category, club_id, table_id, hand_id, tournament_id, description)
        VALUES (
          COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
          'table_stack',   p_table_id,
          'club_treasury', p_club_id,
          p_rake, 'rake', p_club_id, p_table_id, p_hand_id, p_tournament_id,
          'Rake to club treasury, hand ' || COALESCE('#' || p_hand_number::text, 'unknown')
            || ' (atomic_distribute_rake)');
      EXCEPTION WHEN OTHERS THEN
      -- A journal failure must abort the enclosing chip movement.
      -- Preserve SQLSTATE so the existing caller can retry the whole operation.
      RAISE;
    END;

      IF NOT v_first_claim THEN v_recovered := true; END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT v_first_claim, (NOT v_first_claim), v_recovered, v_rr_id,
                      v_net, v_route, p_rake, v_union_id;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.fn_union_settlement_cascade(p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001'::uuid, p_period_start timestamp with time zone DEFAULT NULL::timestamp with time zone, p_period_end timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_credit_club record;
  v_from timestamptz := COALESCE(p_period_start, public.fn_union_prev_week_start(now()));
  v_to   timestamptz := COALESCE(p_period_end,   public.fn_union_week_start(now()));
  v_r1 jsonb; v_r2 jsonb; v_r3 jsonb; v_eco jsonb; v_inv jsonb;
  v_floor timestamptz;
  v_club_statements jsonb; v_previous_validated text;
  v_sqlstate text; v_msg text; v_detail text; v_context text;

BEGIN
  IF EXISTS (SELECT 1 FROM settlement_locks WHERE lock_type = 'GLOBAL_SETTLEMENT_FREEZE' AND is_active = true) THEN
    RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK';
  END IF;

  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_union_overseer(p_union_id, auth.uid()))) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  -- THE FLOOR, checked before anything moves. Round 1 has always honoured it;
  -- nothing above round 1 did, so three further rounds ran on a floored week.
  SELECT f.earliest_period_start INTO v_floor
    FROM union_settlement_floor f WHERE f.union_id = p_union_id;

  IF v_floor IS NOT NULL AND v_from < v_floor THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'union_settlement_incomplete', DETAIL = (jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'before_settlement_floor',
      'period_start', v_from, 'period_end', v_to,
      'settlement_floor', v_floor,
      'note', 'This period is below the union settlement floor and must not be '
              || 'settled. No round was run.'))::text;
  END IF;

  /* WARM THE CACHE BEFORE THE FIRST LOCK (2026-09-09). union_rake_rollup_days
     is a speed cache: a day that is missing is recomputed live and correct,
     but it is recomputed INSIDE the settlement, while it holds treasury rows -
     which is where this union has been deadlocking. Doing it here costs the
     same work at a moment when nothing is locked. A failure is not fatal:
     the live path still answers, just more slowly. */
  BEGIN
    PERFORM public.fn_union_rake_rollup_refresh_day(p_union_id, g.d::date)
       FROM generate_series(v_from::date, (v_to - interval '1 day')::date, interval '1 day') g(d)
      WHERE NOT EXISTS (SELECT 1 FROM public.union_rake_rollup_days rd
                         WHERE rd.union_id = p_union_id AND rd.day = g.d::date)
        AND g.d::date < (now() AT TIME ZONE 'UTC')::date;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'settlement could not warm the rake rollup (%); the live path will answer instead', SQLERRM;
  END;

  -- Serialize every entry point for this union/period. A replay must read
  -- the receipts after the competing transaction commits, before moving chips.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'union-accounting:' || p_union_id::text || ':' || extract(epoch FROM v_from)::text || ':' || extract(epoch FROM v_to)::text, 0));

  -- A union-owned table is not a player's earning club. These outstanding
  -- records are invisible to the member-club join in Round 3. Never certify
  -- completion while they exist, and never guess a replacement beneficiary.
  IF EXISTS (SELECT 1 FROM public.rakeback_periods rp
       WHERE rp.club_id = p_union_id AND rp.status = 'pending'
         AND rp.rakeback_amount > 0
         AND (rp.period_start::timestamp AT TIME ZONE 'UTC') < v_to
         AND ((rp.period_end + 1)::timestamp AT TIME ZONE 'UTC') > v_from) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'union_rakeback_wrong_club',
      DETAIL = 'Pending player rakeback is booked under the union ID. Reconcile the earning-club evidence before settlement.';
  END IF;

  -- ROUND 1 - union rake treasury pays the clubs their 90%.
  v_r1 := public.fn_union_weekly_rakeback_close(p_union_id, v_from, v_to);
  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payers, payees, amount, detail)
  VALUES (p_union_id, v_from, v_to, 1, 'union_to_clubs', 1,
          COALESCE((v_r1->>'clubs_paid')::int,0),
          COALESCE((v_r1->>'total_rakeback')::numeric,0), v_r1)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO NOTHING;

  IF COALESCE((v_r1->>'success')::boolean, false) IS NOT TRUE
     AND COALESCE(v_r1->>'error','') <> 'already_executed' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'union_settlement_incomplete', DETAIL = (jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'round1_failed: ' || COALESCE(v_r1->>'error','unknown'),
      'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1,
      'note', 'Rounds 2, 3 and 4 were not run. A club is not asked to pay its '
              || 'agents out of a treasury the union has not funded.'))::text;
  END IF;

  -- ROUND 2 - clubs pay their super agents and agents.
  v_r2 := public.fn_settle_round2_club_to_agents(p_union_id, v_from, v_to);
  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payees, amount, shortfalls, detail)
  VALUES (p_union_id, v_from, v_to, 2, 'club_to_agents',
          COALESCE((v_r2->>'payees')::int,0), COALESCE((v_r2->>'amount')::numeric,0),
          COALESCE((v_r2->>'shortfalls')::int,0), v_r2)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO UPDATE
    SET detail=union_settlement_rounds.detail || jsonb_build_object('latest_attempt',EXCLUDED.detail);

  -- Round 2 carries no 'success' key: it raises on error and returns
  -- {round,name,payees,amount,shortfalls,detail} otherwise, so a test for
  -- 'success' would be unreachable. Assert the CONTRACT instead - a round that
  -- stops reporting an amount must stop the cascade, not record 0 and carry on.
  IF (v_r2->>'amount') IS NULL OR (v_r2->>'payees') IS NULL
     OR (v_r2->>'shortfalls') IS NULL
     OR jsonb_typeof(v_r2->'shortfalls') IS DISTINCT FROM 'number'
     OR (v_r2 ? 'success' AND COALESCE((v_r2->>'success')::boolean, true) IS FALSE
         AND COALESCE(v_r2->>'error','') <> 'already_executed') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'union_settlement_incomplete', DETAIL = (jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'round2_contract_violated_or_failed: ' || COALESCE(v_r2->>'error','unknown'),
      'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
      'note', 'Rounds 3 and 4 were not run.'))::text;
  END IF;

  -- ROUND 3 - agents pay their players.
  v_r3 := public.fn_settle_round3_agents_to_players(p_union_id, v_from, v_to);
  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payees, amount, shortfalls, detail)
  VALUES (p_union_id, v_from, v_to, 3, 'agents_to_players',
          COALESCE((v_r3->>'payees')::int,0), COALESCE((v_r3->>'amount')::numeric,0),
          COALESCE((v_r3->>'shortfalls')::int,0), v_r3)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO UPDATE
    SET detail=union_settlement_rounds.detail || jsonb_build_object('latest_attempt',EXCLUDED.detail);

  -- Same contract assertion for round 3.
  IF (v_r3->>'amount') IS NULL OR (v_r3->>'payees') IS NULL
     OR (v_r3->>'shortfalls') IS NULL
     OR jsonb_typeof(v_r3->'shortfalls') IS DISTINCT FROM 'number'
     OR (v_r3 ? 'success' AND COALESCE((v_r3->>'success')::boolean, true) IS FALSE
         AND COALESCE(v_r3->>'error','') <> 'already_executed') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'union_settlement_incomplete', DETAIL = (jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'round3_contract_violated_or_failed: ' || COALESCE(v_r3->>'error','unknown'),
      'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
      'round3_agents_to_players', v_r3,
      'note', 'Round 4 was not run; no statement is issued for a settlement '
              || 'that did not complete.'))::text;
  END IF;

  -- A round can post funded recipients while reporting others still unpaid.
  -- Keep that durable progress, but do not mark the period settled or issue
  -- completion statements until every reported shortfall is zero.
  IF (v_r2->>'shortfalls')::numeric <> 0
     OR (v_r3->>'shortfalls')::numeric <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'union_settlement_incomplete', DETAIL = (jsonb_build_object('success',false,'union_id',p_union_id,
      'error','recipient_shortfalls_remaining','period_start',v_from,'period_end',v_to,
      'round1_union_to_clubs',v_r1,'round2_club_to_agents',v_r2,
      'round3_agents_to_players',v_r3))::text;
  END IF;

  IF EXISTS (SELECT 1 FROM public.rakeback_periods rp
      JOIN public.union_clubs uc ON uc.club_id=rp.club_id AND uc.union_id=p_union_id
      WHERE rp.status='pending' AND rp.rakeback_amount>0
        AND rp.period_start >= (v_from AT TIME ZONE 'UTC')::date
        AND ((rp.period_end+1)::timestamp AT TIME ZONE 'UTC') <= v_to) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='union_player_obligations_remaining';
  END IF;

  -- CONSERVATION, asserted before anything else is written. Raises on a
  -- breach, which rolls this union's whole settlement back.
  PERFORM public.fn_union_settlement_conservation_assert(
            p_union_id, v_from, v_to, v_r1, v_r2, v_r3);

  -- The period is an accounting object, not a by-product of invoicing.
  PERFORM public.fn_union_mark_period_settled(p_union_id, v_from, v_to);

  IF public.fn_union_eco_enabled(p_union_id) THEN
    BEGIN
      v_eco := public.fn_union_eco_record(p_union_id, v_from, v_to, NULL);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT,
                              v_detail = PG_EXCEPTION_DETAIL, v_context = PG_EXCEPTION_CONTEXT;
      v_eco := jsonb_build_object('success', false, 'error', v_msg, 'sqlstate', v_sqlstate,
                                  'exception_detail', v_detail, 'exception_context', v_context);
    END;
  ELSE
    v_eco := jsonb_build_object('skipped', true, 'reason', 'eco_disabled');
  END IF;

  IF v_eco->>'success' = 'false' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'union_eco_record_failed', DETAIL = v_eco::text;
  END IF;

  IF public.fn_union_setting(p_union_id, 'weekly_invoices_enabled', 1) <> 1 THEN
    v_inv := jsonb_build_object(
      'success', true, 'skipped', true, 'invoices', 0,
      'reason', 'weekly_invoices_disabled: the union setting weekly_invoices_enabled is 0. '
                || 'Since Phase 6 (20260907) the statement reads the same fn_union_club_rake_basis '
                || 'rows round 1 pays on; switching statements back on is a setting, not a fix.');
  ELSE
    BEGIN
      v_inv := public.fn_union_issue_weekly_invoices(p_union_id, v_from, v_to, true);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT,
                              v_detail = PG_EXCEPTION_DETAIL, v_context = PG_EXCEPTION_CONTEXT;
      v_inv := jsonb_build_object('success', false, 'error', v_msg, 'sqlstate', v_sqlstate,
                                  'exception_detail', v_detail, 'exception_context', v_context);
    END;
  END IF;

  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payees, amount, detail)
  VALUES (p_union_id, v_from, v_to, 4, 'union_invoices_issued',
          COALESCE((v_inv->>'invoices')::int, 0), 0, v_inv)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO UPDATE
    SET detail=EXCLUDED.detail,payees=EXCLUDED.payees;

  IF COALESCE((v_inv->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'union_settlement_incomplete', DETAIL = (jsonb_build_object('success', false, 'union_id', p_union_id,
      'error', 'round4_invoices_failed: ' || COALESCE(v_inv->>'error','unknown'),
      'period_start', v_from, 'period_end', v_to,
      'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
      'round3_agents_to_players', v_r3, 'eco_recorded', v_eco,
      'round4_invoices', v_inv))::text;
  END IF;

  IF COALESCE((v_inv->>'skipped')::boolean, false) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'union_invoices_not_issued', DETAIL = v_inv::text;
  END IF;

  IF EXISTS (SELECT 1 FROM public.union_clubs uc
    WHERE uc.union_id=p_union_id AND uc.club_id<>p_union_id
      AND NOT EXISTS (SELECT 1 FROM public.settlement_invoices si
        WHERE si.club_id=uc.club_id AND si.invoice_type='union_weekly_squareup'
          AND si.breakdown->>'union_id'=p_union_id::text
          AND (si.breakdown->>'period_start')::timestamptz=v_from
          AND (si.breakdown->>'period_end')::timestamptz=v_to
          AND si.message_sent=true AND si.status<>'cancelled')) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='union_invoice_delivery_incomplete';
  END IF;

  FOR v_credit_club IN SELECT club_id FROM public.union_clubs WHERE union_id=p_union_id AND club_id<>p_union_id ORDER BY club_id LOOP
    PERFORM public.fn_generate_scope_credit_invoices(v_credit_club.club_id,v_from,v_to);
  END LOOP;
  v_previous_validated:=current_setting('app.union_accounting_validated_period',true);
  PERFORM set_config('app.union_accounting_validated_period',p_union_id::text||':'||v_from::text||':'||v_to::text,true);
  v_club_statements:=public.fn_issue_club_weekly_accounting(p_union_id,v_from,v_to);
  PERFORM set_config('app.union_accounting_validated_period',COALESCE(v_previous_validated,''),true);
  RETURN jsonb_build_object('success', true, 'union_id', p_union_id, 'club_weekly_statements',v_club_statements,
    'period_start', v_from, 'period_end', v_to,
    'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
    'round3_agents_to_players', v_r3, 'eco_recorded', v_eco,
    'round4_invoices', v_inv);
END $function$
;
