"""Actual-source scoped reset/undo regression. No production connections or full DB certificate."""
from pathlib import Path
import os,re,subprocess,tempfile,json,hashlib,argparse,shutil,time
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--workdir',type=Path,required=True)
parser.add_argument('--source-migrations',type=Path,nargs=4,metavar=('BASE','TRANSPORT','COHORT','PREARCHIVE'))
parser.add_argument('--stage-migration',type=Path)
parser.add_argument('--node',default=shutil.which('node'))
parser.add_argument('--component-root',type=Path)
parser.add_argument('--followup-migration',type=Path,help='One exact guarded installed-source followup after the base migration')
parser.add_argument('--launch-followup',type=Path)
parser.add_argument('--candidate-migration',type=Path,help='Single complete assembled candidate migration; loaded exactly once')
parser.add_argument('--component-map',type=Path,help='JSON object mapping relative component names to actual candidate SQL paths')
parser.add_argument('--scratch-root',type=Path,required=True)
parser.add_argument('--output-dir',type=Path,required=True)
parser.add_argument('--pg-bin',type=Path)
parser.add_argument('--production-roster',action='store_true',help='Use exact observed 1903-wallet split')
parser.add_argument('--prefix-roster',action='store_true',help='Bounded 64-wallet roster exercises actual validated tally prefixes')
args=parser.parse_args()
workdir=args.workdir.resolve()
if args.source_migrations:
 args.candidate_migration,args.followup_migration,args.launch_followup,args.stage_migration=args.source_migrations
else:
 migrations=workdir/'supabase/migrations'
 args.candidate_migration=args.candidate_migration or migrations/'20261012181905_scoped_club_launch_reset_and_guarded_recovery.sql'
 args.followup_migration=args.followup_migration or migrations/'20261013133012_scoped_launch_operator_accepts_authoritative_json_claims.sql'
 args.launch_followup=args.launch_followup or migrations/'20261013202353_scoped_launch_preserves_retired_wallets_and_starts_current_w.sql'
 args.stage_migration=args.stage_migration or migrations/'20261014000346_scoped_launch_stages_complete_reporting_archive.sql'
args.production_roster=True
if args.prefix_roster:parser.error('This regression preserves the exact eligible1717/raw1903 cohort; do not substitute a smaller lifecycle roster')
if not args.node:parser.error('Node.js required for actual two-connection native race proofs')
STAGE_FIX=workdir/'scripts/ci/fixtures/launch-reset/derived-prearchive'
for relative,digest in json.loads((STAGE_FIX/'fixture-pins.json').read_text()).items():
 if hashlib.sha256((STAGE_FIX/relative).read_bytes()).hexdigest()!=digest:raise AssertionError('Derived prearchive executable fixture changed: '+relative)
source_pins=json.loads((STAGE_FIX/'source-pins.json').read_text())
for sourcepath in [args.candidate_migration,args.followup_migration,args.launch_followup,args.stage_migration]:
 if hashlib.sha256(sourcepath.read_bytes()).hexdigest()!=source_pins[sourcepath.name]:raise AssertionError('Exact prearchive source changed: '+sourcepath.name)

# The existing required job owns this installed base and its exact followup.
# A missing followup fails normally; this is never a conditional test skip.
if args.candidate_migration and args.candidate_migration.name=='20261012181905_scoped_club_launch_reset_and_guarded_recovery.sql' and args.followup_migration is None:
 args.followup_migration=Path(__file__).resolve().parents[2]/'supabase'/'migrations'/'20261013133012_scoped_launch_operator_accepts_authoritative_json_claims.sql'
BASE=args.scratch_root.resolve();OUT=args.output_dir.resolve()
if not BASE.is_dir():parser.error('scratch root must already exist')
OUT.mkdir(parents=True,exist_ok=True)
PG=args.pg_bin or Path(shutil.which('initdb') or '').parent
if not all((PG/n).is_file() for n in ['initdb','pg_ctl','psql']):parser.error('PostgreSQL 17 binaries required via PATH or --pg-bin')
version=subprocess.check_output([str(PG/'initdb'),'--version'],text=True)
if not re.search(r'PostgreSQL\) 17\.',version):parser.error('PostgreSQL 17 required')
FIX=workdir/'scripts/ci/fixtures/launch-reset'
FOLLOW_FIX=FIX/'transport-boundary'
fixture_hashes=json.loads((FIX/'fixture-hashes.json').read_text())
for name,digest in fixture_hashes.items():
 if hashlib.sha256((FIX/name).read_bytes()).hexdigest()!=digest:raise AssertionError('Original fixture fingerprint changed: '+name)
if args.followup_migration:
 for name,digest in json.loads((FOLLOW_FIX/'fixture-pins.json').read_text()).items():
  if hashlib.sha256((FOLLOW_FIX/name).read_bytes()).hexdigest()!=digest:raise AssertionError('Followup fixture changed: '+name)
  fixture_hashes['followup/'+name]=digest
meta=json.loads((FIX/'original-authorities.json').read_text())
functions=meta['functions'];seen=set(meta['seen']);selected=set(meta['selected']);triggered=set(meta['triggered']);triggers=meta['triggers']
names=['reset-undo-component/closing-contract.sql', 'accounting-component/boundary.sql', 'accounting-component/treasury-selftest-wiring.sql', 'accounting-component/reporting-boundary.sql', 'accounting-component/source-wiring.sql', 'accounting-component/consumer-wiring.sql', 'accounting-component/hand-stats-wiring.sql', 'accounting-component/accounting-owner-wiring.sql', 'accounting-component/reporting-wiring.sql', 'accounting-component/fact-projection-wiring.sql', 'accounting-component/reporting-extra-wiring.sql', 'accounting-component/union-reporting-wiring.sql', 'accounting-component/commission-assertion-wiring.sql', 'cashier-cutoff-component/cashier-cutoff.sql', 'accounting-component/activation.sql', 'accounting-component/invoice-visibility.sql', 'incident-component.sql', 'reset-undo-component/balance-contract.sql', 'reset-undo-component/velocity-wiring.sql', 'reset-undo-component/bbj-reporting.sql', 'floor-component/scoped-floor.sql', 'accounting-component/floor-original-acl.sql', 'accounting-component/floor-admission-component.sql', 'accounting-component/original-reader-acl.sql', 'guard-definition-component/guard-declaration.sql']
mapping=json.loads(args.component_map.read_text()) if args.component_map else {}
if not args.candidate_migration and not args.component_root and not mapping:parser.error('component root or explicit component map required')
if args.candidate_migration and (args.component_root or mapping):parser.error('Choose assembled candidate or component paths, not both')
components=[args.candidate_migration.resolve()] if args.candidate_migration else [Path(mapping[n]).resolve() if n in mapping else (args.component_root/n).resolve() for n in names]
if args.followup_migration and not args.candidate_migration:parser.error('Followup requires one assembled base candidate')
if args.followup_migration:components.append(args.followup_migration.resolve())
components.append(args.launch_followup.resolve())
component_sources={p:p.read_text() for p in components}
with tempfile.TemporaryDirectory(prefix='fb-',dir=BASE) as folder:
 root=Path(folder);socket=root/'s';socket.mkdir();data=root/'d'
 env=dict(os.environ,PGHOST=str(socket),PGUSER='postgres',PGDATABASE='postgres',PGPORT='5432',PGSSLMODE='disable',PGTZ='UTC',PGOPTIONS='-c search_path=public,extensions')
 def run(args,sql=None,ok=True):
  r=subprocess.run([str(x) for x in args],input=sql,text=True,capture_output=True,env=env,timeout=300)
  if ok and r.returncode:raise AssertionError(r.stderr)
  if not ok and not r.returncode:raise AssertionError('Expected refusal did not occur')
  return r.stdout.strip() if ok else r.stderr
 q=[PG/'psql','-X','-At','-v','ON_ERROR_STOP=1']
 run([PG/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale'])
 with (data/'postgresql.conf').open('a') as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(socket)+"'\n")
 try:
  with (data/'postgresql.conf').open('a') as f:f.write((STAGE_FIX/'bounded-native.conf').read_text())
  run([PG/'pg_ctl','-D',data,'-l',root/'log','-w','start'])
  settings=json.loads(run(q,"SELECT jsonb_agg(jsonb_build_object('name',name,'setting',setting,'unit',unit,'source',source) ORDER BY name) FROM pg_settings WHERE name IN('shared_buffers','work_mem','maintenance_work_mem','effective_cache_size','max_wal_size','checkpoint_timeout','checkpoint_completion_target','wal_compression','random_page_cost','fsync','synchronous_commit','full_page_writes');"))
  assert all(next(x for x in settings if x['name']==n)['setting']=='on' for n in ['fsync','synchronous_commit','full_page_writes']),'Durability must remain enabled'
  # Bounded correctness proof: this local configuration is not a provider-volume timing certificate.
  (OUT/'effective-native-settings.json').write_text(json.dumps(settings,indent=2)+'\n')
  run(q,(FIX/'original-bootstrap.sql').read_text())
  # First seed fixture identities/state, then install triggers before action.
  actor='2d1cd6c3-5700-4af9-a271-d4863fdab20d';horse='10000000-0000-0000-0000-000000000001';human='10000000-0000-0000-0000-000000000002'
  horses=[horse]+[str(__import__('uuid').UUID(hashlib.md5(('horse-fixture:'+str(i)).encode()).hexdigest())) for i in range(583 if args.production_roster else 15 if args.prefix_roster else 7)]
  wallet_counts=[580,416,584,323] if args.production_roster else [16,16,16,16] if args.prefix_roster else [8,8,8,8]
  raw_horse_wallets=sum(wallet_counts)
  retired_horses=horses[416:478]
  eligible_wallet_counts=[518,416,522,261]
  horse_wallets=sum(eligible_wallet_counts)
  scope=['a0000000-0000-0000-0000-000000000001','2a1132b9-5ba2-42e6-9f01-30a7fcffebe3','a41434bb-8d0c-400a-8f0d-e8b3d65afed4','fade0000-0000-0000-0000-000000000001']
  seed=f"INSERT INTO profiles(id,role,status,is_horse) VALUES('{actor}','god','active',false),('{horse}','user','active',true),('{human}','user','active',false);"
  seed+=''.join(f"INSERT INTO profiles(id,role,status,is_horse) VALUES('{h}','user','active',true);" for h in horses[1:])
  seed+="INSERT INTO ca_financial_epochs(id,name,description,is_current) OVERRIDING SYSTEM VALUE VALUES(2,'fixture','Isolated scoped qualification',true); INSERT INTO ca_mint_policy(id,per_operation_cap_chips,rolling_24h_cap_chips,per_operation_cap_diamonds,rolling_24h_cap_diamonds) VALUES(1,10000000,25000000,10000000,25000000); INSERT INTO ca_ledger_invariant_mode(mode,reason) VALUES('refuse','Actual native qualification'); INSERT INTO ca_emergency_stops(path,stopped) VALUES('positive_issuance',false),('cashout',false),('tournament_registration',false);"
  for club_index,c in enumerate(scope):
   seed+=f"INSERT INTO clubs(id,name,slug,owner_id,asset,chip_treasury,chip_pool,promo_balance,insurance_balance) VALUES('{c}','Fixture {c}','fixture-{c}','{actor}','chips',100000,0,200,100); INSERT INTO club_members(club_id,user_id,role,status,chip_balance,promo_balance) VALUES('{c}','{horse}','player','active',50000,20),('{c}','{human}','player','active',50,10);"
   members=([*horses[:261],*retired_horses] if club_index==3 else horses[:wallet_counts[club_index]])
   seed+=''.join(f"INSERT INTO club_members(club_id,user_id,role,status,chip_balance,promo_balance) VALUES('{c}','{h}','player','active',50000,20);" for h in members[1:])
   seed+=f"INSERT INTO agents(club_id,user_id,role,commission_rate,player_rakeback_rate,agent_wallet_balance,business_balance,promo_wallet_balance,promo_balance,player_wallet_balance,player_balance,credit_limit,credit_used,lifetime_earnings,weekly_rake_generated) VALUES('{c}','{human}','agent',0,0,70,70,10,10,0,0,100,25,50,12); UPDATE club_members SET credit_used=15,hands_played=42,total_rake_paid=3.14 WHERE club_id='{c}';"
  seed+=f"INSERT INTO unions(id,name,slug,owner_id) VALUES('{scope[3]}','Fixture Midway','fixture-midway','{actor}'); INSERT INTO union_wallets(union_id,chip_balance) VALUES('{scope[3]}',100000); INSERT INTO bbj_pools(id,union_id,main_balance,backup_balance,promo_balance) VALUES('f9806a7f-e7a2-47d2-a676-36336e3a5337','{scope[3]}',20000,5000,500);"
  current_week="(public.fn_union_week_start(now()) AT TIME ZONE 'America/Los_Angeles')::date"
  period_counts=[111,0,34,0] if args.production_roster else [2,0,2,0]
  period_seed=[];period_ids=[]
  for ci,count in enumerate(period_counts):
   for i in range(count):
    pid=str(__import__('uuid').UUID(hashlib.md5(('current-week-fixture:'+str(ci)+':'+str(i)).encode()).hexdigest()))
    user=horses[i];period_ids.append((pid,scope[ci],user))
    period_seed.append(f"INSERT INTO rakeback_periods(id,user_id,club_id,period_start,period_end,rake_generated,rakeback_rate,rakeback_amount,status,created_at) VALUES('{pid}','{user}','{scope[ci]}',{current_week},{current_week}+6,10,0.2,2,'pending',now()-interval '1 hour');")
  for i,(pid,club,user) in enumerate(period_ids+period_ids[:10 if args.production_roster else 1]):
   period_seed.append(f"INSERT INTO accounting_rakeback_period_calculations(id,period_id,source_fingerprint,club_id,player_id,period_start,period_end,rake_generated,rakeback_amount,display_rate,payer_kind,source_allocations,recorded_at) OVERRIDING SYSTEM VALUE VALUES({i+1},'{pid}','historical-fixture-{i}','{club}','{user}',{current_week},{current_week}+6,10,2,0.2,'club','[]',now()-interval '1 hour');")
  seed+=''.join(period_seed)
  run(q,seed)
  run(q,"SELECT setval(pg_get_serial_sequence('accounting_rakeback_period_calculations','id'),(SELECT max(id) FROM accounting_rakeback_period_calculations));")
  run(q,"UPDATE profiles SET status='deleted' WHERE id=ANY('"+'{'+','.join(retired_horses)+'}'+"'::uuid[]);UPDATE club_members SET chip_balance=0,promo_balance=0 WHERE user_id=ANY('"+'{'+','.join(retired_horses)+'}'+"'::uuid[]);")
  run(q,"INSERT INTO tables(id,club_id,status,name,game_type) VALUES('70000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001','closed','Owned Volume Fixture','cash'); INSERT INTO club_member_daily_stats(club_id,table_id,user_id,stat_date,hands_played,profit) SELECT 'a0000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000001',md5(i::text)::uuid,'2026-10-11',8,i/100.0 FROM generate_series(1,20)i; INSERT INTO club_member_table_state(table_id,user_id,last_stack) SELECT '70000000-0000-0000-0000-000000000001',md5(i::text)::uuid,i/100.0 FROM generate_series(1,21)i; ANALYZE club_member_daily_stats; ANALYZE club_member_table_state;")
  run(q,(STAGE_FIX/'bounded-cache-indexes.sql').read_text())
  iid='ee31e7ff-fc2a-4c94-b9df-50cb0624285c';aid='1df63d8e-7d33-4b55-8be3-02f2f41f9387';echo='7eadc5d1-cc92-4871-b850-a02c642baa1d'
  metadata={'union_id':scope[3],'period_start':'2026-10-05T07:00:00+00:00','period_end':'2026-10-12T07:00:00+00:00','alert_id':aid,'result':{'error':'weekly_accounting_calculation_incomplete','uncertified_old_evidence':['keep']}}
  context={k:v for k,v in metadata.items() if k in ['union_id','period_start','period_end']}
  run(q,f"INSERT INTO ca_drift_incidents(id,detected_at,deadline_at,classification,severity,layer,status,source,dedupe_key,ledger_balanced,metadata) VALUES('{iid}',now()-interval '1 hour',now()+interval '1 hour','unknown','critical','unknown','open','financial_alerts:union_accounting_scheduler','qualified-old-week-fixture',false,'{json.dumps(metadata)}');")
  for alert_id,source,ctx in [(aid,'union_accounting_scheduler',context),(echo,'drift_incident:financial_alerts:union_accounting_scheduler',dict(context,incident_id=iid))]:run(q,f"INSERT INTO financial_alerts(id,severity,source,message,context,resolved) VALUES('{alert_id}','critical','{source}','Old basis incomplete','{json.dumps(ctx)}',false);")
  for eid in ['899985f3-daf0-447b-a6f1-d6e755a5b88d', '597a0628-2115-4088-a217-e6980256e80a', 'b4d32681-eedf-4125-9c98-103c39976b6f', 'e5113641-d4f0-46e3-afe7-6a3771fe8843']:run(q,f"INSERT INTO ca_drift_incidents(id,detected_at,deadline_at,classification,severity,layer,status,source,dedupe_key,ledger_balanced,metadata,resolved_at,closure_basis,root_cause,correction_ref,resolution) VALUES('{eid}',now()-interval '2 hours',now()+interval '1 hour','unknown','warning','unknown','resolved','original-eco-witness','{eid}',false,'{{}}',now()-interval '1 hour','operator','Existing Remeasurement Witness Retained','ruling: existing witness','Already resolved by original owner');")
  # Actual old warning sources, original mirrors and unknown scheduler period.
  new_incidents=[
   ('1f146817-bd56-469e-a42c-601aa348d081','fn_ca_conservation_sweep:fn_union_governance_check',{'row_count':1,'rows':[{'invariant':'union_eco_not_recorded','offenders':1,'severity':'warning','detail':"Unions with ECO enabled and no union_eco_ledger row for the settlement week that has CLOSED: that week's win tax / loss rebate is not reproducible. The ledger is written at close, so the week in progress is not asked about"}]}),
   ('52704570-bdc7-4745-9cfb-f829ea132963','fn_ca_conservation_sweep:fn_union_credit_risk_check',{'row_count':1,'rows':[{'invariant':'union_eco_not_recorded','offenders':1,'severity':'warning','detail':"Unions with ECO enabled and no union_eco_ledger row for the settlement week that has CLOSED: that week's win tax / loss rebate is not reproducible. The ledger is written at close, so the week in progress is not asked about"}]}),
   ('c17b258e-3b4e-407f-9ab3-f92d2c147920','financial_alerts:fn_union_treasury_selftest',{'union_id':scope[3],'check':'lapsed_week_unclosed','alert_id':'a7a59fb9-5491-426b-ac84-1aa5d1e4fedf'}),
   ('d6180536-0d0c-4024-bd3d-ddeb3d5c7e66','financial_alerts:union_accounting_scheduler',{'scope_kind':'union','scope_id':scope[3],'result':{'error':'weekly_scope_statement_budget_exhausted'},'alert_id':'20b37a4b-8d9b-4207-8d5c-af8ee169a484'})]
  for new_id,new_source,new_metadata in new_incidents:
   metadata_literal=json.dumps(new_metadata).replace("'","''")
   run(q,f"INSERT INTO ca_drift_incidents(id,detected_at,deadline_at,classification,severity,layer,status,source,dedupe_key,ledger_balanced,metadata) VALUES('{new_id}',now()-interval '10 minutes',now()+interval '1 hour','unknown','warning','unknown','open','{new_source}','{new_id}',NULL,'{metadata_literal}');")
   mirrors=[('drift_incident:'+new_source,dict(new_metadata,incident_id=new_id))]
   if 'alert_id' in new_metadata:mirrors.insert(0,(new_source.removeprefix('financial_alerts:'),new_metadata))
   for source_index,(mirror_source,mirror_context) in enumerate(mirrors):
    mirror_id=new_metadata['alert_id'] if source_index==0 and 'alert_id' in new_metadata else str(__import__('uuid').uuid5(__import__('uuid').NAMESPACE_URL,'native-mirror:'+new_id))
    mirror_literal=json.dumps(mirror_context).replace("'","''")
    run(q,f"INSERT INTO financial_alerts(id,severity,source,message,context,resolved) VALUES('{mirror_id}','warning','{mirror_source}','Uncertified old prelaunch witness','{mirror_literal}',false);")
  run(q,f"UPDATE unions SET settings=jsonb_build_object('eco_enabled',true) WHERE id='{scope[3]}'; UPDATE clubs SET union_id='{scope[3]}' WHERE id=ANY(ARRAY{scope!r}::uuid[]); INSERT INTO union_clubs(union_id,club_id) SELECT '{scope[3]}',id FROM clubs WHERE id=ANY(ARRAY{scope!r}::uuid[]);")
  run(q,f"INSERT INTO player_stats(user_id,club_id,hands_played,total_winnings,total_rake) VALUES('{horse}','{scope[0]}',7,25,2.50),('{horse}',NULL,4,10,1); UPDATE profiles SET total_hands_played=1001 WHERE id='{horse}'; INSERT INTO credit_invoices(agent_id,period_start,period_end,debt_owed,amount_remaining,due_date) SELECT id,now()-interval '8 days',now()-interval '1 day',123,123,now()+interval '1 day' FROM agents WHERE club_id='{scope[0]}'; INSERT INTO settlement_invoices(club_id,invoice_type,from_entity_type,from_entity_id,to_entity_type,to_entity_id,gross_amount,net_amount,source_credit_invoice_id,status) SELECT '{scope[0]}','transaction_receipt','club','{scope[0]}','agent','{human}',123,123,id,'generated' FROM credit_invoices;")
  registry=json.loads((FIX/'original-money-registry.json').read_text())
  def literal(v):return "'"+str(v).replace("'","''")+"'" if v is not None else 'NULL'
  run(q,'INSERT INTO ca_money_rpc_registry(proname,status,notes) VALUES '+','.join('('+','.join(literal(row[k]) for k in ['proname','status','notes'])+')' for row in registry if row['proname'] in seen)+';')
  # The actual meter computes fixture supply; seed its isolated opening
  # register witness, then retain every subsequent register operation.
  run(q,"SELECT fn_ca_supply_snapshot(); INSERT INTO ca_mint_ledger(op_id,action,asset,holder_type,holder_id,amount,balance_before,balance_after,supply_after,reason) SELECT 'register-opening-baseline:isolated-fixture','mint','chips','circulation','00000000-0000-0000-0000-00000000c1c0',total,0,total,total,'Isolated Fixture Initial Supply Baseline' FROM ca_supply_snapshots ORDER BY taken_at DESC LIMIT 1;")
  run(q,"INSERT INTO ca_bbj_pool_snapshots(pool_id,main,backup,promo,is_baseline,basis_version) SELECT id,main_balance,backup_balance,promo_balance,true,'labelled-bank-v3' FROM bbj_pools;")
  run(q,"INSERT INTO ca_chip_store_coverage(store,treatment,counted_by,notes) SELECT x,'counted','native fixture','Actual native store declaration' FROM unnest(ARRAY['player_wallet','club_treasury','promo_wallet','insurance_bank','agent_wallet','club_wallet','union_bank','union_wallet','bbj_pool','spin_reserve','opening_setup','prize_liability','bounty_liability','escrow','issuance_reserve','chip_retirement'])x;")
  run(q,'\n'.join(triggers)+"ALTER TABLE auth.users ADD CONSTRAINT users_pkey PRIMARY KEY(id); INSERT INTO auth.users(id) SELECT id FROM profiles; ALTER TABLE chip_ledger ADD CONSTRAINT chip_ledger_performed_by_fkey FOREIGN KEY(performed_by) REFERENCES auth.users(id);")
  # Production actor custody is auth.users, not its public profile projection.
  # Assert the exact installed identity before any candidate DDL or money action.
  assert run(q,"SELECT count(*)=1 FROM pg_constraint WHERE conrelid='public.chip_ledger'::regclass AND conname='chip_ledger_performed_by_fkey' AND confrelid='auth.users'::regclass AND pg_get_constraintdef(oid)='FOREIGN KEY (performed_by) REFERENCES auth.users(id)';")=='t'
  assert run(q,"SELECT NOT EXISTS(SELECT 1 FROM profiles p LEFT JOIN auth.users u ON u.id=p.id WHERE u.id IS NULL);")=='t'

  # Read-only authorization baseline for this isolated owner; restrictive
  # production policies grant nothing and compose with existing authority.
  run(q,"GRANT USAGE ON SCHEMA public,auth TO authenticated; GRANT SELECT ON clubs,agents,settlement_invoices,credit_invoices TO authenticated; ALTER TABLE settlement_invoices ENABLE ROW LEVEL SECURITY; ALTER TABLE credit_invoices ENABLE ROW LEVEL SECURITY; CREATE POLICY fixture_owned_settlement ON settlement_invoices FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM clubs c WHERE c.id=settlement_invoices.club_id AND c.owner_id=auth.uid())); CREATE POLICY fixture_owned_credit ON credit_invoices FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM agents a JOIN clubs c ON c.id=a.club_id WHERE a.id=credit_invoices.agent_id AND c.owner_id=auth.uid()));")
  # Fresh production comparison consumes these exact selected signatures,
  # column/default types and checks, with trigger hashes filtered to the
  # affected original trigger authorities installed above.
  names=','.join(literal(n) for n in sorted(selected))
  fnames=','.join(literal(n) for n in sorted(triggered))
  fingerprint=f"""SELECT jsonb_build_object('relations',(SELECT jsonb_object_agg(c.relname,jsonb_build_object('columns',md5((SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)::text FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)),'constraints',md5((SELECT jsonb_agg(jsonb_build_array(x.conname,x.contype,pg_get_constraintdef(x.oid)) ORDER BY x.conname)::text FROM pg_constraint x WHERE x.conrelid=c.oid AND x.contype IN('c','p','u'))),'triggers',md5((SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY t.tgname)::text FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid=c.oid AND NOT t.tgisinternal AND p.proname IN({fnames})))) ) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN({names})));"""
  original_catalog=json.loads(run(q,fingerprint))
  (OUT/'selected-original-catalog.json').write_text(json.dumps(original_catalog,indent=2)+'\n')
  (OUT/'selected-original-catalog-query.sql').write_text(fingerprint+'\n')
  details="SELECT 'column' as kind,a.attname as name,jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid)) as detail from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid='public.clubs'::regclass and a.attnum>0 and not a.attisdropped union all select 'constraint:'||c.relname,x.conname,jsonb_build_array(x.conname,x.contype,pg_get_constraintdef(x.oid)) from pg_constraint x join pg_class c on c.oid=x.conrelid where c.oid in('public.chip_ledger'::regclass,'public.rakeback_periods'::regclass,'public.settlement_invoices'::regclass) and x.contype in('c','p','u') order by kind,name"
  detailrows=json.loads(run(q,"SELECT jsonb_agg(to_jsonb(d)) FROM ("+details+")d;"))
  (OUT/'selected-original-catalog-details.json').write_text(json.dumps(detailrows,indent=2)+'\n')
  pinned=json.loads((FIX/'live-selected-catalog.json').read_text())
  expected=pinned['live'] if 'live' in pinned else pinned
  assert original_catalog==expected,'Original native catalog no longer matches independently read production fingerprints'
  # Seed only the actual retained original target baseline, never all guards.
  run(q,"SELECT fn_ca_declare_guard_redefinition('fn_ca_mint_velocity_watch','migration an_operators_declared_funding_is_not_a_mint_loop');")
  # Model current production creation defaults only after restoring original
  # objects and their archived ACLs. Current defaults do not retroactively
  # grant legacy routines to anon/authenticated/service_role.
  defaults=meta['current_function_default_privileges']
  assert defaults['owner']=='postgres' and defaults['schema']=='public'
  run(q,"ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE,REFERENCES,TRIGGER,MAINTAIN ON TABLES TO anon,authenticated; ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;")
  if args.followup_migration:
   floor_fixture=json.loads((FOLLOW_FIX/'floor-json-fixture.json').read_text())
   for original in floor_fixture['missing_originals']:
    assert run(q,"SELECT to_regprocedure('public."+original['signature']+"') IS NULL;")=='t','Original fixture unexpected overlap'
    run(q,original['definition']+'; REVOKE ALL ON FUNCTION public.'+original['signature']+' FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.'+original['signature']+' TO service_role;')
   escrow_definition=(FOLLOW_FIX/'escrow-table.sql').read_text().replace('CREATE TABLE public.tournament_escrow','CREATE TEMP TABLE expected_escrow')
   column_check="SELECT (SELECT jsonb_agg(jsonb_build_array(attname,format_type(atttypid,atttypmod),attnotnull) ORDER BY attnum) FROM pg_attribute WHERE attrelid='public.tournament_escrow'::regclass AND attnum>0 AND NOT attisdropped)=(SELECT jsonb_agg(jsonb_build_array(attname,format_type(atttypid,atttypmod),attnotnull) ORDER BY attnum) FROM pg_attribute WHERE attrelid='expected_escrow'::regclass AND attnum>0 AND NOT attisdropped);"
   assert 't' in run(q,'BEGIN;'+escrow_definition+column_check+'ROLLBACK;').splitlines(),'Actual escrow rowtype differs from current source'
  original_function_oids=run(q,"SELECT string_agg(p.oid::text,',') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','smarter_private');")
  run(q,component_sources[components[0]])
  if args.followup_migration:
   for table_name,key in [('ca_operator_roles','roles'),('ca_operator_role_permissions','permissions'),('ca_operator_policy','policy')]:
    body=json.dumps(floor_fixture['permission_fixture'][key]).replace("'","''");run(q,'INSERT INTO '+table_name+' SELECT * FROM jsonb_populate_recordset(NULL::'+table_name+",'"+body+"'::jsonb) ON CONFLICT DO NOTHING;")
   command_op='30000000-0000-0000-0000-000000000012';command_reason='Native Scoped Existing Command Delivery'
   run(q,f"INSERT INTO ca_engine_operator_commands(id,actor_id,domain,action,reason,status) VALUES('{command_op}','{actor}','floor','park','{command_reason}','accepted'); INSERT INTO ca_launch_operator_scopes(operation_id,actor_id,club_ids) VALUES('{command_op}','{actor}',ARRAY['{scope[0]}']::uuid[]); INSERT INTO ca_operator_floor_hold(id,operation_id,mode,reason) VALUES(true,'{command_op}','park','{command_reason}');")
   claims_prefix=f"SET request.jwt.claim.role=''; SET request.jwt.claims='{{\"role\":\"service_role\",\"sub\":\"{actor}\"}}';"
   calls=[f"SELECT fn_ca_engine_operator_command('{actor}','{command_op}','floor','park','{command_reason}');",f"SELECT fn_ca_launch_operator_command('{actor}','{command_op}','park','{command_reason}');",f"SELECT fn_ca_engine_operator_observe('{command_op}','accepted','{{}}');",f"SELECT fn_ca_operator_finish_cash_close('30000000-0000-0000-0000-000000000013','{command_op}');"]
   for call in calls:assert 'forbidden' in run(q,claims_prefix+call,False)
   run(q,"SET typed_witness.before='on';"+(FOLLOW_FIX/'typed-escrow-witness.sql').read_text())
   run(q,component_sources[components[1]])
   run(q,"SET typed_witness.before='off';"+(FOLLOW_FIX/'typed-escrow-witness.sql').read_text())
   for call in calls:run(q,claims_prefix+call)
   for role in ['anon','authenticated']:
    for call in calls:assert 'forbidden' in run(q,"SET request.jwt.claim.role=''; SET request.jwt.claims='{\"role\":\""+role+"\"}';"+call,False)
   for call in calls:run(q,"SET request.jwt.claim.role='service_role'; SET request.jwt.claims='{}';"+call)
   assert 'engine_operator_forbidden' in run(q,claims_prefix+f"SELECT fn_ca_engine_operator_command('{human}','{command_op}','floor','park','{command_reason}');",False)
   assert 'operation_identity_conflict' in run(q,claims_prefix+f"SELECT fn_ca_engine_operator_command('{actor}','{command_op}','floor','park','Different Native Reason');",False)
   assert run(q,f"SELECT count(*) FROM ca_launch_operator_scopes WHERE operation_id='{command_op}';")=='1'
   run(q,'DELETE FROM ca_operator_floor_hold;')
   assert 'LAUNCH_TRANSPORT_PREIMAGE_CHANGED' in run(q,component_sources[components[1]],False)
  else:
   for p in components[1:]:
    if p!=args.launch_followup.resolve():run(q,component_sources[p])
  role_helper_names=['fn_ca_launch_accounting_cutoff','fn_ca_launch_accounting_start','fn_ca_launch_accounting_accepts','fn_ca_launch_accounting_waived']
  service_entry_names=['fn_ca_launch_reset_assert_drained','fn_ca_launch_reset_capture','fn_ca_launch_reset_execute','fn_ca_launch_reset_undo','fn_ca_launch_operator_command']
  new_acl=json.loads(run(q,"SELECT jsonb_agg(jsonb_build_object('name',p.proname,'role',r,'execute',has_function_privilege(r,p.oid,'EXECUTE'))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN unnest(ARRAY['anon','authenticated','service_role'])r WHERE n.nspname IN('public','smarter_private') AND p.oid NOT IN("+original_function_oids+");"))
  for grant in new_acl:
   expected=grant['role']!='anon' if grant['name'] in role_helper_names else grant['role']=='service_role' if grant['name'] in service_entry_names else False
   assert grant['execute']==expected,'New function privilege differs from scoped authority: '+str(grant)
  assert run(q,"SELECT bool_and(NOT has_table_privilege(r,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN unnest(ARRAY['anon','authenticated','service_role'])r WHERE n.nspname='public' AND c.relname LIKE 'ca_launch_%' AND c.relkind IN('r','v');")=='t','Private launch store inherited production client-role privilege'

  # The original watcher remains loud for an undeclared target change. Guards
  # outside this finite fixture keep truthful missing reports; compare target
  # deltas rather than claiming the whole watcher estate is quiet.
  missing_watched=int(run(q,"SELECT count(*) FROM unnest(fn_ca_guard_watchlist())g WHERE NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=g);"))
  target_finding="SELECT (SELECT count(*) FROM ca_drift_incidents WHERE dedupe_key LIKE 'guard-def-drift:fn_ca_mint_velocity_watch:%')+(SELECT count(*) FROM ca_incident_events WHERE detail->>'capped_dedupe_key' LIKE 'guard-def-drift:fn_ca_mint_velocity_watch:%');"
  good_watch=run(q,'BEGIN;SELECT fn_ca_guard_defs_watch();'+target_finding+'ROLLBACK;').splitlines()
  assert str(missing_watched) in good_watch and '0' in good_watch,'Declared velocity guard generated drift'
  prior_watch=run(q,"BEGIN;UPDATE ca_guard_defs SET def_hash='c22bbee2e281142c032212d4220a0a17',declared_ref='migration an_operators_declared_funding_is_not_a_mint_loop' WHERE proname='fn_ca_mint_velocity_watch';SELECT fn_ca_guard_defs_watch();"+target_finding+'ROLLBACK;').splitlines()
  assert str(missing_watched+1) in prior_watch and '1' in prior_watch,'Original undeclared target change was silent'
  unknown_guard="DO $change$ DECLARE d text; BEGIN SELECT pg_get_functiondef('public.fn_ca_mint_velocity_watch()'::regprocedure) INTO d; EXECUTE replace(d,E'BEGIN\\n',E'BEGIN\\n -- Isolated Undeclared Guard Change\\n');END $change$;"
  unknown_watch=run(q,'BEGIN;'+unknown_guard+'SELECT fn_ca_guard_defs_watch();'+target_finding+'ROLLBACK;').splitlines()
  assert str(missing_watched+1) in unknown_watch and '1' in unknown_watch,'Later undeclared target change was silent'
  op='10000000-0000-0000-0000-000000000099'
  prefix=f"SET request.jwt.claims='{{\"role\":\"service_role\",\"sub\":\"{actor}\"}}';"
  # Use the original Mint to consume almost all of its normal rolling ceiling.
  # Exact launch grants must still fit their finite authorization; arbitrary
  # subsequent issuance must remain refused.
  for i,amount in enumerate([10000000,10000000,4990000]):
   key=f'fixture-prior-mint:{i}' if i<2 else 'launch-open:00000000-0000-4000-8000-000000000001:'+scope[0]
   minted=json.loads(run(q,prefix+f"SELECT fn_ca_mint('chips','club','{scope[0]}',{amount},'Isolated Ordinary Mint With Untrusted Launch Marker','{key}');").splitlines()[-1])
   assert minted['ok'] is True
  normal=json.loads(run(q,prefix+f"SELECT fn_ca_mint('chips','club','{scope[0]}',20000,'Ordinary Over Ceiling Issuance Refuses','fixture-normal-over-ceiling');").splitlines()[-1])
  assert normal['ok'] is False and normal['reason']=='over_the_rolling_24h_issuance_ceiling'
  run(q,"SELECT fn_ca_supply_snapshot();")
  def velocity_witness():
   lines=run(q,prefix+"BEGIN; SELECT fn_ca_mint_velocity_watch(); ROLLBACK;").splitlines()
   return next(__import__('decimal').Decimal(x) for x in lines if re.fullmatch(r'[0-9]+(?:\.[0-9]+)?',x))
  run(q,component_sources[args.launch_followup.resolve()])
  stagepath=args.stage_migration.resolve()
  components.append(stagepath);component_sources[stagepath]=stagepath.read_text()
  run(q,"CREATE SCHEMA IF NOT EXISTS supabase_migrations;CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations(version text PRIMARY KEY,name text,statements text[]);")
  for sourcepath in components[:-1]:
   version,name=sourcepath.stem.split('_',1);text=component_sources[sourcepath].replace("'","''")
   run(q,"INSERT INTO supabase_migrations.schema_migrations VALUES('"+version+"','"+name+"',ARRAY['"+text+"']);")
  run(q,component_sources[stagepath])
  staged='eece5c98-1bd4-45c5-a6d8-5a637c9a782c';cert='b'*64
  stagecall=f"SELECT fn_ca_launch_cache_stage('{staged}','{cert}','{actor}');"
  assert 'CACHE_STAGE_OWN_CASH_CLOSE_REQUIRED' in run(q,prefix+"BEGIN ISOLATION LEVEL REPEATABLE READ;"+stagecall+"ROLLBACK;",False)
  run(q,prefix+f"SELECT fn_ca_launch_operator_command('{actor}','a970faa8-7a40-4af9-9096-51d8c67ca803','park','Native Scoped Cache Stage');")
  run(q,f"INSERT INTO ca_engine_operator_commands(id,actor_id,domain,action,reason,status) VALUES('5790e1ef-9bb1-40d7-a2da-0fed650bd4b8','{actor}','floor','close_cash','Original Owned Close','completed');")
  assert 'CACHE_STAGE_REPEATABLE_READ_REQUIRED' in run(q,prefix+stagecall,False)
  assert 'CACHE_STAGE_ORIGINAL_OWNER_REQUIRED' in run(q,prefix+"BEGIN ISOLATION LEVEL REPEATABLE READ;"+stagecall.replace(staged,'10000000-0000-0000-0000-000000000098')+"ROLLBACK;",False)
  assert 'CACHE_STAGE_ACTOR_REFUSED' in run(q,f"SET request.jwt.claims='{{\"role\":\"service_role\",\"sub\":\"{human}\"}}';BEGIN ISOLATION LEVEL REPEATABLE READ;"+stagecall+"ROLLBACK;",False)
  stale=json.loads(run([Path(args.node),(STAGE_FIX/'stale-snapshot-race.mjs'),(workdir/'node_modules/pg/lib/index.js')]))
  (OUT/'stale-snapshot-race.json').write_text(json.dumps(stale,indent=2)+'\n')
  stage_result=run(q,prefix+"SELECT pg_advisory_lock_shared(530093); BEGIN ISOLATION LEVEL REPEATABLE READ;"+stagecall+"COMMIT; SELECT pg_advisory_unlock_shared(530093);")
  assert 'staged' in stage_result
  assert 'CACHE_STAGE_REPLAY_OR_BOUNDARY_REFUSED' in run(q,prefix+"BEGIN ISOLATION LEVEL REPEATABLE READ;"+stagecall+"ROLLBACK;",False)
  assert 'launch_accounting_archive_is_immutable' in run(q,f"UPDATE smarter_private.ca_launch_cache_stages SET certificate_sha256=repeat('c',64) WHERE operation_id='{staged}';",False)
  assert run(q,"SELECT NOT EXISTS(SELECT FROM pg_constraint WHERE conrelid='smarter_private.ca_launch_cache_stages'::regclass AND contype='f');")=='t'
  assert run(q,"SELECT (SELECT count(*) FROM jsonb_object_keys(relation_counts))=20 FROM smarter_private.ca_launch_cache_stages;")=='t'
  velocity_before=velocity_witness()
  run(q,"INSERT INTO engine_maintenance_break(phase,announced_at,break_started_at,break_ends_at,enforce_freeze,ownership_token) VALUES('counting_down',now()-interval '2 minutes',now()-interval '1 minute',now()+interval '3 minutes',true,gen_random_uuid());")
  assert 'CACHE_STAGE_ONLY_OUTSIDE_FREEZE' in run(q,prefix+"BEGIN ISOLATION LEVEL REPEATABLE READ;"+stagecall+"ROLLBACK;",False)
  for mutation in ["UPDATE club_member_daily_stats SET profit=profit+1 WHERE user_id=md5('1')::uuid", "DELETE FROM club_member_daily_stats WHERE user_id=md5('1')::uuid", "INSERT INTO club_member_daily_stats(club_id,table_id,user_id,stat_date) VALUES('a0000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000001','ffffffff-ffff-ffff-ffff-ffffffffffff','2026-10-11')"]:
   sql=prefix+f"BEGIN;SELECT fn_ca_launch_reset_capture('{staged}','{cert}','{actor}');"+mutation+f";SELECT fn_ca_launch_accounting_activate('{staged}');ROLLBACK;"
   assert 'CACHE_STAGE_ROWSET_CHANGED' in run(q,sql,False)
  oldvalidator=(STAGE_FIX/'before-updated-at-validator.sql').read_text()
  timestamp="UPDATE player_stats SET updated_at=clock_timestamp()+interval '1 minute' WHERE club_id='a0000000-0000-0000-0000-000000000001';"
  capture=f"SELECT fn_ca_launch_reset_capture('{staged}','{cert}','{actor}');"
  activate=f"SELECT fn_ca_launch_accounting_activate('{staged}');"
  oldrefusal=run(q,prefix+'BEGIN;'+oldvalidator+capture+timestamp+activate+'ROLLBACK;',False)
  assert 'CACHE_STAGE_ROWSET_CHANGED' in oldrefusal
  run(q,prefix+'BEGIN;'+capture+timestamp+activate+'ROLLBACK;')
  assert 'CACHE_STAGE_ROWSET_CHANGED' in run(q,prefix+'BEGIN;'+capture+"UPDATE player_stats SET hands_played=hands_played+1 WHERE club_id='a0000000-0000-0000-0000-000000000001';"+activate+'ROLLBACK;',False)
  badhash="ALTER TABLE ca_launch_accounting_archives DISABLE TRIGGER launch_accounting_archive_immutable;UPDATE ca_launch_accounting_archives SET row_sha256=repeat('0',64) WHERE operation_id='"+staged+"' AND relation_name='player_stats';"
  assert 'CACHE_STAGE_ROWSET_CHANGED' in run(q,prefix+'BEGIN;'+capture+badhash+activate+'ROLLBACK;',False)
  (OUT/'timestamp-regression.json').write_text(json.dumps(dict(old_updated_at_only_false_refusal=True,new_updated_at_only_accepts=True,changed_business_refused=True,archive_fullrow_hash_refused=True,archive_exception_fields=['updated_at'],production_actions=False),indent=2)+'\n')
  certdrift=prefix+f"BEGIN;SELECT fn_ca_launch_reset_capture('{staged}',repeat('c',64),'{actor}');SELECT fn_ca_launch_accounting_activate('{staged}');ROLLBACK;"
  assert 'CACHE_STAGE_CAPTURE_IDENTITY_CHANGED' in run(q,certdrift,False)
  race=json.loads(run([Path(args.node),(STAGE_FIX/'cache-stage-race.mjs'),(workdir/'node_modules/pg/lib/index.js')]))
  (OUT/'stage-writer-race.json').write_text(json.dumps(race,indent=2)+'\n')
  original_bbj=json.loads(run(q,"SELECT to_jsonb(fn_bbj_reconcile('f9806a7f-e7a2-47d2-a676-36336e3a5337'));").splitlines()[-1])
  mutable=['club_members','agents','clubs','union_wallets','bbj_pools','profiles','unions','settlement_invoices','credit_invoices','player_stats','player_stats_snapshots','club_member_daily_stats','club_member_play_totals','ca_club_commission_daily','ca_club_rake_daily','ca_club_rake_daily_user','club_rake_daily_user','club_rake_rollup_complete','club_table_rake_totals','club_hand_daily_shard','club_member_table_state','accounting_rakeback_period_evidence_checkpoints','accounting_recompute_split_parts','accounting_period_recompute_requests','rakeback_periods','club_settlement_floor','union_settlement_floor','ca_club_player_daily','ca_club_tournament_daily','ca_club_tournament_player_daily','club_table_daily','union_rake_weekly','ca_drift_incidents','financial_alerts']
  def metadata(n):
   return json.loads(run(q,f"SELECT jsonb_build_object('count',count(*),'fingerprint',encode(extensions.digest(coalesce(string_agg(md5((to_jsonb(t)-'updated_at'-'credit_control_revision')::text),'' ORDER BY (to_jsonb(t)-'updated_at'-'credit_control_revision')::text),''),'sha256'),'hex')) FROM {n} t;"))
  before={n:metadata(n) for n in mutable}
  certificates_before=metadata('accounting_rakeback_period_calculations')
  def visible_invoices():
   return json.loads(run(q,prefix+"SET ROLE authenticated; SELECT jsonb_build_array((SELECT count(*) FROM settlement_invoices),(SELECT count(*) FROM credit_invoices)); RESET ROLE;").splitlines()[-2])
  assert visible_invoices()==[1,1]
  # One first-launch authorization per club is intentional. Exercise the
  # self-aborting rehearsal before the committed fixture launch consumes it.
  again='eece5c98-1bd4-45c5-a6d8-5a637c9a782c'
  same=prefix+f"BEGIN; SELECT fn_ca_launch_reset_capture('{again}','"+'b'*64+f"','{actor}'); SELECT fn_ca_launch_reset_execute('{again}',(SELECT closing_sha256 FROM ca_launch_reset_operations WHERE operation_id='{again}'),{horse_wallets}); SELECT fn_ca_launch_reset_undo('{again}',(SELECT closing_sha256 FROM ca_launch_reset_operations WHERE operation_id='{again}')); SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;"
  comparison=f"""DO $verify$ DECLARE r record;changed boolean;BEGIN
 FOR r IN SELECT * FROM public.ca_launch_accounting_store_receipts WHERE operation_id='{again}'::uuid ORDER BY relation_name LOOP
  EXECUTE 'SELECT EXISTS(SELECT 1 FROM ('||public.fn_ca_launch_accounting_store_query(r.relation_name,r.mutated_columns)||') n FULL JOIN (SELECT row_key,CASE WHEN $2 IS NULL THEN before_image ELSE (SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(before_image)e WHERE e.key=ANY($2)) END AS row_image FROM public.ca_launch_accounting_archives WHERE operation_id=$3 AND relation_name=$4) p USING(row_key) WHERE (n.row_key IS NULL OR p.row_key IS NULL OR (n.row_image-ARRAY[''updated_at'',''credit_control_revision'']) IS DISTINCT FROM (p.row_image-ARRAY[''updated_at'',''credit_control_revision''])) AND ($4<>''settlement_invoices'' OR p.row_key IS NOT NULL))'
  INTO changed USING '{{a0000000-0000-0000-0000-000000000001,2a1132b9-5ba2-42e6-9f01-30a7fcffebe3,a41434bb-8d0c-400a-8f0d-e8b3d65afed4,fade0000-0000-0000-0000-000000000001}}'::uuid[],r.mutated_columns,'{again}'::uuid,r.relation_name;
  IF changed THEN RAISE EXCEPTION 'LIVE_PROBE_OWNED_ACCOUNTING_FIELDS_NOT_RESTORED: %',r.relation_name; END IF;
 END LOOP;
END $verify$;"""
  comparison=comparison.replace('DO $verify$ DECLARE r record;changed boolean;BEGIN','').replace('END $verify$;','')
  same=prefix+f"BEGIN; SET LOCAL statement_timeout='270s'; DO $combined$ DECLARE answer jsonb;closing text;r record;changed boolean;BEGIN answer:=fn_ca_launch_reset_capture('{again}','"+'b'*64+f"','{actor}');SELECT closing_sha256 INTO closing FROM ca_launch_reset_operations WHERE operation_id='{again}';answer:=fn_ca_launch_reset_execute('{again}',closing,{horse_wallets});answer:=fn_ca_launch_reset_undo('{again}',closing);SET CONSTRAINTS ALL IMMEDIATE;"+comparison+" END $combined$; ROLLBACK;"
  all_runtime=json.loads(run(q,"SELECT jsonb_agg(jsonb_build_object('signature',p.proname||'('||pg_get_function_identity_arguments(p.oid)||')','definition_sha256',encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex'),'prosrc_md5',md5(p.prosrc),'owner',pg_get_userbyid(p.proowner),'security_definer',p.prosecdef,'config',p.proconfig,'acl',p.proacl::text) ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','smarter_private') AND p.prokind='f';"))
  (OUT/'runtime-postimages.json').write_text(json.dumps(all_runtime,indent=2)+'\n')
  phase_timings={}
  def save_phases():
   (OUT/'phase-timings.json').write_text(json.dumps(dict(complete=False,source_hashes={str(p):hashlib.sha256(component_sources[p].encode()).hexdigest() for p in components},horse_wallet_counts=wallet_counts,phase_timings=phase_timings),indent=2)+'\n')
  phase_start=time.monotonic();run(q,same);phase_timings['self_aborting_capture_execute_undo_seconds']=time.monotonic()-phase_start;save_phases()
  after={n:metadata(n) for n in mutable}
  assert before==after,'Combined full-volume rollback comparison mismatch'
  certificates_after=metadata('accounting_rakeback_period_calculations')
  assert certificates_before==certificates_after and certificates_after['count']==155,'Historical certificate records changed'
  elapsed=phase_timings['self_aborting_capture_execute_undo_seconds']
  phase_timings['external_snapshot_comparison_seconds']=time.monotonic()-phase_start-elapsed
  receipt=dict(qualified=True,production_volume_timing_qualified=False,bounded_stage_regressions=True,stage_result=stage_result,effective_native_settings=settings,config_fixture_sha256=hashlib.sha256((STAGE_FIX/'bounded-native.conf').read_bytes()).hexdigest(),within_270_seconds=elapsed<270,combined_capture_execute_undo_seconds=elapsed,horse_wallet_counts=eligible_wallet_counts,raw_horse_wallet_counts=wallet_counts,retired_horse_wallet_counts=[62,0,62,62],rows_by_store={'club_member_daily_stats':20,'club_member_table_state':21},current_week_pending_rows=145,historical_calculation_certificates=155,historical_certificates_before=certificates_before,historical_certificates_after=certificates_after,recovered_stores=mutable,metadata_before=before,metadata_after=after,source_hashes={str(p):hashlib.sha256(component_sources[p].encode()).hexdigest() for p in components},fixture_hashes=fixture_hashes,production_installation=False,live_freeze_qualification=False)
  if any(p.read_text()!=component_sources[p] for p in components):raise AssertionError('Bound source changed during native qualification')
  (OUT/'combined-volume-result.json').write_text(json.dumps(receipt,indent=2)+'\n')
  print(json.dumps({k:v for k,v in receipt.items() if k not in ('metadata_before','metadata_after')}))
  raise SystemExit(0)
 finally:
  run([PG/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
