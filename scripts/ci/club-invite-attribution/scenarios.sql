\set ON_ERROR_STOP 1
-- Fixture
INSERT INTO auth.users SELECT unnest(ARRAY[
 '00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000b','00000000-0000-0000-0000-00000000000c',
 '00000000-0000-0000-0000-00000000000d','00000000-0000-0000-0000-00000000000e','00000000-0000-0000-0000-00000000000f',
 '00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000012',
 '00000000-0000-0000-0000-000000000013','00000000-0000-0000-0000-000000000014']::uuid[]);
-- a owner, b agent, c player under b, d newbie, e selfdevice, f samephone, 10 kingfish, 11 danimal, 12 departed, 13 newbie2, 14 old account
INSERT INTO profiles(id,username,player_number,phone,phone_verified,created_at) VALUES
 ('00000000-0000-0000-0000-00000000000a','owner','100','+13125550100',true, now()-interval '400 days'),
 ('00000000-0000-0000-0000-00000000000b','agentb','200','+13125550200',true, now()-interval '400 days'),
 ('00000000-0000-0000-0000-00000000000c','playerc','300','312-555-0300',true, now()-interval '400 days'),
 ('00000000-0000-0000-0000-00000000000d','newbie',  '400',NULL,false, now()),
 ('00000000-0000-0000-0000-00000000000e','selfdev', '500',NULL,false, now()),
 ('00000000-0000-0000-0000-00000000000f','samephone','600',NULL,false, now()),
 ('00000000-0000-0000-0000-000000000010','kingfish','1','+13125551111',true, now()-interval '400 days'),
 ('00000000-0000-0000-0000-000000000011','danimal','2',NULL,false, now()),
 ('00000000-0000-0000-0000-000000000012','departed','700',NULL,true, now()-interval '400 days'),
 ('00000000-0000-0000-0000-000000000013','newbie2','800',NULL,false, now()),
 ('00000000-0000-0000-0000-000000000014','oldacct','900',NULL,false, now()-interval '60 days');
INSERT INTO anti_cheat_exemptions VALUES
 ('00000000-0000-0000-0000-000000000010','multi_account','KingFish'),('00000000-0000-0000-0000-000000000011','multi_account','Danimal');
INSERT INTO clubs(id,club_id,slug,name,member_count,owner_id) VALUES
 ('11111111-1111-1111-1111-111111111111',77777,'jaqk','Club JAQK',3,'00000000-0000-0000-0000-00000000000a');
INSERT INTO club_members(club_id,user_id,role,status,agent_id) VALUES
 ('11111111-1111-1111-1111-111111111111','00000000-0000-0000-0000-00000000000a','owner','active',NULL),
 ('11111111-1111-1111-1111-111111111111','00000000-0000-0000-0000-00000000000b','agent','active',NULL),
 ('11111111-1111-1111-1111-111111111111','00000000-0000-0000-0000-00000000000c','player','approved','00000000-0000-0000-0000-00000000000b'),
 ('11111111-1111-1111-1111-111111111111','00000000-0000-0000-0000-000000000010','player','active',NULL),
 ('11111111-1111-1111-1111-111111111111','00000000-0000-0000-0000-000000000012','player','left',NULL);
INSERT INTO agents(club_id,user_id,status) VALUES ('11111111-1111-1111-1111-111111111111','00000000-0000-0000-0000-00000000000b','active');

CREATE TEMP TABLE r(k text, v jsonb);
CREATE FUNCTION pg_temp.as_user(u text) RETURNS void LANGUAGE sql AS $$ SELECT set_config('request.jwt.claim.sub', u, false) $$;
CREATE FUNCTION pg_temp.ok(cond boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; END IF; RAISE NOTICE 'PASS: %', label; END $$;

-- 1. player c creates link (device dev-c); repeat is stable
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
INSERT INTO r SELECT 'c_link', fn_club_invite_link('11111111-1111-1111-1111-111111111111','dev-c');
INSERT INTO r SELECT 'c_link2', fn_club_invite_link('11111111-1111-1111-1111-111111111111');
SELECT pg_temp.ok((SELECT v->>'code' FROM r WHERE k='c_link') = (SELECT v->>'code' FROM r WHERE k='c_link2'), 'link is stable per inviter');
SELECT pg_temp.ok((SELECT v->>'join_path' FROM r WHERE k='c_link') LIKE '/hub/club-arena/invite/11111111-1111-1111-1111-111111111111?ref=300&i=%', 'join path carries player number and code');
-- non-member cannot create
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
SELECT pg_temp.ok((fn_club_invite_link('11111111-1111-1111-1111-111111111111'))->>'code' = 'not_a_member', 'non-member cannot create a link');

-- 2. anonymous resolve counts a click
SELECT pg_temp.as_user('');
INSERT INTO r SELECT 'resolve', fn_club_invite_resolve((SELECT v->>'code' FROM r WHERE k='c_link'));
SELECT pg_temp.ok((SELECT (v->>'found')::boolean AND v->'inviter'->>'alias'='playerc' AND (v->'club'->>'players_playing')::int=7 FROM r WHERE k='resolve'), 'resolve returns inviter alias and live count');
SELECT pg_temp.ok((SELECT click_count FROM club_invite_links WHERE inviter_id='00000000-0000-0000-0000-00000000000c') = 1, 'click counted');
SELECT pg_temp.ok((fn_club_invite_resolve('BADCODE1'))->>'found' = 'false', 'bad code not found');

-- 3. newbie d claims c's link
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
INSERT INTO r SELECT 'd_claim', fn_club_invite_claim((SELECT v->>'code' FROM r WHERE k='c_link'),'dev-d', now()-interval '5 minutes');
SELECT pg_temp.ok((SELECT v->>'status'='signed_up' AND (v->>'fresh_signup')::boolean FROM r WHERE k='d_claim'), 'fresh signup claimed');
SELECT pg_temp.ok(EXISTS(SELECT 1 FROM referrals WHERE referee_id='00000000-0000-0000-0000-00000000000d' AND referrer_id='00000000-0000-0000-0000-00000000000c' AND status='pending'), 'platform referral recorded');
SELECT pg_temp.ok((SELECT referred_by FROM profiles WHERE id='00000000-0000-0000-0000-00000000000d')='00000000-0000-0000-0000-00000000000c', 'referred_by set');
SELECT pg_temp.ok(EXISTS(SELECT 1 FROM notifications WHERE user_id='00000000-0000-0000-0000-00000000000c' AND type='club_invite_signup'), 'inviter notified of signup');

-- 4. first link wins: d opens agent b's link later
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
INSERT INTO r SELECT 'b_link', fn_club_invite_link('11111111-1111-1111-1111-111111111111','dev-b');
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000d');
INSERT INTO r SELECT 'd_claim2', fn_club_invite_claim((SELECT v->>'code' FROM r WHERE k='b_link'),'dev-d', now());
SELECT pg_temp.ok((SELECT (v->>'first_wins')::boolean FROM r WHERE k='d_claim2'), 'second link reports first-wins');
SELECT pg_temp.ok((SELECT inviter_id FROM club_invite_attributions WHERE user_id='00000000-0000-0000-0000-00000000000d')='00000000-0000-0000-0000-00000000000c', 'first inviter kept');

-- 5. pending before verify
SELECT pg_temp.ok((fn_club_invite_pending())->>'pending' = 'true', 'pending invite visible before verification');

-- 6. phone verification credits
UPDATE profiles SET phone='+1 773 555 0999', phone_verified=true WHERE id='00000000-0000-0000-0000-00000000000d';
SELECT pg_temp.ok((SELECT status FROM club_invite_attributions WHERE user_id='00000000-0000-0000-0000-00000000000d')='verified', 'verified after phone');
SELECT pg_temp.ok((SELECT status FROM referrals WHERE referee_id='00000000-0000-0000-0000-00000000000d')='completed', 'referral completed after phone');
SELECT pg_temp.ok(EXISTS(SELECT 1 FROM notifications WHERE user_id='00000000-0000-0000-0000-00000000000c' AND type='club_invite_verified'), 'inviter notified of verification');

-- 7. join via a different ?ref -> first inviter c, placed under c's agent b, admitted
INSERT INTO club_members(club_id,user_id,status) VALUES ('11111111-1111-1111-1111-111111111111','00000000-0000-0000-0000-00000000000d','pending');
INSERT INTO r SELECT 'd_redeem', fn_redeem_club_invite_code('11111111-1111-1111-1111-111111111111','00000000-0000-0000-0000-00000000000d','200');
SELECT pg_temp.ok((SELECT v->>'inviter_id' FROM r WHERE k='d_redeem')='00000000-0000-0000-0000-00000000000c', 'redeem uses first-wins inviter');
SELECT pg_temp.ok((SELECT agent_id='00000000-0000-0000-0000-00000000000b' AND invited_by='00000000-0000-0000-0000-00000000000c' AND status='active' FROM club_members WHERE user_id='00000000-0000-0000-0000-00000000000d'), 'placed in downline and admitted');
SELECT pg_temp.ok((SELECT status FROM club_invite_attributions WHERE user_id='00000000-0000-0000-0000-00000000000d')='joined', 'attribution joined');
SELECT pg_temp.ok(EXISTS(SELECT 1 FROM notifications WHERE user_id='00000000-0000-0000-0000-00000000000c' AND type='club_invite_joined'), 'inviter notified of join');
SELECT pg_temp.ok((SELECT total_players FROM agents WHERE user_id='00000000-0000-0000-0000-00000000000b')=2, 'agent counts re-derived');
SELECT pg_temp.ok((fn_club_invite_pending())->>'pending' = 'false', 'pending cleared after join');

-- 8. same device self-referral blocked, never admits
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000e');
INSERT INTO r SELECT 'e_claim', fn_club_invite_claim((SELECT v->>'code' FROM r WHERE k='c_link'),'dev-c', now());
SELECT pg_temp.ok((SELECT v->>'status' FROM r WHERE k='e_claim')='blocked', 'same device blocked');
SELECT pg_temp.ok(NOT EXISTS(SELECT 1 FROM referrals WHERE referee_id='00000000-0000-0000-0000-00000000000e'), 'blocked earns no referral');
INSERT INTO club_members(club_id,user_id,status) VALUES ('11111111-1111-1111-1111-111111111111','00000000-0000-0000-0000-00000000000e','pending');
INSERT INTO r SELECT 'e_redeem', fn_redeem_club_invite_code('11111111-1111-1111-1111-111111111111','00000000-0000-0000-0000-00000000000e','300');
SELECT pg_temp.ok((SELECT v->>'referral_skipped' FROM r WHERE k='e_redeem')='same_device', 'blocked redeem skipped');
SELECT pg_temp.ok((SELECT status='pending' AND agent_id IS NULL FROM club_members WHERE user_id='00000000-0000-0000-0000-00000000000e'), 'blocked member stays pending, unplaced');

-- 9. same phone blocked at verification
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000f');
INSERT INTO r SELECT 'f_claim', fn_club_invite_claim((SELECT v->>'code' FROM r WHERE k='c_link'),'dev-f', now());
UPDATE profiles SET phone='(312) 555-0300', phone_verified=true WHERE id='00000000-0000-0000-0000-00000000000f';
SELECT pg_temp.ok((SELECT status='blocked' AND block_reason='same_phone' FROM club_invite_attributions WHERE user_id='00000000-0000-0000-0000-00000000000f'), 'same phone blocked');
SELECT pg_temp.ok(NOT EXISTS(SELECT 1 FROM referrals WHERE referee_id='00000000-0000-0000-0000-00000000000f'), 'same phone referral removed');
SELECT pg_temp.ok((SELECT referred_by IS NULL FROM profiles WHERE id='00000000-0000-0000-0000-00000000000f'), 'same phone referred_by cleared');

-- 10. KingFish -> Danimal on the same device is exempt
SELECT pg_temp.as_user('00000000-0000-0000-0000-000000000010');
INSERT INTO r SELECT 'k_link', fn_club_invite_link('11111111-1111-1111-1111-111111111111','dev-owner');
SELECT pg_temp.as_user('00000000-0000-0000-0000-000000000011');
INSERT INTO r SELECT 'dan_claim', fn_club_invite_claim((SELECT v->>'code' FROM r WHERE k='k_link'),'dev-owner', now());
SELECT pg_temp.ok((SELECT v->>'status' FROM r WHERE k='dan_claim')='signed_up', 'beta accounts exempt from same-device block');

-- 11. departed inviter routes to owner, does not auto-admit
INSERT INTO club_invite_links(code,club_id,inviter_id) VALUES ('DEPART7','11111111-1111-1111-1111-111111111111','00000000-0000-0000-0000-000000000012');
SELECT pg_temp.as_user('00000000-0000-0000-0000-000000000013');
INSERT INTO r SELECT 'n2_claim', fn_club_invite_claim('DEPART7','dev-n2', now());
INSERT INTO club_members(club_id,user_id,status) VALUES ('11111111-1111-1111-1111-111111111111','00000000-0000-0000-0000-000000000013','pending');
INSERT INTO r SELECT 'n2_redeem', fn_redeem_club_invite_code('11111111-1111-1111-1111-111111111111','00000000-0000-0000-0000-000000000013','700');
SELECT pg_temp.ok((SELECT (v->>'success')::boolean AND (v->>'routed_to_owner')::boolean FROM r WHERE k='n2_redeem'), 'departed inviter no longer fails the join');
SELECT pg_temp.ok((SELECT status='pending' AND agent_id IS NULL AND invited_by='00000000-0000-0000-0000-000000000012' FROM club_members WHERE user_id='00000000-0000-0000-0000-000000000013'), 'routed to owner, awaits approval');

-- 12. expiry
SELECT pg_temp.as_user('00000000-0000-0000-0000-000000000014');
SELECT pg_temp.ok((fn_club_invite_claim((SELECT v->>'code' FROM r WHERE k='b_link'),NULL, now()-interval '31 days'))->>'code'='expired', 'expired after 30 days');

-- 13. old account: placed, not platform-credited
INSERT INTO r SELECT 'old_claim', fn_club_invite_claim((SELECT v->>'code' FROM r WHERE k='b_link'),'dev-old', now());
SELECT pg_temp.ok((SELECT NOT (v->>'fresh_signup')::boolean FROM r WHERE k='old_claim'), 'existing account is not a fresh signup');
SELECT pg_temp.ok(NOT EXISTS(SELECT 1 FROM referrals WHERE referee_id='00000000-0000-0000-0000-000000000014'), 'existing account earns no platform referral');

-- 14. a legacy ?ref= join with no claimed code is still recorded and credited
INSERT INTO club_members(club_id,user_id,status) VALUES ('11111111-1111-1111-1111-111111111111','00000000-0000-0000-0000-000000000014','pending');
DELETE FROM club_invite_attributions WHERE user_id='00000000-0000-0000-0000-000000000014';
INSERT INTO r SELECT 'old_redeem', fn_redeem_club_invite_code('11111111-1111-1111-1111-111111111111','00000000-0000-0000-0000-000000000014','300');
SELECT pg_temp.ok((SELECT status='joined' AND inviter_id='00000000-0000-0000-0000-00000000000c' FROM club_invite_attributions WHERE user_id='00000000-0000-0000-0000-000000000014'), 'legacy ?ref join recorded against the inviter');
SELECT pg_temp.ok((SELECT agent_id='00000000-0000-0000-0000-00000000000b' AND status='active' FROM club_members WHERE user_id='00000000-0000-0000-0000-000000000014'), 'legacy ?ref join placed under the inviter''s agent');

-- 15. stats
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
INSERT INTO r SELECT 'c_stats', fn_club_invite_my_stats('11111111-1111-1111-1111-111111111111');
SELECT pg_temp.ok((SELECT (v->>'opened')::int=1 AND (v->>'signed_up')::int=1 AND (v->>'verified')::int=1 AND (v->>'joined')::int=2 FROM r WHERE k='c_stats'), 'my stats correct (one fresh join, one legacy join)');
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
INSERT INTO r SELECT 'owner_stats', fn_club_invite_club_stats('11111111-1111-1111-1111-111111111111');
SELECT pg_temp.ok((SELECT v->>'scope'='club' AND jsonb_array_length(v->'rows')>=4 FROM r WHERE k='owner_stats'), 'owner sees whole club');
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
INSERT INTO r SELECT 'agent_stats', fn_club_invite_club_stats('11111111-1111-1111-1111-111111111111');
SELECT pg_temp.ok((SELECT v->>'scope'='downline' AND EXISTS(SELECT 1 FROM jsonb_array_elements(v->'rows') e WHERE e->>'alias'='playerc') AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v->'rows') e WHERE e->>'alias'='kingfish') FROM r WHERE k='agent_stats'), 'agent sees own downline only');
SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
SELECT pg_temp.ok((fn_club_invite_club_stats('11111111-1111-1111-1111-111111111111'))->>'allowed'='false', 'plain player cannot read club stats');

SELECT v FROM r WHERE k IN ('owner_stats');
