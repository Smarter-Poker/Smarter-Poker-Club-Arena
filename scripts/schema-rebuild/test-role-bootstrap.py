#!/usr/bin/env python3
"""Actual PG17 GRANTED BY failure and source bootstrap-authority regression."""
import importlib.util,json,os,shutil,subprocess,tempfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('rebuild',Path(__file__).with_name('verify.py'));v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
pg=Path(os.environ.get('PG_BIN','/opt/homebrew/opt/postgresql@17/bin'));parent=v.validate_parent(os.environ.get('SCHEMA_TEST_SCRATCH',str(v.ROOT.parent)));contract=json.loads((v.BASE/'pokeriq-role-contract.json').read_text());bootstrap=json.loads((v.BASE/'pokeriq-platform-contract.json').read_text())['database']['bootstrap_role'];env={k:x for k,x in os.environ.items() if not k.startswith('PG')};provider=os.environ.get('SCHEMA_PROVIDER_TEST')=='1'
class Rejected(Exception):
 def __init__(self,diagnostic):self.diagnostic=diagnostic
for correct in [False,True]:
 work=Path(tempfile.mkdtemp(prefix='role-',dir=parent));sock=work/'s';sock.mkdir();started=False
 def command(args,sql=None):
  r=subprocess.run([str(x) for x in args],input=sql,text=True,capture_output=True,env=env,timeout=30)
  if r.returncode:raise RuntimeError('Native fixture command refused')
  return r.stdout.strip()
 try:
  initial=bootstrap if correct else 'schema_restore_owner'
  command([pg/'initdb','-D',work/'d','-U',initial,'--auth-local=trust','--auth-host=reject','--no-locale'])
  with (work/'d/postgresql.conf').open('a') as f:f.write("\nlisten_addresses=''\nunix_socket_directories="+v.lit(sock)+"\nshared_buffers='16MB'\n")
  if provider:
   with (work/'d/postgresql.conf').open('a') as f:
    f.write("\nshared_preload_libraries='supautils'\n")
    for setting in json.loads((v.BASE/'pokeriq-extension-runtime.json').read_text())['settings']:f.write(setting['name']+'='+v.lit(setting['setting'])+'\n')
  command([pg/'pg_ctl','-D',work/'d','-l',work/'server.log','-w','start']);started=True
  cmd=[pg/'psql','-X','-qAt','-h',sock,'-U',initial,'-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose']
  if correct:
   command(cmd,'CREATE ROLE schema_restore_owner LOGIN SUPERUSER;');cmd[cmd.index('-U')+1]='schema_restore_owner'
  def sql(source,phase='catalog-read',**context):
   r=subprocess.run([str(x) for x in cmd],input=source,text=True,capture_output=True,env=env,timeout=30)
   if r.returncode:raise Rejected(v.failure_diagnostic(r.stderr,phase,context,'psql'))
   return r.stdout.strip()
  if not correct:
   try:v.bootstrap_roles(sql,contract,initial)
   except Rejected as exc:
    assert exc.diagnostic['sqlstate']=='42501',exc.diagnostic
    assert exc.diagnostic['phase']=='role-membership',exc.diagnostic
    first=contract['memberships'][0]
    expected_context={key:first[key] for key in ['role','member','grantor']}
    assert expected_context['grantor']==bootstrap,expected_context
    assert exc.diagnostic['context']==expected_context,exc.diagnostic
   else:raise AssertionError('Wrong bootstrap principal unexpectedly accepted captured grantor')
   try:v.require_builtin_extension(sql,next(x for x in contract['extensions'] if x['name']=='plpgsql'))
   except v.Refused:pass
   else:raise AssertionError('Wrong builtin owner was accepted')
  else:
   v.bootstrap_roles(sql,contract,bootstrap)
   before=sql("SELECT oid FROM pg_extension WHERE extname='plpgsql';")
   v.require_builtin_extension(sql,next(x for x in contract['extensions'] if x['name']=='plpgsql'))
   assert sql("SELECT oid FROM pg_extension WHERE extname='plpgsql';")==before,'Exact initializer extension was replaced'
   actual=json.loads(sql("SELECT jsonb_agg(jsonb_build_object('role',pg_get_userbyid(roleid),'member',pg_get_userbyid(member),'grantor',pg_get_userbyid(grantor),'admin',admin_option,'inherit',inherit_option,'set',set_option)) FROM pg_auth_members;"))
   assert {json.dumps(x,sort_keys=True) for x in actual}=={json.dumps(x,sort_keys=True) for x in contract['memberships']}
   rolequery="SELECT jsonb_agg(jsonb_build_object('name',rolname,'inherit',rolinherit,'canlogin',rolcanlogin,'createdb',rolcreatedb,'bypassrls',rolbypassrls,'superuser',rolsuper,'createrole',rolcreaterole,'replication',rolreplication,'connectionlimit',rolconnlimit,'config',rolconfig)) FROM pg_roles WHERE rolname IN ("+','.join(v.lit(r['name']) for r in contract['roles'])+");"
   actual=json.loads(sql(rolequery));expected=[]
   for role in contract['roles']:
    role=dict(role)
    if not role['name'].startswith('pg_'):role['canlogin']=False
    expected.append(role)
   for rows in [actual,expected]:
    for role in rows:role['config']=sorted(role.get('config') or [])
   assert sorted(actual,key=lambda x:x['name'])==sorted(expected,key=lambda x:x['name']),[(a['name'],{key:{'actual':a[key],'expected':b[key]} for key in a if a[key]!=b[key]}) for a,b in zip(sorted(actual,key=lambda x:x['name']),sorted(expected,key=lambda x:x['name'])) if a!=b]
   if provider:
    sql('CREATE FUNCTION public.owner_callback() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;ALTER FUNCTION public.owner_callback() OWNER TO postgres;')
    statement='CREATE EVENT TRIGGER owner_contract ON ddl_command_end\n EXECUTE FUNCTION public.owner_callback();\nALTER EVENT TRIGGER owner_contract OWNER TO postgres;'
    try:sql(statement,phase='provider-event-trigger-before',owner='postgres')
    except Rejected as exc:
     assert exc.diagnostic['sqlstate']=='XX000',exc.diagnostic
     assert exc.diagnostic['message']=='Superuser owned event trigger must execute a superuser owned function',exc.diagnostic
    else:raise AssertionError('Generic superuser unexpectedly accepted non-superuser callback')
    reference={'event_triggers':[dict(name='owner_contract',owner='postgres',event='ddl_command_end',function='public.owner_callback()')],'routines':[dict(schema='public',name='owner_callback',args='',owner='postgres')]}
    sql(v.render_event_trigger_owners(statement,reference,contract),phase='provider-event-trigger-after',owner='postgres')
    actual=json.loads(sql("SELECT jsonb_build_object('owner',pg_get_userbyid(e.evtowner),'callback_owner',pg_get_userbyid(p.proowner),'enabled',e.evtenabled,'event',e.evtevent) FROM pg_event_trigger e JOIN pg_proc p ON p.oid=e.evtfoid WHERE e.evtname='owner_contract';"))
    assert actual==dict(owner='postgres',callback_owner='postgres',enabled='O',event='ddl_command_end'),actual
    print('PASS: actual provider XX000 reproduced; captured-owner rendering creates enabled event trigger with exact postgres owner/callback owner, without privilege changes or disabled hooks.')
 finally:
  if started:subprocess.run([str(pg/'pg_ctl'),'-D',str(work/'d'),'-m','immediate','-w','stop'],capture_output=True,env=env,timeout=30)
  shutil.rmtree(work)
print('PASS: wrong bootstrap authority reproduces 42501; captured principal restores all 32 membership grantors/options and 37 role capabilities/configs with declared NOLOGIN containment; exact initial plpgsql retained and wrong owner refused.')
