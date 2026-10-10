-- 20261010084125_wheel_batches_commit_every_paid_spin_atomically_and_retain_o.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

-- Owner request 2026-10-10: a paid batch fulfills all spins atomically.
-- Every seed hash is returned before payment. Admission settles every v4
-- receipt in one transaction: all debits, prizes and queued game liabilities
-- commit together, or all roll back. Acknowledgment loss replays one batch.
-- No engine change. Install this backward-compatible batch contract before
-- publishing its client. Install choice version 5 only after that client.
-- @live-proof: md5(pg_get_functiondef('public.fn_wheel_card_public(wheel_card_awards)'::regprocedure))='7c1aa6193b7deacbf50db38c0cc729c1'
-- @live-proof: md5(pg_get_functiondef('public.fn_wheel_batch_immutable()'::regprocedure))='b78878a4ece623decf9616475ddc7a93'
-- @live-proof: md5(pg_get_functiondef('public.fn_wheel_bonus_start(uuid,uuid,text,boolean,text,integer,integer,integer,integer)'::regprocedure))='05549c2332bdff65c4e5a060c057f2ca'
-- @live-proof: md5(pg_get_functiondef('public.fn_wheel_bonus_public_award(wheel_bonus_awards,boolean)'::regprocedure))='a252f8b72c80811a79c479dc5493e5c0'
-- @live-proof: md5(pg_get_functiondef('public.fn_wheel_spin_v2(uuid,uuid,text,integer,text,uuid)'::regprocedure))='3a5c2e4182a60bf90c3f011dac16d99d'
-- @live-proof: md5(pg_get_functiondef('public.fn_wheel_diamond_cards_pick(uuid,smallint)'::regprocedure))='638350abeaee1e07a14b359c4feaaa7e'
-- @live-proof: md5(pg_get_functiondef('public.fn_wheel_batch_read(uuid)'::regprocedure))='b12d3dfe64c0db90b45fa17422735f1a'
-- @live-proof: md5(pg_get_functiondef('public.fn_wheel_batch_prepare(uuid,uuid,integer,integer)'::regprocedure))='4ada9d365b6452bae6f79bb1ce0ed1d2'
-- @live-proof: md5(pg_get_functiondef('public.fn_wheel_batch_begin(uuid,text)'::regprocedure))='865d58bddc51a4d7668010d9de4284ed'
-- @live-proof: md5(pg_get_functiondef('public.fn_wheel_batch_active(uuid,uuid,integer)'::regprocedure))='c06b5f932a4b8eb6de581b1528615d1b'
-- @live-proof: md5(pg_get_functiondef('public.fn_wheel_prize_order(uuid)'::regprocedure))='e6864bf69b25c99b210b813ecb15ccaf'
-- @live-proof: md5(pg_get_functiondef('public.fn_wheel_next_unplayed(uuid,uuid)'::regprocedure))='40f214ffb1e96b52a1157841eb7153ec'
-- @live-proof: (SELECT relrowsecurity FROM pg_class WHERE oid='public.wheel_batch_requests'::regclass)
-- @live-proof: EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='public.wheel_batch_requests'::regclass AND polname='wheel_batch_own')
-- @live-proof: NOT has_table_privilege('authenticated','public.wheel_batch_requests','INSERT,UPDATE,DELETE') AND NOT has_table_privilege('anon','public.wheel_batch_requests','SELECT')
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='90s';
DO $$ BEGIN IF md5(pg_get_functiondef('public.fn_wheel_commit()'::regprocedure)) IS DISTINCT FROM '2325f279e9b3e5826cfdb9df996680a8' THEN RAISE EXCEPTION 'The Installed Independent Ticket Contract Changed'; END IF; END $$;
CREATE TABLE public.wheel_batch_requests (
 id uuid PRIMARY KEY, user_id uuid NOT NULL, club_id uuid NOT NULL,
 spins integer NOT NULL CHECK(spins IN(5,10,25)),
 entry_diamonds integer NOT NULL CHECK(entry_diamonds BETWEEN 25 AND 2500),
 commit_ids uuid[] NOT NULL, tickets jsonb NOT NULL,
 client_seed text, run_id uuid, receipt jsonb,
 status text NOT NULL DEFAULT 'prepared' CHECK(status IN('prepared','starting','complete')),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(cardinality(commit_ids)=spins),
 CHECK((status='complete')=(receipt IS NOT NULL))
);
CREATE UNIQUE INDEX wheel_batch_one_run ON public.wheel_batch_requests(run_id) WHERE run_id IS NOT NULL;
ALTER TABLE public.wheel_batch_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY wheel_batch_own ON public.wheel_batch_requests FOR SELECT TO authenticated USING(user_id=auth.uid());
REVOKE ALL ON public.wheel_batch_requests FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.wheel_batch_requests TO authenticated;
CREATE FUNCTION public.fn_wheel_batch_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF OLD.status='complete' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.club_id IS DISTINCT FROM OLD.club_id OR NEW.spins IS DISTINCT FROM OLD.spins OR NEW.entry_diamonds IS DISTINCT FROM OLD.entry_diamonds OR NEW.commit_ids IS DISTINCT FROM OLD.commit_ids OR NEW.tickets IS DISTINCT FROM OLD.tickets THEN RAISE EXCEPTION 'A Paid Batch Cannot Be Rewritten'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER wheel_batch_immutable BEFORE UPDATE ON public.wheel_batch_requests FOR EACH ROW EXECUTE FUNCTION public.fn_wheel_batch_immutable();
CREATE FUNCTION public.fn_wheel_batch_prepare(p_request_id uuid,p_club_id uuid,p_spins integer,p_entry_diamonds integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE r public.wheel_batch_requests; ticket jsonb; tickets jsonb:='[]'; ids uuid[]:='{}'; n integer;
BEGIN
 IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To Spin'); END IF;
 IF p_request_id IS NULL OR p_spins IS NULL OR p_spins NOT IN(5,10,25) OR p_entry_diamonds IS NULL OR p_entry_diamonds NOT BETWEEN 25 AND 2500 THEN RETURN jsonb_build_object('ok',false,'error','Choose Valid Batch Settings'); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text,94618));
 SELECT * INTO r FROM public.wheel_batch_requests WHERE id=p_request_id;
 IF FOUND THEN
  IF r.user_id IS DISTINCT FROM auth.uid() OR r.club_id IS DISTINCT FROM p_club_id OR r.spins IS DISTINCT FROM p_spins OR r.entry_diamonds IS DISTINCT FROM p_entry_diamonds THEN RETURN jsonb_build_object('ok',false,'error','This Batch Belongs To Different Settings'); END IF;
  RETURN jsonb_build_object('ok',true,'request_id',r.id,'spins',r.spins,'entry_diamonds',r.entry_diamonds,'status',r.status,'tickets',r.tickets,'receipt',r.receipt);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.club_members WHERE club_id=p_club_id AND user_id=auth.uid() AND COALESCE(status,'active') IN('active','approved')) THEN RETURN jsonb_build_object('ok',false,'error','Join The Club Before You Spin'); END IF;
 FOR n IN 1..p_spins LOOP
  ticket:=public.fn_wheel_commit();
  IF ticket->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Batch Ticket Could Not Be Sealed'; END IF;
  tickets:=tickets||jsonb_build_array(ticket);ids:=array_append(ids,(ticket->>'commit_id')::uuid);
 END LOOP;
 INSERT INTO public.wheel_batch_requests(id,user_id,club_id,spins,entry_diamonds,commit_ids,tickets) VALUES(p_request_id,auth.uid(),p_club_id,p_spins,p_entry_diamonds,ids,tickets);
 RETURN jsonb_build_object('ok',true,'request_id',p_request_id,'spins',p_spins,'entry_diamonds',p_entry_diamonds,'status','prepared','tickets',tickets);
END $$;
CREATE FUNCTION public.fn_wheel_batch_active(p_run_id uuid,p_commit_id uuid,p_entry integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT EXISTS(SELECT 1 FROM public.wheel_batch_requests r WHERE r.id::text=current_setting('diamond.wheel_batch',true) AND r.user_id=auth.uid() AND r.status='starting' AND r.run_id=p_run_id AND r.entry_diamonds=p_entry AND p_commit_id=ANY(r.commit_ids))
$$;
CREATE FUNCTION public.fn_wheel_batch_begin(p_request_id uuid,p_client_seed text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $$
DECLARE r public.wheel_batch_requests; q jsonb; begun jsonb; spin jsonb; receipts jsonb:='[]'; n integer; answer jsonb; old_context text;
BEGIN
 IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To Spin'); END IF;
 IF p_client_seed IS NULL OR length(p_client_seed) NOT BETWEEN 1 AND 60 THEN RETURN jsonb_build_object('ok',false,'error','Choose A Valid Batch Seed'); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(auth.uid()::text,94615));
 SELECT * INTO r FROM public.wheel_batch_requests WHERE id=p_request_id AND user_id=auth.uid() FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','That Batch Could Not Be Found'); END IF;
 IF r.status='complete' THEN
  IF r.client_seed IS DISTINCT FROM p_client_seed THEN RETURN jsonb_build_object('ok',false,'error','This Batch Used A Different Seed'); END IF;
  RETURN r.receipt||jsonb_build_object('replayed',true);
 END IF;
 IF r.status<>'prepared' THEN RETURN jsonb_build_object('ok',false,'error','This Batch Is Being Confirmed'); END IF;
 IF EXISTS(SELECT 1 FROM public.wheel_runs WHERE user_id=auth.uid() AND status='open') THEN RETURN jsonb_build_object('ok',false,'error','Finish The Run You Already Started','charged_diamonds',0,'status','prepared','request_id',r.id); END IF;
 q:=public.fn_wheel_state_v2(r.club_id,r.entry_diamonds);
 IF q->>'available' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('ok',false,'error',COALESCE(q->>'reason','The Host Cannot Fund This Batch'),'charged_diamonds',0,'status','prepared','request_id',r.id); END IF;
 IF COALESCE((q#>>'{player,spendable}')::numeric,0)<r.spins*r.entry_diamonds THEN RETURN jsonb_build_object('ok',false,'error','Not Enough Diamonds For The Whole Run','charged_diamonds',0,'status','prepared','request_id',r.id); END IF;
 IF COALESCE((q#>>'{player,spins_today}')::integer,0)+r.spins>COALESCE((q#>>'{config,max_spins_per_player_per_day}')::integer,0) THEN RETURN jsonb_build_object('ok',false,'error','The Whole Run Exceeds Today’s Spin Limit','charged_diamonds',0,'status','prepared','request_id',r.id); END IF;
 old_context:=current_setting('diamond.wheel_batch',true);
 BEGIN
  begun:=public.fn_wheel_run_begin(r.club_id,r.spins);
  IF begun->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION USING ERRCODE='PDB03',MESSAGE=COALESCE(begun->>'error','The Batch Could Not Begin'); END IF;
  r.run_id:=(begun->>'run_id')::uuid;
  UPDATE public.wheel_batch_requests SET status='starting',run_id=r.run_id,client_seed=p_client_seed WHERE id=r.id;
  PERFORM set_config('diamond.wheel_batch',r.id::text,true);
  FOR n IN 1..r.spins LOOP
   spin:=public.fn_wheel_spin_v2(r.club_id,r.commit_ids[n],p_client_seed||':'||n,r.entry_diamonds,'paid',NULL);
   IF spin->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION USING ERRCODE='PDB03',MESSAGE=COALESCE(spin->>'error','The Host Cannot Fund Every Spin In This Run'); END IF;
   receipts:=receipts||jsonb_build_array(spin);
  END LOOP;
  answer:=jsonb_build_object('ok',true,'request_id',r.id,'run_id',r.run_id,'spins',r.spins,'spins_done',r.spins,'entry_diamonds',r.entry_diamonds,'total_cost_diamonds',r.spins*r.entry_diamonds,'client_seed',p_client_seed,'tickets',r.tickets,'receipts',receipts);
  UPDATE public.wheel_batch_requests SET status='complete',receipt=answer WHERE id=r.id;
  PERFORM set_config('diamond.wheel_batch',COALESCE(old_context,''),true);
  RETURN answer;
 EXCEPTION WHEN SQLSTATE 'PDB03' THEN
  PERFORM set_config('diamond.wheel_batch',COALESCE(old_context,''),true);
  RETURN jsonb_build_object('ok',false,'error',SQLERRM,'charged_diamonds',0,'status','prepared','request_id',r.id);
 END;
END $$;
CREATE FUNCTION public.fn_wheel_batch_read(p_run_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE r public.wheel_batch_requests;
BEGIN
 IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To Read Your Run'); END IF;
 SELECT * INTO r FROM public.wheel_batch_requests WHERE run_id=p_run_id AND user_id=auth.uid() AND status='complete';
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','This Is An Earlier Run'); END IF;
 RETURN r.receipt;
END $$;
REVOKE ALL ON FUNCTION public.fn_wheel_batch_immutable(),public.fn_wheel_batch_active(uuid,uuid,integer),public.fn_wheel_batch_prepare(uuid,uuid,integer,integer),public.fn_wheel_batch_begin(uuid,text),public.fn_wheel_batch_read(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_wheel_batch_prepare(uuid,uuid,integer,integer),public.fn_wheel_batch_begin(uuid,text),public.fn_wheel_batch_read(uuid) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_wheel_batch_active(uuid,uuid,integer) TO service_role;
-- Only an owned, active batch can share one transaction's time across spins.
DO $patch$
DECLARE original text;
BEGIN
 original:=pg_get_functiondef('public.fn_wheel_spin_v2(uuid,uuid,text,integer,text,uuid)'::regprocedure);
 IF md5(original) IS DISTINCT FROM '2b50c8310f1b41548815d48b1a5997e9' THEN RAISE EXCEPTION 'Spin preimage changed'; END IF;
 IF strpos(original,'IF v_last IS NOT NULL AND now() - v_last < make_interval(secs => cfg.min_seconds_between_spins) THEN')=0 THEN RAISE EXCEPTION 'Batch clock boundary missing'; END IF;
 original:=replace(original,'IF v_last IS NOT NULL AND now() - v_last < make_interval(secs => cfg.min_seconds_between_spins) THEN','IF NOT public.fn_wheel_batch_active(v_run.id,p_commit_id,p_entry_diamonds) AND v_last IS NOT NULL AND now() - v_last < make_interval(secs => cfg.min_seconds_between_spins) THEN');
 -- A batch reserves the complete 20x optional-addon promise for each game,
 -- rather than consuming almost the entire game allowance on its first award.
 -- The same cap is sealed in the award and shown on the game quote. Earlier
 -- awards and ordinary single spins retain their existing sealed caps.
 original:=replace(original,
  'v_cap:=(v_caps->>(v_game||'':''||v_boost))::integer;v_hold:=ceil(v_budget::numeric/v_rate*v_cap)/100;',
  'v_cap:=(v_caps->>(v_game||'':''||v_boost))::integer;IF public.fn_wheel_batch_active(v_run.id,p_commit_id,p_entry_diamonds) THEN v_cap:=LEAST(v_cap,2000*(v_boost+1)/v_boost); END IF;v_hold:=ceil(v_budget::numeric/v_rate*v_cap)/100;');
 IF position('THEN v_cap:=LEAST(v_cap,2000*(v_boost+1)/v_boost)' in original)=0 THEN RAISE EXCEPTION 'Batch Award Reservation Branch Changed'; END IF;
 EXECUTE original;
END $patch$;
CREATE FUNCTION public.fn_wheel_prize_order(p_spin_id uuid) RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT extract(epoch FROM s.created_at)*1000000+COALESCE((s.receipt_v2#>>'{auto_run,spins_done}')::integer,0) FROM public.wheel_spins s WHERE s.id=p_spin_id
$$;
CREATE FUNCTION public.fn_wheel_next_unplayed(p_user uuid,p_club uuid) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT q.id FROM (
 SELECT a.id,public.fn_wheel_prize_order(a.spin_id) won_order FROM public.wheel_bonus_awards a WHERE a.user_id=p_user AND a.club_id=p_club AND public.fn_wheel_bonus_unfinished(a)
 UNION ALL SELECT c.id,public.fn_wheel_prize_order(c.spin_id) FROM public.wheel_card_awards c WHERE c.user_id=p_user AND c.club_id=p_club AND c.status='pending'
 ) q ORDER BY q.won_order,q.id LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.fn_wheel_prize_order(uuid),public.fn_wheel_next_unplayed(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_wheel_prize_order(uuid),public.fn_wheel_next_unplayed(uuid,uuid) TO service_role;
DO $$ BEGIN IF md5(pg_get_functiondef('public.fn_wheel_bonus_public_award(public.wheel_bonus_awards,boolean)'::regprocedure)) IS DISTINCT FROM '05c398390da8bf8c5d84b7c6549cf83b' THEN RAISE EXCEPTION 'fn_wheel_bonus_public_award preimage changed'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_wheel_bonus_public_award(a wheel_bonus_awards, p_double boolean)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT jsonb_build_object('id',a.id,'game',a.game,'club_id',a.club_id,'entry_diamonds',a.entry_diamonds,'base_diamonds',a.base_diamonds,'boost_multiplier',a.boost_multiplier,
 'bet_diamonds',a.base_diamonds+CASE WHEN p_double THEN a.entry_diamonds ELSE 0 END,'added_diamonds',CASE WHEN p_double THEN a.entry_diamonds ELSE 0 END,
 'cap_cents',floor(a.cap_cents*a.base_diamonds::numeric/(a.base_diamonds+CASE WHEN p_double THEN a.entry_diamonds ELSE 0 END)),
 'original_cap_cents',a.cap_cents,'reserved_chips',a.reserved_chips,'status',a.status,'commit_id',a.commit_id,'result',public.fn_wheel_bonus_current_result(a),'created_at',a.created_at,'won_order',public.fn_wheel_prize_order(a.spin_id))
$function$
;
DO $$ BEGIN IF md5(pg_get_functiondef('public.fn_wheel_card_public(public.wheel_card_awards)'::regprocedure)) IS DISTINCT FROM '89ba43cc77d479c10fa64dd7c5764093' THEN RAISE EXCEPTION 'fn_wheel_card_public preimage changed'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_wheel_card_public(a wheel_card_awards)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
 SELECT jsonb_build_object('id',a.id,'spin_id',a.spin_id,'club_id',a.club_id,
  'risk_diamonds',a.risk_diamonds,'status',a.status,'created_at',a.created_at,'won_order',public.fn_wheel_prize_order(a.spin_id))
$function$
;
DO $$ BEGIN IF md5(pg_get_functiondef('public.fn_wheel_diamond_cards_pick(uuid,smallint)'::regprocedure)) IS DISTINCT FROM '79f3711b99ef751482e8b1c3e3cd3c76' THEN RAISE EXCEPTION 'fn_wheel_diamond_cards_pick preimage changed'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_wheel_diamond_cards_pick(p_award_id uuid, p_card smallint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_user uuid:=auth.uid(); a public.wheel_card_awards; v_values integer[]; v_paid integer;
 v_credit jsonb; v_after numeric; v_rate integer:=public.fn_ca_bridge_rate();
BEGIN
 IF v_user IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To Spin'); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(auth.uid()::text,94615));
 IF p_award_id IS NULL OR p_card IS NULL OR p_card NOT BETWEEN 1 AND 3 THEN
  RETURN jsonb_build_object('ok',false,'error','Choose Card One, Two Or Three'); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_award_id::text,94617));
 SELECT * INTO a FROM public.wheel_card_awards WHERE id=p_award_id FOR UPDATE;
 IF a.id IS NULL OR a.user_id IS DISTINCT FROM v_user THEN
  RETURN jsonb_build_object('ok',false,'error','That Card Game Belongs To Another Player'); END IF;
 v_values:=public.fn_wheel_card_values(a.half_diamonds,a.risk_diamonds,a.permutation);
 IF a.status='picked' THEN
  SELECT COALESCE(p.diamonds,0) INTO v_after FROM public.profiles p WHERE p.id=v_user;
  RETURN jsonb_build_object('ok',true,'replayed',true,'award_id',a.id,'spin_id',a.spin_id,
   'picked',a.picked_card,'cards',to_jsonb(v_values),'paid_diamonds',a.paid_diamonds,
   'risk_diamonds',a.risk_diamonds,'balances',jsonb_build_object('diamonds',v_after),
   'fairness',jsonb_build_object('domain','wheel-v4-cards','roll',a.roll,'permutation',a.permutation,
    'server_seed',a.server_seed,'server_seed_hash',a.server_seed_hash,'client_seed',a.client_seed,'nonce',a.nonce));
 END IF;
 IF public.fn_wheel_next_unplayed(auth.uid(),a.club_id) IS DISTINCT FROM a.id THEN RETURN jsonb_build_object('ok',false,'error','Play The Earlier Prize In Your Queue First'); END IF;
 IF public.fn_platform_frozen() THEN
  RETURN jsonb_build_object('ok',false,'error','The Platform Is In Its Maintenance Break. Pick Again In A Few Minutes'); END IF;
 IF EXISTS(SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope='wheel' AND f.cleared_at IS NULL) THEN
  RETURN jsonb_build_object('ok',false,'error','The Diamond Wheel Is Paused'); END IF;
 v_paid:=v_values[p_card];
 -- Same lock order as the spin: both wallets by id, then the pool.
 PERFORM 1 FROM public.profiles WHERE id IN(a.owner_id,v_user) ORDER BY id FOR UPDATE;
 UPDATE public.wheel_card_awards SET status='picked',picked_card=p_card,paid_diamonds=v_paid,
   picked_at=transaction_timestamp() WHERE id=a.id RETURNING * INTO a;
 IF v_paid>0 THEN
  PERFORM public.fn_diamond_spin_book(a.owner_id,a.club_id,a.host_id,a.host_kind,v_user,'diamond_prize',-v_paid,
   'wheel-cards:'||a.id||':custody','Diamond Spins: Diamonds Cards');
  v_credit:=public.add_diamonds_to_balance(v_user,v_paid,'transfer','Diamond Spins: Diamonds',
   'wheel-cards:'||a.id,a.owner_id);
  IF COALESCE((v_credit->>'success')::boolean,false) IS NOT TRUE THEN
   RAISE EXCEPTION 'The Diamond Card Prize Credit Failed: %',v_credit->>'error'; END IF;
  IF NOT a.is_welcome THEN
   UPDATE public.wheel_pools SET diamond_float=diamond_float-v_paid,diamonds_paid=diamonds_paid+v_paid,
     updated_at=now() WHERE host_id=a.host_id;
  END IF;
 END IF;
 SELECT COALESCE(p.diamonds,0) INTO v_after FROM public.profiles p WHERE p.id=v_user;
 RETURN jsonb_build_object('ok',true,'replayed',false,'award_id',a.id,'spin_id',a.spin_id,
  'picked',a.picked_card,'cards',to_jsonb(v_values),'paid_diamonds',v_paid,
  'risk_diamonds',a.risk_diamonds,'value_chips',v_paid::numeric/v_rate,
  'balances',jsonb_build_object('diamonds',v_after),
  'fairness',jsonb_build_object('domain','wheel-v4-cards','roll',a.roll,'permutation',a.permutation,
   'server_seed',a.server_seed,'server_seed_hash',a.server_seed_hash,'client_seed',a.client_seed,'nonce',a.nonce));
END $function$
;
DO $$ BEGIN IF md5(pg_get_functiondef('public.fn_wheel_bonus_start(uuid,uuid,text,boolean,text,integer,integer,integer,integer)'::regprocedure)) IS DISTINCT FROM 'fcc69d076563d627b9b472bbb7417497' THEN RAISE EXCEPTION 'fn_wheel_bonus_start preimage changed'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_wheel_bonus_start(p_award_id uuid, p_commit_id uuid, p_client_seed text, p_double boolean, p_mode text DEFAULT NULL::text, p_denom integer DEFAULT NULL::integer, p_table_version integer DEFAULT NULL::integer, p_auto_cashout_cents integer DEFAULT NULL::integer, p_max_steps integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE a public.wheel_bonus_awards;e public.diamond_bonus_entries;wanted jsonb;v_result jsonb;total integer;old_context text;v_refusal jsonb;
BEGIN
 IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To Play'); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(auth.uid()::text,94615));
 IF p_award_id IS NULL OR p_commit_id IS NULL OR p_double IS NULL OR p_client_seed IS NULL OR length(p_client_seed) NOT BETWEEN 1 AND 64 THEN
  RETURN jsonb_build_object('ok',false,'error','Choose Valid Bonus Settings'); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_commit_id::text,94613));
 SELECT * INTO a FROM public.wheel_bonus_awards WHERE id=p_award_id AND user_id=auth.uid() FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','This Bonus Award Does Not Belong To You'); END IF;
 wanted:=jsonb_build_object('award',p_award_id,'commit',p_commit_id,'seed',p_client_seed,'double',p_double,'mode',p_mode,'denom',p_denom,'table',p_table_version,'auto',p_auto_cashout_cents,'steps',p_max_steps);
 IF a.status='redeemed' THEN
  IF a.request IS DISTINCT FROM wanted THEN RETURN jsonb_build_object('ok',false,'error','This Award Was Used With Different Bonus Settings'); END IF;
  RETURN public.fn_wheel_bonus_current_result(a)||jsonb_build_object('replayed',true);
 END IF;
 IF public.fn_wheel_next_unplayed(auth.uid(),a.club_id) IS DISTINCT FROM a.id THEN RETURN jsonb_build_object('ok',false,'error','Play The Earlier Prize In Your Queue First'); END IF;
 IF a.status<>'pending' THEN RETURN jsonb_build_object('ok',false,'error','This Bonus Is Already Starting'); END IF;
 -- The award is untouched, so nothing has been charged on this ticket. A
 -- ticket that cannot open a round is refused here, before the entry whose
 -- foreign key would otherwise turn it into an exception the client cannot read.
 v_refusal:=public.fn_diamond_ticket_refusal(a.user_id,a.game,p_commit_id);
 IF v_refusal IS NOT NULL THEN RETURN v_refusal; END IF;
 IF public.fn_platform_frozen() THEN RETURN jsonb_build_object('ok',false,'error','The Platform Is In Its Maintenance Break'); END IF;
 -- Follow the same game-config, pool, host order as ordinary game admission.
 PERFORM 1 FROM public.diamond_game_configs WHERE host_id=a.host_id AND game=a.game FOR UPDATE;
 PERFORM 1 FROM public.diamond_game_pools WHERE host_id=a.host_id AND game=a.game FOR UPDATE;
 PERFORM * FROM public.fn_diamond_game_cover_lock(a.host_id,a.host_kind);
 total:=a.base_diamonds+CASE WHEN p_double THEN a.entry_diamonds ELSE 0 END;
 old_context:=current_setting('diamond.wheel_award',true);
 BEGIN
  UPDATE public.wheel_bonus_awards SET status='starting',commit_id=p_commit_id,request=wanted WHERE id=a.id;
  PERFORM set_config('diamond.wheel_award',a.id::text,true);
  INSERT INTO public.diamond_bonus_entries(user_id,club_id,host_id,host_kind,game,commit_id,base_diamonds,added_diamonds,request,is_fixture,wheel_award_id)
   VALUES(a.user_id,a.club_id,a.host_id,a.host_kind,a.game,p_commit_id,a.base_diamonds,total-a.base_diamonds,wanted,
    public.fn_ca_is_fixture_account(a.user_id) OR public.fn_ca_is_cert_account(a.user_id),a.id) RETURNING * INTO e;
  -- The host row lock makes this transfer of liability indivisible to all other
  -- admissions and withdrawals. Refusal rolls the release and all money back.
  UPDATE public.diamond_game_pools SET reserved_chips=reserved_chips-a.reserved_chips WHERE host_id=a.host_id AND game=a.game;
  IF a.game='plinko' THEN v_result:=public.fn_plinko_bonus_run(a.club_id,p_commit_id,p_client_seed,total,p_denom,p_table_version);
  ELSIF a.game='crash' THEN v_result:=public.fn_crash_start(a.club_id,p_commit_id,p_client_seed,total,p_auto_cashout_cents);
  ELSE v_result:=public.fn_choice_start(a.club_id,a.game,p_mode,total,p_commit_id,p_client_seed,p_max_steps); END IF;
  IF v_result->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION USING ERRCODE='PDB02',MESSAGE=COALESCE(v_result->>'error','The Bonus Could Not Start'); END IF;
  IF COALESCE(v_result->>'commit_id',v_result#>>'{fairness,commit_id}') IS DISTINCT FROM p_commit_id::text OR v_result->>'club_id' IS DISTINCT FROM a.club_id::text OR (v_result->>'bet_diamonds')::integer IS DISTINCT FROM total THEN
   RAISE EXCEPTION USING ERRCODE='PDB02',MESSAGE='Resume Your Existing Round First'; END IF;
  v_result:=v_result||public.fn_wheel_award_receipt(p_commit_id);
  UPDATE public.diamond_bonus_entries SET result=v_result WHERE id=e.id;
  UPDATE public.wheel_bonus_awards SET status='redeemed',result=v_result WHERE id=a.id;
  PERFORM set_config('diamond.wheel_award',COALESCE(old_context,''),true);
  RETURN v_result;
 EXCEPTION WHEN SQLSTATE 'PDB02' THEN
  PERFORM set_config('diamond.wheel_award',COALESCE(old_context,''),true);
  RETURN jsonb_build_object('ok',false,'error',SQLERRM);
 END;
END $function$
;
COMMIT;
