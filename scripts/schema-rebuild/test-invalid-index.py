#!/usr/bin/env python3
"""Native invalid-index dump omission and exact isolated restoration."""
import importlib.util,json,os,shutil,subprocess,tempfile
from pathlib import Path
import fidelity
spec=importlib.util.spec_from_file_location('rebuild',Path(__file__).with_name('verify.py'));v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
pg=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'));work=Path(tempfile.mkdtemp(prefix='index-',dir=v.validate_parent(os.environ.get('SCHEMA_TEST_SCRATCH',str(v.ROOT.parent)))));sock=work/'s';sock.mkdir();started=False;env={k:x for k,x in os.environ.items() if not k.startswith('PG')}
def run(args,source=None):
 r=subprocess.run([str(x) for x in args],input=source,text=True,capture_output=True,env=env,timeout=40)
 if r.returncode:raise RuntimeError('Invalid-index fixture refused')
 return r.stdout.strip()
try:
 run([pg/'initdb','-D',work/'d','-U','supabase_admin','--auth-local=trust','--auth-host=reject','--no-locale'])
 with (work/'d/postgresql.conf').open('a') as f:f.write("\nlisten_addresses=''\nunix_socket_directories="+v.lit(sock)+"\nshared_buffers='16MB'\n")
 run([pg/'pg_ctl','-D',work/'d','-l',work/'server.log','-w','start']);started=True
 cmd=[pg/'psql','-X','-qAt','-h',sock,'-U','supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1']
 def sql(source,**context):return run(cmd,source)
 catalog=lambda:json.loads(sql((v.ROOT/'scripts/schema-rebuild/catalog.sql').read_text()))
 name='idx_chip_tx_bbj_promo_sweep_amount'
 definition="CREATE INDEX "+name+" ON public.chip_transactions USING btree (transaction_type) INCLUDE (amount) WHERE (transaction_type = 'bbj_promo_sweep'::text)"
 sql('CREATE ROLE postgres;GRANT CREATE ON SCHEMA public TO postgres;SET ROLE postgres;CREATE TABLE public.chip_transactions(transaction_type text,amount numeric);'+definition+';RESET ROLE;UPDATE pg_index SET indisvalid=false WHERE indexrelid=\'public.'+name+'\'::regclass;')
 reference=catalog();dump=run([pg/'pg_dump','--schema-only','-h',sock,'-U','supabase_admin','-d','postgres']);assert name not in dump,'Native dump unexpectedly retained invalid index'
 sql('DROP INDEX public.'+name+';');missing=catalog();assert v.compare(reference,missing),'Missing invalid index was accepted'
 assert fidelity.restore_omitted_invalid_index(sql,reference,missing)==1;assert not v.compare(reference,catalog()),'Exact invalid-index state was not restored'
 sql("UPDATE pg_index SET indisready=false WHERE indexrelid='public."+name+"'::regclass;")
 try:fidelity.restore_omitted_invalid_index(sql,reference,catalog())
 except ValueError:pass
 else:raise AssertionError('Changed readiness was accepted')
 sql('DROP INDEX public.'+name+';ALTER TABLE public.chip_transactions ADD CONSTRAINT '+name+' UNIQUE(transaction_type);')
 try:fidelity.restore_omitted_invalid_index(sql,reference,catalog())
 except ValueError:pass
 else:raise AssertionError('Unique constraint index was accepted')
 changed=json.loads(json.dumps(reference));next(r for r in changed['relations'] if r['name']=='chip_transactions')['indexes'][0]['definition']='CREATE INDEX wrong_definition'
 try:fidelity.restore_omitted_invalid_index(sql,changed,catalog())
 except ValueError:pass
 else:raise AssertionError('Changed captured definition was accepted')
 print('PASS: native pg_dump omits actual invalid index; missing fails, exact isolated metadata repair passes; changed definition/readiness/unique constraint refuse.')
finally:
 if started:subprocess.run([str(pg/'pg_ctl'),'-D',str(work/'d'),'-m','immediate','-w','stop'],capture_output=True,env=env,timeout=30)
 shutil.rmtree(work)
