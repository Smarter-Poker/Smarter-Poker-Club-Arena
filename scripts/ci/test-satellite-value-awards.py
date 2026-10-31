#!/usr/bin/env python3
"""Qualify reusable satellite awards in the existing isolated financial catalog.

No remote connection option or production write. Core settlement, receipt,
entry, escrow, custody, journal and immutable guards are actual owning SQL.
"""
from pathlib import Path
from types import SimpleNamespace
import argparse,json,os,re,sys,hashlib
sys.dont_write_bytecode=True
from satellite_qualifier_fixture import compose,module,function_sql
from satellite_value_ticket_concurrency import qualify as qualify_concurrent_consumption

def main():
 ap=argparse.ArgumentParser(description=__doc__)
 ap.add_argument('--evidence',type=Path,required=True)
 ap.add_argument('--pg-bin',type=Path,default=Path('/opt/homebrew/opt/postgresql@17/bin'))
 args=ap.parse_args();root=Path(__file__).resolve().parents[2]
 output=args.evidence.resolve();output.mkdir(parents=True,exist_ok=False)
 native=module(root/'scripts/ci/test-mtt-unlimited.py','value_ticket_existing_execution')
 authoring=module(root/'scripts/ci/mtt_break_authoring_native.py','value_ticket_authoring')
 manifest=compose(root)
 (output/'foundation.sql').write_text(manifest['sql'])
 (output/'entry-deps.sql').write_text(manifest['entry_sql'])
 catalog=native.preparation_inputs(SimpleNamespace(root=root,report=manifest))
 authoring.authoring_inputs(root)
 supplements=[]
 for f in catalog['fixtures']:
  if f['kind']=='function-successor': supplements.append({**f,'kind':'functions','presence':'exact'})
  elif f['kind']!='registry': supplements.append(f)
 (output/'supplement.sql').write_text(native.preparation_supplement_sql(root,supplements))
 local_tmp=Path(os.environ['TMPDIR']).resolve()
 e=native.Execution(root,output,args.pg_bin.resolve(),local_tmp,900,socket_parent=local_tmp)
 e.report.update(fixture_identity='satellite-same-value-entry-v1',production_mutations=False)
 try:
  e.start();db=e.database()
  for file in ['foundation.sql','entry-deps.sql','supplement.sql']:
   e.sql(db,file=output/file,label=file,seconds=180)
  for stage in catalog['stages']:
   e.sql(db,file=root/stage['migration']['path'],label='prepare-'+Path(stage['migration']['path']).stem,seconds=120)
  authoring._assert_scope(e,db,root)
  supplement=(root/authoring.FIXTURE/'catalog-supplement.sql').read_text()
  marker="DO $$ BEGIN IF to_regprocedure('public.fn_club_scope_ids(uuid)') IS NOT NULL"
  if supplement.count(marker)!=1:raise ValueError('authoring fixture scope seam changed')
  e.sql(db,supplement.partition(marker)[0]+'COMMIT;\n',label='authoring-captured-dependencies',seconds=120)
  authoring._assert_capture(e,db,root)
  e.sql(db,file=root/authoring.MIGRATION,label='existing-authoring',seconds=120)
  e.sql(db,file=root/'supabase/migrations/20260917201651_satellite_multi_qualifier_receipt_v3.sql',label='existing-cohort-v3',seconds=120)
  fixture=root/'tests/fixtures/satellite-value-awards'
  # Current reporting readers refer to these empty, source-captured columns.
  # No Spin, jackpot or historical snapshot producer is simulated here.
  columns=sum((json.loads((fixture/name).read_text()) for name in ['reporting-columns.json','jackpot-columns.json','archived-journal-columns.json']),[])
  tables={}
  for col in columns:tables.setdefault(col['table_name'],[]).append('"'+col['column_name']+'" '+col['type'])
  schema='\n'.join('CREATE TABLE IF NOT EXISTS public."'+name+'" ('+','.join(cols)+');' for name,cols in tables.items())
  e.sql(db,schema,label='empty-current-reporting-projections')
  e.sql(db,"CREATE OR REPLACE FUNCTION public.fn_poker_diamond_jackpot_diamonds() RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public,pg_temp AS $function$\n  SELECT COALESCE(sum(l.amount), 0)::numeric FROM public.poker_diamond_jackpot_ledger l;\n$function$;",label='actual-unchanged-jackpot-total')
  dependencies=json.loads((fixture/'unchanged-dependencies.json').read_text())+json.loads((fixture/'ticket-routing-dependency.json').read_text())+json.loads((fixture/'entitlement-owner.json').read_text())
  (output/'current-dependencies.sql').write_text('\n'.join(r['definition'].rstrip().rstrip(';')+';' for r in dependencies))
  e.sql(db,file=output/'current-dependencies.sql',label='actual-unchanged-dependencies',seconds=120)
  owners=json.loads((fixture/'current-owners.json').read_text())+json.loads((fixture/'global-owners.json').read_text())
  for capture in dependencies+owners:
   definition=capture['definition']
   body=re.search(r'AS \$function\$(.*?)\$function\$',definition,re.S)
   if body is None: raise ValueError('captured function body delimiter changed')
   digest=capture.get('md5') or capture.get('hash') or capture.get('source_md5')
   if digest and hashlib.md5(body.group(1).encode()).hexdigest()!=digest:
    raise ValueError('captured source fingerprint differs: '+str(capture.get('name')))

  (output/'current-owners.sql').write_text('\n'.join(r['definition'].rstrip().rstrip(';')+';' for r in owners))
  e.sql(db,file=output/'current-owners.sql',label='actual-current-owners',seconds=120)
  candidate=next((root/'supabase/migrations').glob('*_satellite_fallback_awards_are_reusable_value_tickets.sql'))
  prerequisite=next((root/'supabase/migrations').glob('*_diamond_value_ticket_custody_transfers_retain_no_wallet_jour.sql'))
  # The shared historical foundation predates the house-leg CHECK expansion.
  # Reconstruct these two captured current production constraints exactly.
  constraints=json.loads((fixture/'custody-constraints.json').read_text())
  current_checks='\n'.join('ALTER TABLE public.'+r['relation']+' DROP CONSTRAINT '+r['conname']+'; ALTER TABLE public.'+r['relation']+' ADD CONSTRAINT '+r['conname']+' '+r['definition']+';' for r in constraints)
  e.sql(db,current_checks,label='actual-current-custody-checks',seconds=30)
  # Installation is guarded by actual closed play, not a generic financial
  # component label. This isolated setting is changed only by later funded cases.
  e.sql(db,"INSERT INTO public.ca_arena_settings(id,club_id,settlement_window_days,note,cash_games_enabled,tournaments_enabled) SELECT 1,id,0,'isolated closed-play installation',false,false FROM public.clubs WHERE is_platform AND asset='diamonds' ON CONFLICT(id) DO UPDATE SET cash_games_enabled=false,tournaments_enabled=false;",label='closed-play-installation-configuration')
  # CHECK grammar boundaries in a separate disposable catalog, never by
  # dropping or bypassing a constraint in the actual funded-owner scene.
  check_db=e.database()
  minimal="CREATE TABLE public.ca_arena_settings(id integer,cash_games_enabled boolean,tournaments_enabled boolean); INSERT INTO public.ca_arena_settings VALUES(1,false,false); CREATE TABLE public.poker_diamond_movements(request_id uuid,custody_id uuid,user_id uuid,action text,amount bigint,source_account text,destination_account text,wallet_journal_id uuid,request jsonb,receipt jsonb); CREATE TABLE public.poker_diamond_tournament_ledger(kind text,user_id uuid,custody_id uuid,wallet_journal_id uuid,registration_id uuid,idempotency_key text,amount bigint,prize_part bigint,bounty_part bigint,fee_part bigint,request jsonb);"
  minimal+=''.join('ALTER TABLE public.'+r['relation']+' ADD CONSTRAINT '+r['conname']+' '+r['definition']+';' for r in constraints)
  e.sql(check_db,minimal,label='custody-check-only-catalog')
  e.sql(check_db,file=prerequisite,label='custody-check-only-exact-DDL')
  e.sql(check_db,file=fixture/'custody-check-cases.sql',label='custody-check-45-boundaries')
  code,_,error=e.sql(check_db,file=prerequisite,label='custody-check-refuses-DDL-replay',check=False)
  if code==0 or 'VALUE_TICKET_CONSTRAINT_PREIMAGE_CHANGED' not in error:raise ValueError('exact custody CHECK DDL replay was not refused')
  for column in ['cash_games_enabled','tournaments_enabled']:
   e.sql(check_db,'UPDATE public.ca_arena_settings SET '+column+'=true;',label='open-play-installation-'+column)
   code,_,error=e.sql(check_db,file=prerequisite,label='open-play-DDL-refused-'+column,check=False)
   if code==0 or 'VALUE_TICKET_DDL_REQUIRES_CLOSED_DIAMOND_PLAY' not in error:raise ValueError('open Diamond play was not refused before DDL')
   e.sql(check_db,'UPDATE public.ca_arena_settings SET '+column+'=false;',label='restore-isolated-closed-'+column)
  e.sql(check_db,'DELETE FROM public.ca_arena_settings;',label='missing-play-configuration')
  code,_,error=e.sql(check_db,file=prerequisite,label='missing-play-DDL-refused',check=False)
  if code==0 or 'VALUE_TICKET_DDL_REQUIRES_CLOSED_DIAMOND_PLAY' not in error:raise ValueError('missing play configuration was not refused')
  e.discard(check_db)
  e.sql(db,file=prerequisite,label='exact-custody-check-prerequisite',seconds=30)
  # The native route records exact prerequisite installation, like the real
  # applier; the candidate refuses absent or changed CHECK postimages.
  e.sql(db,"CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations(version text PRIMARY KEY,name text); INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES('20261031075352','diamond_value_ticket_custody_transfers_retain_no_wallet_jour');",label='prerequisite-installation-history')
  guard=json.loads((fixture/'guard-declaration.json').read_text())
  tables={}
  for col in guard['columns']:
   tables.setdefault(col['relname'],[]).append('"'+col['attname']+'" '+col['type']+(' NOT NULL' if col['attnotnull'] else '')+(' DEFAULT '+col['default_expression'] if col['default_expression'] else ''))
  guard_sql="CREATE SEQUENCE IF NOT EXISTS public.ca_guard_def_history_id_seq;\n"+'\n'.join('CREATE TABLE IF NOT EXISTS public.'+name+' ('+','.join(cols)+');' for name,cols in tables.items())
  guard_sql+='\n'.join('ALTER TABLE public.'+r['relation']+' ADD CONSTRAINT '+r['conname']+' '+r['definition']+';' for r in guard['constraints'])
  guard_sql+='\n'.join(r['definition'].rstrip().rstrip(';')+';' for r in json.loads((fixture/'guard-declaration-indexes.json').read_text()))
  guard_sql+='\n'.join(r['definition'].rstrip().rstrip(';')+';' for r in guard['functions'])
  e.sql(db,guard_sql,label='actual-guard-declaration-catalog')
  e.sql(db,file=candidate,label='exact-value-ticket-candidate',seconds=120)
  expected=json.loads((fixture/'postimages.json').read_text())
  for name,digest in expected.items():
   _,out,_=e.sql(db,"SELECT md5(prosrc) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='"+name+"';",label='postimage-'+name)
   if out.strip()!=digest: raise ValueError('postimage differs: '+name)
  e.report['candidate_sha256']=hashlib.sha256(candidate.read_bytes()).hexdigest()
  e.report['postimages_verified']=len(expected)
  e.sql(db,file=root/'scripts/ci/probes/atomic-terminal-rehearsal-fixture.sql',label='owned-structural-opening',seconds=60)
  # The source-bound scenes below exercise actual funded settlement and use.
  scene=fixture/'native-cases.sql'
  if not scene.exists(): raise ValueError('native funded cases are required')
  seed=(root/'scripts/ci/probes/satellite-qualifiers-native.sql').read_text()
  seed=seed[:seed.index("SELECT 'SATELLITE_QUALIFIER_NATIVE_EVIDENCE='")]
  seed=seed.replace("clock_timestamp()+interval '1 hour','REGISTERING'","clock_timestamp()+interval '5 minutes','REGISTERING'")
  # Reuse the actual four paid-entry/final-hand opening; the new scene makes
  # its own assertions instead of the original direct-seat-only assertions.
  composed=output/'funded-cases.sql'
  diamond_seed=seed[seed.index('CREATE FUNCTION pg_temp.qualifier_case'):]
  diamond_seed=diamond_seed.replace('pg_temp.qualifier_case(', 'pg_temp.qualifier_diamond_case(').replace('26.25','27').replace('105','108').replace('993001','993003').replace('993002','993004').replace('1000000+survivors','2000000+survivors').replace('5 bubble','8 bubble')
  diamond_seed=diamond_seed.replace("INSERT INTO public.clubs(id,club_id,name) VALUES(club,CASE WHEN survivors=2 THEN 993003 ELSE 993004 END,'Native Qualifier '||case_name);", "INSERT INTO public.clubs(id,club_id,name,asset,is_platform,chip_treasury,chip_pool,promo_balance,insurance_balance) VALUES(club,CASE WHEN survivors=2 THEN 993003 ELSE 993004 END,'Native Qualifier '||case_name,'diamonds',true,0,0,0,0); INSERT INTO public.ca_arena_settings(id,club_id,settlement_window_days,note,updated_at,cash_games_enabled,tournaments_enabled) VALUES(1,club,0,'isolated value-ticket qualification',now(),false,true) ON CONFLICT(id) DO UPDATE SET club_id=EXCLUDED.club_id,settlement_window_days=0,tournaments_enabled=true;")
  diamond_seed=diamond_seed.replace("INSERT INTO public.profiles(id,username,display_name) VALUES(u,'native_qualifier_'||case_name||'_'||i,'Native Qualifier');", "INSERT INTO public.profiles(id,username,display_name,diamonds) VALUES(u,'native_qualifier_'||case_name||'_'||i,'Native Qualifier',300);")
  diamond_seed=diamond_seed.replace("case_name||': actual authenticated entry '||i)","case_name||': actual authenticated entry '||i||' returned '||r::text)")
  diamond_seed=diamond_seed.replace("club uuid:=md5('l04:'||case_name||':club')::uuid;", "club uuid:=(SELECT id FROM public.clubs WHERE is_platform AND asset='diamonds');")
  diamond_seed=diamond_seed.replace("INSERT INTO public.clubs(id,club_id,name,asset,is_platform,chip_treasury,chip_pool,promo_balance,insurance_balance) VALUES(club,CASE WHEN survivors=2 THEN 993003 ELSE 993004 END,'Native Qualifier '||case_name,'diamonds',true,0,0,0,0);", 'PERFORM 1; /* Reuse the actual one-platform Diamond arena. */')
  diamond_seed=diamond_seed.replace("INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance,joined_at)\n   VALUES(club,u,'player','active',300,clock_timestamp()-interval '1 day');", 'PERFORM 1; -- Diamond platform membership is profile-based, never a Chip wallet.')
  diamond_seed=diamond_seed.replace("PERFORM pg_temp.qualifier_assert((SELECT prize_balance=108 AND gross_in=108", "PERFORM public.fn_poker_diamond_tournament_open_shadow(source_id);\n PERFORM pg_temp.qualifier_assert((SELECT prize_balance=108 AND gross_in=108")
  diamond_seed=diamond_seed.replace('PERFORM 1; /* Reuse the actual one-platform Diamond arena. */', "INSERT INTO auth.users(id) SELECT owner_id FROM public.clubs WHERE id=club AND owner_id IS NOT NULL ON CONFLICT(id) DO NOTHING; INSERT INTO public.users(id,username) SELECT owner_id,'native_diamond_platform_owner' FROM public.clubs WHERE id=club AND owner_id IS NOT NULL ON CONFLICT(id) DO NOTHING; INSERT INTO public.profiles(id,username,display_name) SELECT owner_id,'native_diamond_platform_owner','Native Diamond Platform Owner' FROM public.clubs WHERE id=club AND owner_id IS NOT NULL ON CONFLICT(id) DO NOTHING;")
  composed.write_text(seed+'\n'+scene.read_text()+'\n'+diamond_seed+'\n'+(fixture/'native-diamond-cases.sql').read_text()+"\nSET CONSTRAINTS ALL IMMEDIATE;\nROLLBACK;\n")
  # The current one-survivor legacy producer is a separate public call path.
  # Capture its actual owners, then demonstrate the future-award assertion RED
  # before installing the narrowly guarded successor in this isolated catalog.
  single=root/'tests/fixtures/satellite-single-value-awards'
  for capture in ['legacy-inner-before.sql','receipt-before.sql','wrapper-unchanged.sql']:
   e.sql(db,file=single/capture,label='actual-single-owner-'+capture,seconds=30)
  e.sql(db,"REVOKE ALL ON FUNCTION public.fn_ca_satellite_settlement_receipt(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role; REVOKE ALL ON FUNCTION public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid) TO service_role;",label='actual-single-owner-acl')
  properties="SELECT jsonb_agg(jsonb_build_object('identity',oid::regprocedure::text,'definition_md5',md5(pg_get_functiondef(oid)),'source_md5',md5(prosrc),'owner',pg_get_userbyid(proowner),'security_definer',prosecdef,'config',proconfig,'acl',proacl)) FROM pg_proc WHERE oid IN('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)'::regprocedure,'public.fn_ca_satellite_settlement_receipt(uuid,uuid)'::regprocedure,'public.fn_settle_satellite_tournament(uuid,uuid)'::regprocedure);"
  e.sql(db,properties,label='single-properties-before')
  one_seed=seed[:seed.index('CREATE FUNCTION pg_temp.qualifier_case')]
  creator=seed[seed.index('CREATE FUNCTION pg_temp.qualifier_case'):]
  creator=creator[:creator.index(" EXECUTE 'SET LOCAL ROLE service_role';\n r:=public.fn_get_satellite_qualifier_state")]
  creator=creator.replace('pg_temp.qualifier_case(', 'pg_temp.single_value_case(')
  creator=creator.replace('CASE WHEN survivors=2 THEN 993001 ELSE 993002 END','993100+abs(hashtext(case_name)%10000)')
  # A finite legacy target is an explicit opening, never a modified settled contract.
  creator=creator.replace("0,NULL,3,0,club,0,0,0,false,false,false,0,0,0,'MTT','freezeout','mtt-v2'","0,CASE WHEN (case_name LIKE '%full%' OR case_name LIKE '%held%') THEN 3 ELSE NULL END,3,0,club,0,0,0,false,false,false,0,0,0,CASE WHEN (case_name LIKE '%full%' OR case_name LIKE '%held%') THEN 'SNG' ELSE 'MTT' END,'freezeout',CASE WHEN (case_name LIKE '%full%' OR case_name LIKE '%held%') THEN 'sng-v1' ELSE 'mtt-v2' END")
  creator+="\n RETURN jsonb_build_object('tournament_id',source_id,'qualifier_ids',to_jsonb(q),'target_id',target_id,'table_id',v_table_id);\nEND $case$;\n"
  diamond_creator=diamond_seed[diamond_seed.index('CREATE FUNCTION pg_temp.qualifier_diamond_case'):]
  diamond_creator=diamond_creator[:diamond_creator.index(" EXECUTE 'SET LOCAL ROLE service_role';\n r:=public.fn_get_satellite_qualifier_state")]
  diamond_creator=diamond_creator.replace('pg_temp.qualifier_diamond_case(', 'pg_temp.single_diamond_case(')
  diamond_creator=diamond_creator.replace("0,NULL,3,0,club,0,0,0,false,false,false,0,0,0,'MTT','freezeout','mtt-v2'","0,CASE WHEN (case_name LIKE '%full%' OR case_name LIKE '%held%') THEN 3 ELSE NULL END,3,0,club,0,0,0,false,false,false,0,0,0,CASE WHEN (case_name LIKE '%full%' OR case_name LIKE '%held%') THEN 'SNG' ELSE 'MTT' END,'freezeout',CASE WHEN (case_name LIKE '%full%' OR case_name LIKE '%held%') THEN 'sng-v1' ELSE 'mtt-v2' END")
  diamond_creator+="\n RETURN jsonb_build_object('tournament_id',source_id,'qualifier_ids',to_jsonb(q),'target_id',target_id,'table_id',v_table_id);\nEND $case$;\n"
  single_scene=output/'single-funded-cases.sql'
  single_scene.write_text(one_seed+creator+diamond_creator+(single/'native-cases.sql').read_text()+"\nSET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;\n")
  code,_,error=e.sql(db,file=single_scene,label='single-old-red',seconds=180,check=False)
  if code==0 or 'SINGLE_VALUE_EXPECT_REUSABLE_TICKET' not in error:
   raise ValueError('old actual single-winner path did not produce the expected RED: '+error[-2500:])
  successor=root/'supabase/migrations/20261031211736_single_winner_satellite_fallback_is_a_reusable_value_ticket.sql'
  historical=output/'single-historical-transition.sql'
  # One isolated transaction creates a genuine legacy payment, replaces the
  # functions, verifies replay, and rolls everything back before other cases.
  transition=successor.read_text().replace('BEGIN;', '', 1).removesuffix('COMMIT;\n')
  historical.write_text(one_seed+creator+(single/'historical-before.sql').read_text().removesuffix('COMMIT;\n')+transition+(single/'historical-after.sql').read_text().replace('BEGIN;', '', 1))
  e.sql(db,file=historical,label='single-historical-transition',seconds=60)
  e.sql(db,file=successor,label='single-value-successor',seconds=30)
  e.sql(db,properties,label='single-properties-after')
  e.sql(db,file=single_scene,label='single-new-green',seconds=180)
  e.sql(db,file=composed,label='funded-value-ticket-cases',seconds=180)
  qualify_concurrent_consumption(e,root,native,db,output,seed,scene.read_text(),diamond_seed,(fixture/'native-diamond-cases.sql').read_text())
  e.report.update(passed=True,status='passed')
 finally:
  e.close()
  (output/'report.json').write_text(json.dumps(e.report,indent=2,default=str)+'\n')
 print('PASS: actual funded satellite value awards, native assets, exact single-use entry and immutable historical receipts')

if __name__=='__main__':main()
