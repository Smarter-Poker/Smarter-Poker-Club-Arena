# Preserve the already qualified wallet-jackpot change while proving treasury.
import re
q((B/'actual-extra-tables.sql').read_text())
w=json.loads((B/'captured-card-free-witness.json').read_text())
tables={k:{}for k in ['bbj_pools','bbj_payouts','bbj_payout_recipients','wallet_credit_idempotency','chip_ledger','chip_transactions','union_pnl_original_flows','bbj_unclaimed_shares']}
def add(table,row):
 if row:tables[table][row.get('id',row.get('key',row.get('ledger_id')))]=row
for record in w['records']:
 add('bbj_payouts',record['payout']);add('bbj_payout_recipients',record['recipient']);add('wallet_credit_idempotency',record['wallet_key']);add('union_pnl_original_flows',record['original']);add('chip_ledger',record['original']['ledger_snapshot'])
 for z in record['pool_legs']:add('chip_ledger',z)
 for z in record['wallet_journals']:add('chip_transactions',z)
for key,table in [('pools','bbj_pools'),('unclaimed','bbj_unclaimed_shares')]:
 for row in w[key]or[]:add(table,row)
for table,rows in tables.items():
 if rows:load(table,list(rows.values()))
m=(B/'qualified-bbj-03208.sql').read_text()
def bbj_body(body):
 for i in range(8):
  old=re.search(r'\$anchor'+str(i)+r'\$(.*?)\$anchor'+str(i)+r'\$',m,re.S).group(1)
  new=re.search(r'\$replacement'+str(i)+r'\$(.*?)\$replacement'+str(i)+r'\$',m,re.S).group(1)
  assert body.count(old)==1
  body=body.replace(old,new)
 return body
exec(compile((R/'native-stale-flows.py').read_text(),str(R/'native-stale-flows.py'),'exec'),globals(),globals())
originals=[bbj_body(body)for body in originals]
