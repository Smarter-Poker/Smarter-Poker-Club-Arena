"""Exact mystery receipt parity and indexed runtime prefix qualification."""
import hashlib,json,re,subprocess

def qualify(root,fix,out,cmd,run,schema):
 binding=json.loads((fix/'source-binding.json').read_text())
 candidate=(root/binding['mystery_prefix_migration']).read_text()
 base=cmd[:cmd.index('-c')]+['-At']
 def sql(text,label,ok=True):
  f=out/(label+'.sql');f.write_text(text)
  r=subprocess.run(base+['-v','VERBOSITY=verbose','-c',"SET timezone='UTC';SET statement_timeout='30s';",'-f',str(f)],capture_output=True,text=True,timeout=45)
  (out/(label+'.log')).write_text(r.stdout+r.stderr)
  if ok and r.returncode:raise AssertionError(label+': '+r.stderr[-4000:])
  return r
 sql((fix/'mystery-prefix-scene.sql').read_text(),'mystery-prefix-scene')
 event='88000000-0000-0000-0000-000000000001'
 award='88500000-0000-0000-0000-000000000001'
 award2='88500000-0000-0000-0000-000000000002'
 obligation='88800000-0000-0000-0000-000000000001'
 user="(SELECT winner FROM held_fee_fixture.mystery_prefix_ids)"
 key="'tourney:"+event+":obl:"+obligation+":0'"
 residual="'mb-residual:"+event+"'"
 legacy="'mb:"+award+":'||"+user+"::text"
 cases={
  'mixed':('', 'ok'),
  'legacy':("INSERT INTO public.wallet_credit_idempotency(key,user_id,amount) SELECT 'mb:"+award2+":'||winner,winner,5 FROM held_fee_fixture.mystery_prefix_ids;DELETE FROM public.wallet_credit_idempotency WHERE key="+key+";DELETE FROM public.tournament_obligations WHERE id='"+obligation+"';",'ok'),
  'obligations':("DELETE FROM public.wallet_credit_idempotency WHERE key IN("+legacy+","+residual+");UPDATE public.tournament_obligations SET amount_owed=12,amount_paid=12 WHERE id='"+obligation+"';UPDATE public.wallet_credit_idempotency SET amount=12 WHERE key="+key+';','ok'),
  'split':("UPDATE public.wallet_credit_idempotency SET amount=2 WHERE key="+key+";INSERT INTO public.wallet_credit_idempotency(key,user_id,amount) SELECT 'tourney:"+event+":obl:"+obligation+":200',winner,3 FROM held_fee_fixture.mystery_prefix_ids;",'ok'),
  'legacy-user':("UPDATE public.wallet_credit_idempotency SET user_id='ffffffff-ffff-ffff-ffff-ffffffffffff' WHERE key="+legacy+';','P0404'),
  'legacy-amount':('UPDATE public.wallet_credit_idempotency SET amount=6 WHERE key='+legacy+';','P0404'),
  'award-suffix':("INSERT INTO public.wallet_credit_idempotency(key,user_id,amount) SELECT 'mb:"+award+":'||chr(1114111),winner,5 FROM held_fee_fixture.mystery_prefix_ids;",'P0404'),
  'residual-unicode':("INSERT INTO public.wallet_credit_idempotency(key,user_id,amount) SELECT "+residual+"||chr(1114111),winner,2 FROM held_fee_fixture.mystery_prefix_ids;",'P0404'),
  'residual-ascii':("INSERT INTO public.wallet_credit_idempotency(key,user_id,amount) SELECT "+residual+"||':bad',winner,2 FROM held_fee_fixture.mystery_prefix_ids;",'P0404'),
  'obligation-user':("UPDATE public.wallet_credit_idempotency SET user_id='ffffffff-ffff-ffff-ffff-ffffffffffff' WHERE key="+key+';','P0404'),
  'obligation-suffix':("UPDATE public.wallet_credit_idempotency SET key=key||chr(1114111) WHERE key="+key+';','P0404'),
  'missing':('DELETE FROM public.wallet_credit_idempotency WHERE key='+key+';','P0404'),
  'gap':("UPDATE public.wallet_credit_idempotency SET key='tourney:"+event+":obl:"+obligation+":1' WHERE key="+key+';','P0404'),
  'overlap':("UPDATE public.wallet_credit_idempotency SET amount=2 WHERE key="+key+";INSERT INTO public.wallet_credit_idempotency(key,user_id,amount) SELECT 'tourney:"+event+":obl:"+obligation+":100',winner,3 FROM held_fee_fixture.mystery_prefix_ids;",'P0404')}
 def exercise(phase):
  observations={}
  for name,(change,expected) in cases.items():
   r=sql("BEGIN;SET LOCAL session_replication_role=replica;"+change+"DO $$ DECLARE result jsonb;code text:='ok'; message text; BEGIN BEGIN result:=public.fn_ca_mystery_bounty_completion_evidence('"+event+"',"+user+");EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE,message=MESSAGE_TEXT;END;RAISE NOTICE 'MYSTERY_PREFIX_CASE:%',jsonb_build_object('code',code,'result',result,'message',message);END $$;ROLLBACK;",'mystery-prefix-'+phase+'-'+name)
   match=re.search(r'MYSTERY_PREFIX_CASE:(\{[^\n]*\})',r.stderr)
   if not match:raise AssertionError('Missing case result '+name)
   data=json.loads(match.group(1))
   if data['code']!=expected:raise AssertionError(name+': '+str(data))
   observations[name]=data
  return observations
 before=exercise('before')
 # The complete definition/ACL guard fails before any index or code can land.
 sql("ALTER FUNCTION public.fn_ca_mystery_bounty_completion_evidence(uuid,uuid) SET statement_timeout='29s';",'mystery-prefix-drift')
 previous=schema();r=sql(candidate,'mystery-prefix-drift-refused',False)
 if r.returncode==0 or 'mystery credit prefix predecessor changed' not in r.stderr or schema()!=previous:raise AssertionError('Predecessor drift did not preserve schema')
 sql("ALTER FUNCTION public.fn_ca_mystery_bounty_completion_evidence(uuid,uuid) SET statement_timeout='30s';",'mystery-prefix-restored')
 sql(candidate,'mystery-prefix-install')
 after=exercise('after')
 if after!=before:raise AssertionError('Prefix bounds changed financial validation results')
 # Three prefix families, including the default-ICU collation and generic
 # dynamic bounds. No disabled sequential scans or hinted planner settings.
 prefixes=[('award','mb:'+award+':','mb:'+award+';'),('obligation','tourney:'+event+':obl:'+obligation+':','tourney:'+event+':obl:'+obligation+';'),('residual','mb-residual:'+event,'mb-residual:'+event[:-1]+chr(ord(event[-1])+1))]
 plans=[]
 for mode in ['force_custom_plan','force_generic_plan']:
  for name,low,high in prefixes:
   text="SET plan_cache_mode='"+mode+"';PREPARE prefix(text,text,text) AS SELECT key FROM public.wallet_credit_idempotency WHERE key ~>=~ $1 AND key ~<~ $2 AND key LIKE $3;EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) EXECUTE prefix('"+low+"','"+high+"','"+low+"%');"
   r=sql(text,'mystery-prefix-plan-'+mode+'-'+name)
   plan=json.loads(r.stdout[r.stdout.index('['):])
   if 'wallet_credit_idempotency_key_pattern_idx' not in r.stdout or 'Index Cond' not in r.stdout:raise AssertionError('Runtime prefix did not use bounded index: '+mode+'/'+name)
   if '"Node Type": "Seq Scan"' in r.stdout:raise AssertionError('Full credit scan remains: '+mode+'/'+name)
   plans.append({'mode':mode,'family':name,'plan':plan})
 # Prefix-successor equivalence covers every final UUID hex digit, all suffix
 # boundaries, ASCII punctuation and the largest valid Unicode scalar.
 r=sql("SELECT bool_and((k LIKE p||'%') IS NOT DISTINCT FROM (k ~>=~ p AND k ~<~ hi)) FROM (SELECT 'mb-residual:00000000-0000-0000-0000-00000000000'||digit p,'mb-residual:00000000-0000-0000-0000-00000000000'||chr(ascii(digit)+1) hi FROM unnest(string_to_array('0,1,2,3,4,5,6,7,8,9,a,b,c,d,e,f',',')) digit) p CROSS JOIN LATERAL (SELECT p||suffix k FROM unnest(ARRAY['',':','0','z',chr(233),chr(1114111)]) suffix UNION ALL SELECT hi UNION ALL SELECT p||'x'||chr(1114111)) candidates;",'mystery-prefix-successor')
 if not re.search(r'\bt\b',r.stdout):raise AssertionError('Prefix successor lost malformed keys')
 identity=sql("SELECT jsonb_build_object('definition_md5',md5(pg_get_functiondef(p.oid)),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'config',p.proconfig) FROM pg_proc p WHERE oid='public.fn_ca_mystery_bounty_completion_evidence(uuid,uuid)'::regprocedure;",'mystery-prefix-installed-identity')
 result={'status':'passed','before_after_cases':after,'runtime_prefix_plans':plans,'source_guard_rollback':True,'uuid_successor_boundaries':True,'installed_identity_output':identity.stdout,'migration_sha256':hashlib.sha256(candidate.encode()).hexdigest(),'scope':'Read-only mystery completion validator; synthetic evidence only, no production money or wider gameplay suite'}
 (out/'mystery-prefix-evidence.json').write_text(json.dumps(result,indent=2)+'\n')
 return result
