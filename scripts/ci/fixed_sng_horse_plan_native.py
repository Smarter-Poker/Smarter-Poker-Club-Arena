"""Exact new guard on the existing real paid satellite registration fixture."""
import hashlib
import json
import re

MIGRATION='supabase/migrations/20261029032444_fixed_sng_satellite_horse_daily_plan.sql'
ACTIVATION='supabase/migrations/20261029034842_activate_fixed_sng_satellite_horse_paid_guard.sql'

def qualify(e,root,db,output):
    candidate=root/MIGRATION
    e.sql(db,file=candidate,label='sng-horse-exact-migration',seconds=60)
    activation=root/ACTIVATION
    _,prefix,_=e.sql(db,"SET request.jwt.claims='{\"role\":\"service_role\"}'; SELECT public.fn_sng_satellite_horse_fill_plan(gen_random_uuid());",label='sng-horse-preparation-fails-closed')
    if json.loads(prefix)['reason']!='guard_not_installed':
        raise RuntimeError('prepared RPC admitted an entry before authoritative activation')
    e.sql(db,file=activation,label='sng-horse-exact-window-activation',seconds=60)

    capture_path=root/'scripts/ci/fixtures/sng-horse-current-registration.json'
    capture=json.loads(capture_path.read_text())
    pilot_path=root/'supabase/migrations/20261017043748_lightning_pilot_assignment_blocks_new_automated_tournament_e.sql'
    pilot=pilot_path.read_text()
    players=re.search(r'CREATE (?:OR REPLACE )?FUNCTION public.fn_lightning_pilot_assignment_players\(\).*?\$players\$;',pilot,re.S).group(0)
    table=re.search(r'CREATE TABLE public.lightning_pilot_assignment \(.*?\n\);',pilot,re.S).group(0)
    funding_path=root/'scripts/ci/fixtures/sng-horse-current-funding.json'
    funding=json.loads(funding_path.read_text())
    receipts_path=root/'supabase/migrations/20260917233447_tournament_original_funding_and_obligation_receipts.sql'
    receipts=re.search(r'CREATE TABLE public.tournament_participant_funding_receipts \(.*?\n\);',receipts_path.read_text(),re.S).group(0)
    cashier_path=root/'supabase/migrations/20261015132042_cashier_sends_a_ticket_into_one_tournament.sql'
    cashier=re.search(r'CREATE TABLE public.tournament_ticket_entry_targets \(.*?\n\);',cashier_path.read_text(),re.S).group(0)
    timing_path=root/'supabase/migrations/20261028195328_horse_scheduled_mtt_purchases_begin_ten_minutes_before_start.sql'
    timing=re.search(r'CREATE OR REPLACE FUNCTION public.fn_ca_horse_mtt_purchase_window_open\(.*?\$window\$;',timing_path.read_text(),re.S).group(0)
    current='BEGIN;\n'+players+'\n'+table+'\n'+receipts+'\n'+cashier+'\n'+timing+'\n'+'\n'.join(row['definition'].rstrip().rstrip(';')+';' for row in capture['functions']+funding['functions'])+'\nCOMMIT;'
    guards=','.join("('public."+row['signature']+"','"+row['source_md5']+"')" for row in capture['functions']+funding['functions'])
    current+="DO $exact$ DECLARE r record; BEGIN FOR r IN SELECT * FROM (VALUES "+guards+")e(signature,digest) LOOP IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(r.signature)) IS DISTINCT FROM r.digest THEN RAISE EXCEPTION 'horse current owner capture differs: %',r.signature; END IF; END LOOP; END $exact$;"
    current_path=output/'sng-horse-current-owners.sql';current_path.write_text(current)
    e.sql(db,file=current_path,label='sng-horse-exact-current-service-owners',seconds=60)

    probe=(output/'fixed-sng/probe.sql').read_text()
    header=probe[:probe.index('CREATE FUNCTION pg_temp.qualifier_case')]
    scene=probe[probe.index('CREATE FUNCTION pg_temp.qualifier_case'):]
    setup=scene[:scene.index(" FOR i IN 1..6 LOOP\n  u:=md5",scene.index("PERFORM set_config('session_replication_role','origin',true);"))]
    setup=setup.replace('CREATE FUNCTION pg_temp.qualifier_case','CREATE FUNCTION pg_temp.horse_plan_case')
    setup=setup.replace('FOR i IN 1..6 LOOP','FOR i IN 1..8 LOOP')
    setup=setup.replace("club uuid:=md5('l04:'||case_name||':club')::uuid;", "club uuid:=CASE WHEN case_name='sng_race_a' THEN 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid WHEN case_name='sng_race_b' THEN 'a0000000-0000-0000-0000-000000000001'::uuid ELSE 'fade0000-0000-0000-0000-000000000001'::uuid END;")
    # Fixtures are explicit opening state; production guard/funding remains on.
    setup=setup.replace(" PERFORM set_config('session_replication_role','origin',true);", """
 INSERT INTO public.unions(id,name,owner_id,slug) VALUES(club,'Horse Plan Union',md5('l04:'||case_name||':user:1')::uuid,'horse-plan-'||case_name);
 INSERT INTO public.union_clubs(union_id,club_id) VALUES(club,club);
 UPDATE public.clubs SET is_union=true WHERE id=club;
 UPDATE public.tournaments SET union_id=club WHERE id IN(source_id,target_id);
 UPDATE public.profiles SET is_horse=true WHERE id IN(SELECT md5('l04:'||case_name||':user:'||x)::uuid FROM generate_series(1,6)x);
 PERFORM set_config('session_replication_role','origin',true);
""",1)
    tests=r'''
 -- Old direct callers cannot redraw a day inside a refused paid transaction.
 u:=md5('l04:'||case_name||':user:1')::uuid;
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 before_money:=pg_temp.qualifier_financial_state();refused:=false;
 BEGIN
  EXECUTE 'SET LOCAL ROLE service_role';
  r:=public.fn_register_horse_for_tournament(source_id,u,true);
  EXECUTE 'RESET ROLE';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN EXECUTE 'RESET ROLE'; refused:=SQLERRM='SNG_HORSE_ADMISSION: plan_not_initialized'; END;
 PERFORM pg_temp.qualifier_assert(refused AND before_money=pg_temp.qualifier_financial_state()
   AND NOT EXISTS(SELECT 1 FROM smarter_private.sng_horse_days WHERE union_id=club)
   AND NOT EXISTS(SELECT 1 FROM smarter_private.sng_horse_claims WHERE tournament_id=source_id),'unplanned old caller fails atomically without random day redraw');
 -- A plan is stable across repeated process calls and consumes no initiation.
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 r:=public.fn_sng_satellite_horse_fill_plan(source_id);
 PERFORM pg_temp.qualifier_assert((SELECT jsonb_array_length(slots) BETWEEN 3 AND 5 FROM smarter_private.sng_horse_days WHERE union_id=club),'horse day random budget 3-5');
 PERFORM pg_temp.qualifier_assert(NOT EXISTS(SELECT 1 FROM smarter_private.sng_horse_claims WHERE tournament_id=source_id),'planning never claims a paid start');
 before_money:=(SELECT slots FROM smarter_private.sng_horse_days WHERE union_id=club);
 PERFORM public.fn_sng_satellite_horse_fill_plan(source_id);
 PERFORM pg_temp.qualifier_assert(before_money=(SELECT slots FROM smarter_private.sng_horse_days WHERE union_id=club),'restart reuses persisted random slots');
 -- Deterministic current slot only inside this isolated transactional scene.
 UPDATE smarter_private.sng_horse_days SET slots=jsonb_build_array(
  jsonb_build_object('slot',0,'due',clock_timestamp()-interval '1 minute','expires',clock_timestamp()+interval '10 minutes'),
  jsonb_build_object('slot',1,'due',clock_timestamp()-interval '3 hours','expires',clock_timestamp()-interval '2 hours'),
  jsonb_build_object('slot',2,'due',clock_timestamp()+interval '3 hours','expires',clock_timestamp()+interval '4 hours')) WHERE union_id=club;
 r:=public.fn_sng_satellite_horse_fill_plan(source_id);
 PERFORM pg_temp.qualifier_assert((r->>'ok')::boolean AND (SELECT slots->0->>'tournament_id'=source_id::text FROM smarter_private.sng_horse_days WHERE union_id=club),'random current slot persists its eligible board choice before paid claim');
 -- A late failure AFTER the trigger has claimed must roll back balance AND claim.
 PERFORM set_config('native.horse_fault','on',true);
 u:=md5('l04:'||case_name||':user:1')::uuid;
 session_id:=md5('l04:'||case_name||':session:1')::uuid;
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated','session_id',session_id)::text,true);
 before_money:=pg_temp.qualifier_financial_state();
 refused:=false;
 BEGIN
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  EXECUTE 'SET LOCAL ROLE service_role';
  r:=public.fn_register_horse_for_tournament(source_id,u,true);
  EXECUTE 'RESET ROLE';
  refused:=coalesce((r->>'ok')::boolean,false)=false;
 EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; refused:=true; END;
 PERFORM set_config('native.horse_fault','off',true);
 PERFORM pg_temp.qualifier_assert(refused AND before_money=pg_temp.qualifier_financial_state()
   AND NOT EXISTS(SELECT 1 FROM smarter_private.sng_horse_claims WHERE tournament_id=source_id),'failed funded registration rolls back entire money state and first-paid claim');
 FOR i IN 1..5 LOOP
  u:=md5('l04:'||case_name||':user:'||i)::uuid;
  session_id:=md5('l04:'||case_name||':session:'||i)::uuid;
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated','session_id',session_id)::text,true);
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  EXECUTE 'SET LOCAL ROLE service_role';
  r:=public.fn_register_horse_for_tournament(source_id,u,true);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.qualifier_assert((r->>'ok')::boolean AND (r->>'cost')::numeric=19,'real service horse paid entry '||i||' result '||r::text);
 END LOOP;
 PERFORM pg_temp.qualifier_assert((SELECT count(*)=1 AND min(wait_seconds)>=120 AND max(wait_seconds)<=150
   FROM smarter_private.sng_horse_claims WHERE tournament_id=source_id),'first actual paid horse claims one random 120-150 second wait plus existing <=30-second tick');
 PERFORM pg_temp.qualifier_assert((SELECT prize_balance=85.5 AND fee_balance=9.5 AND gross_in=95 FROM public.tournament_escrow WHERE tournament_id=source_id),'five ordinary funded horses preserve fee and prize custody');
 -- At max-1, another horse cannot use the final human chair or charge chips.
 u:=md5('l04:'||case_name||':user:6')::uuid;
 session_id:=md5('l04:'||case_name||':session:6')::uuid;
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated','session_id',session_id)::text,true);
 before_money:=pg_temp.qualifier_financial_state();refused:=false;
 BEGIN
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  EXECUTE 'SET LOCAL ROLE service_role';
  r:=public.fn_register_horse_for_tournament(source_id,u,true);
  EXECUTE 'RESET ROLE';refused:=coalesce((r->>'ok')::boolean,false)=false;
 EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE';refused:=true; END;
 PERFORM pg_temp.qualifier_assert(refused AND before_money=pg_temp.qualifier_financial_state()
   AND (SELECT count(*)=1 FROM smarter_private.sng_horse_claims WHERE tournament_id=source_id),'reserved chair refusal rolls back money and never consumes another slot');
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 r:=public.fn_sng_satellite_horse_fill_plan(source_id);
 PERFORM pg_temp.qualifier_assert(r->>'target_players'='5' AND r->>'reason'='human_wait','partial field still reserves human chair');
 UPDATE smarter_private.sng_horse_claims SET first_paid_at=clock_timestamp()-interval '4 minutes' WHERE tournament_id=source_id;
 r:=public.fn_sng_satellite_horse_fill_plan(source_id);
 PERFORM pg_temp.qualifier_assert(r->>'target_players'='6','elapsed persisted wait permits final horse fill');
 -- A human may always buy the final chair, independently of horse planning.
 u:=md5('l04:'||case_name||':user:7')::uuid;
 session_id:=md5('l04:'||case_name||':session:7')::uuid;
 UPDATE smarter_private.sng_horse_claims SET first_paid_at=clock_timestamp() WHERE tournament_id=source_id;
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated','session_id',session_id)::text,true);
 EXECUTE 'SET LOCAL ROLE authenticated';
 r:=public.fn_register_for_tournament_request(source_id,md5('horse:human-final')::uuid);
 EXECUTE 'RESET ROLE';
 PERFORM pg_temp.qualifier_assert((r->>'ok')::boolean AND (SELECT count(*)=6 FROM public.tournament_players WHERE tournament_id=source_id),'human final chair bypasses no financial rules and has no wait gate');
 -- Pre-policy paid boards are a structural historical opening, never replayed.
 -- Their real first-paid roster identities count, but their promises finish.
 PERFORM set_config('session_replication_role','replica',true);
 FOR i IN 1..6 LOOP
   INSERT INTO public.tournaments SELECT (jsonb_populate_record(NULL::public.tournaments,
     to_jsonb(t)||jsonb_build_object('id',md5('horse:legacy:'||i)::uuid,'name','Native Historical Horse '||i,'current_players',CASE WHEN i<=5 THEN 1 ELSE 0 END))).*
     FROM public.tournaments t WHERE id=source_id;
   IF i<=5 THEN
    INSERT INTO public.tournament_players SELECT (jsonb_populate_record(NULL::public.tournament_players,
      to_jsonb(tp)||jsonb_build_object('id',md5('horse:legacy:roster:'||i)::uuid,'tournament_id',md5('horse:legacy:'||i)::uuid))).*
      FROM public.tournament_players tp WHERE tournament_id=source_id AND user_id=md5('l04:'||case_name||':user:1')::uuid;
   END IF;
 END LOOP;
 PERFORM set_config('session_replication_role','origin',true);
 DELETE FROM smarter_private.sng_horse_claims WHERE union_id=club;
 DELETE FROM smarter_private.sng_horse_days WHERE union_id=club;
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 r:=public.fn_sng_satellite_horse_fill_plan(md5('horse:legacy:6')::uuid);
 PERFORM pg_temp.qualifier_assert(r->>'reason'='daily_budget' AND (SELECT count(*)=6 FROM smarter_private.sng_horse_claims WHERE union_id=club),'prior paid boards count before any new initiation, no install-day reset');
 r:=public.fn_sng_satellite_horse_fill_plan(source_id);
 PERFORM pg_temp.qualifier_assert((r->>'ok')::boolean AND r->>'target_players'='6','existing paid board finishes independently of exhausted daily budget');
 PERFORM pg_temp.qualifier_assert(has_function_privilege('service_role','public.fn_sng_satellite_horse_fill_plan(uuid)','EXECUTE') AND NOT has_function_privilege('authenticated','public.fn_sng_satellite_horse_fill_plan(uuid)','EXECUTE') AND NOT has_function_privilege('anon','public.fn_sng_satellite_horse_fill_plan(uuid)','EXECUTE'),'plan RPC is service only');
 RETURN jsonb_build_object('source',source_id,'club',club);
END $case$;
CREATE FUNCTION pg_temp.horse_after_claim_fault() RETURNS trigger LANGUAGE plpgsql AS $fault$
BEGIN
 IF current_setting('native.horse_fault',true)='on' THEN
  PERFORM pg_temp.qualifier_assert(EXISTS(SELECT 1 FROM smarter_private.sng_horse_claims WHERE tournament_id=NEW.tournament_id),'fault injection occurs AFTER first paid claim in ordinary funding transaction');
  RAISE EXCEPTION 'native after paid claim fault';
 END IF;
 RETURN NEW;
END $fault$;
CREATE TRIGGER native_horse_fault AFTER INSERT ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION pg_temp.horse_after_claim_fault();
SELECT pg_temp.horse_plan_case('horse_plan',2,false);
-- Range union means overlapping thaw receipts cannot double-credit the wait.
DO $pause$
DECLARE first_at timestamptz:=clock_timestamp()-interval '10 minutes'; deadline timestamptz;
BEGIN
 PERFORM set_config('session_replication_role','replica',true);
 INSERT INTO public.engine_maintenance_thaws(freeze_started_at,frozen_seconds,shifted,thawed_by,announced_at,ownership_token,contract_version,release_target_at,release_generation)
 VALUES(first_at+interval '30 seconds',60,'{"complete":true}','native-sng',first_at+interval '30 seconds',gen_random_uuid(),3,first_at+interval '90 seconds',1),
 (first_at+interval '60 seconds',60,'{"complete":true}','native-sng',first_at+interval '60 seconds',gen_random_uuid(),3,first_at+interval '120 seconds',1),
 (first_at+interval '8 minutes',30,'{"complete":true}','native-sng',first_at+interval '8 minutes',gen_random_uuid(),3,first_at+interval '8 minutes 30 seconds',1);
 PERFORM set_config('session_replication_role','origin',true);
 deadline:=smarter_private.sng_horse_wait_until(first_at,150);
 PERFORM pg_temp.qualifier_assert(deadline=first_at+interval '270 seconds','paused wait clips and merges thaw intervals; late freeze does not reopen expired wait');
END $pause$;
SELECT 'SNG_HORSE_PLAN_NATIVE_PASS';
ROLLBACK;
'''
    path=output/'sng-horse-paid-plan.sql'
    path.write_text(header+setup+tests)
    before=e.snapshot(db,'sng-horse-before-data'); catalog=e.catalog_snapshot(db,'sng-horse-before-catalog')
    code,out,err=e.sql(db,file=path,label='sng-horse-actual-paid-plan',seconds=180,check=False)
    (output/'sng-horse-paid.stdout').write_text(out);(output/'sng-horse-paid.stderr').write_text(err)
    if code or 'SNG_HORSE_PLAN_NATIVE_PASS' not in out or 'fault injection occurs AFTER first paid claim' not in err:
        raise RuntimeError('SNG horse paid guard proof failed: '+err[-6000:])
    if before!=e.snapshot(db,'sng-horse-after-data') or catalog!=e.catalog_snapshot(db,'sng-horse-after-catalog'):
        raise RuntimeError('SNG horse proof did not roll back catalog/data')
    e.report['fixed_sng_horse_plan']={'prep_guard_not_installed':True,'exact_window_activation':True,'actual_paid_registration':True,'atomic_money_claim_rollback':True,
      'assertions':len(re.findall('NOTICE:  QUALIFIER PASS:',err)),'data_catalog_rollback':True}
    from fixed_sng_horse_plan_race import qualify_race
    e.report['fixed_sng_horse_plan']['race']=qualify_race(e,root,db,output,header,setup)
    return {str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [candidate,activation,root/'scripts/ci/fixed_sng_horse_plan_native.py',root/'scripts/ci/fixed_sng_horse_plan_race.py',capture_path,pilot_path,funding_path,receipts_path,cashier_path,timing_path]}
