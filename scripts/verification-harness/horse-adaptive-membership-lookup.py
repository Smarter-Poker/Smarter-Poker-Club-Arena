#!/usr/bin/env python3
"""Original adaptive member lookup follows validated inputs through existing keys.
Native-only. Planner-volume rows are segregated from actual authority proofs.
"""
from pathlib import Path
import argparse,datetime,json,re,sys
sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'scripts/ci'))
from satellite_qualifier_fixture import module,sha,lit
MIGRATION=Path('supabase/migrations/20261012220324_horse_membership_checks_only_original_hand_digests.sql')
PREDECESSOR=Path('supabase/migrations/20261012192304_horse_adaptive_batch_membership_validates_once_and_records_as_one_set.sql')
def qualifier_query(source):
 start=source.index('  IF (CASE WHEN') if '  IF (CASE WHEN' in source else source.rindex('  IF EXISTS(');end=source.index(' THEN\n   UPDATE public.horse_adaptive_observation_batches',start)
 return source[start:end].strip()[3:]
def qualify(e,template):
 passed=[];d=e.database(template)
 def read(q,label):return e.sql(d,q,label=label)[1].strip()
 def yes(q,label):
  assert read(q,label)=='t',label;passed.append(label)
 old=(ROOT/PREDECESSOR).read_text();new=(ROOT/MIGRATION).read_text()
 old_query=qualifier_query(old);new_query=qualifier_query(new)
 # Reverse only the measured leaf replacement: all other original owner bytes
 # (validation, row locks, write/sanitize, null/ready handling) remain exact.
 def body(s):return s[s.index('CREATE OR REPLACE FUNCTION'):s.index('REVOKE ALL')]
 assert body(new).replace(new_query,old_query)==body(old)
 passed.append('only-retired-member-predicate-changed')
 for p in [MIGRATION,PREDECESSOR,Path(__file__).relative_to(ROOT)]:e.report.setdefault('source_sha256',{})[str(p)]=sha(ROOT/p)
 yes("SELECT md5(pg_get_functiondef('smarter_private.register_horse_adaptive_batch_membership(text)'::regprocedure))<>'02b1038d96aef58c02af6fd7c41bdf5c';",'successor-is-actual-qualified-owner')
 code,_,err=e.sql(d,file=ROOT/MIGRATION,label='point-lookup-replay-refusal',check=False)
 assert code and 'ADAPTIVE_MEMBERSHIP_LOOKUP_PREIMAGE_CHANGED' in err;passed.append('forward-migration-replay-refused')
 # Admitted empty originals, not direct fabricated batch rows.
 import hashlib
 h=lambda s:hashlib.sha256(s.encode()).hexdigest();actor=h('lookup-actor');scope=json.dumps(['adaptive-public-node-v1']+[None]*28,separators=(',',':'));scopekey=h(scope)
 now=int(read("SELECT floor(extract(epoch FROM (now()-interval '20 days'))*1000)::bigint;",'lookup-original-clock'))
 def payload(handlist,source):
  digest=h(source);key=h('|'.join(['adaptive-journal-v1',actor,digest,str(now-1),str(now+1)]))
  facts=[json.dumps([1,hand+':'+str(i),hand,actor,'00000001'+'c'*56,now,'training',scopekey,scope,'call',True,'player' if i%2 else 'horse_policy'],separators=(',',':')) for i,hand in enumerate(handlist)]
  return key,json.dumps([1,key,actor,now-1,now+1,digest,[],facts],separators=(',',':'))
 empty,ep=payload([],'empty-original');nonempty,np=payload(['ac000000-0000-4000-8000-'+f'{i+1:012x}' for i in range(64)],'nonempty-original')
 for k,p in [(empty,ep),(nonempty,np)]:
  e.sql(d,'SELECT fn_append_horse_adaptive_observations('+lit(p)+');',label='genuine-original-append')
  yes('SELECT retention_membership_ready AND NOT retention_compacted AND canonical_payload='+lit(p)+' AND batch_digest='+lit(h(p))+' FROM horse_adaptive_observation_batches WHERE batch_key='+lit(k)+';','actual-'+('empty' if k==empty else 'nonempty')+'-original-registered-exact')
 # This clone exists ONLY to establish physical execution shape at volume.
 # It is never an authority/financial/retirement fixture and never reaches prod.
 volume=e.database(d)
 e.sql(volume,"ALTER TABLE smarter_private.horse_adaptive_disposal_certificates DISABLE TRIGGER horse_adaptive_disposal_certificate_immutable; INSERT INTO smarter_private.horse_adaptive_disposal_certificates SELECT ('ad000000-0000-4000-8000-'||lpad(to_hex(i),12,'0'))::uuid,encode(sha256(convert_to('ad000000-0000-4000-8000-'||lpad(to_hex(i),12,'0'),'UTF8')),'hex'),'11111111-1111-4111-8111-111111111111',i,'planner-only-no-authority',now(),NULL,'{\"version\":\"settled-horse-adaptive-disposal-v1\"}'::jsonb FROM generate_series(1,20000)i; ALTER TABLE smarter_private.horse_adaptive_disposal_certificates ENABLE TRIGGER horse_adaptive_disposal_certificate_immutable; INSERT INTO smarter_private.horse_adaptive_batch_hand_membership SELECT encode(sha256(convert_to('planner-member-'||i,'UTF8')),'hex'),encode(sha256(convert_to('planner-batch-'||(i%1000),'UTF8')),'hex') FROM generate_series(1,200000)i; ANALYZE smarter_private.horse_adaptive_disposal_certificates; ANALYZE smarter_private.horse_adaptive_batch_hand_membership;",label='native-planner-only-volume-NOT-authority')
 def query(q,k,hands,compacted=False):
  q=q.replace('b.retention_compacted','true' if compacted else 'false')
  q=re.sub(r'\bp_key\b',lit(k),q)
  return re.sub(r'\bhands\b',"ARRAY["+','.join(lit(x) for x in hands)+"]::text[]",q)
 def nodes(p):
  yield p
  for c in p.get('Plans',[]):yield from nodes(c)
 plans={}
 handlist=json.loads(np)[7];handlist=[json.loads(x)[2] for x in handlist]
 for name,q,k,hands in [('old-empty',old_query,empty,[]),('new-empty',new_query,empty,[]),('new-nonempty',new_query,nonempty,handlist)]:
  code,out,err=e.sql(volume,'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT '+query(q,k,hands)+';',label='exact-'+name+'-predicate-plan')
  plan=json.loads(out)[0];plans[name]=plan
  ns=list(nodes(plan['Plan']));cert=[n for n in ns if n.get('Relation Name')=='horse_adaptive_disposal_certificates']
  if name=='old-empty':assert any(n['Node Type']=='Seq Scan' and n.get('Rows Removed by Filter')==20000 for n in cert)
  elif name=='new-empty':assert all(n['Actual Loops']==0 for n in cert)
  else:assert any(n['Node Type']=='Index Scan' and n['Index Name']=='horse_adaptive_disposal_certificates_hand_digest_key' and n['Actual Loops']==64 for n in cert)
  passed.append(name+'-physical-plan')
 e.report['membership_lookup_plans']=plans;e.report['membership_lookup_plan_limit']='20000 synthetic planner-only unretired certificates and200000synthetic memberships in a separate clone. Empty/nonempty batches admitted by actual append. No synthetic certificate counted as retention authority or production throughput.'
 e.discard(volume)
 # Actual qualified retirement, with protected human observation surviving.
 oldhands=module(ROOT/'scripts/ci/test-hand-submission-retention-disposal.py','lookup_original_hands')
 seed=oldhands.SEED.replace("'{\"p_stacks\": []}'::jsonb","jsonb_build_object('p_stacks','[]'::jsonb,'p_hand_row',jsonb_build_object('has_human',false,'players',jsonb_build_array(jsonb_build_object('userId','"+oldhands.HORSE+"'))))")+'UPDATE hand_history SET has_human=false;'
 human='ac000000-0000-4000-8000-000000000001';key,p=payload([oldhands.HAND_ID,human],'real-retirement')
 e.sql(d,seed+'SELECT fn_append_horse_adaptive_observations('+lit(p)+');'+oldhands.AUTHORITY+'SELECT smarter_private.hand_submission_retention_disposal(ARRAY['+lit(oldhands.HAND_ID)+"::uuid],'Native original qualified membership lookup');SELECT smarter_private.enable_horse_adaptive_retention('"+'a'*40+"');SELECT smarter_private.retire_horse_adaptive_hand("+lit(oldhands.HAND_ID)+');',label='actual-original-qualified-retirement')
 yes('SELECT retired_at IS NOT NULL FROM smarter_private.horse_adaptive_disposal_certificates WHERE hand_id='+lit(oldhands.HAND_ID)+';','actual-original-retirement-not-planner-row')
 retired=[oldhands.HAND_ID];yes('SELECT '+query(new_query,key,retired)+';','exact-digest-and-batch-retired-member-positive')
 yes('SELECT NOT '+query(new_query,nonempty,retired)+';','retired-certificate-without-exact-batch-membership-negative')
 yes('SELECT NOT '+query(new_query,key,[human])+';','human-without-qualified-retired-certificate-negative')
 yes('SELECT NOT '+query(new_query,key,['be000000-0000-4000-8000-000000000001'])+';','unknown-original-without-authority-negative')
 yes('SELECT NOT '+query(new_query,key,[])+';','empty-original-no-retired-lookup-positive-sanitize')
 yes('SELECT '+query(new_query,key,[],compacted=True)+';','flagged-stale-membership-retains-original-retired-semantics')
 # Real retired batch is ready+compacted; legal replay remains exact no-op.
 original_batch=read('SELECT to_jsonb(b)::text FROM horse_adaptive_observation_batches b WHERE batch_key='+lit(key)+';','actual-retired-ready-state')
 e.sql(d,'SELECT smarter_private.register_horse_adaptive_batch_membership('+lit(key)+');',label='ready-compacted-original-replay')
 assert read('SELECT to_jsonb(b)::text FROM horse_adaptive_observation_batches b WHERE batch_key='+lit(key)+';','ready-compacted-after-replay')==original_batch
 passed.append('actual-ready-compacted-replay-noop')
 # Defensive flagged stale prestate: a retained canonical representation may
 # no longer mention a member. Both owners must retain the exact old decision.
 flagged=e.database(d)
 e.sql(flagged,'UPDATE horse_adaptive_observation_batches SET retention_membership_ready=false WHERE batch_key='+lit(key)+';',label='isolated-flagged-stale-ready-reset-NOT-production')
 predecessor=e.database(flagged)
 original_definition=body(old)
 e.sql(predecessor,original_definition,label='native-predecessor-owner-only')
 for db in [predecessor,flagged]:e.sql(db,'SELECT smarter_private.register_horse_adaptive_batch_membership('+lit(key)+');',label='flagged-stale-original-owner')
 def frozen(db):return e.sql(db,"SELECT jsonb_build_object('batches' ,(SELECT jsonb_agg(to_jsonb(b) ORDER BY batch_key) FROM horse_adaptive_observation_batches b),'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY hand_digest,batch_key) FROM smarter_private.horse_adaptive_batch_hand_membership m));",label='flagged-stale-exact-state' )[1].strip()
 assert frozen(predecessor)==frozen(flagged);passed.append('flagged-stale-existing-members-owner-equivalent')
 e.discard(predecessor);e.discard(flagged)
 # The old retired set can differ from current inputs only in altered invalid
 # unflagged/nonready prestates, not a legal atomic registration/retirement.
 # Preserve this limit explicitly rather than claim arbitrary-state equivalence.
 yes('SELECT '+query(old_query,key,[])+' AND NOT '+query(new_query,key,[])+';','altered-unflagged-missing-current-input-counterexample-recorded')
 e.report['membership_lookup_equivalence_limit']='Unflagged nonready rows with unrelated preexisting private memberships are not original-owner reachable: registration is atomic under the batch lock; ready returns before lookup; retirement requires every legacy row ready; future append AFTER INSERT registers original canonical before final sanitization. Flagged prestates conservatively use exact old lookup. Arbitrarily corrupt unflagged fixtures are not claimed equivalent.'

 yes("SELECT p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private'] FROM pg_proc p WHERE oid='smarter_private.register_horse_adaptive_batch_membership(text)'::regprocedure;",'exact-original-owner-ACL-definer-searchpath-preserved')
 e.report['membership_lookup_postimage']=json.loads(read("SELECT jsonb_build_object('md5',md5(pg_get_functiondef(oid)),'owner',pg_get_userbyid(proowner),'acl',proacl::text,'secdef',prosecdef,'config',proconfig) FROM pg_proc WHERE oid='smarter_private.register_horse_adaptive_batch_membership(text)'::regprocedure;",'lookup-final-postimage'))
 e.report['membership_lookup_proven']=passed;e.discard(d);return passed

def main():
 p=argparse.ArgumentParser();p.add_argument('--evidence',type=Path,required=True);p.add_argument('--pg-bin',type=Path,required=True);args=p.parse_args()
 out=args.evidence.resolve();out.mkdir(parents=True,exist_ok=False)
 scratch=out if sys.platform!='darwin' else ROOT/'scratch';scratch.mkdir(exist_ok=True)
 native=module(ROOT/'scripts/ci/test-mtt-unlimited.py','lookup_execution');adaptive=module(ROOT/'scripts/verification-harness/horse-adaptive-statistics-retention.py','lookup_setup');membership=module(ROOT/'scripts/verification-harness/horse-adaptive-membership-set.py','lookup_original_semantics')
 socket_parent=out if sys.platform!='darwin' else Path('/Volumes/SmarterWork/agent-work/hml-20261012-sock');socket_parent.mkdir(exist_ok=True)
 e=native.Execution(ROOT,out,args.pg_bin.resolve(),scratch,300,socket_parent=str(socket_parent))
 try:
  e.start();base=adaptive.prepare_base(e);e.sql(base,file=ROOT/adaptive.MIGRATION,label='actual-adaptive-ancestor-setup-only')
  current=membership.qualify(e,base,keep_template=True,successor=MIGRATION);qualify(e,current);e.discard(current);e.discard(base)
  for path,digest in e.report['source_sha256'].items():assert sha(ROOT/path)==digest,path
  e.report['status']='passed'
 except BaseException as exc:e.report['failure']=repr(exc)
 finally:
  try:e.close()
  except BaseException as exc:e.report.update(cleanup_failure=repr(exc),status='failed')
  e.report['ended_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();(out/'result.json').write_text(json.dumps(e.report,indent=2)+'\n');print(json.dumps({k:e.report.get(k) for k in ['status','failure','cleanup']}))
 return 0 if e.report['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())
