#!/usr/bin/env python3
"""Private PG17 original funding/roster regression, on the existing journal fixture.
Policy/auth helper fixtures remain controlled; this is not full production financial certification.
"""
import json, os, subprocess, tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
FIX=ROOT/'tests/fixtures/cash-participant-funding'
PG=Path(os.environ.get('PG17_BINDIR','/opt/homebrew/opt/postgresql@17/bin'))
subprocess.run(['python3',str(FIX/'build-candidate.py'),'--check'],check=True)
parent=os.environ.get('ACCOUNTING_FIXTURE_PARENT','/tmp')
rows=json.loads((FIX/'captured-preimages.json').read_text())+json.loads((FIX/'captured-hand-preimages.json').read_text())+json.loads((FIX/'captured-integration-preimages.json').read_text())+json.loads((FIX/'captured-reader-preimages.json').read_text())
with tempfile.TemporaryDirectory(prefix='u-fund-',dir=parent) as temp:
 base=Path(temp); socket=base/'s'; socket.mkdir()
 subprocess.run([str(PG/'initdb'),'-D',str(base/'data'),'-U','postgres','-A','trust','--no-locale','-E','UTF8'],check=True,capture_output=True)
 subprocess.run([str(PG/'pg_ctl'),'-D',str(base/'data'),'-l',str(base/'postgres.log'),'-o',f"-k {socket} -p 55468 -c listen_addresses=''",'-w','start'],check=True,capture_output=True)
 try:
  def run(sql):
   sql_file=base/'input.sql'; sql_file.write_text(sql)
   if os.environ.get('PGNODE'):
    env=dict(os.environ,PGHOST=str(socket),PGPORT='55468',PGUSER='postgres',PGDATABASE='postgres')
    with sql_file.open() as source:
     p=subprocess.run([os.environ['PGNODE'],str(ROOT/'scripts/ci/probes/chip-journal-atomicity/postgres-runtime/query.mjs')],stdin=source,text=True,capture_output=True,timeout=90,env=env)
   else:
    p=subprocess.run([str(PG/'psql'),'-X','-q','-v','ON_ERROR_STOP=1','-h',str(socket),'-p','55468','-U','postgres','-d','postgres','-f',str(sql_file)],text=True,capture_output=True,timeout=90)
   if p.returncode: raise AssertionError(p.stderr)
   return p.stdout
  setup=(ROOT/'scripts/ci/probes/chip-journal-atomicity/fixture.sql').read_text()+(FIX/'bootstrap.sql').read_text()
  for r in rows:
   setup+=r['definition']+';\n'
   setup+=f"REVOKE ALL ON FUNCTION public.{r['signature']} FROM PUBLIC,anon,authenticated,service_role;\n"
   if 'service_role=' in r['acl']: setup+=f"GRANT EXECUTE ON FUNCTION public.{r['signature']} TO service_role;\n"
  setup+="CREATE TRIGGER trg_club_members_audit_chip_movement AFTER UPDATE OF chip_balance ON public.club_members FOR EACH ROW WHEN (OLD.chip_balance IS DISTINCT FROM NEW.chip_balance) EXECUTE FUNCTION public.fn_club_members_ledger_writer();"
  run(setup)
  migration=ROOT/'supabase/migrations/20260917230925_cash_funding_retains_original_participant_custody.sql'
  run(migration.read_text())
  run((ROOT/'supabase/migrations/20260917232243_union_cash_pnl_reads_original_participant_receipts.sql').read_text())
  regression=(FIX/'regression.sql').read_text()
  old_buyin=next(r['definition'] for r in rows if r['signature'].startswith('atomic_table_buyin_'))
  red=regression[:regression.index('SELECT pg_temp.assert((SELECT amount=100')]
  try:
   run('BEGIN;'+old_buyin+';'+red+'ROLLBACK;')
  except AssertionError as error:
   if 'Every original admission including unkeyed must capture exactly one actual ledger' not in str(error): raise
   print('PASS red proof: original buy-in core fails retained original-ledger coverage assertion')
  else: raise AssertionError('Original uncaptured core unexpectedly passed the receipt regression')
  marker='-- A horse treasury top-up'
  prefix,suffix=regression.split(marker,1)
  run(prefix+(FIX/'reader-regression.sql').read_text()+marker+suffix+(FIX/'reader-legacy-regression.sql').read_text())
  retention=(FIX/'retention-bootstrap.sql').read_text()
  for r in json.loads((FIX/'captured-retention-preimages.json').read_text()):
   retention+=r['definition']+';\n'
   retention+=f"REVOKE ALL ON FUNCTION public.{r['signature']} FROM PUBLIC,anon,authenticated,service_role;\n"
   if 'service_role=' in r['acl']: retention+=f"GRANT EXECUTE ON FUNCTION public.{r['signature']} TO service_role;\n"
  run(retention)
  run((ROOT/'supabase/migrations/20260917233517_horse_hand_history_retains_eight_days.sql').read_text())
  run((FIX/'retention-regression.sql').read_text())
  print('PASS original funding, accepted-owner and PNL transactions, exact signed oracle, retained accounting proof, and eight-day history pruning')
 finally:
  subprocess.run([str(PG/'pg_ctl'),'-D',str(base/'data'),'-m','immediate','-w','stop'],check=True,capture_output=True)
