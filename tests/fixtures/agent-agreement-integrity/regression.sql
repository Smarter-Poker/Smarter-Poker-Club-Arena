\set ON_ERROR_STOP on
SELECT assert_true(NOT EXISTS(SELECT id,commission_rate,player_rakeback_rate,credit_limit FROM agents EXCEPT SELECT * FROM original_agreements),'migration preserves every original agreement including historical conflicts');
SELECT set_config('request.jwt.claim.sub',u(11)::text,false);
SELECT assert_true(create_agent_for(70,3,200)->>'success'='false','create rejects a parent from a different club');
SELECT assert_true(create_agent_for(70,3,999)->>'success'='false','create rejects a missing parent');
SELECT assert_rejected('UPDATE agents SET parent_agent_id=u(200) WHERE id=u(101)','storage rejects cross-club parent assignment');
SELECT assert_rejected('UPDATE agents SET parent_agent_id=u(101) WHERE id=u(100)','storage rejects a two-node cycle');
SELECT assert_rejected('UPDATE agents SET parent_agent_id=id WHERE id=u(100)','storage rejects self-parent');
SELECT assert_rejected('UPDATE agents SET id=u(999) WHERE id=u(200)','storage preserves the financial account id even without children');
SELECT assert_rejected('UPDATE agents SET user_id=u(999) WHERE id=u(200)','storage preserves financial account ownership');
SELECT assert_rejected('UPDATE agents SET club_id=u(3) WHERE id=u(200)','storage preserves a childless financial accounts club identity');
SELECT assert_rejected('UPDATE agents SET club_id=u(4) WHERE id=u(100)','composite foreign key prevents moving a parent away from its children');
SELECT assert_rejected('UPDATE agents SET role=''sub_agent'' WHERE id=u(100)','parent cannot become a sub-agent while it has children');
UPDATE agents SET status='suspended' WHERE id=u(200);
SELECT set_config('request.jwt.claim.sub',u(22)::text,false);
SELECT assert_true(create_agent_for(70,4,200)->>'error'='parent agent not found','authorized owner cannot choose an inactive parent');
UPDATE agents SET status='active' WHERE id=u(200);
SELECT set_config('request.jwt.claim.sub',u(11)::text,false);

SELECT assert_rejected('SELECT fn_admin_update_agent(u(101),p_commission_rate=>.65)','admin update cannot increase commission above parent cap');
SELECT assert_rejected('SELECT fn_admin_update_agent(u(101),p_player_rakeback_rate=>.45)','admin update cannot increase rakeback above parent cap');
SELECT assert_rejected('SELECT fn_admin_update_agent(u(100),p_commission_rate=>.25)','parent commission cannot be lowered below an existing child');
SELECT assert_rejected('SELECT fn_admin_update_agent(u(100),p_player_rakeback_rate=>.15)','parent rakeback cannot be lowered below an existing child');
SELECT assert_rejected('UPDATE agents SET credit_limit=100 WHERE id=u(100)','parent credit cap cannot be lowered below an existing child');
SELECT assert_rejected('UPDATE agents SET commission_rate=.65 WHERE id=u(101)','direct table writes obey the same commission cap');
SELECT assert_rejected('UPDATE agents SET player_rakeback_rate=.45 WHERE id=u(101)','direct table writes obey the same rakeback cap');
SELECT assert_true(fn_admin_update_agent(u(151),p_status=>'frozen')->>'success'='true','non-economic edit is allowed on a historical conflict');
SELECT assert_true((SELECT commission_rate=.4 AND player_rakeback_rate=.3 FROM agents WHERE id=u(151)),'non-economic edit does not rewrite historical rates');
SELECT assert_rejected('UPDATE agents SET commission_rate=.45 WHERE id=u(151)','existing commission conflict cannot be worsened');
SELECT assert_rejected('UPDATE agents SET player_rakeback_rate=.35 WHERE id=u(151)','existing rakeback conflict cannot be worsened');
SELECT assert_rejected('UPDATE agents SET commission_rate=.25 WHERE id=u(150)','existing parent conflict cannot be worsened by lowering its cap');
SELECT assert_true(fn_admin_update_agent(u(151),p_commission_rate=>.35,p_player_rakeback_rate=>.25)->>'success'='true','historical conflicts can be reduced without forcing a new formula');
SELECT assert_true(fn_admin_update_agent(u(151),p_commission_rate=>.3,p_player_rakeback_rate=>.2)->>'success'='true','historical conflicts can be fully repaired through ordinary authorized edits');

DO $$DECLARE value numeric;BEGIN FOREACH value IN ARRAY ARRAY['NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric,-1::numeric,.001::numeric] LOOP
 PERFORM assert_true(create_agent_for(70,3,100,.2,.1,value)->>'success'='false','create rejects nonfinite, negative or subcent credit: '||value::text);
 PERFORM assert_true(fn_admin_update_agent(u(101),p_credit_limit=>value)->>'success'='false','update rejects nonfinite, negative or subcent credit: '||value::text);
END LOOP;END$$;
SELECT assert_rejected('UPDATE agents SET credit_limit=''NaN''::numeric WHERE id=u(101)','storage rejects nonfinite credit');
SELECT assert_true(fn_admin_update_agent(u(101),p_credit_limit=>123.45)->>'success'='true','finite cents remain valid');

SELECT set_config('request.jwt.claim.sub',u(33)::text,false);
SELECT assert_true(create_agent_for(70,3,100)->>'success'='false' AND fn_admin_update_agent(u(101),p_status=>'active')->>'success'='false','banned admin cannot manage agreements');
SELECT set_config('request.jwt.claim.sub',u(34)::text,false);
SELECT assert_true(create_agent_for(70,3,100)->>'success'='false' AND fn_admin_update_agent(u(101),p_status=>'active')->>'success'='false','removed co-owner cannot manage agreements');
SELECT set_config('request.jwt.claim.sub',u(22)::text,false);
SELECT assert_true(create_agent_for(70,3,100)->>'success'='false' AND fn_admin_update_agent(u(101),p_status=>'active')->>'success'='false','other-club owner cannot manage this club');
SELECT set_config('request.jwt.claim.sub','',false);
SELECT assert_true(create_agent_for(70,3,100)->>'success'='false' AND fn_admin_update_agent(u(101),p_status=>'active')->>'success'='false','missing authenticated actor is refused');
SELECT set_config('request.jwt.claim.sub',u(35)::text,false);
SELECT assert_true(fn_admin_update_agent(u(101),p_status=>'active')->>'success'='true','approved staff retain their existing authority');
SELECT set_config('request.jwt.claim.sub',u(36)::text,false);
SELECT assert_true(fn_admin_update_agent(u(101),p_status=>'active')->>'success'='true','active staff retain their existing authority');
SELECT set_config('request.jwt.claim.sub',u(11)::text,false);
SELECT assert_true(create_agent_for(70,3,100)->>'success'='true','club owner authority is preserved independently of membership status');
SELECT set_config('request.jwt.claim.sub',u(22)::text,false);
CREATE TEMP TABLE second_club_creation AS SELECT create_agent_for(70,4,200) AS result;
SELECT assert_true((SELECT result->>'success' FROM second_club_creation)='true' AND (SELECT count(DISTINCT id) FROM agents WHERE user_id=u(70))=2,'same user can create a distinct financial account in another club');
SELECT set_config('request.jwt.claim.sub',u(11)::text,false);

SELECT set_config('test.role_refusal','true',false);
CREATE TEMP TABLE snapshot_before_refusal AS SELECT (SELECT count(*) FROM agents) AS agents,(SELECT count(*) FROM role_effects) AS effects,(SELECT count(*) FROM credit_assignments) AS credits;
DO $$DECLARE r jsonb;BEGIN
 r:=create_agent_for(40,3,100);
 PERFORM assert_true(r='{"success":false,"error":"role grant refused","code":"fixture-refusal","detail":{"preserve":true}}'::jsonb,'create returns the original role-callee refusal payload');
 PERFORM assert_true((SELECT count(*) FROM agents)=(SELECT agents FROM snapshot_before_refusal) AND NOT EXISTS(SELECT 1 FROM agents WHERE user_id=u(40)),'failed create rolls back the inserted agent');
 PERFORM assert_true((SELECT role FROM club_members WHERE club_id=u(3) AND user_id=u(40))='player' AND (SELECT count(*) FROM role_effects)=(SELECT effects FROM snapshot_before_refusal),'failed create rolls back role-callee membership and audit mutations');
 r:=fn_admin_update_agent(u(101),p_role=>'sub_agent',p_credit_limit=>150);
 PERFORM assert_true(r='{"success":false,"error":"role grant refused","code":"fixture-refusal","detail":{"preserve":true}}'::jsonb,'update returns the original role-callee refusal payload');
 PERFORM assert_true((SELECT role='agent' AND credit_limit=123.45 FROM agents WHERE id=u(101)) AND (SELECT role FROM club_members WHERE club_id=u(3) AND user_id=u(41))='agent','failed update preserves agent and membership terms');
 PERFORM assert_true((SELECT count(*) FROM role_effects)=(SELECT effects FROM snapshot_before_refusal) AND (SELECT count(*) FROM credit_assignments)=(SELECT credits FROM snapshot_before_refusal),'failed update rolls back every secondary role and credit effect');
END$$;
SELECT set_config('test.role_refusal','false',false);
CREATE TEMP TABLE accepted_creation AS SELECT create_agent_for(42,3,100) AS result;
SELECT assert_true((SELECT result->>'success' FROM accepted_creation)='true' AND (SELECT role FROM club_members WHERE club_id=u(3) AND user_id=u(42))='agent','successful role assignment and agent creation commit together');
SELECT assert_true((SELECT convalidated FROM pg_constraint WHERE conname='agents_parent_in_same_club'),'same-club foreign key is validated against existing rows');
INSERT INTO agents(id,club_id,user_id,role,parent_agent_id,commission_rate,player_rakeback_rate,credit_limit) VALUES(u(201),u(4),u(61),'agent',u(200),.1,.1,100);
INSERT INTO agent_commissions VALUES(u(3),u(41),12.34,NULL,now()),(u(4),u(61),99.99,NULL,now());
SELECT set_config('request.jwt.claim.sub',u(50)::text,false);
SELECT assert_true(EXISTS(SELECT 1 FROM jsonb_array_elements(fn_agent_downline_commission(u(3)))a WHERE a->>'agent_id'=u(101)::text AND a->'unclaimed'='12.34'::jsonb)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(fn_agent_downline_commission(u(3)))a WHERE a->>'club_id'<>u(3)::text),'real downline reader scopes a multi-club agent to the selected club and ledger balance');
SELECT assert_true(EXISTS(SELECT 1 FROM jsonb_array_elements(fn_agent_downline_commission(u(4)))a WHERE a->>'agent_id'=u(201)::text AND a->'unclaimed'='99.99'::jsonb)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(fn_agent_downline_commission(u(4)))a WHERE a->>'club_id'<>u(4)::text),'real downline reader resolves the second club independently');
SELECT count(*) AS passed_assertions FROM assertions;
