-- 20261017040017_double_diamonds_is_retired_from_the_wheel_bonus_games.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, 2026-10-16, verbatim: "REMOVE THE DOUBLE DIAMONDS FUNCTIONALITY FOR THE
-- BONUS GAMES ON THE DIAMOND SPINS. ITS CONFUSING TO SOME PLAYERS."
--
-- The client no longer offers the add-on (no Double Your Diamonds screen, no
-- Double Down box) and always sends p_double = false. This makes the server
-- the authority as well, so a tab still holding the previous bundle (the
-- origin keeps old assets, CLAUDE.md 1.1) cannot start a doubled round:
--
--   fn_wheel_bonus_start    a new start with p_double = true is refused.
--   fn_diamond_bonus_start  the same, for the award-less entry path.
--
-- WHERE THE REFUSAL SITS, AND WHY THERE. Both functions first look for a round
-- this ticket already opened and replay it when the request matches. A round
-- an older page opened WITH the add-on was paid for and must still replay its
-- own receipt, so the refusal is placed after that replay branch and before
-- anything is reserved, debited or inserted. Nothing is charged on a refusal;
-- the client clears its saved request and deals a fresh ticket (a plain
-- ok:false is a refusal, DiamondBonusService.start).
--
-- Everything else in both bodies is the live production definition read with
-- pg_get_functiondef on 2026-10-17 03:55 UTC, unchanged. The four-argument
-- signatures stay as they are: dropping p_double would break every replay of
-- a historical doubled round, and the read paths (fn_wheel_bonus_state,
-- fn_wheel_bonus_public_award) still need it to describe those rounds.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

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
 -- DOUBLE DIAMONDS IS RETIRED (Dan 2026-10-16). A redeemed award that took the
 -- add-on replays above; a new start that asks for it is refused here, before
 -- the award is touched, so nothing is charged.
 IF p_double THEN RETURN jsonb_build_object('ok',false,'error','Double Diamonds Is No Longer Offered. Refresh To Play Your Bonus.'); END IF;
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
END $function$;

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
 -- DOUBLE DIAMONDS IS RETIRED (Dan 2026-10-16). A round an older page opened
 -- with the add-on replays above; a new start that asks for it is refused
 -- here, before any entry is written, so nothing is charged.
 IF p_double THEN RETURN jsonb_build_object('ok',false,'error','Double Diamonds Is No Longer Offered. Refresh To Play Your Bonus.'); END IF;
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

COMMIT;
