CREATE OR REPLACE FUNCTION public.fn_settle_round2_club_to_agents(p_union_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record; v_club_bal numeric; v_paid numeric := 0;
  v_payees int := 0; v_short int := 0; v_detail jsonb := '[]'::jsonb;
  v_debit jsonb; v_agent_bal numeric; v_pairs jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR NOT public.fn_is_union_overseer(p_union_id, auth.uid())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;
  IF EXISTS (SELECT 1 FROM settlement_locks WHERE lock_type = 'GLOBAL_SETTLEMENT_FREEZE' AND is_active = true) THEN
    RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK';
  END IF;
  IF p_union_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL OR p_period_end <= p_period_start THEN
    RETURN jsonb_build_object('round', 2, 'name', 'club_to_agents', 'success', false, 'error', 'bad_params',
                              'payees', 0, 'amount', 0, 'shortfalls', 0, 'detail', '[]'::jsonb);
  END IF;
  /* A row's created_at is its transaction's start. The longest transaction that
     writes agent_commissions is an eight-second engine call; five minutes after
     the period closes, nothing that began inside it is still in flight. Before
     that, a period recorded as paid could swallow a row that landed late. */
  IF p_period_end > now() - interval '5 minutes' THEN
    RETURN jsonb_build_object('round', 2, 'name', 'club_to_agents', 'success', false, 'retryable', true,
                              'error', 'period_too_fresh', 'period_end', p_period_end,
                              'payees', 0, 'amount', 0, 'shortfalls', 0, 'detail', '[]'::jsonb);
  END IF;

  /* What each pair is owed INSIDE this period: unstamped, and not already
     covered by a settlement row. One index scan per pair, no materialised set. */
  FOR r IN
    SELECT ac.club_id, ac.user_id AS agent_user, SUM(ac.amount) AS owed, count(*) AS n
      FROM agent_commissions ac
      JOIN union_clubs uc ON uc.club_id = ac.club_id AND uc.union_id = p_union_id
      JOIN agents a ON a.user_id = ac.user_id AND a.club_id = ac.club_id AND a.status = 'active'
     WHERE ac.created_at >= p_period_start AND ac.created_at < p_period_end
       AND ac.settled_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM agent_commission_settlements s
                        WHERE s.club_id = ac.club_id AND s.user_id = ac.user_id
                          AND ac.created_at >= s.period_start AND ac.created_at < s.period_end)
     GROUP BY ac.club_id, ac.user_id
    HAVING SUM(ac.amount) > 0
     ORDER BY 1, 2
  LOOP
    -- Same pot Round 1 credits (clubs.chip_treasury), not club_wallets.
    SELECT COALESCE(chip_treasury, 0) INTO v_club_bal FROM clubs WHERE id = r.club_id FOR UPDATE;

    IF COALESCE(v_club_bal, 0) < r.owed THEN
      v_short := v_short + 1;
      v_detail := v_detail || jsonb_build_object('club_id', r.club_id, 'agent', r.agent_user,
                    'owed', r.owed, 'club_treasury', COALESCE(v_club_bal, 0), 'skipped', true);
      CONTINUE;
    END IF;

    /* ONE MOVEMENT, ONE LEG (2026-09-09). The leg for this payment is
       written by hand at the bottom of this loop, carrying the period, the
       row count and an idempotency key that a replay can recognise. Until
       today both balance writes ALSO fired their own journal triggers, and
       neither had been told who the counterparty was, so each wrote an
       anonymous twin through settlement_suspense. Every commission was
       therefore journalled twice. The two stand-downs are set immediately
       before each write and cleared immediately after, so a CONTINUE out of
       this iteration can never leave a later statement silently unjournalled. */
    PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
    v_debit := public.fn_debit_treasury(
      r.club_id, r.owed,
      'Round 2: club -> agent commission',
      jsonb_build_object('union_id', p_union_id, 'agent_user_id', r.agent_user,
                         'period_start', p_period_start, 'period_end', p_period_end));
    PERFORM set_config('app.ledger_autoskip_clubs', '', true);
    IF COALESCE((v_debit->>'success')::boolean, false) IS NOT TRUE THEN
      v_short := v_short + 1;
      v_detail := v_detail || jsonb_build_object('club_id', r.club_id, 'agent', r.agent_user,
                    'owed', r.owed, 'error', v_debit, 'skipped', true);
      CONTINUE;
    END IF;

    PERFORM public.fn_ensure_club_wallet(r.agent_user, r.club_id);
    PERFORM set_config('app.ledger_autoskip_club_members', '1', true);
    UPDATE club_members
       SET chip_balance = COALESCE(chip_balance, 0) + r.owed, updated_at = now()
     WHERE user_id = r.agent_user AND club_id = r.club_id
     RETURNING chip_balance INTO v_agent_bal;
    PERFORM set_config('app.ledger_autoskip_club_members', '', true);

    /* THE RECORD, instead of two million stamps: one row says this pair's
       rows inside this period are paid. A second call finds no open rows
       inside the period and pays nothing. */
    INSERT INTO public.agent_commission_settlements
      (club_id, user_id, union_id, period_start, period_end, amount, rows_count, paid_at, settlement_ref)
    VALUES (r.club_id, r.agent_user, p_union_id, p_period_start, p_period_end, round(r.owed, 2), r.n, now(),
            'round2:' || p_union_id::text || ':' || to_char(p_period_start at time zone 'UTC', 'YYYY-MM-DD'))
    ON CONFLICT (club_id, user_id, period_start, period_end) DO NOTHING;

    -- Both sides of the entry: club-side debit above, agent credit here.
    INSERT INTO wallet_transactions
      (user_id, wallet_type, type, amount, category, description, balance_after)
    VALUES
      (r.agent_user, 'PLAYER', 'credit', r.owed, 'commission',
       'Round 2: club -> agent commission [club wallet]', v_agent_bal);

    /* CONTROL (phase 8): the same movement as two balanced legs, on the
       journal fn_ca_trial_balance reads. */
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, union_id, description, idempotency_key, metadata)
    VALUES
      (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
       'club_treasury', r.club_id, 'player_wallet', r.agent_user,
       round(r.owed, 2), 'commission', r.club_id, p_union_id,
       'Round 2: club -> agent commission (period '
         || to_char(p_period_start, 'YYYY-MM-DD') || '..'
         || to_char(p_period_end, 'YYYY-MM-DD') || ')',
       'round2:' || p_union_id::text || ':'
         || to_char(p_period_start at time zone 'UTC', 'YYYY-MM-DD') || ':'
         || r.club_id::text || ':' || r.agent_user::text,
       jsonb_build_object('period_start', p_period_start, 'period_end', p_period_end,
                          'rows_count', r.n, 'agent_balance_after', v_agent_bal))
    ON CONFLICT DO NOTHING;

    v_pairs := v_pairs || jsonb_build_object('club_id', r.club_id, 'user_id', r.agent_user);
    v_paid := v_paid + r.owed;
    v_payees := v_payees + 1;
  END LOOP;

  IF v_pairs <> '[]'::jsonb THEN
    PERFORM public.fn_agent_commission_rollup_recompute(v_pairs);
  END IF;

  RETURN jsonb_build_object('round', 2, 'name', 'club_to_agents',
    'payees', v_payees, 'amount', round(v_paid, 2), 'shortfalls', v_short, 'detail', v_detail);
END
$function$
;
CREATE OR REPLACE FUNCTION public.fn_settle_round3_agents_to_players(p_union_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r record;g record;v_items jsonb:='[]'::jsonb;v_agent uuid;v_payout uuid;v_wallet uuid;v_agent_before numeric;v_agent_after numeric;
 v_player_before numeric;v_player_after numeric;v_owed numeric;v_rake numeric;v_rate numeric;
 v_admitted_clubs uuid[];
 v_paid numeric:=0;v_payees integer:=0;v_short integer:=0;v_detail jsonb:='[]';v_skip text;
BEGIN
 IF EXISTS(SELECT 1 FROM settlement_locks WHERE lock_type='GLOBAL_SETTLEMENT_FREEZE' AND is_active=true)
 THEN RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK'; END IF;
 IF p_union_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL OR p_period_end<=p_period_start
  OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
 THEN RETURN jsonb_build_object('round',3,'name','agents_to_players','success',false,'error','bad_params','amount',0,'payees',0,'shortfalls',0,'detail','[]'::jsonb); END IF;
 v_admitted_clubs := ARRAY(SELECT club_id FROM public.union_clubs WHERE union_id=p_union_id ORDER BY club_id);
 PERFORM public.fn_lock_rakeback_payer_clubs(v_admitted_clubs);
 -- Lock each exact period before calculating or choosing its legacy payer.
 FOR r IN SELECT rp.* FROM rakeback_periods rp
 JOIN union_clubs uc ON uc.club_id=rp.club_id AND uc.union_id=p_union_id
 WHERE rp.status='pending' AND rp.club_id=ANY(v_admitted_clubs)
 AND rp.period_start >= (p_period_start AT TIME ZONE 'UTC')::date
 AND (rp.period_end + 1)::timestamp AT TIME ZONE 'UTC' <= p_period_end
 AND (rp.period_end + 1)::timestamp AT TIME ZONE 'UTC' <= statement_timestamp()
 ORDER BY rp.club_id,rp.period_start,rp.id FOR UPDATE OF rp
 LOOP
  IF EXISTS(SELECT 1 FROM rakeback_period_payouts x WHERE x.rakeback_period_id=r.id AND x.user_id=r.user_id) THEN CONTINUE; END IF;
  SELECT agent_id,chip_balance INTO v_agent,v_player_before FROM club_members WHERE club_id=r.club_id AND user_id=r.user_id;
  IF v_agent IS NULL THEN CONTINUE; END IF;
  IF v_agent=r.user_id THEN RAISE EXCEPTION 'Legacy rakeback payer cannot equal beneficiary' USING ERRCODE='23514'; END IF;
  v_owed:=r.rakeback_amount;v_rake:=coalesce(r.rake_generated,r.total_rake_paid);v_rate:=r.rakeback_rate;
  -- Negative offsets and missing receipt basis require explicit repair, not
  -- silent exclusion from the installed aggregate funding decision.
  IF v_owed<0 THEN RAISE EXCEPTION 'Legacy rakeback aggregate contains a negative period' USING ERRCODE='23514'; END IF;
  IF v_owed IS NULL OR v_owed=0 THEN CONTINUE; END IF;
  IF v_rake IS NULL OR v_rake<0 OR v_rake::text IN('NaN','Infinity','-Infinity')
    OR v_rate IS NULL OR v_rate<0 OR v_rate>1 OR v_rate::text IN('NaN','Infinity','-Infinity')
  THEN RAISE EXCEPTION 'Legacy rakeback receipt basis requires repair' USING ERRCODE='23514'; END IF;
  IF v_owed::text IN('NaN','Infinity','-Infinity') OR v_owed<>round(v_owed,2)
  THEN RAISE EXCEPTION 'Legacy rakeback must be finite whole cents' USING ERRCODE='23514'; END IF;
  v_items:=v_items||jsonb_build_object('id',r.id,'club_id',r.club_id,'user_id',r.user_id,
    'agent',v_agent,'owed',v_owed,'rake',v_rake,'rate',v_rate);
 END LOOP;
 -- Preserve the installed all-or-nothing funding decision for each player group.
 -- Exact membership and amounts were pinned while every period row was locked.
 FOR g IN SELECT x.club_id,x.user_id,x.agent,sum(x.owed) AS owed
  FROM jsonb_to_recordset(v_items) AS x(id uuid,club_id uuid,user_id uuid,agent uuid,owed numeric,rake numeric,rate numeric)
  GROUP BY x.club_id,x.user_id,x.agent ORDER BY x.club_id,x.agent,x.user_id
 LOOP
  v_agent:=g.agent;
  PERFORM 1 FROM club_members WHERE club_id=g.club_id AND user_id IN(v_agent,g.user_id) ORDER BY user_id FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM club_members WHERE club_id=g.club_id AND user_id=g.user_id AND agent_id=v_agent)
  THEN RAISE EXCEPTION 'Legacy payer changed during admission' USING ERRCODE='40001'; END IF;
  SELECT chip_balance INTO v_agent_before FROM club_members WHERE club_id=g.club_id AND user_id=v_agent;
  IF coalesce(v_agent_before,0)<g.owed THEN
   v_short:=v_short+1;v_detail:=v_detail||jsonb_build_object('agent',v_agent,'player',g.user_id,'owed',g.owed,'agent_balance',coalesce(v_agent_before,0),'skipped',true);CONTINUE;
  END IF;
  FOR r IN SELECT x.* FROM jsonb_to_recordset(v_items)
    AS x(id uuid,club_id uuid,user_id uuid,agent uuid,owed numeric,rake numeric,rate numeric)
    WHERE x.club_id=g.club_id AND x.user_id=g.user_id AND x.agent=g.agent ORDER BY x.id
  LOOP
   v_owed:=r.owed;v_rake:=r.rake;v_rate:=r.rate;
   SELECT chip_balance INTO v_agent_before FROM club_members WHERE club_id=r.club_id AND user_id=v_agent;
   SELECT coalesce(chip_balance,0) INTO v_player_before FROM club_members WHERE club_id=r.club_id AND user_id=r.user_id;
  INSERT INTO rakeback_period_payouts(rakeback_period_id,club_id,user_id,user_rake_contribution,rakeback_pct,payout_amount,status,paid_at)
  VALUES(r.id,r.club_id,r.user_id,v_rake,round(v_rate*100,2),v_owed,'paid',now())
  ON CONFLICT(rakeback_period_id,user_id) DO NOTHING RETURNING id INTO v_payout;
  IF v_payout IS NULL THEN RAISE EXCEPTION 'Legacy period receipt changed after admission' USING ERRCODE='40001'; END IF;
  v_skip:=current_setting('app.ledger_autoskip_club_members',true);
  PERFORM set_config('app.ledger_autoskip_club_members','1',true);
  UPDATE club_members SET chip_balance=chip_balance-v_owed,updated_at=now() WHERE club_id=r.club_id AND user_id=v_agent RETURNING chip_balance INTO v_agent_after;
  UPDATE club_members SET chip_balance=coalesce(chip_balance,0)+v_owed,updated_at=now() WHERE club_id=r.club_id AND user_id=r.user_id RETURNING chip_balance INTO v_player_after;
  PERFORM set_config('app.ledger_autoskip_club_members',coalesce(v_skip,''),true);
  IF v_agent_after IS NULL OR v_player_after IS NULL OR v_agent_before-v_agent_after<>v_owed OR v_player_after-v_player_before<>v_owed
  THEN RAISE EXCEPTION 'Legacy rakeback balance conservation failed' USING ERRCODE='23514'; END IF;
  INSERT INTO wallet_transactions(user_id,wallet_type,type,amount,category,description,balance_after,related_entity_id)
  VALUES(r.user_id,'PLAYER','credit',v_owed,'rakeback','Round 3: agent -> player rakeback [club wallet]',v_player_after,v_payout) RETURNING id INTO v_wallet;
  PERFORM set_config('app.ledger_maintenance','rakeback payout evidence pointer',true);
  UPDATE rakeback_period_payouts SET wallet_transaction_id=v_wallet WHERE id=v_payout;
  PERFORM set_config('app.ledger_maintenance','',true);
  INSERT INTO chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata)
  VALUES(coalesce(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),'player_wallet',v_agent,'player_wallet',r.user_id,v_owed,'rakeback',r.club_id,p_union_id,
   'Round 3: agent -> player rakeback','round3-period:'||r.id::text,
   jsonb_build_object('period_id',r.id,'period_start',p_period_start,'period_end',p_period_end,'payout_id',v_payout,'wallet_transaction_id',v_wallet));
  UPDATE rakeback_periods SET status='paid',paid_at=now() WHERE id=r.id;
  v_paid:=v_paid+v_owed;
  END LOOP;
  v_payees:=v_payees+1;
 END LOOP;
 RETURN jsonb_build_object('round',3,'name','agents_to_players','payees',v_payees,'amount',round(v_paid,2),'shortfalls',v_short,'detail',v_detail);
END $function$
;