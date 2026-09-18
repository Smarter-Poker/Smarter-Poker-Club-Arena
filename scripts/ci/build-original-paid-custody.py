"""Build the exact additive original-paid-entry custody authority."""
from pathlib import Path
import argparse
import hashlib
import json
import re

ROOT=Path(__file__).resolve().parents[2]
CAPTURE=Path('scripts/ci/fixtures/original-paid-custody/current-authorities.json')
SOURCE=Path('scripts/ci/probes/original-paid-custody-authority.sql')
MIGRATION=Path('supabase/migrations/20260918093004_original_paid_tournament_stack_keeps_its_custody.sql')

def quoted(s): return "'"+s.replace("'","''")+"'"

def build(root=ROOT):
 rows=json.loads((root/CAPTURE).read_text())
 assignment=next(r for r in rows if r['signature'].startswith('fn_ca_assign_tournament_player_seat_locked('))
 source=assignment['definition']
 tag=re.search(r'AS (\$\w*\$)',source)[1]
 if hashlib.md5(source.encode()).hexdigest()!=assignment['definition_md5'] or hashlib.md5(source.split(tag)[1].encode()).hexdigest()!=assignment['body_md5']:
  raise ValueError('captured assignment bytes differ')
 old='''       AND (v_live_total-v_own_live+v_stack)>v_cap_chips THEN'''
 new='''       AND (v_live_total-v_own_live+v_stack)>v_cap_chips
       -- Only the private original-purchase transaction may transfer a
       -- proved, unconsumed off-felt stack. This is not a cap increase:
       -- ordinary callers, later transactions and other coordinates retain
       -- the same conservation refusal. The deferred receipt must complete.
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_paid_stack_custody_receipts r
          WHERE r.transaction_id=pg_current_xact_id() AND r.state='reserved'
            AND r.tournament_id=p_tournament_id AND r.user_id=p_user_id
            AND r.destination_table_id=p_table_id AND r.destination_seat_number=p_seat_number
            AND r.grant_chips=v_stack AND r.live_chips_before=v_live_total
            AND r.funded_supply=v_cap_chips AND v_own_live=0
            AND v_tp.status='playing' AND v_tp.table_id IS NULL AND v_tp.seat_number IS NULL
            AND v_tp.rebuy_prompt_until IS NULL
            AND EXISTS(SELECT 1 FROM public.tournament_knockout_candidates c
              WHERE c.id=r.candidate_id AND c.state='rebought' AND c.resolved_at IS NOT NULL
                AND c.tournament_id=p_tournament_id AND c.eliminated_user_id=p_user_id)
       ) THEN'''
 if source.count(old)!=1: raise ValueError('exact conservation branch differs')
 successor=source.replace(old,new)
 guard=json.loads((root/CAPTURE.parent/'activation-guard.json').read_text())[0]
 if hashlib.md5(guard['definition'].encode()).hexdigest()!=guard['definition_md5'] or guard['acl']!='{postgres=X/postgres}':
  raise ValueError('captured activation guard differs')
 old_pin=assignment['definition_md5'];new_pin=hashlib.md5(successor.encode()).hexdigest()
 if guard['definition'].count(old_pin)!=1:raise ValueError('exact assignment activation pin missing')
 guard_successor=guard['definition'].replace(old_pin,new_pin)
 pre=[]
 for r in rows+[dict(guard,acl=['postgres=X/postgres'])]:
  schema='' if '.' in r['signature'].split('(')[0] else 'public.'
  sig=schema+r['signature']
  if r['owner']!='postgres' or r['acl']!=['postgres=X/postgres']:
   raise ValueError('expected private authority')
  pre.append("IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE oid="+quoted(sig)+"::regprocedure AND md5(prosrc)="+quoted(r['body_md5'])+" AND md5(pg_get_functiondef(oid))="+quoted(r['definition_md5'])+" AND pg_get_userbyid(proowner)='postgres' AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(proacl,acldefault('f',proowner))) a WHERE a.grantee<>proowner)) THEN RAISE EXCEPTION 'ORIGINAL_PAID_AUTHORITY_PREIMAGE_CHANGED: %',"+quoted(sig)+"; END IF;")
 body='-- Original paid tournament chips retain their custody; no wallet or funding change.\nBEGIN;\nSET LOCAL lock_timeout=\'3s\';\nSET LOCAL statement_timeout=\'8s\';\nDO $preimage$ BEGIN\n'+'\n'.join(pre)+'\nEND $preimage$;\n'
 body+=(root/SOURCE).read_text()+'\n'+successor+';\n'
 body+='REVOKE ALL ON FUNCTION public.'+assignment['signature']+' FROM PUBLIC,anon,authenticated,service_role;\n'
 body+='-- Preserve the existing activation guard and every other sealed authority.\n'+guard_successor+';\n'
 body+='REVOKE ALL ON FUNCTION public.fn_ca_guard_mtt_admission_contract() FROM PUBLIC,anon,authenticated,service_role;\n'
 body+='DO $postimage$ BEGIN\n'
 for sig,definition in [(assignment['signature'],successor),(guard['signature'],guard_successor)]:
  body+="IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE oid="+quoted('public.'+sig)+"::regprocedure AND md5(pg_get_functiondef(oid))="+quoted(hashlib.md5(definition.encode()).hexdigest())+" AND pg_get_userbyid(proowner)='postgres' AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) a WHERE a.grantee<>proowner)) THEN RAISE EXCEPTION 'ORIGINAL_PAID_AUTHORITY_POSTIMAGE_CHANGED: %',"+quoted(sig)+"; END IF;\n"
 body+='END $postimage$;\nCOMMIT;\n'
 return body,successor

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--check',action='store_true');args=parser.parse_args()
 migration,successor=build()
 if args.check:
  if (ROOT/MIGRATION).read_text()!=migration:raise ValueError('generated custody migration differs')
 else:(ROOT/MIGRATION).write_text(migration)
 print(json.dumps({'migration':str(MIGRATION),'sha256':hashlib.sha256(migration.encode()).hexdigest(),'assignment_source_md5':hashlib.md5(successor.split('$function$')[1].encode()).hexdigest(),'assignment_definition_md5':hashlib.md5(successor.encode()).hexdigest()}))
