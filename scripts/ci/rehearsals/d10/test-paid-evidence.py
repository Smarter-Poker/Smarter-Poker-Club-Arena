"""The exact ruling must refuse incomplete paid identity and a second execution."""
from pathlib import Path
import json,subprocess,sys

base=Path(__file__).resolve().parent
state=json.loads((base/'cluster.json').read_text())
assert state['cluster'].startswith('/tmp/ca-e2-owned-') and state['database']=='d10_c1f15c30'
psql=['/opt/homebrew/opt/postgresql@17/bin/psql','-X','-v','ON_ERROR_STOP=1','-h',state['socket'],'-p',str(state['port']),'-U','postgres','-d',state['database']]
tables=['tournaments','tournament_players','tournament_payouts','tournament_obligations','tournament_terminal_settlements','tournament_escrow','chip_ledger','wallet_transactions','club_members','union_wallets','club_wallets','tables','table_seats','tournament_manager_wakes','tournament_knockout_candidates','hand_atomic_commits','tournament_refund_entitlements','managed_game_contract_versions','settlement_idempotency_keys','wallet_credit_idempotency']
def hashes():
    return {t:subprocess.check_output(psql+['-Atc',f"SELECT md5(coalesce(jsonb_agg(j ORDER BY j::text),'[]')::text) FROM (SELECT to_jsonb(x) j FROM {t} x) s"],text=True).strip() for t in tables}
before=hashes();phase=sys.argv[1]
prefix=''
if phase=='pre':
    prefix="BEGIN; DELETE FROM wallet_credit_idempotency WHERE key=(SELECT idempotency_key FROM tournament_payouts WHERE position=1);\n"
    error='tournament wallet credit claims are append-only'
else:
    assert phase=='post'
    error='preflight: tournament row is not the COMPLETING 180.00 event'
# The archived ruling file itself is passed whole and byte-for-byte. The
# precondition corruption is transaction-local and rolls back on its refusal.
result=subprocess.run(psql,input=prefix+(base/'ruling_c1f15c30.sql').read_text(),text=True,capture_output=True)
assert result.returncode and error in result.stderr,result.stderr
after=hashes();assert before==after
receipt={'phase':phase,'case':'original_wallet_credit_identity_cannot_be_deleted' if phase=='pre' else 'whole_ruling_replay','refused':True,'expectedError':error,'observedTables':len(tables),'unchanged':True,'beforeHashes':before,'afterHashes':after}
(base/f'negative-{phase}-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({k:v for k,v in receipt.items() if not k.endswith('Hashes')}))
