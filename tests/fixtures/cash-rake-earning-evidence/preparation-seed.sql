INSERT INTO public.clubs VALUES(u(10),u(40),false),(u(20),u(40),false),(u(30),u(40),true);
INSERT INTO auth.users VALUES(u(501)),(u(502)),(u(503));
INSERT INTO public.accounting_agreement_history(entity_type,entity_key,club_id,subject_user_id,event_type,observed_at,after_terms) VALUES
 ('agents',u(901)::text,u(10),u(511),'INSERT','2026-01-01Z',jsonb_build_object('id',u(901),'club_id',u(10),'user_id',u(511),'status','active','commission_rate',0.6,'player_rakeback_rate',0.2)),
 ('club_members',u(10)::text||':'||u(501)::text,u(10),u(501),'INSERT','2026-01-01Z',jsonb_build_object('club_id',u(10),'user_id',u(501),'agent_id',u(511),'is_active',true,'status','approved','player_rakeback_pct',0.2)),
 ('club_members',u(10)::text||':'||u(502)::text,u(10),u(502),'INSERT','2026-01-01Z',jsonb_build_object('club_id',u(10),'user_id',u(502),'agent_id',NULL,'is_active',true,'status','active','player_rakeback_pct',0.1)),
 ('club_members',u(20)::text||':'||u(503)::text,u(20),u(503),'INSERT','2026-01-01Z',jsonb_build_object('club_id',u(20),'user_id',u(503),'agent_id',NULL,'is_active',true,'status','active','player_rakeback_pct',0.1));
CREATE FUNCTION test_source(n int,player_n int,club_n int,credit numeric,at_time timestamptz,deal numeric DEFAULT NULL,game_union_n int DEFAULT 40,coordinator_n int DEFAULT 40) RETURNS void LANGUAGE plpgsql AS $$
DECLARE member jsonb;tiers jsonb:='[]';agent jsonb;contract jsonb;
BEGIN
 INSERT INTO public.rake_records VALUES(u(n),u(n+1000),CASE WHEN game_union_n IS NULL THEN u(club_n) ELSE u(30) END,u(401),credit,false,NULL,at_time,'{}');
 INSERT INTO public.rake_attributions VALUES(u(n+2000),u(n),u(n+1000),u(player_n),u(club_n),credit);
 member:=fn_accounting_terms_at('club_members',u(club_n)::text||':'||u(player_n)::text,at_time);
 IF deal IS NOT NULL THEN member:=jsonb_set(member,'{terms,player_rakeback_pct}',to_jsonb(deal)); END IF;
 IF member->'terms'->>'agent_id' IS NOT NULL THEN
  agent:=fn_accounting_agent_terms_at(u(club_n),(member->'terms'->>'agent_id')::uuid,at_time);
  tiers:=jsonb_build_array(jsonb_build_object('user_id',agent->'terms'->'user_id','depth',1,'rate',agent->'terms'->'commission_rate','agreement',agent));
 END IF;
 contract:=jsonb_build_object('player_id',u(player_n),'club_id',u(club_n),'attribution_id',u(n+2000),'rake_credit',credit,'membership',member,'tiers',tiers,'union_id',u(game_union_n),'coordinator_union_id',u(coordinator_n));
 INSERT INTO public.accounting_cash_accrual_batches(rake_record_id,hand_id,earned_at,source_fingerprint,status,plan)
  VALUES(u(n),u(n+1000),at_time,'fixture source '||n,'accrued','{}');
 INSERT INTO public.accounting_cash_rake_sources(rake_record_id,player_id,club_id,union_id,coordinator_union_id,earned_at,rake_credit,contract)
  VALUES(u(n),u(player_n),u(club_n),u(game_union_n),u(coordinator_n),at_time,credit,contract);
END$$;
