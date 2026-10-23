#!/usr/bin/env python3
"""Exact empty-schema journal index DDL; no performance or installation claim."""
import importlib.util,json,os,re,shutil,subprocess,tempfile,copy
from pathlib import Path
import forward
spec=importlib.util.spec_from_file_location('rebuild',Path(__file__).with_name('verify.py'));v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
forward.validate(v.ROOT,forward.entries());source=(v.ROOT/forward.JOURNAL_PATH).read_text();native=(v.BASE/'pokeriq-20261020.sql').read_text();delta=json.loads((v.BASE/'pending-journal-index-catalog.json').read_text())
pg=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'));parent=v.validate_parent(os.environ.get('SCHEMA_TEST_SCRATCH',str(v.ROOT.parent)));work=Path(tempfile.mkdtemp(prefix='ji-',dir=parent));sock=work/'s';sock.mkdir();started=False;env={k:x for k,x in os.environ.items() if not k.startswith('PG')}
def run(args,text=None):
 r=subprocess.run([str(x) for x in args],input=text,text=True,capture_output=True,env=env,timeout=40)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
try:
 run([pg/'initdb','-D',work/'d','-U','supabase_admin','--auth-local=trust','--auth-host=reject','--no-locale'])
 with (work/'d/postgresql.conf').open('a') as f:f.write("\nlisten_addresses=''\nunix_socket_directories="+v.lit(sock)+"\nshared_buffers='16MB'\n")
 run([pg/'pg_ctl','-D',work/'d','-l',work/'server.log','-w','start']);started=True
 cmd=[pg/'psql','-X','-qAt','-h',sock,'-U','supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose']
 def sql(s):return run(cmd,s)
 table=re.search(r'CREATE TABLE public\.horse_adaptive_observation_journal \(.*?\n\);',native,re.S)[0]
 sql('CREATE ROLE postgres;GRANT CREATE ON SCHEMA public TO postgres;SET ROLE postgres;'+table+'ALTER TABLE public.horse_adaptive_observation_journal ADD CONSTRAINT horse_adaptive_observation_journal_pkey PRIMARY KEY(observation_id);')
 query=(v.ROOT/'scripts/schema-rebuild/catalog.sql').read_text();before=json.loads(sql(query));relation=next(r for r in before['relations'] if r['name']=='horse_adaptive_observation_journal')
 assert not any(i['name']==delta['index']['name'] for i in relation['indexes'])
 expected=copy.deepcopy(before);target=next(r for r in expected['relations'] if r['name']==relation['name']);target['indexes'].append(delta['index']);target['indexes'].sort(key=lambda i:i['name'])
 assert v.compare(expected,before),'Missing exact index was accepted'
 # stdin preserves the original concurrent preamble outside BEGIN/COMMIT.
 sql('SET ROLE postgres;'+source)
 actual=json.loads(sql(query));assert v.compare(expected,actual)==[],'Exact original index DDL changed independent catalog expectation'
 reference=json.loads((v.BASE/'pokeriq-catalog-reference.json').read_text());forward.journal_expected(reference,v.BASE)
 bad=copy.deepcopy(reference);next(r for r in bad['relations'] if r['name']==relation['name'])['owner']='wrong_owner'
 try:forward.journal_expected(bad,v.BASE)
 except ValueError:pass
 else:raise AssertionError('Changed whole-table preimage accepted')
 sql('SET ROLE postgres;DROP INDEX public.horse_adaptive_journal_metadata_cover;CREATE INDEX horse_adaptive_journal_metadata_cover ON public.horse_adaptive_observation_journal(observation_id) INCLUDE(observed_at_ms,hand_id);')
 try:sql('SET ROLE postgres;'+source)
 except RuntimeError as exc:assert 'adaptive_journal_metadata_cover_shape_changed' in str(exc)
 else:raise AssertionError('Original source accepted wrong include order')
 print('PASS: missing index fails; exact concurrent source matches independent1index/allothercatalog; wrong include order/fulltable preimage refuse; zero rows/business calls.')
finally:
 if started:subprocess.run([str(pg/'pg_ctl'),'-D',str(work/'d'),'-m','immediate','-w','stop'],capture_output=True,env=env,timeout=30)
 shutil.rmtree(work)
