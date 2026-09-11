-- Candidate only. Historical receipt rows are never rewritten or backpaid.
BEGIN;
DO $gate$ BEGIN
 IF md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_settle_round3_agents_to_players(uuid,timestamptz,timestamptz)'::regprocedure))<>'5234e460b1ea1f666fbc6bac7a9a1b17'
 THEN RAISE EXCEPTION 'Legacy Round3 changed since captured review'; END IF;
END $gate$;
CREATE OR REPLACE FUNCTION public.fn_settle_round3_agents_to_players(p_union_id uuid,p_period_start timestamptz,p_period_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public AS $f$
DECLARE r record;v_agent uuid;v_payout uuid;v_wallet uuid;v_agent_before numeric;v_agent_after numeric;
 v_player_before numeric;v_player_after numeric;v_owed numeric;v_rake numeric;v_rate numeric;
 v_paid numeric:=0;v_payees integer:=0;v_short integer:=0;v_detail jsonb:='[]';v_skip text;
BEGIN
 IF EXISTS(SELECT 1 FROM settlement_locks WHERE lock_type='GLOBAL_SETTLEMENT_FREEZE' AND is_active=true)
 THEN RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK'; END IF;
 IF p_union_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL OR p_period_end<=p_period_start
  OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
 THEN RETURN jsonb_build_object('round',3,'name','agents_to_players','success',false,'error','bad_params','amount',0,'payees',0,'shortfalls',0,'detail','[]'::jsonb); END IF;
 PERFORM public.fn_lock_rakeback_payer_clubs(ARRAY(SELECT club_id FROM public.union_clubs WHERE union_id=p_union_id ORDER BY club_id));
 -- Lock each exact period before calculating or choosing its legacy payer.
 FOR r IN SELECT rp.* FROM rakeback_periods rp
 JOIN union_clubs uc ON uc.club_id=rp.club_id AND uc.union_id=p_union_id
 WHERE rp.status='pending'
 AND rp.period_start >= (p_period_start AT TIME ZONE 'UTC')::date
 AND (rp.period_end + 1)::timestamp AT TIME ZONE 'UTC' <= p_period_end
 ORDER BY rp.club_id,rp.period_start,rp.id FOR UPDATE OF rp
 LOOP
  IF EXISTS(SELECT 1 FROM rakeback_period_payouts x WHERE x.rakeback_period_id=r.id AND x.user_id=r.user_id) THEN CONTINUE; END IF;
  SELECT agent_id,chip_balance INTO v_agent,v_player_before FROM club_members WHERE club_id=r.club_id AND user_id=r.user_id;
  IF v_agent IS NULL THEN CONTINUE; END IF;
  IF v_agent=r.user_id THEN RAISE EXCEPTION 'Legacy rakeback payer cannot equal beneficiary' USING ERRCODE='23514'; END IF;
  v_owed:=r.rakeback_amount;v_rake:=coalesce(r.rake_generated,r.total_rake_paid,0);v_rate:=r.rakeback_rate;
  IF public.fn_ca_rakeback_period_has_captured(r.club_id,r.user_id,r.period_start,r.period_end) THEN
   v_rake:=public.fn_ca_legacy_player_rake(r.club_id,r.user_id,r.period_start,r.period_end);
   v_rate:=public.fn_player_rakeback_rate(r.user_id,r.club_id,v_rake);v_owed:=round(v_rake*v_rate,2);
   UPDATE rakeback_periods SET rake_generated=v_rake,total_rake_paid=v_rake,rakeback_rate=v_rate,rakeback_amount=v_owed,rakeback_earned=v_owed WHERE id=r.id;
   IF v_owed=0 THEN UPDATE rakeback_periods SET status='paid',paid_at=now() WHERE id=r.id; END IF;
  END IF;
  IF v_owed IS NULL OR v_owed<=0 THEN CONTINUE; END IF;
  IF v_owed::text IN('NaN','Infinity','-Infinity') OR v_owed<>round(v_owed,2)
  THEN RAISE EXCEPTION 'Legacy rakeback must be finite whole cents' USING ERRCODE='23514'; END IF;
  -- Admission precedes member locks; order both wallet rows by user identity.
  PERFORM 1 FROM club_members WHERE club_id=r.club_id AND user_id IN(v_agent,r.user_id) ORDER BY user_id FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM club_members WHERE club_id=r.club_id AND user_id=r.user_id AND agent_id=v_agent)
  THEN RAISE EXCEPTION 'Legacy payer changed during admission' USING ERRCODE='40001'; END IF;
  SELECT chip_balance INTO v_agent_before FROM club_members WHERE club_id=r.club_id AND user_id=v_agent;
  SELECT chip_balance INTO v_player_before FROM club_members WHERE club_id=r.club_id AND user_id=r.user_id;
  IF coalesce(v_agent_before,0)<v_owed THEN
   v_short:=v_short+1;v_detail:=v_detail||jsonb_build_object('agent',v_agent,'player',r.user_id,'owed',v_owed,'agent_balance',coalesce(v_agent_before,0),'skipped',true);CONTINUE;
  END IF;
  INSERT INTO rakeback_period_payouts(rakeback_period_id,club_id,user_id,user_rake_contribution,rakeback_pct,payout_amount,status,paid_at)
  VALUES(r.id,r.club_id,r.user_id,v_rake,round(v_rate*100,2),v_owed,'paid',now())
  ON CONFLICT(rakeback_period_id,user_id) DO NOTHING RETURNING id INTO v_payout;
  IF v_payout IS NULL THEN CONTINUE; END IF;
  v_skip:=current_setting('app.ledger_autoskip_club_members',true);
  PERFORM set_config('app.ledger_autoskip_club_members','1',true);
  UPDATE club_members SET chip_balance=chip_balance-v_owed,updated_at=now() WHERE club_id=r.club_id AND user_id=v_agent RETURNING chip_balance INTO v_agent_after;
  UPDATE club_members SET chip_balance=chip_balance+v_owed,updated_at=now() WHERE club_id=r.club_id AND user_id=r.user_id RETURNING chip_balance INTO v_player_after;
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
  v_paid:=v_paid+v_owed;v_payees:=v_payees+1;
 END LOOP;
 RETURN jsonb_build_object('round',3,'name','agents_to_players','payees',v_payees,'amount',round(v_paid,2),'shortfalls',v_short,'detail',v_detail);
END $f$;
-- Table-side receipt fence also runs for previously compiled Round3 calls.
CREATE FUNCTION public.fn_ca_legacy_round3_wallet_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp AS $f$
DECLARE v_period record; v_legacy numeric;
BEGIN
 IF NEW.category='rakeback' AND NEW.description='Round 3: agent -> player rakeback [club wallet]' THEN
  IF NEW.related_entity_id IS NULL OR NOT EXISTS(SELECT 1 FROM rakeback_period_payouts p
   JOIN rakeback_periods rp ON rp.id=p.rakeback_period_id
   WHERE p.id=NEW.related_entity_id AND p.user_id=NEW.user_id AND p.club_id=rp.club_id AND p.user_id=rp.user_id
    AND p.payout_amount=NEW.amount AND p.status='paid' AND p.wallet_transaction_id IS NULL AND rp.status='pending')
  THEN RAISE EXCEPTION 'Round3 requires the unique unpaid period receipt' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.category='rakeback' AND NEW.related_entity_id IS NOT NULL THEN
  SELECT rp.*,receipt.payout_amount AS receipt_amount,receipt.user_id AS receipt_user INTO v_period
  FROM rakeback_period_payouts receipt JOIN rakeback_periods rp ON rp.id=receipt.rakeback_period_id
  WHERE receipt.id=NEW.related_entity_id;
  IF FOUND AND (v_period.period_end+1)::timestamp AT TIME ZONE 'UTC' > statement_timestamp() THEN
   RAISE EXCEPTION 'Legacy period payment requires a closed earning period' USING ERRCODE='40001';
  END IF;
  IF FOUND AND public.fn_ca_rakeback_period_has_captured(v_period.club_id,v_period.user_id,v_period.period_start,v_period.period_end) THEN
   v_legacy:=public.fn_ca_legacy_player_rake(v_period.club_id,v_period.user_id,v_period.period_start,v_period.period_end);
   IF NEW.user_id IS DISTINCT FROM v_period.user_id OR v_period.receipt_user IS DISTINCT FROM v_period.user_id
    OR NEW.amount IS DISTINCT FROM v_period.receipt_amount
    OR NEW.amount IS DISTINCT FROM round(v_legacy*public.fn_player_rakeback_rate(v_period.user_id,v_period.club_id,v_legacy),2)
   THEN RAISE EXCEPTION 'Legacy period payment includes captured source' USING ERRCODE='40001'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION public.fn_ca_legacy_round3_wallet_receipt() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER ca_legacy_round3_wallet_receipt BEFORE INSERT ON public.wallet_transactions FOR EACH ROW EXECUTE FUNCTION public.fn_ca_legacy_round3_wallet_receipt();
COMMIT;
