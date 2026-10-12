DO $$
DECLARE uid uuid := '00000000-0000-0000-0000-000000000001'; result jsonb;
BEGIN
 IF fn_award_vip_credit(uid,20,'rake',gen_random_uuid(),'test') <> 0 THEN RAISE EXCEPTION 'award not retired'; END IF;
 IF fn_award_vip_credit(uid,20,'tournament_rake',gen_random_uuid(),'Tournament rake generated') <> 0 THEN RAISE EXCEPTION 'tournament award not retired'; END IF;
 IF fn_award_vip_credit(uid,0.0001,'tournament_rake',gen_random_uuid(),'fractional tournament credit') <> 0 THEN RAISE EXCEPTION 'fractional carry created'; END IF;
 INSERT INTO rake_records VALUES(gen_random_uuid(),20,false,NULL,jsonb_build_object(uid,20),'DEALT_EQUAL');
 IF fn_redeem_vip_points(1,'test','avatar')->>'error' <> 'vip_points_retired' THEN RAISE EXCEPTION 'redemption not retired'; END IF;
 IF EXISTS(SELECT 1 FROM vip_reward_catalog WHERE is_active) THEN RAISE EXCEPTION 'catalog active'; END IF;
 IF EXISTS(SELECT 1 FROM lucky_wheel_segments WHERE active AND reward_type='vip_points') THEN RAISE EXCEPTION 'point wheel active'; END IF;
 result := claim_lucky_wheel_spin(uid);
 IF result->>'rewardType' <> 'diamonds' THEN RAISE EXCEPTION 'wheel failed non-points reward'; END IF;
 BEGIN UPDATE vip_reward_catalog SET is_active=true; RAISE EXCEPTION 'catalog reactivation succeeded'; EXCEPTION WHEN SQLSTATE 'P0403' THEN NULL; END;
 -- Bypass attempt through the old writer setting must fail.
 PERFORM set_config('app.vip_points_writer','fn_award_vip_credit',true);
 BEGIN UPDATE vip_points SET current_points=current_points+1 WHERE user_id=uid; RAISE EXCEPTION 'balance bypass succeeded'; EXCEPTION WHEN SQLSTATE 'P0403' THEN NULL; END;
 BEGIN INSERT INTO vip_points_carry VALUES(gen_random_uuid(),1,now()); RAISE EXCEPTION 'carry write succeeded'; EXCEPTION WHEN SQLSTATE 'P0403' THEN NULL; END;
 BEGIN INSERT INTO vip_points_ledger(user_id,points) VALUES(uid,1); RAISE EXCEPTION 'ledger insert succeeded'; EXCEPTION WHEN SQLSTATE 'P0403' THEN NULL; END;
 BEGIN INSERT INTO vip_reward_claims VALUES(uid,'avatar',1,'granted'); RAISE EXCEPTION 'claim succeeded'; EXCEPTION WHEN SQLSTATE 'P0403' THEN NULL; END;
 IF NOT EXISTS(SELECT 1 FROM preserved_snapshot WHERE balances IS NOT DISTINCT FROM (SELECT jsonb_agg(to_jsonb(v)) FROM vip_points v) AND ledger IS NOT DISTINCT FROM (SELECT jsonb_agg(to_jsonb(v)) FROM vip_points_ledger v) AND carry IS NOT DISTINCT FROM (SELECT jsonb_agg(to_jsonb(v)) FROM vip_points_carry v)) THEN RAISE EXCEPTION 'historical balances/carry/ledger mutated'; END IF;
END $$;
SELECT 'PASS VIP earning/redemption retired, cash rake insert succeeds, Diamonds wheel preserved, writer bypass rejected, audit history unchanged' AS result;

DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_proc WHERE oid IN ('fn_award_vip_credit(uuid,numeric,text,uuid,text)'::regprocedure,'fn_award_vip_points_from_rake()'::regprocedure,'fn_redeem_vip_points(bigint,text,text)'::regprocedure,'fn_vip_points_move_only_with_a_leg()'::regprocedure,'claim_lucky_wheel_spin(uuid)'::regprocedure) AND (NOT prosecdef OR pg_get_userbyid(proowner)<>'postgres' OR proacl::text IS DISTINCT FROM CASE WHEN proname='fn_redeem_vip_points' THEN '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' ELSE '{postgres=X/postgres,service_role=X/postgres}' END)) THEN RAISE EXCEPTION 'owner/ACL/security definer changed'; END IF;
END $$;
SELECT oid::regprocedure::text signature,md5(pg_get_functiondef(oid)) definition_md5,md5(prosrc) body_md5,proacl FROM pg_proc WHERE oid IN ('fn_award_vip_credit(uuid,numeric,text,uuid,text)'::regprocedure,'fn_award_vip_points_from_rake()'::regprocedure,'fn_redeem_vip_points(bigint,text,text)'::regprocedure,'fn_vip_points_move_only_with_a_leg()'::regprocedure,'claim_lucky_wheel_spin(uuid)'::regprocedure) ORDER BY 1;
