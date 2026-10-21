CREATE TRIGGER agreement_guard BEFORE INSERT OR UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION fn_guard_agent_agreement();
INSERT INTO clubs VALUES(u(10),u(1));
INSERT INTO profiles(id) SELECT u(n) FROM generate_series(1,6)n;
INSERT INTO club_members(club_id,user_id,role,status,agent_id) VALUES
 (u(10),u(1),'owner','active',NULL),(u(10),u(2),'agent','active',u(1)),
 (u(10),u(3),'player','active',u(2)),(u(10),u(4),'player','active',NULL),
 (u(10),u(5),'sub_agent','active',u(2)),(u(10),u(6),'player','active',u(5));
INSERT INTO agents(id,club_id,user_id,role,status,parent_agent_id,commission_rate,player_rakeback_rate) VALUES
 (u(12),u(10),u(2),'agent','active',NULL,.6,.2),
 (u(15),u(10),u(5),'sub_agent','active',u(12),.4,.1);
SELECT set_config('test.uid',u(2)::text,false);
SELECT assert_true((fn_member_rakeback_terms(u(10),u(3),'player')->>'rate')::numeric=.2,'Read Existing Player Offer');
SELECT assert_true((fn_member_rakeback_terms(u(10),u(3),'player',.3,.2)->>'success')::boolean,'Assign Individual Player Rate');
SELECT assert_true(fn_player_rakeback_rate(u(3),u(10),0)=.3,'Pricing Reads Saved Individual Rate');
SELECT assert_true((fn_member_rakeback_terms(u(10),u(3),'player',.25,.2)->>'success')::boolean=false,'Reject Stale Editor');
SELECT assert_true((fn_member_rakeback_terms(u(10),u(3),'player',.6,.3)->>'success')::boolean=false,'Enforce Actual Upline Cap');
SELECT assert_true((fn_member_rakeback_terms(u(10),u(3),'player',0,.3)->>'success')::boolean,'Assign Explicit Zero');
SELECT assert_true(fn_player_rakeback_rate(u(3),u(10),10000)=0,'Explicit Zero Never Inherits Player Offer Or Volume Ladder');
SELECT assert_true((fn_accounting_agreement_terms('club_members',(SELECT to_jsonb(m) FROM club_members m WHERE user_id=u(3)))->>'player_rakeback_explicit')::boolean,'Historical Terms Preserve Explicit Zero');
SELECT assert_true((fn_member_rakeback_terms(u(10),u(3),'agent',.3,0)->>'success')::boolean=false,'Refuse Stale Role');
SELECT assert_true((fn_member_rakeback_terms(u(10),u(4),'player',.2,.05)->>'success')::boolean=false,'Refuse Outside Downline');
SELECT assert_true((fn_member_rakeback_terms(u(10),u(2),'agent',.7,.6)->>'success')::boolean=false,'Refuse Self Editing');
SELECT assert_true((fn_member_rakeback_terms(u(10),u(3),'player','NaN',0)->>'success')::boolean=false,'Refuse Nonfinite Rate');
SELECT assert_true((fn_member_rakeback_terms(u(10),u(3),'player',-.1,0)->>'success')::boolean=false,'Refuse Negative Rate');
SELECT set_config('test.uid',u(5)::text,false);
SELECT assert_true((fn_member_rakeback_terms(u(10),u(6),'player',.15,.1)->>'success')::boolean,'Sub Agent Edits Their Player');
SELECT set_config('test.uid',u(1)::text,false);
SELECT assert_true((fn_member_rakeback_terms(u(10),u(2),'agent',.55,.6)->>'success')::boolean,'Edit Agent Without Role Change');
SELECT assert_true((SELECT role='agent' AND commission_rate=.55 FROM agents WHERE id=u(12)),'Agent Role Preserved');
SELECT assert_true((fn_member_rakeback_terms(u(10),u(2),'agent',.3,.55)->>'success')::boolean=false,'Existing Child Agreement Protected');
SELECT set_config('test.uid',u(4)::text,false);
SELECT assert_true((fn_member_rakeback_terms(u(10),u(3),'player')->>'success')::boolean=false,'Player Cannot Read Private Terms');
SELECT assert_true(NOT has_function_privilege('anon','public.fn_member_rakeback_terms(uuid,uuid,text,numeric,numeric)','EXECUTE'),'Anonymous Access Revoked');
SELECT assert_true((SELECT count(*)=4 FROM audit_trail WHERE action='set_member_rakeback'),'Only Accepted Edits Are Audited');
