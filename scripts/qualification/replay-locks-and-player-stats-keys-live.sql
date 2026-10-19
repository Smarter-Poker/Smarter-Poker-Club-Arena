-- Production text of every door these cases measure: md5(pg_get_functiondef(oid))
-- read-only on 2026-10-19 ~15:45 UTC (the batch re-read ~19:40 UTC, after 20261019171753), pinned in replay-locks-and-player-stats-keys.manifest.json; the runner refuses to
-- measure unless each loaded body still has that md5. Generated, not edited.

CREATE OR REPLACE FUNCTION public.fn_ca_lock_mtt_admission_contract()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_abi text;
BEGIN
  SELECT abi INTO v_abi FROM public.ca_mtt_admission_contract WHERE singleton FOR SHARE;
  IF NOT FOUND OR v_abi NOT IN ('legacy-capacity-v1','unlimited-mtt-v2') THEN
    RAISE EXCEPTION 'MTT_ADMISSION_CONTRACT_MISSING_OR_UNKNOWN' USING ERRCODE='55000';
  END IF;
  RETURN v_abi;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_lock_settlement_lane_global()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Inside a non-satellite finish (2026-09-17) this transaction already
  -- holds that finish's lane: G shared, F exclusive, T(id) exclusive. The
  -- finish body and the settle functions still call this helper; re-enter
  -- the lane that is held instead of requesting G exclusively, which would
  -- be an upgrade of a shared hold (2026-09-10: no upgrades, they deadlock).
  IF COALESCE(current_setting('ca.finish_lane_tournament', true), '') <> '' THEN
    PERFORM public.fn_ca_lock_settlement_lane_for_finish(NULL);
    RETURN;
  END IF;
  -- G then B. Terminal / rare authorities: serialised against every other
  -- authority AND against every hand settlement, as on 2026-09-09.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1', 0));
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:hand-settlement-barrier:v1', 0));
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_lock_settlement_lane_for_finish(p_tournament_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_held text := COALESCE(current_setting('ca.finish_lane_tournament', true), '');
  v_held_scope text := COALESCE(current_setting('ca.finish_lane_scope', true), '');
  -- Unknown until the row proves it is a plain tournament: the whole lane.
  v_satellite boolean := true;
  v_scope text;
BEGIN
  -- Re-entry: this transaction already holds a finish lane. Every key below
  -- is already held by this backend, so nothing waits; a second tournament
  -- is refused, a transaction never holds two tournaments' lanes. (Inside a
  -- satellite finish or a sweep, F is held exclusively by this backend, so F
  -- shared is granted at once and no scope key is named.)
  IF v_held <> '' THEN
    IF p_tournament_id IS NOT NULL AND v_held <> p_tournament_id::text THEN
      RAISE EXCEPTION 'finish lane is held for tournament %, refused for %',
        v_held, p_tournament_id USING ERRCODE = '55000';
    END IF;
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended('ca:tournament-terminal-settlement:v1', 0));
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended('ca:tournament-finish-lane:v1', 0));
    IF v_held_scope <> '' THEN
      PERFORM pg_advisory_xact_lock(
        hashtextextended('ca:tournament-finish-lane:v1:scope:' || v_held_scope, 0));
    END IF;
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ca:tournament-terminal-settlement:v1:' || v_held, 0));
    RETURN;
  END IF;

  -- Resolve the tournament before any lock. variant, tournament_type and the
  -- satellite target are fixed for the life of the row, so reading them
  -- unlocked gives the answer reading them under the lane would. The bank
  -- scope is the host club's union, else the host club; the finish itself
  -- refuses (40001) if the club changes union before it holds the banks.
  IF p_tournament_id IS NOT NULL THEN
    SELECT (lower(COALESCE(t.variant::text, '')) = 'satellite'
            OR upper(COALESCE(t.tournament_type::text, '')) = 'SATELLITE'
            OR t.satellite_target_id IS NOT NULL
            OR t.satellite_target IS NOT NULL),
           COALESCE(c.union_id::text, t.club_id::text, '')
      INTO v_satellite, v_scope
      FROM public.tournaments t
      LEFT JOIN public.clubs c ON c.id = t.club_id
     WHERE t.id = p_tournament_id;
    IF NOT FOUND THEN
      v_satellite := true;
    END IF;
  END IF;

  -- A satellite finish writes the target tournament's rows, and an unknown
  -- tournament cannot be scoped: the whole lane, as it always was.
  IF v_satellite OR COALESCE(v_scope, '') = '' THEN
    PERFORM public.fn_ca_lock_settlement_lane_global();
    RETURN;
  END IF;

  -- G SHARED: waits for, and excludes, the rare global authorities (G
  -- exclusive) and nothing else.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-terminal-settlement:v1', 0));
  -- F SHARED: satellite finishes and sweeps hold F exclusively and still
  -- exclude every ordinary finish; ordinary finishes no longer exclude
  -- each other platform-wide.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-finish-lane:v1', 0));
  -- F(scope) EXCLUSIVE: one finish at a time per bank scope, so finishes
  -- that share a club wallet, union bank, club treasury or the players'
  -- wallets in those clubs keep the order they had under F exclusive.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-finish-lane:v1:scope:' || v_scope, 0));
  -- T(id) EXCLUSIVE: this tournament's hands (T shared) and rolling
  -- authorities (T exclusive) wait for the finish, and the proof-of-
  -- authority guards read it as this backend's authority over the rows.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1:' || p_tournament_id::text, 0));
  -- The rest of this transaction re-enters this lane through
  -- fn_ca_lock_settlement_lane_global; transaction-local, gone at commit.
  PERFORM set_config('ca.finish_lane_scope', v_scope, true);
  PERFORM set_config('ca.finish_lane_tournament', p_tournament_id::text, true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_lock_settlement_lane_for_satellite_finish(p_satellite_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_held text := COALESCE(current_setting('ca.finish_lane_tournament', true), '');
  v_target_id uuid;
  v_first uuid;
  v_second uuid;
BEGIN
  IF v_held <> '' THEN
    -- Re-entry inside a finish transaction: everything below is held.
    PERFORM public.fn_ca_lock_settlement_lane_for_finish(NULL);
    RETURN;
  END IF;
  IF p_satellite_id IS NOT NULL THEN
    SELECT COALESCE(t.satellite_target_id, t.satellite_target)
      INTO v_target_id
      FROM public.tournaments t
     WHERE t.id = p_satellite_id;
  END IF;
  IF p_satellite_id IS NULL OR v_target_id IS NULL OR v_target_id = p_satellite_id THEN
    -- No target to scope to: the whole lane, as it always was.
    PERFORM public.fn_ca_lock_settlement_lane_global();
    RETURN;
  END IF;
  -- G shared, F exclusive (one finish at a time, satellite or not), then
  -- both T keys exclusively in uuid order. A rolling authority or hand of
  -- either tournament waits on its T; two satellites into one target are
  -- serialised by F; no other transaction holds two T keys at once.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-terminal-settlement:v1', 0));
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-finish-lane:v1', 0));
  IF p_satellite_id::text < v_target_id::text THEN
    v_first := p_satellite_id; v_second := v_target_id;
  ELSE
    v_first := v_target_id; v_second := p_satellite_id;
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1:' || v_first::text, 0));
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1:' || v_second::text, 0));
  -- Re-entry names the satellite; T(target) is held for the transaction's
  -- life regardless, which is what the target's guards read.
  PERFORM set_config('ca.finish_lane_tournament', p_satellite_id::text, true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_share_settlement_lane_for_table(p_table_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
BEGIN
  -- Acquire G before B and T; source custody guards also need G.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  -- B shared: yields to terminal authorities, concurrent with every other
  -- hand and with rolling authorities of OTHER tournaments.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:hand-settlement-barrier:v1', 0));

  IF p_table_id IS NULL THEN
    RETURN;
  END IF;

  SELECT tb.tournament_id INTO v_tournament_id
  FROM public.tables tb
  WHERE tb.id = p_table_id;

  IF v_tournament_id IS NOT NULL THEN
    -- T(id) shared: yields to this tournament's own rolling authorities.
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended('ca:tournament-terminal-settlement:v1:' || v_tournament_id::text, 0));
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_replay_terminal_receipts(p_hours integer DEFAULT 24, p_limit integer DEFAULT 4000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '600s'
 SET lock_timeout TO '2s'
AS $function$
DECLARE
  t record; v jsonb;
  v_ok int := 0; v_refused int := 0; v_locked int := 0; v_raised int := 0; v_resolved int := 0;
  v_fail jsonb := '[]'::jsonb;
BEGIN
  FOR t IN
    SELECT tr.id, upper(coalesce(tr.tournament_type,'')) ttype, lower(coalesce(tr.variant,'')) variant,
           (SELECT tp.user_id FROM public.tournament_players tp WHERE tp.tournament_id=tr.id AND tp.status::text='winner' ORDER BY tp.position LIMIT 1) winner,
           (SELECT s.qualifier_ids FROM public.tournament_satellite_settlements s WHERE s.tournament_id=tr.id) qids,
           EXISTS (SELECT 1 FROM public.tournament_satellite_settlements s WHERE s.tournament_id=tr.id) sat_hdr
      FROM public.tournaments tr
     WHERE tr.status='COMPLETED'
       AND tr.ended_at > now() - make_interval(hours => GREATEST(COALESCE(p_hours,24),1))
       AND upper(coalesce(tr.tournament_type,'')) IN ('MTT','SPIN','SNG','SATELLITE')
     ORDER BY CASE WHEN upper(coalesce(tr.tournament_type,''))='SATELLITE' OR lower(coalesce(tr.variant,''))='satellite' THEN 0
                   WHEN upper(coalesce(tr.tournament_type,''))='MTT' THEN 1 ELSE 2 END,
              tr.ended_at DESC
     LIMIT GREATEST(COALESCE(p_limit,4000),1)
  LOOP
    BEGIN
      IF t.sat_hdr THEN
        IF t.qids IS NOT NULL AND cardinality(t.qids) > 0 THEN
          v := public.fn_ca_satellite_cohort_receipt(t.id, t.qids);
        ELSE
          v := public.fn_ca_satellite_settlement_receipt(t.id, t.winner);
        END IF;
      ELSIF t.ttype='SATELLITE' OR t.variant='satellite' THEN
        RAISE EXCEPTION 'satellite % completed without a settlement header', t.id USING ERRCODE='P0404';
      ELSE
        v := public.fn_ca_tournament_terminal_receipt(t.id, t.winner);
      END IF;
      v_ok := v_ok + 1;
    EXCEPTION
      WHEN lock_not_available OR query_canceled THEN
        v_locked := v_locked + 1;
      WHEN OTHERS THEN
        v_refused := v_refused + 1;
        IF jsonb_array_length(v_fail) < 50 THEN
          v_fail := v_fail || jsonb_build_object('tournament_id', t.id, 'type', t.ttype, 'code', SQLSTATE, 'error', left(SQLERRM, 240));
        END IF;
    END;
  END LOOP;

  -- One open alert per distinct refusal text; the incident bridge keys on it.
  INSERT INTO public.financial_alerts (severity, source, message, context)
  SELECT 'critical', 'fn_ca_replay_terminal_receipts',
         format('A terminal receipt no longer proves on replay: %s tournament(s) completed in the last %s h refuse with "%s" (sample %s). A receipt that stops proving will freeze the next event that reaches the same state, so this is fixed in the receipt before it does.',
                g.n, GREATEST(COALESCE(p_hours,24),1), g.err, g.sample),
         jsonb_build_object('checked_at', now(), 'hours', GREATEST(COALESCE(p_hours,24),1), 'refusal', g.err, 'count', g.n, 'sample_tournament_id', g.sample, 'samples', g.ids)
    FROM (SELECT regexp_replace(f->>'error', '[0-9a-f-]{36}', '<id>', 'g') err, count(*) n, min(f->>'tournament_id') sample,
                 jsonb_agg(f->>'tournament_id') ids
            FROM jsonb_array_elements(v_fail) f GROUP BY 1) g
   WHERE NOT EXISTS (SELECT 1 FROM public.financial_alerts fa
                      WHERE fa.source='fn_ca_replay_terminal_receipts' AND NOT fa.resolved
                        AND fa.context->>'refusal' = g.err);
  GET DIAGNOSTICS v_raised = ROW_COUNT;

  -- A refusal that no longer reproduces closes itself.
  UPDATE public.financial_alerts fa
     SET resolved = true, resolved_at = now(),
         resolution = format('Re-measured by fn_ca_replay_terminal_receipts at %s: %s receipt(s) of the last %s h replayed, none refuses with this text any more.', now(), v_ok, GREATEST(COALESCE(p_hours,24),1))
   WHERE fa.source='fn_ca_replay_terminal_receipts' AND NOT fa.resolved
     AND v_refused = 0 AND v_ok > 0
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_fail) f
                      WHERE regexp_replace(f->>'error', '[0-9a-f-]{36}', '<id>', 'g') = fa.context->>'refusal');
  GET DIAGNOSTICS v_resolved = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'checked_at', now(), 'hours', GREATEST(COALESCE(p_hours,24),1),
    'replayed', v_ok, 'refused', v_refused, 'skipped_locked', v_locked, 'raised', v_raised, 'resolved', v_resolved, 'failures', v_fail);
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_rakeback_player_stats(p_rake_record_id uuid, p_user_id uuid, p_club_id uuid, p_hands integer, p_rake numeric)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inserted integer;
BEGIN
  IF p_rake_record_id IS NULL OR p_user_id IS NULL OR p_club_id IS NULL THEN
    RETURN false;
  END IF;

  IF public.fn_ca_launch_accounting_cutoff('club',p_club_id) IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.rake_records r WHERE r.id=p_rake_record_id AND public.fn_ca_launch_accounting_accepts(p_club_id,r.created_at) AND ((r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL) OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f WHERE f.rake_record_id=r.id AND f.player_id=p_user_id AND f.club_id=p_club_id AND public.fn_ca_launch_accounting_accepts(p_club_id,f.charged_at)))) THEN RETURN false; END IF;

  INSERT INTO public.rakeback_stats_applied (rake_record_id, user_id, hands, rake)
  VALUES (p_rake_record_id, p_user_id, p_hands, p_rake)
  ON CONFLICT (rake_record_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN false;
  END IF;

  INSERT INTO public.player_stats (
    user_id, club_id, hands_played, total_rake,
    total_winnings, total_losses, vpip, pfr, tournaments_played, tournaments_won
  ) VALUES (
    p_user_id, p_club_id, COALESCE(p_hands, 0), COALESCE(p_rake, 0),
    0, 0, 0, 0, 0, 0
  )
  ON CONFLICT (user_id, club_id) DO UPDATE SET
    hands_played = public.player_stats.hands_played + EXCLUDED.hands_played,
    total_rake   = ROUND((public.player_stats.total_rake + EXCLUDED.total_rake) * 100) / 100,
    updated_at   = NOW();

  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_sync_profile_total_hands()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_user uuid := COALESCE(NEW.user_id, OLD.user_id);
BEGIN
  IF public.fn_ca_launch_accounting_actor(COALESCE(NEW.club_id,OLD.club_id)) THEN RETURN COALESCE(NEW,OLD); END IF;
  IF v_user IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  /* A WRITE THAT LEAVES hands_played WHERE IT WAS DOES NOT TOUCH THE PROFILE
     (2026-10-01). The trigger fires for every UPDATE that names the column,
     and a tournament's rake recognition names it with +0 for every entrant
     (apply_rakeback_player_stats(..., 0, ...)): the sum below cannot move,
     but its UPDATE locked each entrant's profile row, in club order, while
     the horse claims hold profile rows in claim order - and the two
     deadlocked. The same player and the same count leave the same sum. */
  IF TG_OP = 'UPDATE' AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.hands_played IS NOT DISTINCT FROM OLD.hands_played THEN
    RETURN NEW;
  END IF;

  /* Recomputed from the table rather than incremented. An increment has to be
     right on every path - insert, update, delete, and the upsert the
     achievement engine uses - and being wrong once is permanent. A SUM over a
     handful of club rows for one player is cheap and cannot drift. */
  UPDATE public.profiles p
     SET total_hands_played = COALESCE((
           SELECT sum(s.hands_played) FROM public.player_stats s WHERE s.user_id = v_user
         ), 0) + COALESCE((SELECT CASE WHEN o.state='executed' THEN b.hand_offset ELSE b.hand_offset-b.restored_scope_hands END FROM public.ca_launch_profile_hand_baselines b
            JOIN public.ca_launch_reset_operations o ON o.operation_id=b.operation_id
            WHERE b.user_id=v_user AND o.state IN('executed','undone') ORDER BY b.captured_at DESC,b.operation_id DESC LIMIT 1),0)
   WHERE p.id = v_user;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_process_cash_accounting_source(p_rake_record_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r public.rake_records%ROWTYPE;w public.accounting_cash_source_work%ROWTYPE;
 receipt public.accounting_cash_source_receipts%ROWTYPE; fingerprint text;result jsonb;credits jsonb:='[]';
 status_value text:='accrued';reason_value text;state_value text;detail_value text;scope jsonb;
 player record;club record;week_start date;next_attempt bigint; applied boolean; v_terminal boolean:=false; v_try int:=0;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'cash_source_not_authorised' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM public.rake_records WHERE id=p_rake_record_id;
 IF NOT FOUND OR COALESCE(r.is_tournament,false) OR r.tournament_id IS NOT NULL THEN
  RAISE EXCEPTION 'cash_source_record_required' USING ERRCODE='22023'; END IF;
 -- Share the existing hand authority. Nothing locks work rows before this.
 PERFORM pg_advisory_xact_lock(hashtextextended(CASE WHEN r.hand_id IS NULL THEN 'accounting_cash_source:'||r.id::text
  ELSE 'accounting_cash_hand:'||r.hand_id::text END,0));
 SELECT * INTO r FROM public.rake_records WHERE id=p_rake_record_id FOR SHARE;
 SELECT md5(jsonb_build_object('id',r.id,'hand',r.hand_id,'club',r.club_id,'rake',r.rake_amount,
  'earned_at',r.created_at,'metadata',r.metadata,'attributions',COALESCE(jsonb_agg(
   jsonb_build_array(a.id,a.hand_id,a.player_id,a.club_id,a.weighted_rake_credit) ORDER BY a.id),'[]'::jsonb))::text)
  INTO fingerprint FROM public.rake_attributions a WHERE a.rake_record_id=r.id;
 SELECT * INTO w FROM public.accounting_cash_source_work WHERE rake_record_id=r.id;
 IF w.status='accrued' AND w.source_fingerprint=fingerprint THEN
  SELECT * INTO receipt FROM public.accounting_cash_source_receipts WHERE id=w.receipt_id;
  RETURN receipt.result||jsonb_build_object('duplicate',true);
 END IF;
 IF NOT public.fn_ca_launch_accounting_accepts(r.club_id,r.created_at) THEN
  RETURN jsonb_build_object('status','waived','recorded',false,'reason','owner_directed_launch_waiver','rake_record_id',r.id,'earned_at',r.created_at);
 END IF;
 next_attempt:=COALESCE(w.attempts,0)+1;
 -- A DEADLOCK IS RETRIED INSIDE ITS OWN TRANSACTION (20261019102410). The
 -- block below is a subtransaction: a deadlock rolls back only this item's
 -- writes and releases the commission keys it took, so the other transaction
 -- proceeds and the same evidence is tried again here, at most three times,
 -- instead of being refused into the retry queue behind every other refusal.
 <<item>> LOOP
 v_try:=v_try+1;
 BEGIN
  IF r.hand_id IS NULL OR NOT isfinite(r.created_at) OR r.rake_amount IS NULL OR r.rake_amount<=0
   OR r.rake_amount::text IN('NaN','Infinity','-Infinity') OR r.rake_amount<>round(r.rake_amount,2)
   OR (SELECT count(*) FROM public.rake_records WHERE hand_id=r.hand_id)<>1 THEN
   RAISE EXCEPTION 'cash_source_identity_or_amount_invalid' USING ERRCODE='23514'; END IF;
  result:=public.fn_accrue_cash_hand_commissions(r.hand_id);
  IF result->>'status'='legacy_unverified' AND result->>'recorded'='true' THEN
   status_value:='blocked';reason_value:='cash_source_legacy_unverified';state_value:='55000';v_terminal:=true;
  ELSE
   IF result->>'status' IS DISTINCT FROM 'accrued' OR result->>'recorded' IS DISTINCT FROM 'true'
    OR result->>'source_version' IS DISTINCT FROM '2'
    OR NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_batches WHERE rake_record_id=r.id AND status='accrued') THEN
    RAISE EXCEPTION 'cash_source_accrual_receipt_invalid' USING ERRCODE='23514'; END IF;
   week_start:=(public.fn_union_week_start(r.created_at) AT TIME ZONE 'America/Los_Angeles')::date;
   FOR player IN SELECT * FROM public.accounting_cash_rake_sources WHERE rake_record_id=r.id ORDER BY club_id,player_id LOOP
    applied:=public.apply_rakeback_player_stats(r.id,player.player_id,player.club_id,1,player.rake_credit);
    IF NOT EXISTS(SELECT 1 FROM public.rakeback_stats_applied a WHERE a.rake_record_id=r.id AND a.user_id=player.player_id
      AND a.hands=1 AND a.rake=player.rake_credit) THEN
     RAISE EXCEPTION 'cash_source_player_stats_receipt_invalid' USING ERRCODE='23514'; END IF;
    credits:=credits||jsonb_build_array(jsonb_build_object('player_id',player.player_id,'club_id',player.club_id,
      'rake_credit',player.rake_credit,'period_start',week_start,'period_end',week_start+6));
   END LOOP;
   IF jsonb_array_length(credits)=0 THEN RAISE EXCEPTION 'cash_source_contributor_receipts_missing' USING ERRCODE='23514'; END IF;
   -- Queue the existing complete-week calculator; do not invent another
   -- calculator or depend on a later hand arriving to repair this source.
   FOR club IN SELECT DISTINCT club_id FROM public.accounting_cash_rake_sources WHERE rake_record_id=r.id ORDER BY club_id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('accounting_rakeback_period:'||club.club_id::text||':'||week_start::text,0));
    INSERT INTO public.accounting_period_recompute_requests(club_id,period_start,period_end)
     VALUES(club.club_id,week_start,week_start+6)
     ON CONFLICT(club_id,period_start,period_end) DO UPDATE SET last_requested_at=clock_timestamp(),status='pending',reason=NULL;
   END LOOP;
  END IF;
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS reason_value=MESSAGE_TEXT,state_value=RETURNED_SQLSTATE,detail_value=PG_EXCEPTION_DETAIL;
  status_value:='blocked';credits:='[]';v_terminal:=false;
 END;
 EXIT item WHEN status_value IS DISTINCT FROM 'blocked' OR v_terminal OR state_value IS DISTINCT FROM '40P01' OR v_try>=3;
 status_value:='accrued';reason_value:=NULL;state_value:=NULL;detail_value:=NULL;result:=NULL;credits:='[]';
 END LOOP item;
 scope:=public.fn_cash_source_refusal_scope(r.id);
 receipt.id:=gen_random_uuid();
 result:=jsonb_build_object('receipt_version',3,'receipt_id',receipt.id,'rake_record_id',r.id,'hand_id',r.hand_id,
  'earned_at',r.created_at,'status',status_value,'recorded',true,'attempt',next_attempt,
  'source_fingerprint',fingerprint,'reason',reason_value,'sqlstate',state_value,'scope',scope,'credits',credits);
 INSERT INTO public.accounting_cash_source_receipts(id,rake_record_id,attempt,earned_at,source_fingerprint,status,reason,sqlstate,error_detail,scope,result)
  VALUES(receipt.id,r.id,next_attempt,r.created_at,fingerprint,status_value,reason_value,state_value,detail_value,scope,result);
 INSERT INTO public.accounting_cash_source_work(rake_record_id,receipt_id,source_fingerprint,status,attempts,next_attempt_at)
  VALUES(r.id,receipt.id,fingerprint,status_value,next_attempt,CASE WHEN v_terminal THEN 'infinity'::timestamptz
   -- A lock refusal (deadlock, lock timeout, serialization) is retried soon.
   WHEN status_value='blocked' AND state_value IN('40P01','55P03','40001') THEN clock_timestamp()+make_interval(secs=>LEAST(300,15*next_attempt)::int)
   ELSE clock_timestamp()+make_interval(secs=>LEAST(3600,60*next_attempt)::int) END)
  ON CONFLICT(rake_record_id) DO UPDATE SET receipt_id=EXCLUDED.receipt_id,source_fingerprint=EXCLUDED.source_fingerprint,
   status=EXCLUDED.status,attempts=EXCLUDED.attempts,next_attempt_at=EXCLUDED.next_attempt_at;
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_credit_agent_commissions_batch(p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE it jsonb;r jsonb;receipts jsonb:='[]';record_id uuid;v_ok int:=0;v_failed int:=0;v_blocked int:=0;first_error text;v_gate uuid;
 v_n bigint;v_clubs uuid[];v_sets jsonb:='[]';v_need uuid[]:='{}';v_held uuid[]:='{}';v_deferred jsonb:='[]';v_lock_timeout text;v_wait_until timestamptz;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'cash_source_not_authorised' USING ERRCODE='42501'; END IF;
 IF p_items IS NULL OR jsonb_typeof(p_items)<>'array' OR jsonb_array_length(p_items)>2000 THEN
  RETURN jsonb_build_object('ok',0,'failed',0,'error','p_items must be a jsonb array of at most 2000 items'); END IF;
 -- EVERY COMMISSION KEY IN CLUB ORDER BEFORE THE FIRST ITEM; AN ITEM WHOSE KEYS
 -- ARE NOT ALL HELD WAITS FOR THE NEXT CALL (2026-10-19). This batch is one
 -- transaction over many hands and keeps each item's rows and keys to its end.
 -- An item's commission rows take the 'agent-commission:<club>' key of each
 -- club its rake is attributed in (trg_agent_commission_rollup_insert), and a
 -- tournament finish takes the same keys in club order. Taking them item by
 -- item, in page order, held a later club while waiting for an earlier one:
 -- 40P01 against a finish (2026-10-19 07:28:34). So the keys every item needs
 -- are taken here, in club order: a free key at once, a busy one waited for
 -- within one 1 s budget while holding only lower keys, which no finish waits
 -- for. A key not granted is skipped (below) and never fails the batch whole
 -- (2026-10-01 00:07:30). An item whose clubs are not all held is not run and
 -- not refused: it writes nothing and is returned in 'deferred', and the
 -- settler submits it again before its cursor may pass it.
 FOR it IN SELECT value FROM jsonb_array_elements(p_items) LOOP
  v_clubs:=ARRAY(SELECT DISTINCT c.club_id FROM (
    SELECT a.club_id FROM public.rake_attributions a
     WHERE a.rake_record_id=CASE WHEN it->>'source_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN CASE it->>'source_type' WHEN 'cash_rake_record' THEN (it->>'source_id')::uuid
       WHEN 'rake_settlement' THEN (SELECT h.id FROM public.rake_records h WHERE h.hand_id=(it->>'source_id')::uuid ORDER BY h.id LIMIT 1)
      END END
    UNION ALL
    SELECT CASE WHEN it->>'club_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (it->>'club_id')::uuid END
     WHERE NOT COALESCE(it->>'source_type' IN('cash_rake_record','rake_settlement'),false)
   ) c WHERE c.club_id IS NOT NULL ORDER BY c.club_id);
  v_sets:=v_sets||jsonb_build_array(to_jsonb(v_clubs));
  v_need:=v_need||v_clubs;
 END LOOP;
 v_need:=ARRAY(SELECT DISTINCT g FROM unnest(v_need) g ORDER BY g);
 -- A BUSY KEY IS SKIPPED, NOT THE END OF THE WALK (2026-10-19, 20261019171753).
 -- Ending the walk at the first busy key deferred every item behind it in club
 -- order, including items that need none of the busy clubs: one busy Midway key
 -- (the lowest uuids) deferred every Lightning item, every call. The walk now
 -- goes on past a busy key. Keys are still only ever waited for in club order,
 -- and only for a key above every key already held, so the gaps keep one total
 -- order; the waits share one 1 s budget per call.
 v_wait_until:=clock_timestamp()+interval '1 second';
 FOREACH v_gate IN ARRAY v_need LOOP
  IF pg_try_advisory_xact_lock(hashtextextended('agent-commission:'||v_gate::text,0)) THEN
   v_held:=v_held||v_gate;
  ELSIF clock_timestamp()<v_wait_until THEN
   BEGIN
    v_lock_timeout:=current_setting('lock_timeout');
    PERFORM set_config('lock_timeout',
     GREATEST(1,ceil(extract(epoch FROM v_wait_until-clock_timestamp())*1000))::bigint::text||'ms',true);
    PERFORM pg_advisory_xact_lock(hashtextextended('agent-commission:'||v_gate::text,0));
    PERFORM set_config('lock_timeout',v_lock_timeout,true);
    v_held:=v_held||v_gate;
   EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
    NULL;
   END;
  END IF;
 END LOOP;
 FOR it,v_n IN SELECT value,ordinality FROM jsonb_array_elements(p_items) WITH ORDINALITY LOOP
  v_clubs:=ARRAY(SELECT g::uuid FROM jsonb_array_elements_text(v_sets->(v_n::int-1)) g);
  IF NOT v_clubs<@v_held THEN
   v_deferred:=v_deferred||jsonb_build_array(it->'source_id');
   CONTINUE;
  END IF;
  BEGIN
   IF it->>'source_type' IN('cash_rake_record','rake_settlement') THEN
    IF it->>'source_type'='cash_rake_record' THEN record_id:=(it->>'source_id')::uuid;
    ELSE
     SELECT id INTO STRICT record_id FROM public.rake_records WHERE hand_id=(it->>'source_id')::uuid;
     -- Keep the legacy caller's scope validation. A batched user cannot move
     -- one contributor's recorded earning into a different club.
     IF NOT EXISTS(SELECT 1 FROM public.rake_attributions WHERE rake_record_id=record_id
      AND player_id=(it->>'user_id')::uuid AND club_id=(it->>'club_id')::uuid
      AND weighted_rake_credit=(it->>'rake_credit')::numeric) THEN
      RAISE EXCEPTION 'cash_source_legacy_input_not_proven' USING ERRCODE='23514'; END IF;
    END IF;
    r:=public.fn_process_cash_accounting_source(record_id);receipts:=receipts||jsonb_build_array(r);
    IF r->>'status'='accrued' THEN v_ok:=v_ok+1;
    ELSE v_failed:=v_failed+1;v_blocked:=v_blocked+1;first_error:=COALESCE(first_error,r->>'reason'); END IF;
   ELSE
    PERFORM public.credit_agent_commission_from_rake((it->>'user_id')::uuid,(it->>'club_id')::uuid,
     COALESCE((it->>'rake_credit')::numeric,0),it->>'source_type',NULLIF(it->>'source_id','')::uuid,it->>'notes');
    v_ok:=v_ok+1;
   END IF;
  EXCEPTION WHEN OTHERS THEN v_failed:=v_failed+1;first_error:=COALESCE(first_error,SQLERRM);
  END;
 END LOOP;
 RETURN jsonb_build_object('receipt_version',3,'ok',v_ok,'failed',v_failed,'blocked',v_blocked,'first_error',first_error,'receipts',receipts,
  'deferred',v_deferred);
END $function$;

CREATE OR REPLACE FUNCTION public.fn_project_hand_side_effects_after_post_commit_20260908(p_hand_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_h public.hand_history%ROWTYPE;
  v_club uuid;
  v_date date;
  v_tourney boolean;
  v_bb numeric;
  v_diamond boolean;
  v_promo jsonb;
BEGIN
  IF NOT (current_user IN ('postgres','service_role')) THEN
    RAISE EXCEPTION 'fn_project_hand_side_effects is engine/service only';
  END IF;

  -- The durable outbox row is also the claim.  Locking it keeps the additive
  -- projections and its DELETE in one transaction: a crash rolls both back;
  -- a concurrent worker waits, then finds no row and cannot run them twice.
  SELECT h.* INTO v_h
    FROM public.hand_projection_outbox o
    JOIN public.hand_history h ON h.id=o.hand_id
   WHERE o.hand_id=p_hand_id
   FOR UPDATE OF o;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','not_pending','hand_id',p_hand_id);
  END IF;

  -- One table's club-member projection carries prior-stack state.  Serialise
  -- it and refuse to leapfrog an earlier durable hand from that table.
  PERFORM pg_advisory_xact_lock(hashtextextended('hand-projection:'||v_h.table_id::text,0));
  IF EXISTS (
    SELECT 1 FROM public.hand_projection_outbox earlier
     WHERE earlier.table_id=v_h.table_id
       AND earlier.hand_number<v_h.hand_number
  ) THEN
    RETURN jsonb_build_object('ok',false,'reason','predecessor_pending');
  END IF;

  SELECT t.club_id, (t.tournament_id IS NOT NULL), c.asset='diamonds'
    INTO v_club, v_tourney, v_diamond
    FROM public.tables t JOIN public.clubs c ON c.id=t.club_id WHERE t.id=v_h.table_id;
  v_tourney := COALESCE(v_tourney,false) OR (v_h.tournament_id IS NOT NULL);
  v_date := (v_h.created_at AT TIME ZONE 'UTC')::date;

  -- A seat's result for THIS hand is what it won minus what it put in. The
  -- accepted-hand envelope lists every contributor's chips in, written in the
  -- same transaction as the hand. No envelope list, no exact figure.
  SELECT c.post_commit_payload->'promo_playthrough' INTO v_promo
    FROM public.hand_atomic_commits c
   WHERE c.hand_id = v_h.id;
  IF jsonb_typeof(v_promo) IS DISTINCT FROM 'array' THEN
    v_promo := NULL;
  ELSIF v_promo = '[]'::jsonb THEN
    v_promo := NULL;
  END IF;

  -- Projection 1: club member/table/day state.  This is the current live
  -- trigger body, with NEW replaced by the immutable hand row selected above.
  IF v_club IS NOT NULL AND NOT COALESCE(v_diamond,false)
     AND public.fn_ca_launch_accounting_accepts(v_club,v_h.created_at) THEN
    WITH pl AS (
      SELECT DISTINCT ON (p->>'userId')
             (p->>'userId')::uuid AS uid, (p->>'stack')::numeric AS stack
        FROM jsonb_array_elements(coalesce(v_h.players,'[]'::jsonb)) p
       WHERE (p->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         AND (p->>'stack') IS NOT NULL
    ), wn AS (
      SELECT (w->>'userId')::uuid AS uid, sum((w->>'amount')::numeric) AS won
        FROM jsonb_array_elements(coalesce(v_h.winners,'[]'::jsonb)) w
       WHERE (w->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       GROUP BY 1
    ), base AS (
      SELECT pl.uid, pl.stack, coalesce(wn.won,0) AS won, st.last_stack,
             (st.last_stack IS NOT NULL AND st.last_hand_number IS NOT NULL
              AND v_h.hand_number IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM public.hand_history h2
                 WHERE h2.table_id=v_h.table_id
                   AND h2.hand_number>st.last_hand_number
                   AND h2.hand_number<v_h.hand_number)) AS adjacent
        FROM pl
        LEFT JOIN wn ON wn.uid=pl.uid
        LEFT JOIN public.club_member_table_state st
          ON st.table_id=v_h.table_id AND st.user_id=pl.uid
    ), agg AS (
      SELECT count(*) AS seated,
             count(*) FILTER (WHERE last_stack IS NOT NULL) AS with_prior,
             coalesce(sum(stack-last_stack) FILTER (WHERE last_stack IS NOT NULL),0) AS dsum
        FROM base
    ), calc AS (
      SELECT b.uid,b.won,
             CASE WHEN b.last_stack IS NOT NULL THEN b.stack-b.last_stack ELSE 0 END AS delta,
             CASE WHEN a.seated=a.with_prior
                  THEN abs(a.dsum+coalesce(v_h.rake_amount,0)+coalesce(v_h.bbj_amount,0))<0.005
                  ELSE b.adjacent AND (b.stack-b.last_stack)<=b.won+0.001 END AS attributable,
             CASE WHEN v_promo IS NOT NULL
                  THEN b.won - COALESCE((SELECT sum((x->>'wagered')::numeric)
                                           FROM jsonb_array_elements(v_promo) x
                                          WHERE lower(x->>'user_id') = b.uid::text), 0)
             END AS exact_net
        FROM base b CROSS JOIN agg a
    )
    INSERT INTO public.club_member_daily_stats AS s
      (club_id,table_id,user_id,stat_date,hands_played,hands_attributed,hands_won,
       total_won,profit,biggest_pot_won,biggest_pot,topup_total)
    SELECT v_club,v_h.table_id,calc.uid,v_date,1,
           CASE WHEN v_tourney THEN 0 WHEN calc.exact_net IS NOT NULL OR calc.attributable THEN 1 ELSE 0 END,
           CASE WHEN calc.won>0 THEN 1 ELSE 0 END,
           CASE WHEN v_tourney THEN 0 ELSE calc.won END,
           CASE WHEN v_tourney THEN 0 WHEN calc.exact_net IS NOT NULL THEN calc.exact_net
                WHEN calc.attributable THEN calc.delta ELSE 0 END,
           CASE WHEN v_tourney THEN 0 ELSE calc.won END,
           CASE WHEN v_tourney THEN 0 ELSE coalesce(v_h.pot_size,0) END,
           CASE WHEN v_tourney THEN 0
                WHEN NOT calc.attributable AND calc.delta>calc.won THEN calc.delta-calc.won
                ELSE 0 END
      FROM calc
    ON CONFLICT (club_id,table_id,user_id,stat_date) DO UPDATE SET
      hands_played=s.hands_played+1,
      hands_attributed=s.hands_attributed+EXCLUDED.hands_attributed,
      hands_won=s.hands_won+EXCLUDED.hands_won,
      total_won=s.total_won+EXCLUDED.total_won,
      profit=s.profit+EXCLUDED.profit,
      biggest_pot_won=greatest(s.biggest_pot_won,EXCLUDED.biggest_pot_won),
      biggest_pot=greatest(s.biggest_pot,EXCLUDED.biggest_pot),
      topup_total=s.topup_total+EXCLUDED.topup_total,
      updated_at=now();

    INSERT INTO public.club_member_table_state AS st
      (table_id,user_id,last_stack,last_hand_number)
    SELECT DISTINCT ON (p->>'userId')
           v_h.table_id,(p->>'userId')::uuid,(p->>'stack')::numeric,v_h.hand_number
      FROM jsonb_array_elements(coalesce(v_h.players,'[]'::jsonb)) p
     WHERE (p->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       AND (p->>'stack') IS NOT NULL
    ON CONFLICT (table_id,user_id) DO UPDATE SET
      last_stack=EXCLUDED.last_stack,
      last_hand_number=EXCLUDED.last_hand_number,
      updated_at=now();

    INSERT INTO public.club_hand_daily_shard AS d
      (club_id,stat_date,shard,hands,rake,bbj,pot_total)
    VALUES (
      v_club,v_date,(pg_backend_pid()%16)::smallint,1,
      coalesce(v_h.rake_amount,0),coalesce(v_h.bbj_amount,0),coalesce(v_h.pot_size,0))
    ON CONFLICT (club_id,stat_date,shard) DO UPDATE SET
      hands=d.hands+1,
      rake=d.rake+EXCLUDED.rake,
      bbj=d.bbj+EXCLUDED.bbj,
      pot_total=d.pot_total+EXCLUDED.pot_total,
      updated_at=now();
  END IF;

  -- Projection 2: legacy player_stats fold/winnings totals (cash only).
  IF NOT COALESCE(v_diamond,false) AND v_h.tournament_id IS NULL
     AND v_club IS NOT NULL
     AND public.fn_ca_launch_accounting_accepts(v_club,v_h.created_at)
     AND jsonb_typeof(v_h.players)='array'
     AND jsonb_array_length(v_h.players)>0 THEN
    v_bb := greatest(coalesce(v_h.big_blind,0),0);
    WITH seated AS (
      SELECT DISTINCT (pl->>'userId') AS uid
        FROM jsonb_array_elements(v_h.players) pl
       WHERE (pl->>'userId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ), won AS (
      SELECT (w->>'userId') AS uid,sum((w->>'amount')::numeric) AS amt
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(v_h.winners)='array' THEN v_h.winners ELSE '[]'::jsonb END) w
       WHERE (w->>'userId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         AND coalesce((w->>'amount')::numeric,0)>0
       GROUP BY 1
    )
    INSERT INTO public.player_stats AS ps
      (id,user_id,club_id,hands_dealt,sum_big_blind,total_winnings,updated_at)
    SELECT gen_random_uuid(),s.uid::uuid,v_club,1,v_bb,coalesce(wo.amt,0),now()
      FROM seated s LEFT JOIN won wo ON wo.uid=s.uid
     WHERE EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=s.uid::uuid)
     ORDER BY s.uid::uuid
    ON CONFLICT (user_id,club_id) DO UPDATE SET
      hands_dealt=ps.hands_dealt+EXCLUDED.hands_dealt,
      sum_big_blind=ps.sum_big_blind+EXCLUDED.sum_big_blind,
      total_winnings=ps.total_winnings+EXCLUDED.total_winnings,
      updated_at=now();
  END IF;

  -- Projection 3: positional aggregates.
  -- Positional profit has no asset dimension. Keep Diamond amounts out of
  -- that legacy aggregate; exact per-hand facts below retain its history.
  IF NOT COALESCE(v_diamond,false) THEN
    PERFORM public.fn_process_hand_position_stats(v_h.players,v_h.actions,v_h.winners);
  END IF;

  -- Projection 3b: immutable private Stats facts.
  PERFORM public.ca_project_hand_stats_facts(v_h.id);

  -- Projection 4: exact per-hand stats materialisation and player index.
  INSERT INTO public.ca_hand_player_idx(user_id,created_at,hand_id)
  SELECT DISTINCT (pl->>'userId')::uuid,v_h.created_at,v_h.id
    FROM jsonb_array_elements(coalesce(v_h.players,'[]'::jsonb)) pl
   WHERE pl->>'userId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ORDER BY 1, 3
  ON CONFLICT DO NOTHING;

  INSERT INTO public.ca_hand_player_stat AS hs (
    user_id,hand_id,created_at,is_cash,tournament_id,game_variant,
    big_blind,small_blind,n_players,seat_position,my_blind,won_amt,is_winner,
    invested_actions,aggro_cnt,call_cnt,vpip,pfr,folded,three_bet,
    three_bet_opp,faced_three_bet,folded_to_three_bet,cbet_opp,cbet_made,
    showdown,hand_secs,profit)
  SELECT
    f.user_id,f.hand_id,f.created_at,f.is_cash,f.tournament_id,f.game_variant,
    f.big_blind,f.small_blind,f.n_players,f.seat_position,f.my_blind,f.won_amt,f.is_winner,
    f.invested_actions,f.aggro_cnt,f.call_cnt,f.vpip,f.pfr,f.folded,f.three_bet,
    f.three_bet_opp,f.faced_three_bet,f.folded_to_three_bet,f.cbet_opp,f.cbet_made,
    f.showdown,f.hand_secs,f.profit
    FROM public.ca_hand_player_facts_one(v_h.id,NULL) f
  ORDER BY f.user_id, f.hand_id
  ON CONFLICT (user_id,hand_id) DO NOTHING;

  -- Projection 4b: the Diamond leaderboard's running totals (migration
  -- 20260930043000). The stat rows keep a player's newest 1,000 hands of an
  -- asset, so a window cannot be read back from them; this keeps what
  -- Projection 2 keeps for chips (cash hands, seats with a profile): hands,
  -- won, put in and the big blind, per player per UTC day, from this hand's
  -- Diamond stat rows whichever writer wrote them. Player order, as every
  -- stat writer. A chip hand never enters this branch.
  IF COALESCE(v_diamond,false) AND v_h.tournament_id IS NULL AND v_club IS NOT NULL THEN
    INSERT INTO public.ca_diamond_player_day AS dd
      (user_id,stat_date,hands_dealt,total_winnings,total_losses,sum_big_blind,updated_at)
    SELECT s.user_id,v_date,1,s.won_amt,s.invested_actions+s.my_blind,
           greatest(coalesce(v_h.big_blind,0),0),now()
      FROM public.ca_hand_player_stat s
     WHERE s.hand_id=v_h.id AND s.asset='diamonds' AND s.is_cash
       AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=s.user_id)
     ORDER BY s.user_id
    ON CONFLICT (user_id,stat_date) DO UPDATE SET
      hands_dealt=dd.hands_dealt+EXCLUDED.hands_dealt,
      total_winnings=dd.total_winnings+EXCLUDED.total_winnings,
      total_losses=dd.total_losses+EXCLUDED.total_losses,
      sum_big_blind=dd.sum_big_blind+EXCLUDED.sum_big_blind,
      updated_at=now();
  END IF;

  -- Daily Mission booking has its own durable outbox. The hand-history
  -- trigger above only inserts those rows; it never takes a player/profile
  -- lock, and this stats projector must not become a second synchronous
  -- consumer. fn_drain_daily_challenge_event_outbox owns booking exactly once.

  DELETE FROM public.hand_projection_outbox o WHERE o.hand_id=v_h.id;

  RETURN jsonb_build_object('ok',true,'hand_id',v_h.id,'hand_number',v_h.hand_number);
END;
$function$;

CREATE TRIGGER trg_sync_profile_total_hands AFTER INSERT OR DELETE OR UPDATE OF hands_played ON public.player_stats FOR EACH ROW EXECUTE FUNCTION fn_sync_profile_total_hands();

-- The grants production holds on the three doors the migration replaces.
REVOKE ALL ON FUNCTION public.fn_ca_replay_terminal_receipts(integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_credit_agent_commissions_batch(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_project_hand_side_effects_after_post_commit_20260908(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_replay_terminal_receipts(integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_credit_agent_commissions_batch(jsonb) TO service_role;
