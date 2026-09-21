-- A saved round settles itself, and a ticket is never pulled from under a live page.
--
-- WHAT HAPPENED (2026-09-21 18:46 UTC, Shark Club, Donkey Cross, award
-- ca50efe7-f15b-46bd-b893-f9b6ed4760be). The player pressed Start Round and
-- fn_wheel_bonus_start raised 23503: commit 52eb6695-... "is not present in
-- table diamond_game_commits". Seven presses, seven 409s, the award still
-- pending, and the page held at "Check Your Saved Round Before Starting
-- Another" with every way out blocked by the bonus guard.
--
-- WHY. fn_diamond_game_commit began by DELETING every unconsumed ticket the
-- player held for that game. A page that asks for a ticket twice (a remount
-- when auth resolves, a second tab, two requests that land out of order) keeps
-- one ticket in memory while the server has already thrown it away. The start
-- functions then INSERT the bonus entry, whose commit_id references the
-- commits table, BEFORE admission looks the ticket up - so a dead ticket is a
-- foreign-key exception instead of the clean refusal admission would have
-- given, the client cannot tell "the server never accepted this" from "the
-- network dropped the answer", and it saves the request and waits for a human.
--
-- THE FIX, server side.
--   1. Issuing a ticket no longer deletes the player's live tickets. A player
--      may hold several unconsumed commitments: nobody knows the seed behind
--      any of them, so none can be chosen against the house. Only that player's
--      EXPIRED unconsumed tickets are swept, and an expired ticket was already
--      refused by admission.
--   2. Both start functions look the ticket up before they touch an entry or a
--      chip. A ticket that is missing, another player's, another game's, used
--      by a different round or expired returns {ok:false, ticket:'gone'} - the
--      transaction never opened anything, so the client may deal a fresh ticket
--      and start again by itself. A ticket already used by THIS request still
--      replays its receipt exactly as before (that check stays first).
-- The client half (the same PR) replays a saved wager on its own schedule and
-- never shows a "Check Round" control.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '20s';
DO $preimages$ DECLARE expected record; BEGIN
 FOR expected IN SELECT * FROM (VALUES
 ('fn_diamond_game_commit(text)','6f1cfed80ae7f203205c2d6c8a2d5c02'),
 ('fn_diamond_bonus_start(uuid,text,integer,boolean,uuid,text,text,integer,integer,integer,integer)','640dd2c02d9edefabc102e4f3fdb2635'),
 ('fn_wheel_bonus_start(uuid,uuid,text,boolean,text,integer,integer,integer,integer)','30c67144f0fe4477d4319244c81c6401')
 ) x(signature,body_hash) LOOP
  IF md5(pg_get_functiondef(to_regprocedure('public.'||expected.signature))) IS DISTINCT FROM expected.body_hash THEN
   RAISE EXCEPTION 'Diamond Ticket Preimage Changed: %',expected.signature; END IF;
 END LOOP;
END $preimages$;

CREATE OR REPLACE FUNCTION public.fn_diamond_game_commit(p_game text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_seed text; v_hash text; v_id uuid; v_exp timestamptz;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Play');
  END IF;
  IF p_game IS NULL OR p_game NOT IN ('plinko', 'crash', 'crossing', 'mines') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Game Does Not Exist');
  END IF;
  -- Only this player's expired, never-used tickets are swept. A live ticket
  -- another page of theirs is holding stays valid until it is used or expires.
  DELETE FROM public.diamond_game_commits WHERE user_id = v_user AND consumed_by IS NULL AND expires_at < now();
  v_seed := encode(extensions.gen_random_bytes(32), 'hex');
  v_hash := encode(extensions.digest(v_seed, 'sha256'), 'hex');
  INSERT INTO public.diamond_game_commits (user_id, game, server_seed, server_seed_hash)
  VALUES (v_user, p_game, v_seed, v_hash) RETURNING id, expires_at INTO v_id, v_exp;
  RETURN jsonb_build_object('ok', true, 'commit_id', v_id, 'server_seed_hash', v_hash, 'expires_at', v_exp);
END $function$;

-- The one answer both start functions give for a ticket that cannot open a
-- round. 'gone' tells the client nothing was charged and a fresh ticket may be
-- dealt without a human in the loop.
CREATE OR REPLACE FUNCTION public.fn_diamond_ticket_refusal(p_user uuid, p_game text, p_commit_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE c public.diamond_game_commits;
BEGIN
  SELECT * INTO c FROM public.diamond_game_commits WHERE id = p_commit_id;
  IF c.id IS NULL OR c.user_id IS DISTINCT FROM p_user OR c.game IS DISTINCT FROM p_game OR c.consumed_by IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'ticket', 'gone', 'error', 'That Ticket Is Not Yours Or Was Already Used. A New One Is Being Dealt');
  END IF;
  IF c.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'ticket', 'gone', 'error', 'That Ticket Expired. A New One Is Being Dealt');
  END IF;
  RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION public.fn_diamond_ticket_refusal(uuid,text,uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_diamond_bonus_start(p_club_id uuid, p_game text, p_base_diamonds integer, p_double boolean, p_commit_id uuid, p_client_seed text, p_mode text DEFAULT NULL::text, p_denom integer DEFAULT NULL::integer, p_table_version integer DEFAULT NULL::integer, p_auto_cashout_cents integer DEFAULT NULL::integer, p_max_steps integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_user uuid:=auth.uid(); prior public.diamond_bonus_entries; wanted jsonb; v_host uuid; v_kind text;
 v_result jsonb; total integer; existing_crash public.crash_rounds; existing_choice public.diamond_choice_rounds; v_refusal jsonb;
BEGIN
 IF v_user IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To Play'); END IF;
 IF p_game IS NULL OR p_game NOT IN ('plinko','crash','crossing','mines') OR p_base_diamonds IS NULL OR
  p_base_diamonds NOT BETWEEN 25 AND 2500 OR p_double IS NULL OR p_commit_id IS NULL OR
  p_client_seed IS NULL OR length(p_client_seed) NOT BETWEEN 1 AND 64 THEN
  RETURN jsonb_build_object('ok',false,'error','Choose An Entry From 25 To 2,500 Diamonds'); END IF;
 total:=p_base_diamonds*CASE WHEN p_double THEN 2 ELSE 1 END;
 wanted:=jsonb_build_object('club',p_club_id,'game',p_game,'base',p_base_diamonds,'double',p_double,
  'seed',p_client_seed,'mode',p_mode,'denom',p_denom,'table',p_table_version,'auto',p_auto_cashout_cents,'steps',p_max_steps);
 PERFORM pg_advisory_xact_lock(hashtextextended(p_commit_id::text,94613));
 SELECT * INTO prior FROM public.diamond_bonus_entries WHERE commit_id=p_commit_id;
 IF FOUND THEN
  IF prior.user_id IS DISTINCT FROM v_user OR prior.request IS DISTINCT FROM wanted THEN
   RETURN jsonb_build_object('ok',false,'error','This Ticket Belongs To Different Bonus Settings'); END IF;
  IF p_game='crash' THEN
   SELECT * INTO existing_crash FROM public.crash_rounds WHERE commit_id=p_commit_id;
   v_result:=public.fn_crash_round_result(existing_crash);
  ELSIF p_game IN ('crossing','mines') THEN
   SELECT * INTO existing_choice FROM public.diamond_choice_rounds WHERE commit_id=p_commit_id;
   v_result:=public.fn_choice_result(existing_choice);
  ELSE v_result:=prior.result; END IF;
  RETURN v_result||jsonb_build_object('bonus',jsonb_build_object('id',prior.id,'base_diamonds',prior.base_diamonds,'added_diamonds',prior.added_diamonds,'total_diamonds',prior.total_diamonds),'replayed',true);
 END IF;
 -- No entry carries this ticket, so nothing has been charged on it. A ticket
 -- that cannot open a round is refused here, before the entry whose foreign
 -- key would otherwise turn it into an exception the client cannot read.
 v_refusal:=public.fn_diamond_ticket_refusal(v_user,p_game,p_commit_id);
 IF v_refusal IS NOT NULL THEN RETURN v_refusal; END IF;
 SELECT host_id,host_kind INTO v_host,v_kind FROM public.fn_wheel_host(p_club_id);
 IF v_host IS NULL THEN RETURN jsonb_build_object('ok',false,'error','That Club Could Not Be Found'); END IF;
 -- A caught refusal rolls back the entry and every inner money leg together.
 BEGIN
  INSERT INTO public.diamond_bonus_entries(user_id,club_id,host_id,host_kind,game,commit_id,base_diamonds,added_diamonds,request,is_fixture)
   VALUES(v_user,p_club_id,v_host,v_kind,p_game,p_commit_id,p_base_diamonds,total-p_base_diamonds,wanted,
    public.fn_ca_is_fixture_account(v_user) OR public.fn_ca_is_cert_account(v_user)) RETURNING * INTO prior;
  IF p_game='plinko' THEN v_result:=public.fn_plinko_bonus_run(p_club_id,p_commit_id,p_client_seed,total,p_denom,p_table_version);
  ELSIF p_game='crash' THEN v_result:=public.fn_crash_start(p_club_id,p_commit_id,p_client_seed,total,p_auto_cashout_cents);
  ELSE v_result:=public.fn_choice_start(p_club_id,p_game,p_mode,total,p_commit_id,p_client_seed,p_max_steps); END IF;
  IF v_result->>'ok'='true' AND (COALESCE(v_result->>'commit_id',v_result#>>'{fairness,commit_id}') IS DISTINCT FROM p_commit_id::text OR v_result->>'club_id' IS DISTINCT FROM p_club_id::text OR (v_result->>'bet_diamonds')::integer IS DISTINCT FROM total) THEN
   RAISE EXCEPTION USING MESSAGE='Resume Your Existing Round First', ERRCODE='PDB01';
  END IF;
  IF v_result->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION USING MESSAGE=COALESCE(v_result->>'error','The Bonus Could Not Start'), ERRCODE='PDB01'; END IF;
  v_result:=v_result||jsonb_build_object('bonus',jsonb_build_object('id',prior.id,'base_diamonds',p_base_diamonds,'added_diamonds',total-p_base_diamonds,'total_diamonds',total));
  UPDATE public.diamond_bonus_entries SET result=v_result WHERE id=prior.id;
  RETURN v_result;
 EXCEPTION WHEN SQLSTATE 'PDB01' THEN RETURN jsonb_build_object('ok',false,'error',SQLERRM);
 END;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_wheel_bonus_start(p_award_id uuid, p_commit_id uuid, p_client_seed text, p_double boolean, p_mode text DEFAULT NULL::text, p_denom integer DEFAULT NULL::integer, p_table_version integer DEFAULT NULL::integer, p_auto_cashout_cents integer DEFAULT NULL::integer, p_max_steps integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE a public.wheel_bonus_awards;e public.diamond_bonus_entries;wanted jsonb;v_result jsonb;total integer;old_context text;v_refusal jsonb;
BEGIN
 IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To Play'); END IF;
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
END $function$;
COMMIT;
