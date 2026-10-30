from pathlib import Path
import os,json,tempfile,subprocess,hashlib,argparse,re,sys
base=Path(__file__).parent/'fixtures'/'launch-reset'/'floor'
parser=argparse.ArgumentParser()
parser.add_argument('--pgbin',default=os.environ.get('PGBIN','/opt/homebrew/bin'))
parser.add_argument('--component',type=Path,default=base/'scoped-floor.sql')
parser.add_argument('--candidate-migration',type=Path)
parser.add_argument('--scratch',type=Path,default=Path(os.environ.get('TMPDIR',str(base.parent))))
parser.add_argument('--output',type=Path,default=base/'qualification.json')
args=parser.parse_args()
candidate_sha=None
if args.candidate_migration:
 candidate_bytes=args.candidate_migration.read_bytes();candidate=candidate_bytes.decode('utf-8')
 marker='-- Component: floor-component/scoped-floor.sql'
 matches=list(re.finditer(r'^'+re.escape(marker)+r'\s*$',candidate,re.M))
 if len(matches)!=1:raise ValueError('Candidate must contain exactly one exact floor component marker')
 tail=candidate[matches[0].end():]
 next_marker=re.search(r'^-- Component: ',tail,re.M)
 extracted=tail[:next_marker.start()] if next_marker else tail
 if not next_marker:
  extracted=re.sub(r'\nCOMMIT;\s*$', '\n',extracted,count=1)
 loaded_floor='BEGIN;\n'+extracted.strip()+'\nCOMMIT;\n'
 candidate_sha=hashlib.sha256(candidate_bytes).hexdigest()
else:
 loaded_floor=args.component.read_text()
loaded_floor_sha=hashlib.sha256(loaded_floor.encode()).hexdigest()
pg=Path(args.pgbin)
args.scratch.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='floor-',dir=args.scratch) as tmp:
 root=Path(tmp);socket=root/'s';socket.mkdir();data=root/'d'
 env=dict(os.environ,PGHOST=str(socket),PGUSER='postgres',PGDATABASE='postgres',PGSSLMODE='disable')
 def run(args,sql=None,refuse=None):
  r=subprocess.run([str(x) for x in args],input=sql,text=True,capture_output=True,env=env,timeout=30)
  if refuse:
   assert r.returncode!=0 and refuse in r.stderr,(refuse,r.stdout,r.stderr)
  else: assert r.returncode==0,r.stderr
  return r.stdout.strip()
 psql=[pg/'psql','-X','-At','-v','ON_ERROR_STOP=1']
 run([pg/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'])
 with (data/'postgresql.conf').open('a') as f:f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(socket)+"'\n")
 try:
  run([pg/'pg_ctl','-D',data,'-l',root/'server.log','-w','start'])
  fixture="""CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
CREATE TABLE ca_engine_operator_commands(id uuid PRIMARY KEY,actor_id uuid,domain text,action text,reason text,status text,announced_at timestamptz,result jsonb,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),end_requested_at timestamptz);
CREATE TABLE ca_operator_floor_hold(id boolean PRIMARY KEY,operation_id uuid,mode text,reason text);
CREATE TABLE ca_operator_table_closes(table_id uuid PRIMARY KEY,operation_id uuid,actor_id uuid,reason text,status text DEFAULT 'pending');
CREATE TABLE tables(id uuid PRIMARY KEY,club_id uuid,union_id uuid,tournament_id uuid,status text,is_deleted boolean,game_type text);
CREATE TABLE tournaments(id uuid PRIMARY KEY,club_id uuid,union_id uuid,status text);
CREATE TABLE tournament_launch_receipts(tournament_id uuid);
CREATE TABLE tournament_players(tournament_id uuid,user_id uuid);
CREATE TABLE table_seats(table_id uuid,left_at timestamptz,occupancy_id uuid);
CREATE TABLE hand_state_snapshots(table_id uuid,is_complete boolean);
CREATE TABLE fixture_audits(actor_id uuid,action text,object_id text);
CREATE FUNCTION fn_ca_operator_permissions(uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT CASE WHEN $1='20000000-0000-0000-0000-000000000001' THEN '{"permissions":["clubs.write","settings.write"]}'::jsonb ELSE '{"permissions":[]}'::jsonb END$$;
CREATE FUNCTION fn_log_admin_action(uuid,text,text,text,jsonb,jsonb,jsonb,uuid,text,text) RETURNS void LANGUAGE sql AS $$INSERT INTO fixture_audits VALUES($1,$2,$4)$$;
CREATE FUNCTION fn_ca_lock_settlement_lane_for_tournament(uuid,uuid) RETURNS void LANGUAGE sql AS $$SELECT$$;
CREATE FUNCTION fn_ca_lock_mtt_admission_contract() RETURNS void LANGUAGE sql AS $$SELECT$$;
CREATE FUNCTION fn_entry_purchases_frozen() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE FUNCTION fn_lock_daily_mission_user(uuid) RETURNS void LANGUAGE sql AS $$SELECT$$;
"""
  run(psql,fixture)
  run(psql,(base/'finish-close-original.sql').read_text())
  for r in json.loads((base/'originals.json').read_text()):run(psql,r['definition']+';')
  run(psql,"CREATE TRIGGER entry_guard BEFORE INSERT OR UPDATE OF left_at,occupancy_id ON table_seats FOR EACH ROW EXECUTE FUNCTION fn_ca_operator_floor_entry_guard();")
  club='a0000000-0000-0000-0000-000000000001';outside='002c2d27-9584-4e52-835a-bb2be148fc81'
  inside_table='10000000-0000-0000-0000-000000000001';outside_table='10000000-0000-0000-0000-000000000002'
  event='10000000-0000-0000-0000-000000000011';other_event='10000000-0000-0000-0000-000000000012'
  actor='20000000-0000-0000-0000-000000000001';park='30000000-0000-0000-0000-000000000001';close='30000000-0000-0000-0000-000000000002';resume='30000000-0000-0000-0000-000000000003'
  run(psql,f"INSERT INTO tables VALUES('{inside_table}','{club}',NULL,NULL,'running',false,'cash'),('{outside_table}','{outside}',NULL,NULL,'running',false,'cash');INSERT INTO tournaments VALUES('{event}','{club}',NULL,'RUNNING'),('{other_event}','{outside}',NULL,'RUNNING');")
  prefix="SET request.jwt.claim.role='service_role';"
  run(psql,prefix+f"SELECT fn_ca_engine_operator_command('{actor}','{park}','floor','park','Qualified Launch Scope Park');")
  assert json.loads(run(psql,f"SELECT fn_ca_operator_floor_state('{outside_table}');"))['hold'] is not None
  run(psql,"TRUNCATE ca_operator_floor_hold,ca_engine_operator_commands,fixture_audits;")
  run(psql,loaded_floor)
  park_call=f"SELECT fn_ca_launch_operator_command('{actor}','{park}','park','Qualified Launch Scope Park');"
  run(psql,park_call,refuse='launch_operator_forbidden')
  run(psql,prefix+park_call)
  run(psql,prefix+park_call)
  assert json.loads(run(psql,f"SELECT fn_ca_operator_floor_state('{inside_table}');"))['hold'] is not None
  assert json.loads(run(psql,f"SELECT fn_ca_operator_floor_state('{outside_table}');"))['hold'] is None
  run(psql,f"INSERT INTO table_seats VALUES('{inside_table}',NULL,'40000000-0000-0000-0000-000000000001');",refuse='OPERATOR_FLOOR_PARKED')
  run(psql,f"INSERT INTO table_seats VALUES('{outside_table}',NULL,'40000000-0000-0000-0000-000000000002');")
  assert json.loads(run(psql,f"SELECT fn_ca_lock_tournament_seat_acquisition('{event}',NULL,NULL);"))['reason']=='operator_floor_parked'
  assert json.loads(run(psql,f"SELECT fn_ca_lock_tournament_seat_acquisition('{other_event}',NULL,NULL);"))['ok'] is True
  run(psql,f"INSERT INTO tournament_players VALUES('{event}','40000000-0000-0000-0000-000000000001');INSERT INTO tables VALUES('10000000-0000-0000-0000-000000000003','{club}',NULL,'{event}','running',false,'tournament');")
  assert json.loads(run(psql,f"SELECT fn_ca_lock_tournament_seat_acquisition('{event}',NULL,'40000000-0000-0000-0000-000000000001');"))['ok'] is True
  assert json.loads(run(psql,"SELECT fn_ca_operator_floor_state('10000000-0000-0000-0000-000000000003');"))['hold'] is None
  run(psql,"INSERT INTO table_seats VALUES('10000000-0000-0000-0000-000000000003',NULL,'40000000-0000-0000-0000-000000000003');")
  run(psql,prefix+f"SELECT fn_ca_launch_operator_command('{actor}','{close}','close_cash','Qualified Launch Scope Close','{park}');")
  assert run(psql,'SELECT count(*) FROM ca_operator_table_closes;')=='1'
  assert run(psql,'SELECT table_id FROM ca_operator_table_closes;')==inside_table
  run(psql,prefix+f"SELECT fn_ca_launch_operator_command('{actor}','{close}','close_cash','Qualified Launch Scope Close','{park}');")
  assert run(psql,'SELECT count(*) FROM ca_operator_table_closes;')=='1'
  run(psql,prefix+f"SELECT fn_ca_launch_operator_command('{actor}','{resume}','resume','Qualified Launch Scope Resume','{close}');",refuse='launch_operator_own_park_required')
  run(psql,prefix+f"SELECT fn_ca_launch_operator_command('{actor}','{resume}','resume','Qualified Launch Scope Resume','{park}');",refuse='launch_operator_pending_closes')
  run(psql,prefix+f"SELECT fn_ca_operator_finish_cash_close('{inside_table}','{close}');")
  assert run(psql,f"SELECT status FROM tables WHERE id='{inside_table}';")=='closed'
  run(psql,f"INSERT INTO table_seats VALUES('{inside_table}',NULL,'40000000-0000-0000-0000-000000000004');",refuse='OPERATOR_FLOOR_PARKED')
  run(psql,prefix+f"SELECT fn_ca_launch_operator_command('{actor}','{resume}','resume','Qualified Launch Scope Resume','{park}');")
  run(psql,prefix+f"SELECT fn_ca_launch_operator_command('{actor}','{resume}','resume','Qualified Launch Scope Resume','{park}');")
  assert run(psql,'SELECT count(*) FROM ca_launch_floor_resume_receipts;')=='1'
  run(psql,f"INSERT INTO table_seats VALUES('{inside_table}',NULL,'40000000-0000-0000-0000-000000000004');")
  assert run(psql,f"SELECT status FROM tables WHERE id='{outside_table}';")=='running'
  run(psql,"UPDATE ca_launch_floor_resume_receipts SET actor_id='20000000-0000-0000-0000-000000000002';",refuse='launch_operator_scope_immutable')
  run(psql,f"INSERT INTO tables VALUES('10000000-0000-0000-0000-000000000009','{outside}',NULL,NULL,'closed',false,'cash');INSERT INTO ca_operator_table_closes VALUES('10000000-0000-0000-0000-000000000009','30000000-0000-0000-0000-000000000009','{actor}','Ordinary Closed Control','closed');")
  run(psql,"INSERT INTO table_seats VALUES('10000000-0000-0000-0000-000000000009',NULL,'40000000-0000-0000-0000-000000000009');",refuse='OPERATOR_FLOOR_PARKED')


  assert run(psql,'SELECT count(*) FROM ca_operator_floor_hold;')=='0'
  run(psql,"UPDATE ca_launch_operator_scopes SET club_ids='{}';",refuse='launch_operator_scope_immutable')
  assert run(psql,"SELECT NOT has_function_privilege('authenticated','fn_ca_launch_operator_command(uuid,uuid,text,text,uuid)','EXECUTE');")=='t'
  result={'qualification':'passed','scope_isolation':True,'actual_original_floor_command_entry_and_acquisition_owners':True,'unrelated_active_tables_untouched':True,'existing_paid_tournament_seating_and_hands_continue':True,'new_entrant_admission_refused':True,'original_actor_authority_stubbed_for_isolated_fixture':True,'runtime_dealer_drain_not_yet_proven':True,'exact_owned_close_resume_replay_and_pending_refusal':True,'source_sha256':loaded_floor_sha,'candidate_migration_sha256':candidate_sha,'loaded_floor_extract_sha256':loaded_floor_sha,'production_installation':False}
  args.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
 finally:run([pg/'pg_ctl','-D',data,'-m','immediate','-w','stop'])

# Phase 7 closure qualification runs in this existing required accounting step.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-phase7-preserve-resolved-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))

# Unchanged weekly receipt freshness predicates use the actual concurrent indexes.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-weekly-source-freshness-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))
# Original-week bank receipt verification keeps ALL correlation legs indexed.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-weekly-bank-correlation-index-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch), '--output', str(args.output.with_name('weekly-bank-correlation-index-qualification.json'))], text=True))

# Installed proof lifetime remains connected to the finite inventory authority.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / "test-inventory-proof-lifetime-postgres.py"), "--pg-bin", str(pg), "--scratch", str(args.scratch)], text=True))
# Historical earning-club discovery uses exact indexed event witnesses.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-weekly-club-event-witness-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))

# Exact weekly cash maxima and accrued-rake bounds use their existing indexes.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-weekly-indexed-reads-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-weekly-cash-cohort-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))

# Actual skewed cash equality/range path and exact unaccrued receipt reader.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-weekly-cash-keyorder-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-weekly-cash-commission-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-weekly-cash-access-install-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))

# Fingerprints preserve source ordering while detoasting each window only once.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-weekly-window-r2-digests-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-weekly-window-earned-digests-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-weekly-window-digest-install-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))

# Historical routing membership and indexed exact-view earning witnesses.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-weekly-routing-period-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))

# Completed-week and statement club discovery share already accepted cash witnesses.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-weekly-cash-first-clubs-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))

# Each touched identity is proved once while every original event still counts.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-weekly-touched-identities-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))

# An in-progress close is visited without the whole scope-eligibility scan.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-weekly-in-progress-tick-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))

# The real certificate CHECK accepts the per-club quality key written by R4.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-weekly-statement-certificate-kind-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch), '--output', str(args.output.with_name('weekly-statement-certificate-kind'))], text=True))

# Fee source identities retain exact full FOR bags through the narrow UUID cover.
# The existing scoped-launch artifact retains this fail-closed native receipt.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-tournament-source-identity-cover-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch), '--output', str(args.output.with_name('tournament-source-identity-cover.json'))], text=True))

# Statement validation retains all original checks while reading indexed event owners.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / "test-weekly-statement-indexed-quality-postgres.py"), "--pg-bin", str(pg), "--scratch", str(args.scratch), "--output", str(args.output.with_name("weekly-statement-indexed-quality.json"))], text=True))

# The real parameterized FOR successor remains enforced, alongside the original
# indexed-owner qualification above. It may not replace or skip that history.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / "test-weekly-statement-indexed-quality-postgres.py"), "--followup-candidate", str(Path(__file__).resolve().parents[2] / "supabase/migrations/20261018185054_weekly_statement_quality_reads_source_and_batch_keysets_in_b.sql"), "--pg-bin", str(pg), "--scratch", str(args.scratch), "--output", str(args.output.with_name("weekly-statement-bulk-quality.json"))], text=True))

# Earning history never exposes a provably unfinished external transaction.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-atomic-accounting-history-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))

# An explicit restart of that original accrual preserves immutable receipts,
# refuses paid books and admits the exact unpaid atomic-history liabilities.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-unpaid-atomic-cash-contracts-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))

# Historical own playing earnings preserve paid legacy receipts and route new
# typed destinations through the actual document pipeline and original R0/R2/R3.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-own-agent-rakeback-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-own-agent-financial-postgres.py'), '--pg-bin', str(pg), '--scratch-root', str(args.scratch), '--output', str(args.output.with_name('own-agent-v1.json'))], text=True))

# A single weekly player entitlement preserves every historical payer through
# native R3 payments, documents, retired reserves and interruption/replay.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-historical-rakeback-payers-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-confirmed-rakeback-payers-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))

# A zero standalone book excludes only proven foreign obligations; real own
# sources and malformed certificates retain the original native refusals.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-historical-rakeback-payers-postgres.py'), '--coordinator-scope-only', '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))

# Revenue statements distinguish terminal payouts from successive funding transfers.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / "test-weekly-revenue-digest-postgres.py"), "--pg-bin", str(pg), "--scratch", str(args.scratch)], text=True))

# The satellite owner proof keeps all rows but seeks its exact tournament/player.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / "test-satellite-funding-user-index-postgres.py"), "--pg-bin", str(pg), "--scratch", str(args.scratch), "--output", str(args.output.with_name("satellite-funding-user-index.json"))], text=True))
# The original bounded weekly source counts use exact record-key membership.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-weekly-source-count-keysets-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))
# New chip clubs reconcile their zero-born wallets without fabricated baselines.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-new-club-conservation-origin-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))

# Original satellite ownership verifies its exact ledger receipt and forty-source guard.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / "test-satellite-ledger-identity-postgres.py"), "--pg-bin", str(pg), "--scratch", str(args.scratch)], text=True))

# The original standalone weekly bank is funding once, with its native mint lineage.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / "test-standalone-weekly-statement-funding-postgres.py"), "--pg-bin", str(pg), "--scratch", str(args.scratch)], text=True))

# The fee fingerprint serializes its unchanged economic object once; native
# semantic, admission ABI and atomic installer faults remain in this required floor.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / "test-weekly-fee-fingerprint-postgres.py"), "--pg-bin", str(pg), "--scratch", str(args.scratch), "--output", str(args.output.with_name("weekly-fee-fingerprint.json"))], text=True))

# Original cash freshness preserves earning scope plus late effective admissions.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-effective-source-freshness-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))

# Statement provenance remains on invoices, excluded by original delivery and private readers.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / "test-statement-provenance-delivery-postgres.py"), "--pg-bin", str(pg), "--scratch", str(args.scratch)], text=True))

# Original hand outcome reductions progress in bounded canonical native windows.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-native-weekly-hand-parts-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-weekly-hand-witness-window-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))
# Original weekly incomplete counts seek immutable source and batch keys per attribution.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-weekly-counts-indexed-incomplete-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch)], text=True))

# Original tournament membership keeps raw Union equality in its physical key.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-tournament-membership-union-key-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch), '--output', str(args.output.with_name('tournament-membership-union-key.json'))], text=True))

# Original shaped cash keeps its exact Boolean evidence gate in a fixed-width physical key.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-original-shaped-cash-boolgate-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch), '--output', str(args.output.with_name('original-shaped-cash-boolgate.json'))], text=True))

# Original Boolean index statistics are collected by the guarded owning migration.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-original-shaped-cash-statistics-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch), '--output', str(args.output.with_name('original-shaped-cash-statistics.json'))], text=True))

# Original linked cash uses a lossless long-text partial proof selector.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-original-linked-cash-spgist-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch), '--output', str(args.output.with_name('original-linked-cash-spgist.json'))], text=True))

# Bounded physical rake evidence keeps every original oversized row on fallback.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-rake-record-bounded-cover-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch), '--output', str(args.output.with_name('rake-record-bounded-cover.json'))], text=True))

# Genuine relation-level linked-cash union statistics are qualified without changing original proof owners.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-original-linked-cash-statistics-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch), '--output', str(args.output.with_name('original-linked-cash-statistics.json'))], text=True))

# Original cash refusal reads scope and clock bounds before blocked IDs.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-cash-refusal-scope-time-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch), '--output', str(args.output.with_name('cash-refusal-scope-time.json'))], text=True))

# Original tournament quality consumes bounded physical evidence atomically.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-tournament-quality-bounded-evidence-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch), '--output', str(args.output.with_name('tournament-quality-bounded-evidence.json'))], text=True))

# Three unsealed original cash readers preserve the genuine generation.
print(subprocess.check_output([sys.executable, str(Path(__file__).resolve().parent / 'test-original-cash-three-helper-forward-postgres.py'), '--pg-bin', str(pg), '--scratch', str(args.scratch), '--output', str(args.output.with_name('original-cash-three-helper-forward.json'))], text=True))
