"""Two clubs race one union slot through real ordinary paid entry owners."""
import re
import hashlib
from satellite_qualifier_fixture import module

def qualify_race(e,root,template,output,header,setup):
    native=module(root/'scripts/ci/test-mtt-unlimited.py','sng_horse_race_native')
    binary=native.stock_isolationtester(e.pg)
    db=e.database(template)
    # The opening is isolated, committed and disposable. No paid entry exists.
    seed=header+setup.replace('CASE WHEN survivors=2 THEN 993001 ELSE 993002 END',"CASE WHEN case_name='sng_race_a' THEN 993003 ELSE 993004 END")+"RETURN jsonb_build_object('source',source_id,'club',club); END $case$;\n"
    seed+="SELECT pg_temp.horse_plan_case('sng_race_a',2,false); SELECT pg_temp.horse_plan_case('sng_race_b',2,false);\n"
    seed+="""SET LOCAL session_replication_role=replica;
DELETE FROM public.union_clubs WHERE union_id IN('a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid,'a0000000-0000-0000-0000-000000000001'::uuid);
UPDATE public.clubs SET is_union=false WHERE id IN('a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid,'a0000000-0000-0000-0000-000000000001'::uuid);
UPDATE public.tournaments SET club_id='fade0000-0000-0000-0000-000000000001'::uuid,union_id='fade0000-0000-0000-0000-000000000001'::uuid WHERE id IN(md5('l04:sng_race_a:source')::uuid,md5('l04:sng_race_a:target')::uuid,md5('l04:sng_race_b:source')::uuid,md5('l04:sng_race_b:target')::uuid);
INSERT INTO public.clubs(id,name,is_union) VALUES('fade0000-0000-0000-0000-000000000001','Native Midway Union Board',true);
INSERT INTO public.club_wallets(id,club_id,chip_balance,period_rake_collected,period_commission_paid,period_bbj_contribution,period_started_at,lifetime_rake_collected,lifetime_commission_paid,lifetime_bbj_contribution,created_at,updated_at,insurance_balance) VALUES(gen_random_uuid(),'fade0000-0000-0000-0000-000000000001',0,0,0,0,now(),0,0,0,now(),now(),0);
INSERT INTO public.unions(id,name,owner_id,slug) VALUES('fade0000-0000-0000-0000-000000000001'::uuid,'Native Horse Race Union',md5('l04:sng_race_a:user:1')::uuid,'native-horse-race');
INSERT INTO public.union_clubs(union_id,club_id) VALUES('fade0000-0000-0000-0000-000000000001'::uuid,'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid),('fade0000-0000-0000-0000-000000000001'::uuid,'a0000000-0000-0000-0000-000000000001'::uuid);
SET LOCAL session_replication_role=origin;
INSERT INTO smarter_private.sng_horse_days VALUES('fade0000-0000-0000-0000-000000000001'::uuid,(clock_timestamp() AT TIME ZONE 'America/Chicago')::date,jsonb_build_array(
 jsonb_build_object('slot',0,'tournament_id',md5('l04:sng_race_a:source')::uuid,'due',clock_timestamp()-interval '1 minute','expires',clock_timestamp()+interval '10 minutes'),
 jsonb_build_object('slot',1,'due',clock_timestamp()-interval '3 hours','expires',clock_timestamp()-interval '2 hours'),
 jsonb_build_object('slot',2,'due',clock_timestamp()+interval '3 hours','expires',clock_timestamp()+interval '4 hours')));
INSERT INTO public.accounting_agreement_history(entity_type,entity_key,club_id,event_type,after_terms,observed_at)
SELECT 'union_clubs',uc.id::text,uc.club_id,'INSERT',public.fn_accounting_agreement_terms('union_clubs',to_jsonb(uc)),transaction_timestamp()-interval '1 day' FROM public.union_clubs uc WHERE union_id='fade0000-0000-0000-0000-000000000001';
COMMIT;
"""
    opening=output/'sng-horse-race-opening.sql';opening.write_text(seed)
    e.sql(db,file=opening,label='sng-horse-union-race-opening',seconds=90)
    def buy(case,expected,reason=""):
        return """DO $buy$ DECLARE r jsonb; BEGIN
PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',md5('l04:CASE:user:1')::uuid,'role','service_role','session_id',md5('l04:CASE:session:1')::uuid)::text,true);
BEGIN
SET LOCAL ROLE service_role;
r:=public.fn_register_horse_for_tournament(md5('l04:CASE:source')::uuid,md5('l04:CASE:user:1')::uuid,true);
RESET ROLE;
EXCEPTION WHEN SQLSTATE 'P0001' THEN
 IF SQLERRM NOT LIKE 'SNG_HORSE_ADMISSION:%' THEN RAISE; END IF;
 RESET ROLE; r:=jsonb_build_object('ok',false,'reason',SQLERRM);
END;
IF NOT EXPECTED AND coalesce(r->>'reason','') IS DISTINCT FROM 'SNG_HORSE_ADMISSION: GUARD_REASON' THEN RAISE EXCEPTION 'race did not prove requested guard: %',r; END IF;
IF coalesce((r->>'ok')::boolean,false) IS DISTINCT FROM EXPECTED THEN RAISE EXCEPTION 'race buy wrong outcome %',r; END IF;
END $buy$;""".replace('CASE',case).replace('EXPECTED','true' if expected else 'false').replace('GUARD_REASON',reason)
    spec='''setup { SELECT 1; } teardown { SELECT 1; }
session "a"
step "a_begin" { BEGIN; }
step "a_buy" { '''+buy('sng_race_a',True)+''' }
step "a_commit" { COMMIT; }
session "b"
step "b_begin" { BEGIN; }
step "b_buy" { '''+buy('sng_race_b',False,'union_day_busy')+''' }
step "b_commit" { COMMIT; }
step "b_expired_retry" { BEGIN; '''+buy('sng_race_b',False,'no_current_slot')+''' COMMIT; }
permutation "a_begin" "b_begin" "a_buy" "b_buy" "a_commit" "b_commit" "b_expired_retry"
'''
    path=output/'sng-horse-union-race.spec';path.write_text(spec)
    conn=f'host={e.socket} port={e.port} dbname={db} user=postgres'
    code,out,err=e.run('sng-horse-two-club-paid-race',[binary,conn],text=spec,seconds=75,check=False)
    if code or re.search(r'\b(ERROR|FATAL|PANIC):',out+'\n'+err):
        raise RuntimeError('SNG horse two-club actual paid race failed: '+(out+err)[-6000:])
    e.sql(db,"""DO $check$ BEGIN
IF (SELECT count(*) FROM smarter_private.sng_horse_claims WHERE union_id='fade0000-0000-0000-0000-000000000001'::uuid)<>1
 OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id IN(md5('l04:sng_race_a:source')::uuid,md5('l04:sng_race_b:source')::uuid))<>1
 OR (SELECT chip_balance FROM public.club_members WHERE user_id=md5('l04:sng_race_a:user:1')::uuid)<>281
 OR (SELECT chip_balance FROM public.club_members WHERE user_id=md5('l04:sng_race_b:user:1')::uuid)<>300
THEN RAISE EXCEPTION 'race claim/money differs'; END IF;
RAISE NOTICE 'SNG_HORSE_UNION_RACE_PASS'; END $check$;""",label='sng-horse-race-exact-money-claim')
    e.discard(db)
    return {'two_clubs_one_union_slot':True,'loser_wallet_unchanged':True,'expired_slot_not_replayed':True,'database_removed':True}
