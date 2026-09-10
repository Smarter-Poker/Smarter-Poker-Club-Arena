import os,subprocess,re
from pathlib import Path
p=Path(os.environ['ROUND1_INPUT']);here=Path(os.environ['ROUND1_HERE']);psql=os.environ['COMMISSION_PSQL']
def sql(s):
 r=subprocess.run([psql,'-X','-q','-v','ON_ERROR_STOP=1'],input=s,text=True,capture_output=True)
 if r.returncode: raise RuntimeError(r.stderr)
source=p/'source-authority'
sql("BEGIN;\n"+"\n".join(f.read_text() for f in [source/'bank-owner/01-bank-receipts.sql',source/'bank-owner/02-bank-owner.sql',source/'03-receipt-source-boundary.sql',source/'04-cash-admission.sql',source/'05-immutable-receipts.sql'])+"\nCOMMIT;")
base=(here.parent/'source-payer-proposal.sql').read_text()
start=base.index('CREATE FUNCTION public.fn_lock_rakeback_payer_clubs')
end=base.index('CREATE FUNCTION public.fn_pay_captured_rakeback_period',start)
sql(base[start:end])
for name in ['01-capacity-schema.sql','02-source-admission.sql','03-capacity-assertions.sql']:
 sql((p/'capacity-owner'/name).read_text())
sql((here/'01-release-writer.sql').read_text())
sql((here/'fixture-clock.sql').read_text())
print("Loaded unchanged accepted/bank owners and prospective Round1 with actual money graph")
