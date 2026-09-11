from pathlib import Path
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
import json, subprocess

base=Path(__file__).resolve().parent
state=json.loads((base/'cluster.json').read_text())
assert state['cluster'].startswith('/tmp/ca-e2-owned-') and state['database']=='d1_7aa16fa7'
psql=['/opt/homebrew/opt/postgresql@17/bin/psql','-X','-v','ON_ERROR_STOP=1','-h',state['socket'],'-p',str(state['port']),'-U','postgres','-d',state['database'],'-Atc']
def query(sql):
    r=subprocess.run(psql+[sql],capture_output=True,text=True,check=True)
    if r.stderr.strip(): raise RuntimeError(r.stderr)
    return json.loads(r.stdout)
def read(n):return json.loads((base/n).read_text())
core=read('live-event-core.json');witness=read('live-event-witnesses.json')
tank='373a7bc7-1505-4c4c-b6b0-ba437b569a8a'
survivors=sorted([p for p in core['players'] if p['status']=='playing'],key=lambda p:(p['chips'],p['user_id']),reverse=True)
winner=survivors[0]['user_id']
expected=read('expected-historical-positions.json')['ruling']
expected.update({p['user_id']:i+1 for i,p in enumerate(survivors)})
actual=query('SELECT jsonb_agg(to_jsonb(p)) FROM tournament_players p')
assert len(actual)==385 and all(p['position']==expected[p['user_id']] for p in actual)
assert expected[tank]==36
ladder=json.loads(core['tournament']['payout_structure'],parse_float=Decimal)
bps=[int((Decimal(str(x['percentage']))*100).quantize(Decimal(1),rounding=ROUND_HALF_UP)) for x in ladder]
remaining=20440;amounts={}
for i,(row,bp) in enumerate(zip(ladder,bps)):
    amount=remaining if i==len(ladder)-1 else min(remaining,int((Decimal(20440)*bp/sum(bps)).quantize(Decimal(1),rounding=ROUND_HALF_UP)))
    amounts[row['place']]=amount;remaining-=amount
payouts=query('SELECT jsonb_agg(to_jsonb(p) ORDER BY position) FROM tournament_payouts p')
assert len(payouts)==39 and sum(int(Decimal(str(p['amount']))*100) for p in payouts)==20440
assert all(expected[p['user_id']]==p['position'] and int(Decimal(str(p['amount']))*100)==amounts[p['position']] for p in payouts)
proof=query("""SELECT jsonb_build_object(
 'status',(SELECT status FROM tournaments),'escrow',(SELECT to_jsonb(e) FROM tournament_escrow e),
 'member_credit',(SELECT sum(m.chip_balance-b.chip_balance) FROM club_members m JOIN d1.before_club_members b USING(club_id,user_id)),
 'union_rake_credit',(SELECT sum(w.rake_wallet-b.rake_wallet) FROM union_wallets w JOIN d1.before_union_wallets b USING(id)),
 'rake_settlement',(SELECT to_jsonb(r) FROM tournament_rake_settlements r),
 'new_ledger_total',(SELECT sum(l.amount) FROM chip_ledger l LEFT JOIN d1.before_chip_ledger b USING(id) WHERE b.id IS NULL),
 'original_ledger_unchanged',NOT EXISTS(SELECT 1 FROM d1.before_chip_ledger b LEFT JOIN chip_ledger l USING(id) WHERE to_jsonb(b) IS DISTINCT FROM to_jsonb(l)),
 'original_wallet_financial_fields_unchanged',NOT EXISTS(SELECT 1 FROM d1.before_wallet_transactions b LEFT JOIN wallet_transactions w USING(id) WHERE to_jsonb(b)-'terminal_closed_at' IS DISTINCT FROM to_jsonb(w)-'terminal_closed_at'),
 'original_entitlements_unchanged',NOT EXISTS(SELECT 1 FROM d1.before_tournament_refund_entitlements b LEFT JOIN tournament_refund_entitlements e USING(id) WHERE to_jsonb(b) IS DISTINCT FROM to_jsonb(e)),
 'terminal_receipts',(SELECT count(*) FROM tournament_terminal_settlements),
 'remaining_live_seats',(SELECT count(*) FROM table_seats WHERE left_at IS NULL),
 'pending_wakes',(SELECT count(*) FROM tournament_manager_wakes WHERE consumed_at IS NULL),
 'trigger_execution',current_setting('session_replication_role'))""")
assert proof['status']=='COMPLETED' and proof['trigger_execution']=='origin'
assert Decimal(str(proof['member_credit']))==Decimal('204.40')
assert Decimal(str(proof['union_rake_credit']))==Decimal('11.60')
assert Decimal(str(proof['new_ledger_total']))==Decimal('216.00')
assert proof['rake_settlement']['attributed_at'] and proof['rake_settlement']['attribution_error'] is None
for key in ['original_ledger_unchanged','original_wallet_financial_fields_unchanged','original_entitlements_unchanged']:assert proof[key],key
assert all(Decimal(str(proof['escrow'][k]))==0 for k in ['prize_balance','fee_balance','bounty_balance'])
assert proof['escrow']['closed_at'] and proof['terminal_receipts']==1 and proof['remaining_live_seats']==0 and proof['pending_wakes']==0
tables=['tournaments','tournament_players','tournament_payouts','tournament_obligations','tournament_terminal_settlements','tournament_escrow','chip_ledger','wallet_transactions','club_members','union_wallets','club_wallets','tables','table_seats','tournament_manager_wakes','tournament_knockout_candidates','hand_atomic_commits','tournament_refund_entitlements','tournament_knockout_invalidations']
def hashes():return {t:query(f"SELECT to_jsonb(md5(coalesce(jsonb_agg(j ORDER BY j::text),'[]')::text)) FROM (SELECT to_jsonb(x) j FROM {t} x) s") for t in tables}
before=hashes();replay=query("SELECT fn_complete_tournament_terminal('7aa16fa7-adf7-4fb9-81b9-b565d8e4af7d','"+winner+"','places')");after=hashes()
assert before==after and replay['status']=='COMPLETED'
history=query("""SELECT jsonb_build_object(
 'candidate_identity_fields_unchanged',NOT EXISTS(SELECT 1 FROM d1.before_tournament_knockout_candidates b LEFT JOIN tournament_knockout_candidates c USING(id) WHERE to_jsonb(b)-ARRAY['state','resolved_at'] IS DISTINCT FROM to_jsonb(c)-ARRAY['state','resolved_at']),
 'captured_atomic_receipts_unchanged',NOT EXISTS(SELECT 1 FROM d1.before_hand_atomic_commits b LEFT JOIN hand_atomic_commits a USING(table_id,hand_number) WHERE to_jsonb(b) IS DISTINCT FROM to_jsonb(a)),
 'historical_status_chips_sequence_unchanged',NOT EXISTS(SELECT 1 FROM d1.before_tournament_players b JOIN tournament_players p USING(id) WHERE b.status='eliminated' AND (p.status,p.chips,p.elimination_sequence) IS DISTINCT FROM (b.status,b.chips,b.elimination_sequence)),
 'other_historical_times_unchanged',NOT EXISTS(SELECT 1 FROM d1.before_tournament_players b JOIN tournament_players p USING(id) WHERE b.status='eliminated' AND b.user_id<>'373a7bc7-1505-4c4c-b6b0-ba437b569a8a' AND p.eliminated_at IS DISTINCT FROM b.eliminated_at),
 'ruling',(SELECT to_jsonb(e) FROM tournament_knockout_invalidations e),
 'latest_candidate_still_invalidated',(SELECT state='invalidated' FROM tournament_knockout_candidates WHERE id=fn_ca_latest_committed_knockout_candidate('7aa16fa7-adf7-4fb9-81b9-b565d8e4af7d','373a7bc7-1505-4c4c-b6b0-ba437b569a8a')))
""")
for k in ['candidate_identity_fields_unchanged','captured_atomic_receipts_unchanged','historical_status_chips_sequence_unchanged','other_historical_times_unchanged','latest_candidate_still_invalidated']:assert history[k],k
orders=read('expected-historical-positions.json')
moved=sum(orders['ruling'][u]==v-1 for u,v in orders['ordinary'].items() if u!=tank)
assert moved==23 and orders['ordinary'][tank]==13
assert next(p for p in payouts if p['user_id']==tank)['amount']==1.94
receipt={'verifiedAt':datetime.now(timezone.utc).isoformat(),'eventId':core['tournament']['id'],'expectedOrderAll385Matches':True,'tankChamp':{'userId':tank,'currentCachedPlace':12,'currentCachedPrize':4.68,'ordinaryTrueOrderPlace':13,'ordinaryTrueOrderPrize':4.37,'ruledPlace':36,'ruledPrize':1.94,'otherFinishersMovedUp':23},'resequencingToggles':0,'proof':proof,'history':history,'payouts':[{'place':p['position'],'userId':p['user_id'],'amount':p['amount']} for p in payouts],'idempotentTerminalReplay':{'unchanged':True,'beforeHashes':before,'afterHashes':after}}
(base/'verification-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'status':'COMPLETED','payouts':39,'prizes':'204.40','unionRake':'11.60','tankPlace':36,'tankPrize':1.94,'otherMovers':23,'idempotentReplay':True}))
