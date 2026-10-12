-- PRIVATE NATIVE FIXTURE ONLY. The caller owns BEGIN/ROLLBACK. Real production
-- guards and statement/row triggers remain active during every owner call.
DO $seed$
DECLARE mode text:=current_setting('held_fee_fixture.commission_case');
BEGIN
 IF inet_server_addr() IS NOT NULL OR current_database()<>'postgres' THEN
  RAISE EXCEPTION 'private_native_fixture_required'; END IF;
 -- Synthetic current profile is independent of the recorded earning agreement.
 PERFORM set_config('session_replication_role','replica',true);
 DELETE FROM public.agents a USING held_fee_fixture.agent f
  WHERE a.id=held_fee_fixture.agent_id() OR (a.club_id=f.club_id AND a.user_id=f.user_id);
 IF mode IN('profile','zero','ordinary_fallback') THEN
  INSERT INTO public.agents(id,user_id,club_id,role,status,commission_rate,player_rakeback_rate,
   credit_limit,credit_used,is_prepaid,business_balance,player_balance,promo_balance,
   total_players,active_player_count,sub_agent_count,weekly_rake_generated,lifetime_earnings,
   joined_at,created_at,updated_at,last_active_at,lifetime_rake_generated,
   agent_wallet_balance,player_wallet_balance,promo_wallet_balance)
  SELECT held_fee_fixture.agent_id(),user_id,club_id,'agent','active',0.3,0.1,
   0,0,false,0,0,0,0,0,0,11.11,0,
   held_fee_fixture.terms_at(),held_fee_fixture.terms_at(),held_fee_fixture.terms_at(),
   held_fee_fixture.terms_at(),123.4567,0,0,0 FROM held_fee_fixture.agent;
 END IF;
 IF mode='zero' THEN
  UPDATE public.accounting_agreement_history
   SET after_terms=jsonb_set(after_terms,'{commission_rate}','0'::jsonb)
   WHERE entity_type='agents' AND entity_key=held_fee_fixture.agent_id()::text;
 END IF;
 IF mode='closed_empty_tiers' THEN
  INSERT INTO public.agent_commission_settlements(club_id,user_id,period_start,period_end,amount,rows_count)
  SELECT club_id,min(user_id::text)::uuid,transaction_timestamp()-interval '1 minute',
   transaction_timestamp()+interval '1 minute',0,0
  FROM held_fee_fixture.contributors WHERE club_id<>(SELECT club_id FROM held_fee_fixture.agent)
  GROUP BY club_id;
 END IF;
 PERFORM set_config('session_replication_role','origin',true);
END $seed$;

DO $exercise$
DECLARE mode text:=current_setting('held_fee_fixture.commission_case');
 r jsonb;economic jsonb;state jsonb;code text;message text;started timestamptz;
 elapsed_ms numeric;calls bigint;commission_count integer;commission_amount numeric;
 expected_rows integer:=CASE WHEN mode='zero' THEN 0 ELSE 2 END;
BEGIN
 IF mode='closed_empty_tiers' THEN
  PERFORM held_fee_fixture.assert((SELECT bool_and(jsonb_array_length(
   public.fn_accounting_earning_contract(c.club_id,c.user_id,c.rake_amount,
    held_fee_fixture.union_id(),held_fee_fixture.terms_at())->'tiers')=0)
   FROM held_fee_fixture.contributors c WHERE c.club_id<>(SELECT club_id FROM held_fee_fixture.agent)),
   'Commission closed-period scene has no earning tiers in the closed club');
  state:=held_fee_fixture.snapshot();started:=clock_timestamp();
  BEGIN
   PERFORM public.fn_ca_recognize_held_tournament_fees_by_owner_basis(held_fee_fixture.operation(),
    jsonb_build_array(jsonb_build_object('tournament_id',held_fee_fixture.event(),'amount',2.70)));
  EXCEPTION WHEN OTHERS THEN code:=SQLSTATE;message:=SQLERRM;END;
  elapsed_ms:=extract(epoch FROM clock_timestamp()-started)*1000;
  PERFORM held_fee_fixture.assert(code='23514' AND message='cash_accrual_closed_period_requires_adjustment'
   AND state=held_fee_fixture.snapshot(),'Commission closed empty-tier period refuses with every write rolled back');
  RAISE NOTICE 'COMMISSION_BATCH_RESULT %',jsonb_build_object('owner_elapsed_ms',elapsed_ms,
   'economic',jsonb_build_object('sqlstate',code,'message',message,'full_rollback',true));
  RETURN;
 END IF;

 started:=clock_timestamp();
 r:=public.fn_ca_recognize_held_tournament_fees_by_owner_basis(held_fee_fixture.operation(),
  jsonb_build_array(jsonb_build_object('tournament_id',held_fee_fixture.event(),'amount',2.70)));
 elapsed_ms:=extract(epoch FROM clock_timestamp()-started)*1000;
 -- The real deferred terminal receipt must execute while this scene is live.
 SET CONSTRAINTS ALL IMMEDIATE;
 IF mode='ordinary_fallback' THEN
  PERFORM held_fee_fixture.assert(NOT EXISTS(SELECT 1 FROM pg_locks
   WHERE pid=pg_backend_pid() AND granted AND locktype='relation'
    AND relation='public.agent_commissions'::regclass
    AND pg_locks.mode IN('ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')),
   'Ordinary commission caller has no strong commission relation admission');
 END IF;
 SELECT CASE WHEN is_called THEN last_value ELSE 0 END INTO calls FROM held_fee_fixture.commission_rollup_calls;
 SELECT count(*),COALESCE(sum(c.amount),0) INTO commission_count,commission_amount
  FROM public.agent_commissions c JOIN public.accounting_tournament_fee_sources s ON s.id=c.source_id
  WHERE s.tournament_id=held_fee_fixture.event() AND c.source_type='tournament_fee_accrual';
 PERFORM held_fee_fixture.assert(r->>'ok'='true' AND (r->>'amount')::numeric=2.70
  AND (r->>'escrow_out')::numeric=2.70 AND (r->>'bank_in')::numeric=2.70
  AND (r->>'recognized_credit')::numeric=2.70 AND r->>'prizes_unchanged'='true',
  'Commission scene preserves full owner conservation');
 PERFORM held_fee_fixture.assert(commission_count=expected_rows
  AND commission_amount=CASE WHEN mode='zero' THEN 0 ELSE 0.06 END
  AND (SELECT count(*)=27 AND sum(rake_credit)=2.70 FROM public.accounting_tournament_recognized_sources
   WHERE tournament_id=held_fee_fixture.event()),'Commission scene preserves exact earned rows and source cents');
 PERFORM held_fee_fixture.assert(calls=current_setting('held_fee_fixture.commission_rollups')::bigint,
  'Commission scene executes the expected number of real statement rollups');
 PERFORM held_fee_fixture.assert(CASE WHEN mode='retired' THEN
  NOT EXISTS(SELECT 1 FROM public.agents WHERE id=held_fee_fixture.agent_id()) AND commission_count=2
  ELSE (SELECT lifetime_rake_generated=123.6567 AND weekly_rake_generated=11.31
   AND last_active_at=transaction_timestamp() AND updated_at=transaction_timestamp()
   AND agent_wallet_balance=0 AND player_wallet_balance=0 AND promo_wallet_balance=0
   FROM public.agents WHERE id=held_fee_fixture.agent_id()) END,
  'Commission profile counters include zero tiers and a retired profile retains its earned liability');

 -- Stable earning keys replace freshly allocated source/commission UUIDs;
 -- transaction timestamps become explicit equality checks, not dropped fields.
 SELECT jsonb_build_object(
  'owner',jsonb_build_object('amount',r->'amount','escrow_out',r->'escrow_out','bank_in',r->'bank_in',
   'recognized_credit',r->'recognized_credit','prizes_unchanged',r->'prizes_unchanged',
   'settlement_suspense_net',r->'settlement_suspense_net'),
  'commissions',(SELECT COALESCE(jsonb_agg(jsonb_build_object('rake_record_id',s.rake_record_id,
   'club_id',c.club_id,'user_id',c.user_id,'amount',c.amount,'rate',c.commission_rate,
   'source_type',c.source_type,'notes',c.notes,'earned_at_is_transaction',c.created_at=transaction_timestamp(),
   'settled_at',c.settled_at) ORDER BY s.rake_record_id,c.user_id),'[]'::jsonb)
   FROM public.agent_commissions c JOIN public.accounting_tournament_fee_sources s ON s.id=c.source_id
   WHERE s.tournament_id=held_fee_fixture.event() AND c.source_type='tournament_fee_accrual'),
  'sources',(SELECT jsonb_agg(jsonb_build_object('rake_record_id',s.rake_record_id,'club_id',s.club_id,
   'player_id',s.player_id,'rake_credit',q.rake_credit,'disposition',q.disposition,
   'recognized_at_is_transaction',q.recognized_at=transaction_timestamp()) ORDER BY s.rake_record_id)
   FROM public.accounting_tournament_fee_sources s JOIN public.accounting_tournament_recognized_sources q ON q.source_id=s.id
   WHERE s.tournament_id=held_fee_fixture.event()),
  'profile',(SELECT jsonb_build_object('id',a.id,'club_id',a.club_id,'user_id',a.user_id,
   'weekly',a.weekly_rake_generated,'lifetime',a.lifetime_rake_generated,
   'last_active_is_transaction',a.last_active_at=transaction_timestamp(),'updated_is_transaction',a.updated_at=transaction_timestamp())
   FROM public.agents a WHERE a.id=held_fee_fixture.agent_id()),
  'unsettled_rollup',(SELECT COALESCE(jsonb_agg(jsonb_build_object('club_id',u.club_id,'user_id',u.user_id,
   'owed',u.owed,'rows_behind',u.rows_behind,'oldest',CASE WHEN u.oldest_unsettled=transaction_timestamp()
    THEN 'CURRENT_TRANSACTION' ELSE u.oldest_unsettled::text END) ORDER BY u.club_id,u.user_id),'[]'::jsonb)
   FROM public.agent_commission_unsettled_rollup u JOIN held_fee_fixture.agent a ON a.club_id=u.club_id AND a.user_id=u.user_id),
  'daily_rollup',(SELECT COALESCE(jsonb_agg(jsonb_build_object('club_id',d.club_id,'amount',d.amount,
   'rows_counted',d.rows_counted) ORDER BY d.club_id),'[]'::jsonb) FROM public.ca_club_commission_daily d
   WHERE d.club_id IN(SELECT club_id FROM held_fee_fixture.contributors) AND d.stat_date=(transaction_timestamp() AT TIME ZONE 'UTC')::date),
  'player_stats',(SELECT jsonb_agg(to_jsonb(p)-'id'-'updated_at' ORDER BY p.club_id,p.user_id)
   FROM public.player_stats p WHERE EXISTS(SELECT 1 FROM held_fee_fixture.contributors c WHERE c.club_id=p.club_id AND c.user_id=p.user_id)),
  'applied_stats',(SELECT jsonb_agg(to_jsonb(a)-'created_at' ORDER BY a.rake_record_id,a.user_id)
   FROM public.rakeback_stats_applied a WHERE a.rake_record_id IN(SELECT rake_record_id FROM held_fee_fixture.contributors))) INTO economic;

 -- Exercise the actual production source guard after the real owner call.
 -- Deliberately wrong cents must never produce a commission or rollup write.
 state:=held_fee_fixture.snapshot();
 BEGIN
  INSERT INTO public.agent_commissions(club_id,user_id,amount,commission_rate,source_type,source_id,notes,created_at)
  SELECT s.club_id,(tier->>'user_id')::uuid,(tier->>'amount')::numeric+0.01,
   (tier->>'rate')::numeric,'tournament_fee_accrual',s.id,'private negative fixture',transaction_timestamp()
  FROM public.accounting_tournament_fee_sources s CROSS JOIN LATERAL jsonb_array_elements(s.contract->'tiers') tier
  WHERE s.tournament_id=held_fee_fixture.event() ORDER BY s.rake_record_id LIMIT 1;
 EXCEPTION WHEN OTHERS THEN code:=SQLSTATE;END;
 PERFORM held_fee_fixture.assert(code='23514' AND state=held_fee_fixture.snapshot(),
  'Commission row guard rejects a different tier amount without side effects');
 RAISE NOTICE 'COMMISSION_BATCH_RESULT %',jsonb_build_object('owner_elapsed_ms',elapsed_ms,
  'rollup_calls',calls,'commission_rows',commission_count,'economic',economic);
END $exercise$;
