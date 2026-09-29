-- ===========================================================================
--  AN ACCRUAL EXCLUDES THE WEEKLY CLOSE. IT MUST NOT EXCLUDE ANOTHER ACCRUAL.
-- ===========================================================================
--
-- Four functions guard the weekly accounting period with an advisory lock
-- keyed on (club-or-union, week_start, week_end):
--
--   fn_accrue_cash_hand_commissions                 once per CASH HAND
--   fn_settle_tournament_rake                       once per TOURNAMENT RAKE SETTLE
--   fn_lock_cash_bank_accounting_week               once per HAND, via atomic_distribute_rake
--   fn_lock_accounting_tournament_recognition_week  once per tournament recognition
--
-- All four took that key EXCLUSIVELY. The lock exists for exactly one reason,
-- written down in fn_resolve_accounting_routing_scope:
--
--     "Acquire before reading source-club membership: a waiting close must see
--      all earning sources committed by the previous lock holder. Accrual
--      shares this key."
--
-- That is a reader/writer contract - many accruals against one weekly close -
-- and it was implemented as writer/writer. Because the key spans SEVEN DAYS,
-- every cash hand and every tournament rake settle in a club serialised
-- through a single lock for a whole week, in FIFO order, however little each
-- one had to do.
--
-- MEASURED ON PRODUCTION 2026-09-29 02:52 UTC, 20 samples over 20 s:
--   mean 24.25 backends waiting on advisory locks, max 45
--   of those, 18.05 mean / 34 max were on these week keys  -> 74.4% of all
--     advisory waiting on the platform
--   against 0.80 mean on the per-table hand locks, which fan out correctly
--   observed queue depth on one key: seven deep, strict FIFO
--
-- Every queued transaction holds all of its other locks while it waits,
-- including the FOR KEY SHARE the rake_records -> clubs foreign key takes on
-- the club row. That is why the clubs tuple queue and the MultiXact SLRU
-- pressure grew with it: they are downstream of this queue, not beside it.
--
-- THE FIX is one keyword in each of the four: pg_advisory_xact_lock_shared.
-- The close side (fn_resolve_accounting_routing_scope, fn_prepare_accounting_week,
-- fn_process_weekly_accounting_scope) keeps the exclusive side untouched, so
-- the documented exclusion is preserved EXACTLY - shared and exclusive still
-- conflict - while accruals stop excluding each other.
--
-- WHY ALL FOUR MOVE TOGETHER AND NOT ONE AT A TIME. fn_settle_tournament_rake
-- calls fn_lock_accounting_tournament_recognition_week on the SAME key. Had
-- only one of that pair become shared, the chain would request an exclusive
-- lock over its own shared hold. This repository already paid for that lesson
-- once: "2026-09-10: no upgrades, they deadlock"
-- (fn_ca_lock_settlement_lane_global).
--
-- The per-hand key inside fn_accrue_cash_hand_commissions
-- ('accounting_cash_hand:'||p_hand_id) stays EXCLUSIVE. It is the exactly-once
-- guard for one hand, it never contends with a sibling, and it is not this bug.
--
-- Concurrent accruals are safe against each other by construction, which is
-- why sharing is correct and not merely faster: accounting_cash_accrual_batches
-- is keyed by rake_record_id, accounting_cash_rake_sources by
-- (rake_record_id, player), agent_commissions is insert-only, and the only
-- accumulator - agents.lifetime_rake_generated / weekly_rake_generated - is
-- written as SET x = x + delta in a single statement, which PostgreSQL
-- serialises on the agent row itself.
--
-- Proof: scripts/ci/test-accounting-week-lane-shared.py, on a disposable
-- PostgreSQL 17 cluster. 8 concurrent accruals of 0.3 s each: 2.449 s wall
-- exclusive, 0.370 s shared, a 6.61x speedup, 8 of 8 rows landing in both, and
-- the close still excluded in both directions.
--
-- Pinned by: scripts/ci/check-accounting-week-lock-mode.mjs
-- ===========================================================================

SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.fn_accrue_cash_hand_commissions(p_hand_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE source public.rake_records%ROWTYPE; batch public.accounting_cash_accrual_batches%ROWTYPE;
 fingerprint text; plan jsonb; player jsonb; source_id uuid; count_rows int:=0; cutoff timestamptz;scope record;week_start timestamptz;week_end timestamptz;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_hand_id IS NULL THEN RAISE EXCEPTION 'cash_hand_id_required' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_cash_hand:'||p_hand_id::text,0));
 SELECT * INTO source FROM public.rake_records WHERE hand_id=p_hand_id FOR SHARE;
 IF NOT FOUND OR COALESCE(source.is_tournament,false) OR source.tournament_id IS NOT NULL OR source.rake_amount<=0
 THEN RAISE EXCEPTION 'cash_rake_source_required' USING ERRCODE='23514'; END IF;
 SELECT md5(jsonb_build_object('record',source.id,'hand',source.hand_id,'rake',source.rake_amount,'earned_at',source.created_at,
   'shares',COALESCE(jsonb_agg(jsonb_build_array(a.id,a.player_id,a.club_id,a.weighted_rake_credit) ORDER BY a.player_id),'[]'::jsonb))::text)
 INTO fingerprint FROM public.rake_attributions a WHERE a.rake_record_id=source.id;
 SELECT * INTO batch FROM public.accounting_cash_accrual_batches WHERE rake_record_id=source.id;
 IF FOUND THEN
  IF batch.source_fingerprint<>fingerprint THEN RAISE EXCEPTION 'cash_accrual_source_changed_after_recording' USING ERRCODE='23514'; END IF;
  RETURN jsonb_build_object('recorded',true,'duplicate',true,'status',batch.status,'source_version',2);
 END IF;
 SELECT starts_at INTO cutoff FROM public.accounting_cash_accrual_cutover WHERE singleton;
 IF cutoff IS NULL THEN RAISE EXCEPTION 'cash_accrual_cutover_missing' USING ERRCODE='23514'; END IF;
 -- Legacy rows remain untouched. Recording this gap is not a commission
 -- credit or a successful weekly close. The coordinator must reject it.
 IF source.created_at<cutoff THEN
  INSERT INTO public.accounting_cash_accrual_batches(rake_record_id,hand_id,earned_at,source_fingerprint,status)
   VALUES(source.id,source.hand_id,source.created_at,fingerprint,'legacy_unverified');
  RETURN jsonb_build_object('recorded',true,'status','legacy_unverified','requires_reconciliation',true,'source_version',2);
 END IF;
 IF EXISTS(SELECT 1 FROM public.agent_commissions ac WHERE ac.source_id=source.hand_id AND ac.source_type IN('rake','rake_settlement'))
 THEN RAISE EXCEPTION 'cash_accrual_legacy_writer_after_cutover' USING ERRCODE='23514'; END IF;
 plan:=public.fn_accounting_cash_commission_plan(source.id);
 week_start:=public.fn_union_week_start(source.created_at);week_end:=public.fn_union_week_start(week_start+interval '8 days');
 FOR scope IN SELECT DISTINCT CASE WHEN p->>'coordinator_union_id' IS NOT NULL THEN 'union-accounting:' ELSE 'club-accounting:' END
   ||COALESCE(p->>'coordinator_union_id',p->>'club_id')||':'||extract(epoch FROM week_start)::text||':'||extract(epoch FROM week_end)::text AS lock_key
   FROM jsonb_array_elements(plan->'players')p ORDER BY lock_key LOOP
  -- Shared: an accrual excludes the weekly close, never a sibling accrual.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(scope.lock_key,0));
 END LOOP;
 -- An empty or zero-own-commission completed week still closes the source set.
 IF EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r CROSS JOIN LATERAL jsonb_array_elements(plan->'players')p
  WHERE r.period_start<=source.created_at AND r.period_end>source.created_at
   AND((r.union_id IS NOT NULL AND r.union_id::text=p->>'coordinator_union_id')
    OR(r.standalone_club_id IS NOT NULL AND p->>'coordinator_union_id' IS NULL AND r.standalone_club_id::text=p->>'club_id')))
 THEN RAISE EXCEPTION 'cash_accrual_closed_period_requires_adjustment' USING ERRCODE='23514'; END IF;
 INSERT INTO public.accounting_cash_accrual_batches(rake_record_id,hand_id,earned_at,source_fingerprint,status,plan)
  VALUES(source.id,source.hand_id,source.created_at,fingerprint,'accrued',plan);
 FOR player IN SELECT value FROM jsonb_array_elements(plan->'players') LOOP
  IF EXISTS(SELECT 1 FROM public.agent_commission_settlements s WHERE s.club_id=(player->>'club_id')::uuid
   AND source.created_at>=s.period_start AND source.created_at<s.period_end)
  THEN RAISE EXCEPTION 'cash_accrual_closed_period_requires_adjustment' USING ERRCODE='23514'; END IF;
  INSERT INTO public.accounting_cash_rake_sources(rake_record_id,player_id,club_id,union_id,coordinator_union_id,earned_at,rake_credit,contract)
   VALUES(source.id,(player->>'player_id')::uuid,(player->>'club_id')::uuid,(player->>'union_id')::uuid,(player->>'coordinator_union_id')::uuid,source.created_at,(player->>'rake_credit')::numeric,player)
   RETURNING id INTO source_id;
  count_rows:=count_rows+public.fn_post_accounting_commission_source(source_id,'cash_rake_accrual',source.created_at,player);
 END LOOP;
 RETURN jsonb_build_object('recorded',true,'status','accrued','source_version',2,'rows_written',count_rows);
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_lock_cash_bank_accounting_week(p_club_id uuid, p_game_union_id uuid, p_banked_at timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE coordinator uuid;memberships int;week_from timestamptz;week_to timestamptz;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_club_id IS NULL OR p_banked_at IS DISTINCT FROM transaction_timestamp() THEN
  RAISE EXCEPTION 'cash_bank_week_identity_invalid' USING ERRCODE='22023'; END IF;
 coordinator:=p_game_union_id;
 IF coordinator IS NULL THEN
  -- A private game's bank remains local. Its weekly coordinator is determined
  -- independently from the observed membership, matching the source contract.
  SELECT count(*),(array_agg((h.after_terms->>'union_id')::uuid))[1] INTO memberships,coordinator FROM (
   SELECT DISTINCT ON(entity_key) entity_key,after_terms FROM public.accounting_agreement_history
    WHERE entity_type='union_clubs' AND club_id=p_club_id AND observed_at<=p_banked_at
    ORDER BY entity_key,observed_at DESC,id DESC
  )h WHERE h.after_terms IS NOT NULL AND h.after_terms->>'club_id'=p_club_id::text;
  IF memberships>1 THEN RAISE EXCEPTION 'cash_bank_coordinator_ambiguous' USING ERRCODE='55000'; END IF;
 END IF;
 week_from:=public.fn_union_week_start(p_banked_at);week_to:=public.fn_union_week_start(week_from+interval '8 days');
 -- Shared: this guard only READS the closed-week tables. It excludes the
 -- weekly close, never a sibling bank.
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(
  CASE WHEN coordinator IS NOT NULL THEN 'union-accounting:' ELSE 'club-accounting:' END
  ||COALESCE(coordinator,p_club_id)::text||':'||extract(epoch FROM week_from)::text||':'||extract(epoch FROM week_to)::text,0));
 IF EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.period_start=week_from AND r.period_end=week_to
   AND ((coordinator IS NOT NULL AND r.union_id=coordinator) OR (coordinator IS NULL AND r.standalone_club_id=p_club_id)))
  OR EXISTS(SELECT 1 FROM public.union_rakeback_log l WHERE l.union_id=coordinator AND l.period_start<=p_banked_at AND l.period_end>p_banked_at)
 THEN RAISE EXCEPTION 'cash_bank_closed_week_requires_adjustment' USING ERRCODE='55000'; END IF;
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_lock_accounting_tournament_recognition_week(p_tournament_id uuid, p_recognized_at timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$DECLARE scope record;week_start timestamptz;week_end timestamptz;BEGIN
 week_start:=public.fn_union_week_start(p_recognized_at);
 week_end:=((week_start AT TIME ZONE 'America/Los_Angeles')+interval '7 days') AT TIME ZONE 'America/Los_Angeles';
 FOR scope IN
  WITH scopes AS (
   SELECT coordinator_union_id,club_id FROM public.accounting_tournament_fee_sources WHERE tournament_id=p_tournament_id
   UNION
   -- The actual bank also participates in the same close order. A legacy event
   -- may have no captured contributor; this names its game bank, never guesses
   -- a contributor's historical membership or commission agreement.
   SELECT f.union_id,t.club_id FROM public.tournaments t
    JOIN public.accounting_tournament_fee_sources f ON f.tournament_id=t.id WHERE t.id=p_tournament_id AND t.club_id IS NOT NULL
   UNION
   SELECT CASE WHEN t.is_private THEN NULL ELSE t.union_id END,t.club_id FROM public.tournaments t
    WHERE t.id=p_tournament_id AND t.club_id IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f WHERE f.tournament_id=t.id)
  ) SELECT DISTINCT coordinator_union_id,club_id,
   CASE WHEN coordinator_union_id IS NULL THEN 'club-accounting:'||club_id::text ELSE 'union-accounting:'||coordinator_union_id::text END
    ||':'||extract(epoch FROM week_start)::text||':'||extract(epoch FROM week_end)::text lock_key
  FROM scopes ORDER BY lock_key
 LOOP
  -- Shared: recognition excludes the weekly close, never a sibling accrual.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(scope.lock_key,0));
  IF EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r WHERE r.period_start<=p_recognized_at AND r.period_end>p_recognized_at
   AND ((r.union_id IS NOT NULL AND r.union_id=scope.coordinator_union_id)
     OR (r.standalone_club_id IS NOT NULL AND scope.coordinator_union_id IS NULL AND r.standalone_club_id=scope.club_id))) THEN
   RAISE EXCEPTION 'tournament_accrual_closed_period_requires_adjustment' USING ERRCODE='23514'; END IF;
 END LOOP;
END$function$
;

CREATE OR REPLACE FUNCTION public.fn_settle_tournament_rake(p_tournament_id uuid, p_source text DEFAULT 'engine'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
 v_t record;v_prior record;v_claimed int;v_plan jsonb;v_att jsonb;v_res jsonb;
 v_net numeric;v_union uuid;v_dest text;v_reason text;v_raw record;v_bank_id uuid;v_journal_id uuid;v_matches int;
 v_week_start timestamptz;v_week_end timestamptz;v_lock_key text;v_attempt int:=0;
BEGIN
 PERFORM public.fn_ca_lock_settlement_lane_global();
 SELECT t.id,t.status,t.club_id,t.union_id,t.is_private,t.name,t.current_players INTO v_t
  FROM public.tournaments t WHERE t.id=p_tournament_id FOR NO KEY UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','not_found'); END IF;
 IF upper(COALESCE(v_t.status,'')) NOT IN('COMPLETING','COMPLETED','CANCELLED','CANCELED') THEN
  RETURN jsonb_build_object('ok',false,'reason','not_terminal','status',v_t.status); END IF;
 PERFORM public.fn_ca_begin_legacy_fee_resolution(p_tournament_id);
 INSERT INTO public.tournament_rake_settlements(tournament_id,club_id,amount,destination,source)
 VALUES(p_tournament_id,v_t.club_id,0,'pending',COALESCE(p_source,'engine')) ON CONFLICT(tournament_id) DO NOTHING;
 GET DIAGNOSTICS v_claimed=ROW_COUNT;
 IF v_claimed=0 THEN
  SELECT * INTO v_prior FROM public.tournament_rake_settlements WHERE tournament_id=p_tournament_id;
  -- Historical claims do not authorize another fee transfer or a success
  -- claim unless their stored attribution actually completed.
  IF v_prior.settled_at IS NULL OR v_prior.attributed_at IS NULL
   OR v_prior.attributed_users IS NULL OR v_prior.attributed_users<0
   OR v_prior.attribution_error IS NOT NULL
   OR NULLIF(v_prior.destination,'') IS NULL OR v_prior.destination='pending' THEN
   RETURN jsonb_build_object('ok',false,'already_settled',true,
    'reason','settlement_attribution_incomplete','amount',v_prior.amount,
    'destination',v_prior.destination,'settled_at',v_prior.settled_at,'attributed',false);
  END IF;
  IF v_prior.amount>0 AND v_prior.union_id IS NULL AND NOT public.fn_poker_diamond_tournament(p_tournament_id)
   AND v_prior.destination IS DISTINCT FROM 'chip_retirement:'||v_prior.club_id::text THEN
   RAISE EXCEPTION 'tournament_fee_legacy_treasury_leg_requires_adjustment' USING ERRCODE='55000'; END IF;
  v_att:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  IF v_prior.amount>0 AND v_prior.union_id IS NULL AND NOT public.fn_poker_diamond_tournament(p_tournament_id) AND v_att IS NULL THEN
   RAISE EXCEPTION 'tournament_fee_disposition_receipt_missing' USING ERRCODE='55000'; END IF;
  RETURN jsonb_build_object('ok',true,'already_settled',true,'amount',v_prior.amount,'destination',v_prior.destination,
    'settled_at',v_prior.settled_at,'attributed',true,'attributed_users',v_prior.attributed_users,
    'no_attribution_due',v_prior.amount=0,'accounting',v_att);
 END IF;
  -- DIAMOND PHASE 8: a Diamond event's fee sits in its custody rows, not in
  -- rake_records; it goes to the house, and then the emptied custody closes.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    v_res := public.fn_poker_diamond_tournament_settle_fee(p_tournament_id, COALESCE(p_source, 'engine'));
    v_net := COALESCE((v_res->>'amount')::numeric, 0);
    UPDATE public.tournament_rake_settlements
       SET amount = v_net,
           destination = CASE WHEN v_net > 0 THEN 'diamond_house' ELSE 'none' END,
           settled_at = now(), attributed_at = now(), attributed_users = 0
     WHERE tournament_id = p_tournament_id;
    v_res := public.fn_poker_diamond_tournament_close_custody(p_tournament_id);
    RETURN jsonb_build_object('ok', true, 'amount', v_net,
      'destination', CASE WHEN v_net > 0 THEN 'diamond_house' ELSE 'none' END,
      'attributed', true, 'attributed_users', 0, 'members', 0, 'asset', 'diamonds',
      'custody_closed', v_res->>'closed', 'custody_still_held', v_res->>'still_held');
  END IF;

 -- Deferred capture is normally already committed. A same-transaction Spin
 -- close still captures the original exact charge before it can be recognized.
 FOR v_raw IN SELECT r.id FROM public.rake_records r WHERE r.tournament_id=p_tournament_id AND r.is_tournament
  AND r.rake_amount>0 AND r.created_at=transaction_timestamp()
  AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches b WHERE b.rake_record_id=r.id) ORDER BY r.id LOOP
  PERFORM public.fn_stamp_accounting_tournament_fee(v_raw.id);
 END LOOP;
 -- 2026-09-20. A fee charged BEFORE the cutover was never captured by a
 -- producer, and fn_ca_capture_tournament_fee_from_recorded_evidence - the
 -- reader built for exactly that record - was reachable only from
 -- fn_ca_begin_legacy_fee_resolution, which does nothing unless the event
 -- already holds a custody obligation, which only a named event can get.
 -- So the reader was never called for an event that was not on a list.
 -- Call it here, on the ordinary close, while the event is COMPLETING.
 -- Each capture takes its own subtransaction: one that cannot prove itself
 -- rolls back alone and leaves its record exactly as it was, so the net
 -- plan below still refuses in the same words and legacy custody still
 -- receives the same reason. This can only add proof, never remove it.
 FOR v_raw IN SELECT r.id FROM public.rake_records r
   JOIN public.accounting_tournament_fee_cutover c ON c.singleton
  WHERE r.tournament_id=p_tournament_id AND r.is_tournament
    AND r.rake_amount>0 AND r.hand_id IS NULL AND r.created_at<c.starts_at
    AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches b WHERE b.rake_record_id=r.id)
  ORDER BY r.id LOOP
  BEGIN
   PERFORM public.fn_ca_capture_tournament_fee_from_recorded_evidence(v_raw.id);
  EXCEPTION WHEN OTHERS THEN
   -- Not silence: the reason travels to the log, and the refusal that
   -- follows is unchanged. "Could not prove it" is not "there was nothing".
   RAISE NOTICE 'pre-cutover fee % left uncaptured: % (%)', v_raw.id, SQLERRM, SQLSTATE;
  END;
 END LOOP;
 SELECT COALESCE(sum(r.rake_amount),0) INTO v_net FROM public.rake_records r WHERE r.tournament_id=p_tournament_id AND r.is_tournament;
 IF v_net<0 OR v_net<>round(v_net,2) OR v_net::text IN('NaN','Infinity','-Infinity') THEN
  RAISE EXCEPTION 'tournament_fee_net_invalid' USING ERRCODE='23514'; END IF;
 BEGIN
  -- Qualify only this owning close's complete original mixed-cutover Spin
  -- receipts. The original batch remains unchanged; any failure below rolls
  -- proof, source rows, claim, bank transfer and recognition back together.
  FOR v_raw IN SELECT r.id FROM public.rake_records r
   JOIN public.accounting_tournament_fee_batches b ON b.rake_record_id=r.id
   JOIN public.accounting_tournament_fee_cutover c ON c.singleton
   WHERE r.tournament_id=p_tournament_id AND r.is_tournament AND r.rake_amount>0
    AND r.source='fn_spin_book_entry' AND r.created_at>=c.starts_at
    AND b.status='legacy_unverified' AND b.source_manifest IS NULL ORDER BY r.id LOOP
   PERFORM public.fn_accounting_qualify_mixed_cutover_spin_fee(v_raw.id);
  END LOOP;
  v_plan:=public.fn_accounting_tournament_fee_net_plan(p_tournament_id);
 EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM NOT IN('tournament_fee_sources_require_reconciliation','accounting_terms_not_observed','accounting_terms_not_active','tournament_fee_not_captured_by_original_producer') THEN RAISE; END IF;
  v_reason:=SQLERRM;
  -- A new positive fee cannot leave custody before its exact attribution is
  -- available. Throw: direct callers must also roll back the inserted claim.
  IF v_net>0 THEN
   RAISE EXCEPTION 'tournament % rake attribution incomplete: %',p_tournament_id,v_reason USING ERRCODE='P0404';
  END IF;
  -- Exact zero owes no new attribution. Preserve the predecessor's zero-fee
  -- completion without inventing a source, bank, commission or paid receipt.
 END;
 v_union:=CASE WHEN v_reason IS NULL THEN NULLIF(v_plan->>'union_id','')::uuid
  WHEN v_t.is_private THEN NULL ELSE v_t.union_id END;
 PERFORM public.fn_lock_accounting_tournament_recognition_week(p_tournament_id,transaction_timestamp());
 -- A legacy event may have no captured contributor scope. Its actual bank
 -- still takes the exact same close lock, before either wallet is touched.
 v_week_start:=public.fn_union_week_start(transaction_timestamp());
 v_week_end:=((v_week_start AT TIME ZONE 'America/Los_Angeles')+interval '7 days') AT TIME ZONE 'America/Los_Angeles';
 v_lock_key:=CASE WHEN v_union IS NULL THEN 'club-accounting:'||v_t.club_id::text ELSE 'union-accounting:'||v_union::text END
  ||':'||extract(epoch FROM v_week_start)::text||':'||extract(epoch FROM v_week_end)::text;
 IF v_lock_key IS NOT NULL THEN PERFORM pg_advisory_xact_lock_shared(hashtextextended(v_lock_key,0)); END IF;
 IF EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs x WHERE x.period_start<=transaction_timestamp() AND x.period_end>transaction_timestamp()
   AND ((v_union IS NOT NULL AND x.union_id=v_union) OR(v_union IS NULL AND x.standalone_club_id=v_t.club_id))) THEN
  RAISE EXCEPTION 'tournament_accrual_closed_period_requires_adjustment' USING ERRCODE='23514'; END IF;
 IF v_net>0 THEN
  IF v_t.club_id IS NULL THEN RAISE EXCEPTION 'tournament_fee_bank_club_required' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM public.club_wallets WHERE club_id=v_t.club_id FOR NO KEY UPDATE;
  PERFORM set_config('app.ledger_category','rake',true);
  PERFORM set_config('app.ledger_counterparty','prize_liability',true);
  PERFORM set_config('app.ledger_counterparty_entity',p_tournament_id::text,true);
  /* THE TOURNAMENT RAKE LEG NAMES THE CLUB IT WAS EARNED IN (2026-09-21).
     The union fee is routed by UPDATE-ing union_wallets.rake_wallet through
     increment_union_wallet; fn_ca_autoledger journals that delta, and
     union_wallets has no club_id column, so every tournament union rake leg
     was written club-less. 20260920192513 taught the autoledger to read a
     declaring payer and fixed the PRIZE legs; 20260921040847 made the
     cash-table rake payer declare; this is the tournament rake payer saying
     the same thing. v_t.club_id is refused NULL above, and is the same club
     handed to increment_union_wallet for union_wallet_transactions.club_id,
     so the leg and its sibling receipt name one club or the fee does not
     move at all. NOT app.ledger_club_id: that name decides which club a
     WALLET credit is paid into (atomic_credit_wallet_and_log) and is set and
     restored by the rakeback close, so clearing it here would move money. */
  PERFORM set_config('app.ledger_autoledger_club_id',COALESCE(v_t.club_id::text,''),true);
  IF v_union IS NOT NULL THEN
   v_res:=public.increment_union_wallet(v_union,v_net,v_t.club_id,
    'Tournament rake: '||COALESCE(v_t.name,'tournament')||' [tournament '||p_tournament_id::text||']');
   IF COALESCE((v_res->>'success')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'tournament_fee_union_credit_failed' USING ERRCODE='23514'; END IF;
   SELECT count(*),(array_agg(id))[1] INTO v_matches,v_bank_id FROM public.union_wallet_transactions
    WHERE union_id=v_union AND club_id=v_t.club_id AND wallet='rake_wallet' AND direction='credit' AND tx_type='rake'
     AND amount=v_net AND created_at=transaction_timestamp() AND position('[tournament '||p_tournament_id::text||']' IN COALESCE(notes,''))>0;
   v_dest:='union:'||v_union::text;
  ELSE
   -- The original settlement-row trigger removes this exact fee from escrow.
   -- Retire that liability in the canonical journal; never debit a treasury or
   -- call fn_ca_burn, which would take these same chips from a wallet again.
   UPDATE public.clubs SET total_rake=COALESCE(total_rake,0)+v_net,updated_at=now()
    WHERE id=v_t.club_id;
   IF NOT FOUND THEN RAISE EXCEPTION 'tournament_fee_club_missing' USING ERRCODE='23514'; END IF;
   INSERT INTO public.chip_ledger
    (performed_by,from_type,from_entity_id,to_type,to_entity_id,club_id,tournament_id,category,amount,description)
   VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
    'prize_liability',p_tournament_id,'chip_retirement',NULL,v_t.club_id,p_tournament_id,'burn',v_net,
    'Standalone tournament fee retired (fn_settle_tournament_rake)') RETURNING id INTO v_journal_id;
   v_matches:=1;
   v_dest:='chip_retirement:'||v_t.club_id::text;
  END IF;
  IF v_matches<>1 THEN RAISE EXCEPTION 'tournament_fee_exact_bank_receipt_required' USING ERRCODE='23514'; END IF;
  UPDATE public.club_wallets SET period_rake_collected=COALESCE(period_rake_collected,0)+v_net,
   lifetime_rake_collected=COALESCE(lifetime_rake_collected,0)+v_net,updated_at=now() WHERE club_id=v_t.club_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'tournament_fee_club_wallet_missing' USING ERRCODE='23514'; END IF;
  PERFORM set_config('app.ledger_autoledger_club_id','',true);
 ELSE v_dest:='none'; END IF;
 IF v_reason IS NULL THEN
  -- Preserve the installed bounded retry contract, now around the sole
  -- canonical recognition writer. Exhaustion and permanent errors escape the
  -- whole settlement; rolled-back attempts cannot retain partial attribution.
  LOOP
   v_attempt:=v_attempt+1;
   BEGIN
    v_att:=public.fn_recognize_accounting_tournament_fees(p_tournament_id,transaction_timestamp(),v_t.club_id,v_bank_id,v_journal_id);
    EXIT;
   EXCEPTION WHEN deadlock_detected OR lock_not_available THEN
    IF v_attempt>=4 THEN RAISE; END IF;
    PERFORM pg_sleep(CASE v_attempt WHEN 1 THEN 0.1 WHEN 2 THEN 0.3 ELSE 0.6 END);
   END;
  END LOOP;
  IF v_att->>'status' IS DISTINCT FROM (CASE WHEN v_net>0 THEN 'recognized' ELSE 'cancelled' END)
   OR (v_att->>'attributed_chips')::numeric IS DISTINCT FROM v_net
   OR (v_net>0 AND COALESCE((v_att->>'attributed_users')::int,0)<1) THEN
   RAISE EXCEPTION 'tournament % rake attribution incomplete: canonical source receipt',p_tournament_id USING ERRCODE='P0404';
  END IF;
 END IF;
 UPDATE public.tournament_rake_settlements SET amount=v_net,union_id=v_union,destination=v_dest,settled_at=transaction_timestamp(),
  attributed_at=transaction_timestamp(),attributed_users=COALESCE((v_att->>'attributed_users')::int,0),
  attribution_error=NULL WHERE tournament_id=p_tournament_id;
 IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_custody_resolutions WHERE tournament_id=p_tournament_id AND transaction_id=txid_current()) THEN
  UPDATE public.tournament_rake_settlements SET terminal_closed_at=(SELECT completed_at FROM public.tournament_terminal_settlements WHERE tournament_id=p_tournament_id) WHERE tournament_id=p_tournament_id AND terminal_closed_at IS NULL;
 END IF;
 RETURN jsonb_build_object('ok',true,'amount',v_net,'destination',v_dest,'attributed',true,
  'attributed_users',COALESCE((v_att->>'attributed_users')::int,0),'attribution_attempts',v_attempt,
  'no_attribution_due',v_net=0,'accounting',public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id));
END;
$function$
;

-- Self-contained ACLs: these four are SECURITY DEFINER and are engine-only.
-- CREATE OR REPLACE preserves existing grants, so these restate the live ACL
-- (postgres only, plus service_role on the tournament settle) rather than
-- change it, and make a fresh apply land in the same place.
--
-- Every browser role is named. anon inherits whatever PUBLIC holds, so a lone
-- REVOKE ... FROM PUBLIC reads as a fix and leaves anon reachable; none of
-- these four asks who is calling, so none of them may be reachable without an
-- account. They are reached only from other definer functions running as the
-- owner, so no browser role needs EXECUTE here.
REVOKE ALL ON FUNCTION public.fn_accrue_cash_hand_commissions(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_lock_cash_bank_accounting_week(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_lock_accounting_tournament_recognition_week(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_rake(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_rake(uuid, text) TO service_role;

-- The migration refuses to leave the lane in a shape it did not intend: each
-- accrual guard shared on the week key, the per-hand guard still exclusive.
DO $verify$
DECLARE missing text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO missing
    FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace
     AND p.proname IN ('fn_accrue_cash_hand_commissions','fn_lock_cash_bank_accounting_week',
                       'fn_lock_accounting_tournament_recognition_week','fn_settle_tournament_rake')
     AND p.prosrc NOT LIKE '%pg_advisory_xact_lock_shared(%';
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'weekly accounting guard is not shared: %', missing;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
                 AND p.proname='fn_accrue_cash_hand_commissions'
                 AND p.prosrc LIKE '%pg_advisory_xact_lock(hashtextextended(''accounting_cash_hand:''%') THEN
    RAISE EXCEPTION 'the per-hand exactly-once guard must stay exclusive';
  END IF;
END
$verify$;
