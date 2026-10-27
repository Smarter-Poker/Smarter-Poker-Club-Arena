# Runs only in the maintained isolated PG17 zero/foreign native family.
import re
OUT=A.output.parent if A.output else A.scratch_root
OUT.mkdir(parents=True,exist_ok=True)
sig='public.fn_standalone_foreign_certificate_periods(text,uuid,date,date,timestamptz,timestamptz)'
original=q("SELECT pg_get_functiondef('"+sig+"'::regprocedure)").stdout.strip()
original_md5=q("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure))").stdout.strip()
assert original_md5=='154b8afb11b7a9c7617d16fd047c9918'
views=q("SELECT jsonb_build_object('effective',pg_get_viewdef('accounting_effective_cash_rake_sources'::regclass,true),'payable',pg_get_viewdef('accounting_payable_earning_sources'::regclass,true))").stdout.strip()
migration_sql=SOURCE_CASH_COVER_MIGRATION.read_text()
pre,installer_body=migration_sql.split('BEGIN;',1);installer_body='BEGIN;'+installer_body
assert q("SELECT NOT EXISTS(SELECT FROM pg_index WHERE indexrelid=to_regclass('public.accounting_cash_foreign_certificate_club_week_cover')AND NOT(indisvalid AND indisready AND indislive))").stdout.strip()=='t'
def must_refuse(sql,message):
 r=q(sql,check=False)
 assert r.returncode and message in r.stderr,(message,r.stdout,r.stderr)
q('UPDATE dr_controls SET frozen=true')
must_refuse(installer_body,'foreign_certificate_cash_cover_install_frozen')
q('UPDATE dr_controls SET frozen=false')
must_refuse(installer_body.replace('COMMIT;',"DO $$BEGIN RAISE EXCEPTION 'forced_cover_rollback';END$$;COMMIT;"),'forced_cover_rollback')
q(migration_sql);q(migration_sql)
faults=[]
for label,ddl in [
 ('missing-include','ON accounting_cash_rake_sources(club_id,earned_at)'),
 ('reversed-keys','ON accounting_cash_rake_sources(earned_at,club_id)INCLUDE(id,player_id,rake_record_id,coordinator_union_id,rake_credit)'),
 ('wrong-include-order','ON accounting_cash_rake_sources(club_id,earned_at)INCLUDE(player_id,id,rake_record_id,coordinator_union_id,rake_credit)'),
 ('descending-key','ON accounting_cash_rake_sources(club_id DESC,earned_at)INCLUDE(id,player_id,rake_record_id,coordinator_union_id,rake_credit)'),
 ('partial-predicate','ON accounting_cash_rake_sources(club_id,earned_at)INCLUDE(id,player_id,rake_record_id,coordinator_union_id,rake_credit)WHERE coordinator_union_id IS NULL'),
 ('expression-key',"ON accounting_cash_rake_sources((md5(club_id::text)),earned_at)INCLUDE(id,player_id,rake_record_id,coordinator_union_id,rake_credit)"),
 ('wrong-table','ON accounting_tournament_fee_sources(club_id)'),
 ('wrong-method','ON accounting_cash_rake_sources USING hash(club_id)'),
]:
 q('DROP INDEX accounting_cash_foreign_certificate_club_week_cover;CREATE INDEX accounting_cash_foreign_certificate_club_week_cover '+ddl)
 must_refuse(migration_sql,'foreign_certificate_cash_cover_');faults.append(label)
q('DROP INDEX accounting_cash_foreign_certificate_club_week_cover')
invalid=q('CREATE UNIQUE INDEX CONCURRENTLY accounting_cash_foreign_certificate_club_week_cover ON accounting_cash_rake_sources(club_id)',check=False)
assert invalid.returncode
assert q("SELECT NOT indisvalid FROM pg_index WHERE indexrelid='accounting_cash_foreign_certificate_club_week_cover'::regclass").stdout.strip()=='t'
must_refuse(migration_sql,'foreign_certificate_cash_cover_shape_changed');faults.append('actual-invalid-concurrent-index')
q('DROP INDEX accounting_cash_foreign_certificate_club_week_cover')
# Install the actual competing club/week and coordinator index definitions.
indexes=[
'CREATE INDEX accounting_cash_club_week_player_cover ON accounting_cash_rake_sources(club_id,earned_at)INCLUDE(player_id,id)',
'CREATE INDEX accounting_cash_rake_sources_period ON accounting_cash_rake_sources(club_id,earned_at,player_id)',
'CREATE INDEX accounting_cash_rake_sources_coordinator_period ON accounting_cash_rake_sources(coordinator_union_id,earned_at,club_id)',
'CREATE INDEX accounting_cash_rake_sources_club_coordinator_earned ON accounting_cash_rake_sources(club_id,coordinator_union_id,earned_at)',
'CREATE INDEX accounting_cash_rake_sources_bank_period ON accounting_cash_rake_sources(union_id,earned_at)WHERE union_id IS NOT NULL',
'CREATE INDEX accounting_cash_rake_sources_club_recorded ON accounting_cash_rake_sources(club_id,recorded_at)INCLUDE(earned_at)',
'CREATE INDEX accounting_cash_rakeback_player_week ON accounting_cash_rake_sources(club_id,player_id,earned_at)',
'CREATE INDEX idx_cash_rake_sources_player ON accounting_cash_rake_sources(player_id)']
for ix in indexes:
 name=ix.split()[2]
 existing=q("SELECT coalesce(pg_get_indexdef(to_regclass('public."+name+"')),'')").stdout.strip()
 if existing:
  def normalize_index(text):return re.sub(r'[\s()]','',text.lower().replace('public.','').replace('using btree',''))
  assert normalize_index(existing)==normalize_index(ix),(name,existing,ix)
 else:q(ix)
# Native-only volume: distinct immutable source keys, unchanged real views and
# original helper. A non-period user avoids manufacturing any paid certificate.
q("INSERT INTO accounting_cash_rake_sources(id,rake_record_id,player_id,club_id,union_id,coordinator_union_id,earned_at,rake_credit,contract)SELECT md5('cover-source-'||i)::uuid,md5('cover-record-'||i)::uuid,caw_u('volume-player'),CASE WHEN i%10=0 THEN caw_u('club')ELSE caw_u('volume-other-club')END,caw_u('union'),caw_u('union'),'2026-10-06 12:00Z'::timestamptz+(i%86400)*interval '1 second',1,jsonb_build_object('original_fixture','native_volume_only','payload',repeat('abcdef',160))FROM generate_series(1,200000)i")
q('VACUUM (ANALYZE, INDEX_CLEANUP ON) accounting_cash_rake_sources')
body=original.split('AS $function$\n',1)[1].rsplit('$function$',1)[0].strip()
vals={'p_scope_kind':"'club'::text",'p_club':"caw_u('club')",'p_from_date':"'2026-10-05'::date",'p_to_date':"'2026-10-11'::date",'p_period_start':"'2026-10-05 07:00Z'::timestamptz",'p_period_end':"'2026-10-12 07:00Z'::timestamptz"}
for k,v in vals.items():body=re.sub(r'\b'+k+r'\b',v,body)
call="SELECT period_id FROM "+sig.split('(')[0]+"('club',caw_u('club'),'2026-10-05','2026-10-11','2026-10-05 07:00Z','2026-10-12 07:00Z')"
bag="SELECT jsonb_build_object('count',count(*),'rake',sum(rake_credit),'md5',md5(coalesce(string_agg(md5(to_jsonb(s)::text),''ORDER BY source_type,source_id),'')))FROM(SELECT source_type,source_id,club_id,player_id,coordinator_union_id,earned_at,rake_credit,rake_record_id FROM accounting_payable_earning_sources WHERE club_id=caw_u('club')AND earned_at>='2026-10-05 07:00Z'AND earned_at<'2026-10-12 07:00Z')s"
before_bag=q(bag).stdout.strip();before_periods=q('SELECT jsonb_agg(period_id ORDER BY period_id)FROM('+call+')p').stdout.strip()
oldplan=json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)'+body).stdout)
indexname='accounting_cash_foreign_certificate_club_week_cover'
indexsql='CREATE INDEX CONCURRENTLY '+indexname+' ON public.accounting_cash_rake_sources(club_id,earned_at)INCLUDE(id,player_id,rake_record_id,coordinator_union_id,rake_credit)'
q(migration_sql);q('VACUUM (ANALYZE, INDEX_CLEANUP ON) accounting_cash_rake_sources')
newplan=json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)'+body).stdout)
def nodes(n):
 yield n
 for c in n.get('Plans',[]):yield from nodes(c)
covered=[n for n in nodes(newplan[0]['Plan'])if n.get('Index Name')==indexname]
assert covered,('natural candidate index absent',newplan)
assert all(n['Node Type']=='Index Only Scan'for n in covered),covered
assert any(n.get('Actual Rows',0)>=20000 for n in covered),covered
assert all(n.get('Heap Fetches',0)<n.get('Actual Rows',0) for n in covered),covered
# Legitimate inherited original-row visibility checks remain; Index Only Scan
# still proves all requested fields are in the index, and bulk rows avoid heap.
assert q(bag).stdout.strip()==before_bag
assert q('SELECT jsonb_agg(period_id ORDER BY period_id)FROM('+call+')p').stdout.strip()==before_periods
assert q("SELECT md5(pg_get_functiondef('"+sig+"'::regprocedure))").stdout.strip()==original_md5
assert q("SELECT jsonb_build_object('effective',pg_get_viewdef('accounting_effective_cash_rake_sources'::regclass,true),'payable',pg_get_viewdef('accounting_payable_earning_sources'::regclass,true))").stdout.strip()==views
# Boundary parity with/without the candidate index, using transaction rollback
# so no certificate, financial row or original source remains changed.
changes=[
 ('effective-funding-move-out',"INSERT INTO accounting_cash_funding_contract_admissions VALUES(caw_u('s1'),caw_u('other'),now(),'{}');"),
 ('effective-funding-move-in',"INSERT INTO accounting_cash_rake_sources(id,rake_record_id,player_id,club_id,earned_at,rake_credit,contract,coordinator_union_id)VALUES(caw_u('moved-in'),caw_u('moved-in-record'),caw_u('volume-player'),caw_u('other'),'2026-10-06',7,'{}',caw_u('union'));INSERT INTO accounting_cash_funding_contract_admissions VALUES(caw_u('moved-in'),caw_u('club'),now(),'{}');"),
 ('own-null-coordinator',"INSERT INTO accounting_cash_rake_sources(id,rake_record_id,player_id,club_id,earned_at,rake_credit,contract)VALUES(caw_u('own-extra'),caw_u('own-extra-record'),caw_u('P1'),caw_u('club'),'2026-10-06',1,'{}');"),
 ('launch-cutoff',"INSERT INTO zero_cutoffs VALUES(caw_u('club'),'2026-10-07');"),
 ('source-exact-start-end',"INSERT INTO accounting_cash_rake_sources(id,rake_record_id,player_id,club_id,earned_at,rake_credit,contract,coordinator_union_id)SELECT caw_u('boundary-'||i),caw_u('boundary-record-'||i),caw_u('volume-player'),caw_u('club'),CASE i WHEN 1 THEN '2026-10-05 07:00Z'::timestamptz ELSE '2026-10-12 07:00Z'::timestamptz END,1,'{}',caw_u('union')FROM generate_series(1,2)i;"),
]
fee_seed="""INSERT INTO accounting_tournament_fee_sources(id,rake_record_id,tournament_id,player_id,club_id,union_id,coordinator_union_id,game_type,registration_id,source_charge_ledger_id,source_entitlement_id,charged_at,rake_credit,contract)VALUES(caw_u('fee-native'),caw_u('fee-record'),caw_u('fee-tournament'),caw_u('volume-player'),caw_u('club'),caw_u('union'),caw_u('union'),'NLHE',caw_u('fee-registration'),caw_u('fee-charge'),caw_u('fee-entitlement'),'2026-10-06 10:00Z',1,'{}');INSERT INTO accounting_tournament_fee_recognitions(tournament_id,recognized_at,status,net_rake,source_fingerprint,plan,union_id)VALUES(caw_u('fee-tournament'),'2026-10-06 12:00Z','recognized',0,md5('native-recognition'),'{}',caw_u('union'));INSERT INTO accounting_tournament_recognized_sources VALUES(caw_u('fee-native'),caw_u('fee-tournament'),'2026-10-06 12:00Z','earned',1);"""
for label,alter,expected in [
 ('fee-earned',"",1),
 ('fee-refunded',"UPDATE accounting_tournament_recognized_sources SET disposition='refunded';",0),
 ('fee-unrecognized',"UPDATE accounting_tournament_fee_recognitions SET status='cancelled';",0),
 ('fee-rake-mismatch',"UPDATE accounting_tournament_recognized_sources SET rake_credit=2;",0),
 ('fee-union-mismatch',"UPDATE accounting_tournament_fee_recognitions SET union_id=NULL;",0),
 ('fee-recognized-end-exclusive',"UPDATE accounting_tournament_recognized_sources SET recognized_at='2026-10-12 07:00Z';UPDATE accounting_tournament_fee_recognitions SET recognized_at='2026-10-12 07:00Z';",0),
 ('fee-charge-before-cutoff',"INSERT INTO zero_cutoffs VALUES(caw_u('club'),'2026-10-06 11:00Z');",0),
]:changes.append((label,fee_seed+alter+"SELECT caw_assert((SELECT count(*)="+str(expected)+" FROM accounting_payable_earning_sources WHERE source_id=caw_u('fee-native')AND earned_at>='2026-10-05 07:00Z'AND earned_at<'2026-10-12 07:00Z'),'exact-fee-eligibility');"))
boundaries=[]
for label,change in changes:
 # Native-only DROP/rollback compares exact same rows under the old and new
 # access paths; no GUC forces either plan.
 ans=q('BEGIN;'+change+'CREATE TEMP TABLE indexed_bag AS '+bag+';CREATE TEMP TABLE indexed_periods AS '+call+';DROP INDEX '+indexname+';SELECT caw_assert((SELECT to_jsonb(i)FROM indexed_bag i)IS NOT DISTINCT FROM(SELECT to_jsonb(o)FROM('+bag+')o),\'source-bag-index-parity\');SELECT caw_assert(NOT EXISTS((TABLE indexed_periods EXCEPT ALL '+call+')UNION ALL('+call+' EXCEPT ALL TABLE indexed_periods)),\'period-index-parity\');ROLLBACK;')
 boundaries.append({'case':label,'passed':True})
# A snapshot read remains repeatable across a concurrent committed insertion;
# the next transaction sees the genuine new source. No snapshot retagging.
ps=subprocess.Popen([str(A.pg_bin/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-h','127.0.0.1','-p',port,'-d','postgres'],env=E,text=True,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,bufsize=1)
ps.stdin.write('BEGIN ISOLATION LEVEL REPEATABLE READ;CREATE TEMP TABLE snapshot_bag AS '+bag+';\\echo NATIVE_SNAPSHOT_READY\n');ps.stdin.flush()
line=ps.stdout.readline();assert line.strip()=='NATIVE_SNAPSHOT_READY',line
q("INSERT INTO accounting_cash_rake_sources(id,rake_record_id,player_id,club_id,earned_at,rake_credit,contract,coordinator_union_id)VALUES(caw_u('concurrent-source'),caw_u('concurrent-record'),caw_u('volume-player'),caw_u('club'),'2026-10-06',3,'{}',caw_u('union'))")
ps.stdin.write("SELECT caw_assert((SELECT to_jsonb(i)FROM snapshot_bag i)IS NOT DISTINCT FROM(SELECT to_jsonb(o)FROM("+bag+")o),'repeatable-read-source-bag');ROLLBACK;\n\\q\n");ps.stdin.flush();stdout,stderr=ps.communicate(timeout=60);assert ps.returncode==0,(stdout,stderr)
after_insert=json.loads(q(bag).stdout);assert after_insert['count']==json.loads(before_bag)['count']+1
hotplan=json.loads(q('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)'+body).stdout)
hot=[n for n in nodes(hotplan[0]['Plan'])if n.get('Index Name')==indexname]
assert hot and any(n.get('Heap Fetches',0)>0 for n in hot),hot
assert q('SELECT jsonb_agg(period_id ORDER BY period_id)FROM('+call+')p').stdout.strip()==before_periods
result={'status':'passed','original_helper_md5':original_md5,'helper_and_both_views_unchanged':True,'actual_competing_index_definitions':indexes,'candidate_index_sql':indexsql,'natural_index_only':covered,'no_planner_forcing':True,'source_bag_before':json.loads(before_bag),'accepted_period_ids':json.loads(before_periods),'old_plan':oldplan,'new_plan':newplan,'mvcc_hot_page_plan':hotplan,'boundaries':boundaries,'concurrent_repeatable_read_and_visible_next_snapshot':True,'native_volume_only_rows':200000,'production_speed':'unproven','migration':str(SOURCE_CASH_COVER_MIGRATION.relative_to(R)),'migration_sha256':hashlib.sha256(migration_sql.encode()).hexdigest(),'exact_installer_frozen_rollback_replay':True,'catalog_faults':faults}
(OUT/'cover-native-result.json').write_text(json.dumps(result,indent=2)+'\n')
results.append({'case':'original-helper-natural-cover-index-only-source-bag-period-parity-boundaries-MVCC','passed':True})
print('COVER_NATIVE_ORIGINAL_HELPER_PASS',flush=True)
