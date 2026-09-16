BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('fn_agent_roster_report(uuid,timestamptz,timestamptz)'::regprocedure))<>'d15425d2bb433c5411ea6ae3666b8f5d'
 OR md5(pg_get_functiondef('fn_agent_weekly_statement(uuid,timestamptz,timestamptz)'::regprocedure))<>'964d9f6523ea3901feef5692501a7d40'
 OR md5(pg_get_functiondef('fn_union_weekly_agent_statements(uuid,timestamptz)'::regprocedure))<>'8ecc8b2263b55daa17b94fbf8bbc42aa'
 THEN RAISE EXCEPTION 'agent statement source changed since review'; END IF;
END $guard$;

CREATE FUNCTION public.fn_accounting_agent_clubs(p_agent_user_id uuid,p_club_id uuid) RETURNS uuid[]
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE result uuid[]; actor uuid:=auth.uid(); engine boolean:=public.fn_caller_is_engine();
BEGIN
 IF p_agent_user_id IS NULL THEN RAISE EXCEPTION 'no_agent_context' USING ERRCODE='22023'; END IF;
 SELECT array_agg(DISTINCT a.club_id ORDER BY a.club_id) INTO result FROM public.agents a
  WHERE a.user_id=p_agent_user_id AND (p_club_id IS NULL OR a.club_id=p_club_id)
   AND (engine OR (actor IS NOT NULL AND (actor=p_agent_user_id OR public.fn_is_club_admin_uid(a.club_id) OR public.fn_union_oversees_club(a.club_id,actor))));
 IF COALESCE(cardinality(result),0)=0 THEN RAISE EXCEPTION 'not_authorised' USING ERRCODE='42501'; END IF;
 RETURN result;
END $function$;
REVOKE ALL ON FUNCTION public.fn_accounting_agent_clubs(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_accounting_agent_clubs(uuid,uuid) TO service_role;

CREATE FUNCTION public.fn_agent_roster_report(p_agent_user_id uuid,p_since timestamptz,p_until timestamptz,p_club_id uuid)
 RETURNS TABLE(player_id uuid,username text,club_id uuid,club_name text,buyins numeric,cashouts numeric,net_result numeric,rake_generated numeric,agent_commission numeric,chip_balance numeric,credit_used numeric,currently_seated boolean)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE actor_agent uuid:=COALESCE(p_agent_user_id,auth.uid()); scopes uuid[];
 since_at timestamptz:=COALESCE(p_since,public.fn_union_week_start(now())); until_at timestamptz:=COALESCE(p_until,now());
BEGIN
 scopes:=public.fn_accounting_agent_clubs(actor_agent,p_club_id);
 IF NOT isfinite(since_at) OR NOT isfinite(until_at) OR since_at>=until_at OR until_at>now()
 THEN RAISE EXCEPTION 'invalid_statement_period' USING ERRCODE='22023'; END IF;
 RETURN QUERY
 WITH RECURSIVE hierarchy AS (
   SELECT a.id,a.user_id,a.club_id FROM public.agents a WHERE a.user_id=actor_agent AND a.club_id=ANY(scopes)
   UNION -- Set semantics terminate cycles and prevent duplicate paths from multiplying money.
   SELECT a.id,a.user_id,a.club_id FROM public.agents a JOIN hierarchy h ON a.parent_agent_id=h.id AND a.club_id=h.club_id
 ), roster AS (
   SELECT DISTINCT m.user_id,m.club_id,m.chip_balance,m.credit_used FROM public.club_members m
    JOIN hierarchy h ON h.user_id=m.agent_id AND h.club_id=m.club_id
 ), flows AS (
   SELECT r.user_id,r.club_id,
    sum(CASE WHEN l.from_type='player_wallet' AND l.from_entity_id=r.user_id AND l.to_type='table_stack' THEN l.amount ELSE 0 END) AS buyins,
    sum(CASE WHEN l.to_type='player_wallet' AND l.to_entity_id=r.user_id AND l.from_type='table_stack' THEN l.amount ELSE 0 END) AS cashouts
   FROM roster r JOIN public.chip_ledger l ON l.club_id=r.club_id AND
    ((l.from_entity_id=r.user_id AND l.from_type='player_wallet' AND l.to_type='table_stack') OR
     (l.to_entity_id=r.user_id AND l.to_type='player_wallet' AND l.from_type='table_stack'))
   WHERE l.status='posted' AND l.created_at>=since_at AND l.created_at<until_at GROUP BY r.user_id,r.club_id
 ), rake AS (
   SELECT ra.player_id,ra.club_id,sum(ra.rake_amount) AS amount FROM public.rake_attributions ra
    JOIN roster r ON r.user_id=ra.player_id AND r.club_id=ra.club_id
   WHERE ra.created_at>=since_at AND ra.created_at<until_at AND ra.club_id=ANY(scopes)
   GROUP BY ra.player_id,ra.club_id
 )
 SELECT r.user_id,p.username,r.club_id,c.name,COALESCE(f.buyins,0),COALESCE(f.cashouts,0),
  COALESCE(f.cashouts,0)-COALESCE(f.buyins,0),round(COALESCE(rk.amount,0),2),
  NULL::numeric, -- The legacy commission journal has no source player. Never repeat a club total on every player.
  r.chip_balance,r.credit_used,
  EXISTS(SELECT 1 FROM public.table_seats s WHERE s.user_id=r.user_id AND s.club_id=r.club_id AND s.left_at IS NULL)
 FROM roster r LEFT JOIN public.profiles p ON p.id=r.user_id LEFT JOIN public.clubs c ON c.id=r.club_id
 LEFT JOIN flows f ON f.user_id=r.user_id AND f.club_id=r.club_id
 LEFT JOIN rake rk ON rk.player_id=r.user_id AND rk.club_id=r.club_id
 ORDER BY 8 DESC NULLS LAST,r.club_id,r.user_id;
END $function$;

CREATE FUNCTION public.fn_agent_weekly_statement(p_agent_user_id uuid,p_period_start timestamptz,p_period_end timestamptz,p_club_id uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE actor_agent uuid:=COALESCE(p_agent_user_id,auth.uid()); scopes uuid[];
 since_at timestamptz:=COALESCE(p_period_start,public.fn_union_week_start(now())); until_at timestamptz:=COALESCE(p_period_end,now());
 players int; rake numeric; cash_flow numeric; booked numeric; paid_to_players numeric; credit numeric; issued numeric; returned numeric;
BEGIN
 scopes:=public.fn_accounting_agent_clubs(actor_agent,p_club_id);
 SELECT count(*),COALESCE(sum(r.rake_generated),0),COALESCE(sum(r.net_result),0) INTO players,rake,cash_flow
  FROM public.fn_agent_roster_report(actor_agent,since_at,until_at,p_club_id) r;
 SELECT COALESCE(sum(a.amount),0) INTO booked FROM public.agent_commissions a
  WHERE a.user_id=actor_agent AND a.club_id=ANY(scopes) AND a.created_at>=since_at AND a.created_at<until_at;
 SELECT COALESCE(sum(l.amount),0) INTO paid_to_players FROM public.chip_ledger l
  WHERE l.club_id=ANY(scopes) AND l.status='posted' AND l.category='rakeback'
   AND l.from_type IN('agent_wallet','player_wallet') AND l.from_entity_id=actor_agent AND l.to_type IN('player_wallet','agent_wallet')
   AND l.created_at>=since_at AND l.created_at<until_at;
 SELECT COALESCE(sum(a.credit_used),0) INTO credit FROM public.agents a WHERE a.user_id=actor_agent AND a.club_id=ANY(scopes);
 SELECT COALESCE(sum(CASE WHEN l.from_entity_id=actor_agent THEN l.amount ELSE 0 END),0),
        COALESCE(sum(CASE WHEN l.to_entity_id=actor_agent THEN l.amount ELSE 0 END),0) INTO issued,returned
  FROM public.chip_ledger l WHERE l.club_id=ANY(scopes) AND l.status='posted'
   AND l.from_type IN('player_wallet','agent_wallet') AND l.to_type IN('player_wallet','agent_wallet')
   AND (l.from_entity_id=actor_agent OR l.to_entity_id=actor_agent)
   AND l.created_at>=since_at AND l.created_at<until_at;
 RETURN jsonb_build_object('agent_user_id',actor_agent,'club_ids',to_jsonb(scopes),'period_start',since_at,'period_end',until_at,
  'players',players,'rake_generated',round(rake,2),'commission_earned',round(booked,2),'rakeback_passed_to_players',round(paid_to_players,2),
  'commission_net_of_rakeback',round(booked-paid_to_players,2),'player_net_result',round(cash_flow,2),
  'chips_issued_to_players',round(issued,2),'chips_returned_from_players',round(returned,2),'credit_outstanding',round(credit,2),
  'net_settlement_position',NULL,'settlement_verified',false,'settles','weekly',
  'basis','Current Downline; Posted Cash Wallet Flows; Recorded Cash Rake And Commission',
  'settlement_note','Use Issued Invoices For Amounts Due. Historical Earning Agreements And The Full Waterfall Require Reconciliation.');
END $function$;

CREATE OR REPLACE FUNCTION public.fn_agent_roster_report(p_agent_user_id uuid DEFAULT NULL,p_since timestamptz DEFAULT NULL,p_until timestamptz DEFAULT NULL)
 RETURNS TABLE(player_id uuid,username text,club_id uuid,club_name text,buyins numeric,cashouts numeric,net_result numeric,rake_generated numeric,agent_commission numeric,chip_balance numeric,credit_used numeric,currently_seated boolean)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
BEGIN RETURN QUERY SELECT * FROM public.fn_agent_roster_report(COALESCE(p_agent_user_id,auth.uid()),p_since,p_until,NULL); END $function$;
CREATE OR REPLACE FUNCTION public.fn_agent_weekly_statement(p_agent_user_id uuid DEFAULT NULL,p_period_start timestamptz DEFAULT NULL,p_period_end timestamptz DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
BEGIN RETURN public.fn_agent_weekly_statement(COALESCE(p_agent_user_id,auth.uid()),p_period_start,p_period_end,NULL); END $function$;
CREATE OR REPLACE FUNCTION public.fn_union_weekly_agent_statements(p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001',p_period_start timestamptz DEFAULT NULL)
 RETURNS TABLE(agent_user_id uuid,agent_name text,club_name text,statement jsonb)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR NOT public.fn_is_union_overseer(p_union_id,auth.uid()))
 THEN RAISE EXCEPTION 'not_authorised' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT a.user_id,p.username,c.name,
  public.fn_agent_weekly_statement(a.user_id,COALESCE(p_period_start,public.fn_union_week_start(now())),
   LEAST(now(),((COALESCE(p_period_start,public.fn_union_week_start(now())) AT TIME ZONE 'America/Los_Angeles')+interval '7 days') AT TIME ZONE 'America/Los_Angeles'),a.club_id)
 FROM public.agents a JOIN public.union_clubs u ON u.club_id=a.club_id AND u.union_id=p_union_id
 LEFT JOIN public.profiles p ON p.id=a.user_id LEFT JOIN public.clubs c ON c.id=a.club_id
 WHERE a.status='active' ORDER BY p.username NULLS LAST,a.club_id;
END $function$;
REVOKE ALL ON FUNCTION public.fn_agent_roster_report(uuid,timestamptz,timestamptz,uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_agent_roster_report(uuid,timestamptz,timestamptz) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_agent_weekly_statement(uuid,timestamptz,timestamptz,uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_agent_weekly_statement(uuid,timestamptz,timestamptz) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_union_weekly_agent_statements(uuid,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_agent_roster_report(uuid,timestamptz,timestamptz,uuid),public.fn_agent_roster_report(uuid,timestamptz,timestamptz),
 public.fn_agent_weekly_statement(uuid,timestamptz,timestamptz,uuid),public.fn_agent_weekly_statement(uuid,timestamptz,timestamptz),public.fn_union_weekly_agent_statements(uuid,timestamptz) TO authenticated,service_role;
COMMIT;
