CREATE FUNCTION test_fee_source(n int,player_n int,club_n int,credit numeric,charged_at timestamptz,game_union_n int DEFAULT 40,coordinator_n int DEFAULT 40,receipt_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$DECLARE member jsonb;agent jsonb;tiers jsonb:='[]';contract jsonb;r rake_records;BEGIN
 INSERT INTO rake_records(id,club_id,rake_amount,is_tournament,tournament_id,created_at,metadata,source)
 VALUES(u(n),CASE WHEN game_union_n IS NULL THEN u(club_n) ELSE u(30) END,credit,true,u(n+1000),charged_at,jsonb_build_object('user_id',u(player_n)),'fn_register_tournament') RETURNING * INTO r;
 member:=fn_accounting_terms_at('club_members',u(club_n)::text||':'||u(player_n)::text,charged_at);
 IF member->'terms'->>'agent_id' IS NOT NULL THEN
  agent:=fn_accounting_agent_terms_at(u(club_n),(member->'terms'->>'agent_id')::uuid,charged_at);
  tiers:=jsonb_build_array(jsonb_build_object('user_id',agent->'terms'->'user_id','depth',1,'rate',agent->'terms'->'commission_rate','agreement',agent));
 END IF;
 contract:=jsonb_build_object('player_id',u(player_n),'club_id',u(club_n),'rake_credit',credit,'membership',member,'tiers',tiers,'union_id',u(game_union_n),'coordinator_union_id',u(coordinator_n),'terms_at',charged_at);
 INSERT INTO accounting_tournament_fee_batches VALUES(r.id,r.tournament_id,fn_accounting_tournament_fee_fingerprint(r),'captured',credit);
 INSERT INTO accounting_tournament_fee_sources VALUES(COALESCE(receipt_id,u(n+5000)),r.id,r.tournament_id,u(player_n),u(club_n),u(game_union_n),u(coordinator_n),charged_at,credit,contract);
 INSERT INTO tournament_refund_entitlements VALUES(r.tournament_id,u(club_n));
END$$;
CREATE FUNCTION test_fee_recognition(n int,recognized_at timestamptz,recognition_status text DEFAULT 'recognized') RETURNS void LANGUAGE plpgsql AS $$DECLARE proof jsonb;src record;BEGIN
 proof:=fn_accounting_tournament_fee_net_plan(u(n+1000));
 SELECT * INTO src FROM accounting_tournament_fee_sources WHERE tournament_id=u(n+1000) LIMIT 1;
 INSERT INTO accounting_tournament_fee_recognitions VALUES(u(n+1000),recognized_at,recognition_status,(proof->>'net_fee')::numeric,(proof->>'union_id')::uuid,src.club_id,proof->>'source_fingerprint',proof);
 IF recognition_status<>'banked_accrual_deferred' THEN
  INSERT INTO accounting_tournament_recognized_sources SELECT s.id,s.tournament_id,recognized_at,
   CASE WHEN (proof->'active_source_ids') ? s.id::text THEN 'earned' ELSE 'refunded' END,
   CASE WHEN (proof->'active_source_ids') ? s.id::text THEN s.rake_credit ELSE 0 END
  FROM accounting_tournament_fee_sources s WHERE s.tournament_id=u(n+1000);
 END IF;
 IF (proof->>'net_fee')::numeric>0 THEN INSERT INTO tournament_rake_settlements VALUES(u(n+1000),src.club_id,(proof->>'union_id')::uuid,(proof->>'net_fee')::numeric,recognized_at);END IF;
END$$;
