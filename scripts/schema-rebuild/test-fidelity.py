#!/usr/bin/env python3
"""Real PG17 parser, provider metadata and inherited-PK regression."""
import importlib.util,json,os,shutil,subprocess,tempfile
from pathlib import Path
import fidelity
spec=importlib.util.spec_from_file_location('rebuild',Path(__file__).with_name('verify.py'));v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
pg=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'));parent=v.validate_parent(os.environ.get('SCHEMA_TEST_SCRATCH',str(v.ROOT.parent)));work=Path(tempfile.mkdtemp(prefix='fid-',dir=parent));sock=work/'s';sock.mkdir();started=False;env={k:x for k,x in os.environ.items() if not k.startswith('PG')}
def run(args,source=None):
 result=subprocess.run([str(x) for x in args],input=source,text=True,capture_output=True,env=env,timeout=40)
 if result.returncode:raise RuntimeError('Native fidelity fixture refused: '+v.safe_error_line(result.stderr.splitlines()[0] if result.stderr else '',{}))
 return result.stdout.strip()
try:
 run([pg/'initdb','-D',work/'d','-U','supabase_admin','--auth-local=trust','--auth-host=reject','--no-locale'])
 with (work/'d/postgresql.conf').open('a') as f:f.write("\nlisten_addresses=''\nunix_socket_directories="+v.lit(sock)+"\nshared_buffers='16MB'\n")
 run([pg/'pg_ctl','-D',work/'d','-l',work/'server.log','-w','start']);started=True
 cmd=[pg/'psql','-X','-qAt','-h',sock,'-U','supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1']
 def sql(source,**context):return run(cmd,source)
 sql('CREATE ROLE postgres;CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA extensions;CREATE EXTENSION pgcrypto WITH SCHEMA extensions;CREATE SCHEMA graphql;CREATE SCHEMA graphql_public;CREATE TABLE public.proof(n int,flag boolean,CHECK(((n>0 AND n<100) AND NOT flag)));')
 sql('CREATE SEQUENCE public.null_acl_sequence;')
 sequence=json.loads(sql("SELECT json_agg(privilege_type ORDER BY privilege_type) FROM aclexplode(acldefault('s',(SELECT relowner FROM pg_class WHERE oid='public.null_acl_sequence'::regclass)));"));assert sequence==['SELECT','UPDATE','USAGE']
 acl=[dict(grantor='supabase_admin',grantee=r,privilege='USAGE',grantable=r=='postgres') for r in ['anon','authenticated','postgres','service_role']]+[dict(grantor='supabase_admin',grantee='supabase_admin',privilege=p,grantable=False) for p in ['CREATE','USAGE']]
 reference=dict(extensions=[dict(name='pgcrypto',schema='extensions',version=sql("SELECT extversion FROM pg_extension WHERE extname='pgcrypto';"),owner='postgres',owner_dependencies=['postgres'])],schemas=[dict(name=n,owner='supabase_admin',acl=acl) for n in ['graphql','graphql_public']])
 assert sql("SELECT pg_get_userbyid(extowner) FROM pg_extension WHERE extname='pgcrypto';")=='supabase_admin'
 # Refuse an unexpected shared-owner dependency before any restoration write.
 sql("INSERT INTO pg_shdepend(dbid,classid,objid,objsubid,refclassid,refobjid,deptype) SELECT (SELECT oid FROM pg_database WHERE datname=current_database()),'pg_extension'::regclass,oid,0,'pg_authid'::regclass,'postgres'::regrole,'o' FROM pg_extension WHERE extname='pgcrypto';")
 try:fidelity.restore_provider_metadata(sql,reference)
 except ValueError:pass
 else:raise AssertionError('Wrong dependency preimage was accepted')
 sql("DELETE FROM pg_shdepend WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid='pg_extension'::regclass AND objid=(SELECT oid FROM pg_extension WHERE extname='pgcrypto') AND deptype='o';")

 fidelity.restore_provider_metadata(sql,reference)
 assert sql("SELECT pg_get_userbyid(extowner) FROM pg_extension WHERE extname='pgcrypto';")=='postgres'
 for schema in reference['schemas']:
  actual=json.loads(sql("SELECT jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(grantor),'grantee',pg_get_userbyid(grantee),'privilege',privilege_type,'grantable',is_grantable)) FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) WHERE n.nspname="+v.lit(schema['name'])+';'))
  assert {json.dumps(x,sort_keys=True) for x in actual}=={json.dumps(x,sort_keys=True) for x in acl}
 # Source expression text is independent; native parsing may flatten its AND.
 base=dict(schema='public',name='proof',view=None,triggers=[],constraints=[dict(name='proof_check',definition='CHECK (((n > 0 AND n < 100) AND NOT flag))')])
 actual=dict(base,constraints=[dict(name='proof_check',definition=sql("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.proof'::regclass;"))])
 expected,observed,count=fidelity.normalize_expressions(sql,dict(relations=[base]),dict(relations=[actual]));assert count==1 and expected==observed
 altered=dict(actual,constraints=[dict(name='proof_check',definition='CHECK (n > 0 AND n < 99 AND NOT flag)')])
 expected,observed,count=fidelity.normalize_expressions(sql,dict(relations=[base]),dict(relations=[altered]));assert expected!=observed,'Meaningful predicate change was accepted'
 sql('CREATE FUNCTION public.noop_callback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;')
 trigger='CREATE TRIGGER proof_update AFTER UPDATE ON public.proof FOR EACH ROW WHEN (((OLD.n <> NEW.n AND OLD.flag IS DISTINCT FROM NEW.flag) AND NEW.n > 0)) EXECUTE FUNCTION public.noop_callback()'
 sql(trigger+';')
 before=dict(base,triggers=[dict(name='proof_update',definition=trigger)])
 after=dict(base,triggers=[dict(name='proof_update',definition=sql("SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid='public.proof'::regclass AND tgname='proof_update';"))])
 expected,observed,count=fidelity.normalize_expressions(sql,dict(relations=[before]),dict(relations=[after]));assert expected==observed
 after['triggers'][0]['definition']=after['triggers'][0]['definition'].replace('new.n > 0','new.n > 1')
 expected,observed,count=fidelity.normalize_expressions(sql,dict(relations=[before]),dict(relations=[after]));assert expected!=observed,'Meaningful trigger predicate change was accepted'
 sql('CREATE VIEW public.proof_view AS SELECT n+1 AS shifted FROM public.proof;')
 before=dict(schema='public',name='proof_view',view='SELECT ((n + 1)) AS shifted FROM public.proof;',triggers=[],constraints=[])
 after=dict(before,view=sql("SELECT pg_get_viewdef('public.proof_view'::regclass);"))
 expected,observed,count=fidelity.normalize_expressions(sql,dict(relations=[before]),dict(relations=[after]));assert expected==observed
 after['view']=after['view'].replace('+ 1','+ 2')
 expected,observed,count=fidelity.normalize_expressions(sql,dict(relations=[before]),dict(relations=[after]));assert expected!=observed,'Meaningful view expression change was accepted'
 # Genuine partition inheritance is restored by supported DDL, no catalog edit.
 sql('CREATE TABLE public.parts(id int PRIMARY KEY) PARTITION BY RANGE(id);CREATE TABLE public.part(id int NOT NULL);ALTER TABLE public.part ADD CONSTRAINT part_pkey PRIMARY KEY(id);ALTER TABLE public.parts ATTACH PARTITION public.part FOR VALUES FROM(0) TO(10);')
 catalog=json.loads(sql((v.ROOT/'scripts/schema-rebuild/catalog.sql').read_text()));target=next(r for r in catalog['relations'] if r['name']=='part');assert target['constraints'][0]['no_inherit']
 import copy
 reference=copy.deepcopy(catalog);next(r for r in reference['relations'] if r['name']=='part')['constraints'][0]['no_inherit']=False
 assert fidelity.restore_inherited_primary_keys(sql,reference,catalog)==1
 restored=json.loads(sql((v.ROOT/'scripts/schema-rebuild/catalog.sql').read_text()));assert reference==restored,v.compare(reference,restored)
 print('PASS: exact extension owner/schema ACL restoration; native parser accepts equivalent Boolean tree and refuses changed bound; supported partition DDL restores complete independent metadata.')
finally:
 if started:subprocess.run([str(pg/'pg_ctl'),'-D',str(work/'d'),'-m','immediate','-w','stop'],capture_output=True,env=env,timeout=30)
 shutil.rmtree(work)
