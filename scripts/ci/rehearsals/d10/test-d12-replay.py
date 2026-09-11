"""Apply reviewed guard restoration only after D10 is completed, then replay."""
from pathlib import Path
import hashlib,json,subprocess

base=Path(__file__).resolve().parent
state=json.loads((base/'cluster.json').read_text())
assert state['cluster'].startswith('/tmp/ca-e2-owned-') and state['database']=='d10_c1f15c30'
psql=['/opt/homebrew/opt/postgresql@17/bin/psql','-X','-v','ON_ERROR_STOP=1','-h',state['socket'],'-p',str(state['port']),'-U','postgres','-d',state['database']]
def query(sql):return json.loads(subprocess.check_output(psql+['-Atc',sql],text=True))
tables=['tournaments','tournament_players','tournament_payouts','tournament_obligations','tournament_terminal_settlements','tournament_escrow','chip_ledger','wallet_transactions','club_members','union_wallets','club_wallets','tables','table_seats','tournament_manager_wakes','tournament_knockout_candidates','hand_atomic_commits','tournament_refund_entitlements','managed_game_contract_versions','settlement_idempotency_keys','wallet_credit_idempotency']
def hashes():return {t:query(f"SELECT to_jsonb(md5(coalesce(jsonb_agg(j ORDER BY j::text),'[]')::text)) FROM (SELECT to_jsonb(x) j FROM {t} x) s") for t in tables}
assert query("SELECT to_jsonb(status) FROM tournaments")=='COMPLETED'
# Original schema-only donor omitted these existing ACLs. Restore the observed
# service-only entry points before testing a migration that preserves them.
service_functions=['fn_settle_tournament_places(uuid,uuid)','fn_complete_tournament_terminal(uuid,uuid,text)','trg_tournament_atomic_place_completion_guard()','trg_freeze_batched_tournament_place()']
acl='BEGIN;'
for f in service_functions+['fn_tournament_finish_readiness(uuid,uuid)']:
    acl+=f'REVOKE ALL ON FUNCTION public.{f} FROM PUBLIC,anon,authenticated,service_role;'
    if f in service_functions:acl+=f'GRANT EXECUTE ON FUNCTION public.{f} TO service_role;'
acl+='COMMIT;'
subprocess.run(psql+['-c',acl],check=True,capture_output=True,text=True)
before=hashes()
migration=base/'d12-preview.sql'
result=subprocess.run(psql+['-f',str(migration)],capture_output=True,text=True)
(base/'d12-migration.log').write_text(result.stdout+result.stderr)
assert result.returncode==0,result.stderr
after_migration=hashes();assert before==after_migration
replay=query("SELECT fn_complete_tournament_terminal('c1f15c30-33c4-4a64-85ac-44037519ca5b','5a0cd7e0-174a-466f-ba1d-6d2c80d9252a','places')")
after_replay=hashes();assert before==after_replay and replay['status']=='COMPLETED'
names=['aa_guard_tournament_completing_claim','aaa_guard_atomic_satellite_completion','zzzz_freeze_finalized_tournament_prize_pool','zzzz_tournament_pool_finalization_window_guard','zzzz_tournaments_atomic_place_completion_guard','zzzzz_tournaments_atomic_final_table_deal_completion_guard','zzzzzz_tournaments_financial_certificate']
guards=query("SELECT jsonb_object_agg(tgname,tgenabled) FROM pg_trigger WHERE tgrelid='tournaments'::regclass AND tgname IN ("+','.join("'"+n+"'" for n in names)+')')
assert len(guards)==7 and set(guards.values())=={'O'}
receipt={'D10CompletedBeforeGuardMigration':True,'d12MigrationSha256':hashlib.sha256(migration.read_bytes()).hexdigest(),'restoredObservedFunctionAcls':service_functions,'readinessOwnerOnly':True,'sevenGuards':guards,'paidRecordAndApplicationRowsUnchangedByMigrationAndReplay':True,'observedTables':len(tables),'beforeHashes':before,'afterMigrationHashes':after_migration,'afterReplayHashes':after_replay}
(base/'d12-replay-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({k:v for k,v in receipt.items() if not k.endswith('Hashes')}))
