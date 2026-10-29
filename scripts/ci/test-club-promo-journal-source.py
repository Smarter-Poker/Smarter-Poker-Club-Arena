#!/usr/bin/env python3
"""Real PG17 journal readers and payment/trigger wiring, isolated from production."""
import argparse,json,pathlib,subprocess,shutil,os,hashlib
ROOT=pathlib.Path(__file__).resolve().parents[2]
MIGRATION='supabase/migrations/20261029065153_club_promo_send_names_its_journal_source_column.sql'
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--pg-bin',type=pathlib.Path,required=True);p.add_argument('--work-root',type=pathlib.Path,required=True);p.add_argument('--evidence',type=pathlib.Path,required=True);a=p.parse_args()
 work=a.work_root.resolve();work.mkdir(parents=True,exist_ok=False);out=a.evidence.resolve();out.mkdir(parents=True,exist_ok=False)
 if os.uname().sysname=='Darwin' and not str(work).startswith('/Volumes/SmarterWork/agent-work/'):
  raise RuntimeError('external SSD required')
 sock=work/'s';sock.mkdir();data=work/'pg';log=out/'postgres.log';pg=a.pg_bin.resolve();env=dict(os.environ,TMPDIR=str(work))
 def run(args,**kw):return subprocess.run([str(x) for x in args],env=env,text=True,capture_output=True,check=True,**kw)
 def sql(text):
  try:return run([pg/'psql','-X','-v','ON_ERROR_STOP=1','-At','-h',sock,'-p','57739','-U','postgres','postgres'],input=text).stdout
  except subprocess.CalledProcessError as e:
   print(e.stderr);raise
 report={'checks':[],'scope':'actual captured payment, two triggers, declaration and all three readers on isolated PG17; auth and permission dependencies use explicit fixture stubs; no live writes'}
 started=False
 try:
  run([pg/'initdb','-D',data,'-U','postgres','-A','trust','--no-locale']);run([pg/'pg_ctl','-D',data,'-l',log,'-o',f"-k {sock} -p 57739 -h ''",'start']);started=True
  fixture=(ROOT/'scripts/ci/fixtures/club-promo-journal-schema.sql').read_text();sql(fixture)
  sources=[]
  for name in ('source','writers','declaration'):sources+=json.loads((ROOT/f'scripts/ci/fixtures/club-promo-journal-{name}.json').read_text())
  for x in sources:
   sql(x['definition']+';\nREVOKE ALL ON FUNCTION public.'+x['signature']+' FROM PUBLIC;'+('GRANT EXECUTE ON FUNCTION public.'+x['signature']+' TO service_role;' if 'service_role' in x['acl'] else ''))
  sql((ROOT/'scripts/ci/fixtures/club-promo-journal-seed.sql').read_text())
  before=sql((ROOT/'scripts/ci/fixtures/club-promo-journal-check.sql').read_text().replace('EXPECTED_NET','-400'))
  report['checks'].append({'before_reader_misses_370':True,'result':before.strip()})
  migration=(ROOT/MIGRATION).read_text();sql(migration)
  after=sql((ROOT/'scripts/ci/fixtures/club-promo-journal-check.sql').read_text().replace('EXPECTED_NET','-770'))
  report['checks'].append({'after_all_three_readers_count_770':True,'result':after.strip()})
  sql((ROOT/'scripts/ci/fixtures/club-promo-journal-payment.sql').read_text());report['checks'].append({'payment_trigger_labels_and_duplicate_and_rollback':True})
  # Reapplying must refuse exact preimage without altering catalog/data.
  prior=sql("select md5(string_agg(pg_get_functiondef(oid),'' order by oid)) from pg_proc where pronamespace='public'::regnamespace;")
  try:sql(migration);raise RuntimeError('replay unexpectedly accepted')
  except subprocess.CalledProcessError as e:
   if 'CLUB_PROMO_SOURCE_PREIMAGE_CHANGED' not in e.stderr:raise
  assert prior==sql("select md5(string_agg(pg_get_functiondef(oid),'' order by oid)) from pg_proc where pronamespace='public'::regnamespace;")
  report['checks'].append({'reapply_refused_catalog_unchanged':True})
  report['migration_sha256']=hashlib.sha256(migration.encode()).hexdigest();report['status']='passed'
 finally:
  if started:run([pg/'pg_ctl','-D',data,'-m','immediate','stop'])
  shutil.rmtree(work)
  (out/'report.json').write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps(report))
if __name__=='__main__':main()
