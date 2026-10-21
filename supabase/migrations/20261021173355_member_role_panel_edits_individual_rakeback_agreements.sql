-- Reserved by scripts/new-migration.mjs. Individual terms are edited separately
-- from role transitions; no wallet or historical settled amount is rewritten.
-- WITHHELD player_rakeback_explicit: Server-only accounting marker; browser clients read authorized terms through fn_member_rakeback_terms.
-- @live-proof: EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='club_members' AND column_name='player_rakeback_explicit')
-- @live-proof: strpos(pg_get_functiondef('public.fn_accounting_agreement_terms(text,jsonb)'::regprocedure),'player_rakeback_explicit')>0
-- @live-proof: strpos(pg_get_functiondef('public.fn_player_rakeback_rate(uuid,uuid,numeric)'::regprocedure),'IF v_explicit OR')>0
-- @live-proof: strpos(pg_get_functiondef('public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])'::regprocedure),'p.member->>''player_rakeback_explicit''')>0
-- @live-proof: strpos(pg_get_functiondef('public.fn_rakeback_split_check(uuid,date,date,uuid[])'::regprocedure),'p.member->>''player_rakeback_explicit''')>0
-- @live-proof: strpos(pg_get_functiondef('public.fn_rakeback_split_write(uuid,date,date,uuid[])'::regprocedure),'p.member->>''player_rakeback_explicit''')>0
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='45s';
ALTER TABLE public.club_members ADD COLUMN player_rakeback_explicit boolean NOT NULL DEFAULT false;

CREATE FUNCTION public.fn_member_rakeback_explicit_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.player_rakeback_explicit IS DISTINCT FROM OLD.player_rakeback_explicit
  AND current_user NOT IN ('postgres','supabase_admin','service_role') THEN
  RAISE EXCEPTION 'Individual Rakeback Must Be Set Through Its Agreement RPC' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.fn_member_rakeback_explicit_guard() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER member_rakeback_explicit_guard BEFORE UPDATE OF player_rakeback_explicit
 ON public.club_members FOR EACH ROW EXECUTE FUNCTION public.fn_member_rakeback_explicit_guard();
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note)
 VALUES('club_members','member_rakeback_explicit_guard','Only the authorized agreement RPC records an explicit player rate, including zero.');

-- Preserve explicit zero in the original earning-time history and pricing paths.
CREATE FUNCTION pg_temp.member_rate_patch(sig text, before_text text, after_text text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE definition text; name text;
BEGIN
 definition:=pg_get_functiondef(sig::regprocedure);
 IF (length(definition)-length(replace(definition,before_text,'')))/length(before_text)<>1 THEN
  RAISE EXCEPTION 'individual rakeback patch anchor drift: %',sig;
 END IF;
 SELECT proname INTO name FROM pg_proc WHERE oid=sig::regprocedure;
 EXECUTE replace(definition,before_text,after_text);
 IF name=ANY(public.fn_ca_guard_watchlist()) THEN
  PERFORM public.fn_ca_declare_guard_redefinition(name,'individual member rakeback editing 20261021173355');
 END IF;
END $$;
SELECT pg_temp.member_rate_patch('public.fn_accounting_agreement_terms(text,jsonb)',
 '''rakeback_rate'',''player_rakeback_pct'']','''rakeback_rate'',''player_rakeback_pct'',''player_rakeback_explicit'']');
SELECT pg_temp.member_rate_patch('public.fn_player_rakeback_rate(uuid,uuid,numeric)',
 'v_has_agent boolean;', 'v_has_agent boolean; v_explicit boolean;');
SELECT pg_temp.member_rate_patch('public.fn_player_rakeback_rate(uuid,uuid,numeric)',
 'a.id IS NOT NULL', 'a.id IS NOT NULL, cm.player_rakeback_explicit');
SELECT pg_temp.member_rate_patch('public.fn_player_rakeback_rate(uuid,uuid,numeric)',
 'v_upline_rate, v_has_agent', 'v_upline_rate, v_has_agent, v_explicit');
SELECT pg_temp.member_rate_patch('public.fn_player_rakeback_rate(uuid,uuid,numeric)',
 'IF COALESCE(v_deal,0) > 0 THEN', 'IF v_explicit OR COALESCE(v_deal,0) > 0 THEN');
SELECT pg_temp.member_rate_patch('public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])',
 'CASE WHEN p.deal>0 THEN p.deal', 'CASE WHEN COALESCE((p.member->>''player_rakeback_explicit'')::boolean,false) OR p.deal>0 THEN p.deal');
SELECT pg_temp.member_rate_patch('public.fn_rakeback_split_check(uuid,date,date,uuid[])',
 'CASE WHEN p.deal>0 THEN p.deal', 'CASE WHEN COALESCE((p.member->>''player_rakeback_explicit'')::boolean,false) OR p.deal>0 THEN p.deal');
SELECT pg_temp.member_rate_patch('public.fn_rakeback_split_write(uuid,date,date,uuid[])',
 'CASE WHEN p.deal>0 THEN p.deal', 'CASE WHEN COALESCE((p.member->>''player_rakeback_explicit'')::boolean,false) OR p.deal>0 THEN p.deal');

CREATE FUNCTION public.fn_member_rakeback_terms(
 p_club_id uuid, p_user_id uuid, p_role text,
 p_rate numeric DEFAULT NULL, p_expected_rate numeric DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor uuid:=auth.uid(); actor_role text; member public.club_members%ROWTYPE;
 agreement public.agents%ROWTYPE; parent public.agents%ROWTYPE;
 current_rate numeric; maximum numeric; old_state jsonb; allowed boolean;
BEGIN
 IF actor IS NULL OR actor=p_user_id THEN
  RETURN jsonb_build_object('success',false,'error','You Cannot Edit Your Own Rakeback');
 END IF;
 IF p_rate IS NOT NULL AND (p_rate::text IN ('NaN','Infinity','-Infinity') OR p_rate<0 OR p_rate>0.70 OR p_rate<>round(p_rate,4)) THEN
  RETURN jsonb_build_object('success',false,'error','Invalid Rakeback Percentage');
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||p_club_id::text,0));
 SELECT role INTO actor_role FROM public.club_members
  WHERE club_id=p_club_id AND user_id=actor AND status IN ('active','approved') AND coalesce(is_active,true);
 SELECT * INTO member FROM public.club_members
  WHERE club_id=p_club_id AND user_id=p_user_id AND status IN ('active','approved') AND coalesce(is_active,true) FOR UPDATE;
 IF NOT FOUND OR member.role IS DISTINCT FROM p_role OR p_role NOT IN ('player','sub_agent','agent','super_agent') THEN
  RETURN jsonb_build_object('success',false,'error','Member Role Changed Or Is Not Eligible');
 END IF;
 allowed:=p_role=ANY(public.fn_club_grantable_roles(p_club_id,actor,p_user_id));
 IF p_role='player' AND actor_role IN ('super_agent','agent','sub_agent')
  AND public.fn_club_is_in_downline(p_club_id,actor,p_user_id) THEN allowed:=true; END IF;
 IF NOT COALESCE(allowed,false) THEN
  RETURN jsonb_build_object('success',false,'error','You Cannot Set This Member Rakeback');
 END IF;
 IF p_role='player' THEN
  SELECT * INTO parent FROM public.agents WHERE club_id=p_club_id AND user_id=member.agent_id AND status='active';
  IF NOT FOUND AND member.agent_id IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM public.clubs WHERE id=p_club_id AND owner_id=member.agent_id) THEN
   RETURN jsonb_build_object('success',false,'error','Player Upline Has No Active Agreement');
  END IF;
  maximum:=CASE WHEN FOUND THEN greatest(parent.commission_rate-0.10,0) ELSE 0.70 END;
  current_rate:=public.fn_player_rakeback_rate(p_user_id,p_club_id,0);
  old_state:=jsonb_build_object('player_rakeback_pct',member.player_rakeback_pct,'player_rakeback_explicit',member.player_rakeback_explicit);
 ELSE
  SELECT * INTO agreement FROM public.agents WHERE club_id=p_club_id AND user_id=p_user_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','No Active Agent Agreement'); END IF;
  SELECT * INTO parent FROM public.agents WHERE id=agreement.parent_agent_id AND club_id=p_club_id AND status='active';
  maximum:=CASE WHEN FOUND THEN least(0.70,parent.commission_rate) ELSE 0.70 END;
  current_rate:=agreement.commission_rate;
  old_state:=jsonb_build_object('commission_rate',current_rate);
 END IF;
 IF p_rate IS NOT NULL THEN
  IF p_expected_rate IS NULL OR current_rate IS DISTINCT FROM p_expected_rate THEN
   RETURN jsonb_build_object('success',false,'error','Rakeback Changed. Reload Terms Before Saving');
  END IF;
  IF p_rate>maximum THEN RETURN jsonb_build_object('success',false,'error','Rakeback Exceeds The Upline Limit'); END IF;
  IF p_role='player' THEN
   UPDATE public.club_members SET player_rakeback_pct=p_rate,player_rakeback_explicit=true,updated_at=now()
    WHERE club_id=p_club_id AND user_id=p_user_id;
  ELSE
   IF p_rate<agreement.player_rakeback_rate THEN
    RETURN jsonb_build_object('success',false,'error','Agent Rate Cannot Fall Below Their Player Offer');
   END IF;
   IF EXISTS(SELECT 1 FROM public.agents WHERE parent_agent_id=agreement.id AND club_id=p_club_id AND commission_rate>p_rate) THEN
    RETURN jsonb_build_object('success',false,'error','Agent Rate Cannot Fall Below A Child Agreement');
   END IF;
   UPDATE public.agents SET commission_rate=p_rate,updated_at=now() WHERE id=agreement.id;
  END IF;
  INSERT INTO public.audit_trail(actor_id,actor_role,action,target_type,target_id,club_id,before_state,after_state,reason)
  VALUES(actor,coalesce(actor_role,'platform_admin'),'set_member_rakeback','club_member',p_user_id,p_club_id,old_state,
   jsonb_build_object('role',p_role,'rate',p_rate),'Individual Rakeback Agreement Updated');
  current_rate:=p_rate;
 END IF;
 RETURN jsonb_build_object('success',true,'club_id',p_club_id,'user_id',p_user_id,'role',p_role,'rate',current_rate,'max_rate',maximum);
END $$;
REVOKE ALL ON FUNCTION public.fn_member_rakeback_terms(uuid,uuid,text,numeric,numeric) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_member_rakeback_terms(uuid,uuid,text,numeric,numeric) TO authenticated;
COMMIT;
