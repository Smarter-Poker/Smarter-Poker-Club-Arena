#!/usr/bin/env python3
"""Actual legacy and captured owners in the original outer dispatcher."""
import os,sys,json,hashlib,subprocess
from pathlib import Path
from decimal import Decimal
sys.path.insert(0,os.environ['ROUND1_HERE'])
from fixture_helpers import sql,setup,source,state
here=Path(os.environ['CASCADE_HERE']);source_input=Path(os.environ['CASCADE_SOURCE_INPUT']);payer=Path(os.environ['CASCADE_PAYER_INPUT'])
checks=[]
def check(name,p):
 assert p,name
 checks.append(name);print('PASS: '+name,flush=True)
def value(q,actor=100):return json.loads(sql(q,actor=actor).splitlines()[-1],parse_float=Decimal)
def load(p):sql(p.read_text())
def refused(name,q,error):
 before=state();e=sql(q,False);check(name,error in e and before==state())
setup()
# The isolated auth fixture must contain the existing money owners' fixed
# ledger attribution identity. No membership, balance or caller subject is made.
sql("INSERT INTO auth.users(id) VALUES('2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid) ON CONFLICT DO NOTHING;")
for name in ['fixture-view.sql','00-expand.sql'] :load(source_input/name)
subprocess.run([os.environ['COMMISSION_PSQL'],'-X','-q','-v','ON_ERROR_STOP=1','-f',str(source_input/'00-online-index.sql')],check=True)
for name in ['00-preflight.sql','01-source-exclusion.sql','02-excluded-owners.sql','03-excluded-unpaid-rollups.sql']:load(source_input/name)
for name in ['01-shared-basis.sql','02-legacy-round1.sql','03-legacy-claim.sql','04-legacy-round3.sql']:load(payer/name)
load(Path(os.environ['ROUND1_INPUT'])/'capacity-owner/04-agent-payment.sql')
load(Path(os.environ['ROUND1_HERE']).parent/'player-capacity-proposal.sql')
load(here/'installed-period-finalizer.sql')
load(here/'01-source-dispatch.sql')
load(here/'tracked-cron-callers.sql')
acl_query="SELECT jsonb_object_agg(p.proname,p.proacl::text) FROM pg_proc p WHERE p.oid IN ('fn_union_settlement_cascade(uuid,timestamptz,timestamptz)'::regprocedure,'fn_union_settlement_cascade_all(timestamptz,timestamptz)'::regprocedure,'fn_union_settlement_cascade_due()'::regprocedure);"
acl_before=value(acl_query)
load(here/'02-outer-cascade.sql')
load(here/'03-cron-diagnostics.sql')
