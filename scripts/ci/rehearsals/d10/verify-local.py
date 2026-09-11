from pathlib import Path
from datetime import datetime, timezone
from decimal import Decimal
import json, subprocess

base=Path(__file__).resolve().parent
state=json.loads((base/'cluster.json').read_text())
assert state['cluster'].startswith('/tmp/ca-e2-owned-') and state['database']=='d10_c1f15c30'
psql=['/opt/homebrew/opt/postgresql@17/bin/psql','-X','-v','ON_ERROR_STOP=1','-h',state['socket'],'-p',str(state['port']),'-U','postgres','-d',state['database'],'-Atc']
def query(sql):
    r=subprocess.run(psql+[sql],capture_output=True,text=True,check=True)
    if r.stderr.strip():raise RuntimeError(r.stderr)
    return json.loads(r.stdout)
tid='c1f15c30-33c4-4a64-85ac-44037519ca5b';winner='5a0cd7e0-174a-466f-ba1d-6d2c80d9252a'
proof=query("""SELECT jsonb_build_object(
 'status',(SELECT status FROM tournaments),'escrow',(SELECT to_jsonb(e) FROM tournament_escrow e),
 'member_credit',(SELECT sum(m.chip_balance-b.chip_balance) FROM club_members m JOIN d10.before_members b USING(club_id,user_id)),
 'union_rake_credit',(SELECT sum(w.rake_wallet-b.rake_wallet) FROM union_wallets w JOIN d10.before_union_wallets b USING(id)),
 'rake_settlement',(SELECT to_jsonb(r) FROM tournament_rake_settlements r),
 'new_ledger_total',(SELECT sum(l.amount) FROM chip_ledger l LEFT JOIN d10.before_ledger b USING(id) WHERE b.id IS NULL),
 'new_wallet_transactions',(SELECT count(*) FROM wallet_transactions w LEFT JOIN d10.before_wallet_transactions b USING(id) WHERE b.id IS NULL),
 'original_ledger_unchanged',NOT EXISTS(SELECT 1 FROM d10.before_ledger b LEFT JOIN chip_ledger l USING(id) WHERE to_jsonb(b) IS DISTINCT FROM to_jsonb(l)),
 'original_wallet_financial_fields_unchanged',NOT EXISTS(SELECT 1 FROM d10.before_wallet_transactions b LEFT JOIN wallet_transactions w USING(id) WHERE to_jsonb(b)-'terminal_closed_at' IS DISTINCT FROM to_jsonb(w)-'terminal_closed_at'),
 'original_entitlements_unchanged',NOT EXISTS(SELECT 1 FROM d10.before_entitlements b LEFT JOIN tournament_refund_entitlements e USING(id) WHERE to_jsonb(b) IS DISTINCT FROM to_jsonb(e)),
 'original_payouts_unchanged',NOT EXISTS(SELECT 1 FROM d10.before_tournament_payouts b FULL JOIN tournament_payouts p USING(id) WHERE to_jsonb(b)-'terminal_closed_at' IS DISTINCT FROM to_jsonb(p)-'terminal_closed_at'),
 'original_obligations_unchanged',NOT EXISTS(SELECT 1 FROM d10.before_tournament_obligations b FULL JOIN tournament_obligations o USING(id) WHERE to_jsonb(b)-ARRAY['terminal_closed_at','updated_at'] IS DISTINCT FROM to_jsonb(o)-ARRAY['terminal_closed_at','updated_at']),
 'original_wallet_keys_unchanged',NOT EXISTS(SELECT 1 FROM d10.before_wallet_credit_idempotency b FULL JOIN wallet_credit_idempotency k USING(key) WHERE to_jsonb(b) IS DISTINCT FROM to_jsonb(k)),
 'original_receipts_unchanged',NOT EXISTS(SELECT 1 FROM d10.before_settlement_idempotency_keys b FULL JOIN settlement_idempotency_keys s USING(table_id,hand_id) WHERE to_jsonb(b) IS DISTINCT FROM to_jsonb(s)),
 'original_contract_history_unchanged',NOT EXISTS(SELECT 1 FROM d10.before_managed_game_contract_versions b LEFT JOIN managed_game_contract_versions c USING(id) WHERE to_jsonb(b) IS DISTINCT FROM to_jsonb(c)),
 'all_positions_status_chips_sequences_unchanged',NOT EXISTS(SELECT 1 FROM d10.before_players b FULL JOIN tournament_players p USING(id) WHERE (b.user_id,b.position,b.status,b.chips,b.eliminated_at,b.elimination_sequence) IS DISTINCT FROM (p.user_id,p.position,p.status,p.chips,p.eliminated_at,p.elimination_sequence)),
 'terminal_receipts',(SELECT count(*) FROM tournament_terminal_settlements),
 'remaining_live_seats',(SELECT count(*) FROM table_seats WHERE left_at IS NULL),
 'pending_wakes',(SELECT count(*) FROM tournament_manager_wakes WHERE consumed_at IS NULL),
 'trigger_execution',current_setting('session_replication_role'))""")
assert proof['status']=='COMPLETED' and proof['trigger_execution']=='origin'
assert Decimal(str(proof['member_credit']))==0 and proof['new_wallet_transactions']==0
assert Decimal(str(proof['union_rake_credit']))==20 and Decimal(str(proof['new_ledger_total']))==20
for key,value in proof.items():
    if key.endswith('_unchanged'):assert value,key
assert proof['rake_settlement']['attributed_at'] and proof['rake_settlement']['attribution_error'] is None
assert all(Decimal(str(proof['escrow'][k]))==0 for k in ['prize_balance','fee_balance','bounty_balance'])
assert proof['escrow']['closed_at'] and proof['terminal_receipts']==1 and proof['remaining_live_seats']==0 and proof['pending_wakes']==0
tables=['tournaments','tournament_players','tournament_payouts','tournament_obligations','tournament_terminal_settlements','tournament_escrow','chip_ledger','wallet_transactions','club_members','union_wallets','club_wallets','tables','table_seats','tournament_manager_wakes','tournament_knockout_candidates','hand_atomic_commits','tournament_refund_entitlements','managed_game_contract_versions','settlement_idempotency_keys','wallet_credit_idempotency']
def hashes():return {t:query(f"SELECT to_jsonb(md5(coalesce(jsonb_agg(j ORDER BY j::text),'[]')::text)) FROM (SELECT to_jsonb(x) j FROM {t} x) s") for t in tables}
before=hashes();replay=query(f"SELECT fn_complete_tournament_terminal('{tid}','{winner}','places')");after=hashes()
assert before==after and replay['status']=='COMPLETED'
payouts=query('SELECT jsonb_agg(to_jsonb(p) ORDER BY position) FROM tournament_payouts p')
assert len(payouts)==6 and sum(Decimal(str(p['amount'])) for p in payouts)==180
receipt={'verifiedAt':datetime.now(timezone.utc).isoformat(),'eventId':tid,'resequencingToggles':0,'preservedPaidAmount':'180.00','newPlaceMoney':'0.00','rakeSettled':'20.00','D8Debt':'121.45','proof':proof,'payouts':payouts,'idempotentTerminalReplay':{'unchanged':True,'beforeHashes':before,'afterHashes':after}}
(base/'verification-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'status':'COMPLETED','paidPlacesPreserved':6,'paidAmountPreserved':'180.00','newPlaceMoney':'0.00','unionRake':'20.00','D8Debt':'121.45','idempotentReplay':True}))
