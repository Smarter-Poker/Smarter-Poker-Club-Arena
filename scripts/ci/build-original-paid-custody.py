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
SUCCESSOR=Path('supabase/migrations/20260918123506_original_paid_custody_preserves_acknowledged_supply.sql')
HAND_SUCCESSOR=Path('supabase/migrations/20260918125231_tournament_felt_guard_recognizes_conserved_hands.sql')

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
 # These are inert installed trigger definitions in the preserved guard JSON,
 # not trigger DDL. Retain the existing activation migration's exact declarations.
 catalog=json.loads(re.search(r'\$prepared\$(.*?)\$prepared\$',guard_successor,re.S)[1])
 proof_comments=''.join('-- money-trigger-ok: '+r[0]+'.'+r[1]+' because this is an inert exact installed trigger identity inside the activation catalog proof; no trigger DDL is executed.\n' for r in catalog['triggers'])
 body=proof_comments+'-- Original paid tournament chips retain their custody; no wallet or funding change.\nBEGIN;\nSET LOCAL lock_timeout=\'3s\';\nSET LOCAL statement_timeout=\'8s\';\nDO $preimage$ BEGIN\n'+'\n'.join(pre)+'\nEND $preimage$;\n'
 body+=(root/SOURCE).read_text()+'\n'+successor+';\n'
 body+='REVOKE ALL ON FUNCTION public.'+assignment['signature']+' FROM PUBLIC,anon,authenticated,service_role;\n'
 body+='-- Preserve the existing activation guard and every other sealed authority.\n'+guard_successor+';\n'
 body+='REVOKE ALL ON FUNCTION public.fn_ca_guard_mtt_admission_contract() FROM PUBLIC,anon,authenticated,service_role;\n'
 body+='DO $postimage$ BEGIN\n'
 for sig,definition in [(assignment['signature'],successor),(guard['signature'],guard_successor)]:
  body+="IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE oid="+quoted('public.'+sig)+"::regprocedure AND md5(pg_get_functiondef(oid))="+quoted(hashlib.md5(definition.encode()).hexdigest())+" AND pg_get_userbyid(proowner)='postgres' AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) a WHERE a.grantee<>proowner)) THEN RAISE EXCEPTION 'ORIGINAL_PAID_AUTHORITY_POSTIMAGE_CHANGED: %',"+quoted(sig)+"; END IF;\n"
 body+='END $postimage$;\nCOMMIT;\n'
 return body,successor

def build_acknowledged(root=ROOT):
 old=re.search(r'CREATE FUNCTION public\.fn_ca_resume_original_paid_tournament_entry\(.*?\$function\$;', (root/SOURCE).read_text(),re.S)[0]
 source=old.replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1)
 changes={
  'actual jsonb; others jsonb; others_after jsonb; supply numeric; live numeric;':
  'actual jsonb; others jsonb; others_after jsonb; supply numeric; live numeric;\n acknowledged_supply numeric; acknowledgement jsonb;',
  ' supply:=public.fn_ca_tournament_chip_supply(t);':''' -- Funded scoring supply is the unchanged assignment owner's raw roster cap.
 -- A prior felt acknowledgement is separate evidence, never another purchase.
 SELECT (count(*)*COALESCE(tour.starting_chips,0))
       +(COALESCE(sum(p.rebuys),0)*COALESCE(tour.rebuy_chips,0))
       +(count(*) FILTER (WHERE p.add_on)*COALESCE(tour.addon_chips,0))
 INTO supply FROM public.tournament_players p WHERE p.tournament_id=t;
 SELECT to_jsonb(a) INTO acknowledgement
 FROM public.tournament_felt_supply_acknowledgements a WHERE a.tournament_id=t FOR UPDATE NOWAIT;
 acknowledged_supply:=public.fn_ca_tournament_chip_supply(t);
 IF acknowledged_supply IS NULL OR acknowledged_supply::text IN ('NaN','Infinity','-Infinity')
 OR acknowledged_supply IS DISTINCT FROM supply+COALESCE((acknowledgement->>'chips')::numeric,0) THEN
  RAISE EXCEPTION 'ORIGINAL_PAID_SUPPLY_PROOF_CHANGED' USING ERRCODE='55000'; END IF;''',
  "'wallet',to_jsonb(wallet),'live_seats',others,'funded_supply',supply,'grant_chips',grant_chips,":
  "'wallet',to_jsonb(wallet),'live_seats',others,'funded_supply',supply,'grant_chips',grant_chips,\n  'acknowledged_supply',acknowledged_supply,'supply_acknowledgement',acknowledgement,",
  ' OR public.fn_ca_tournament_chip_supply(t) IS DISTINCT FROM supply':
  ''' OR public.fn_ca_tournament_chip_supply(t) IS DISTINCT FROM acknowledged_supply
 OR (SELECT to_jsonb(a) FROM public.tournament_felt_supply_acknowledgements a WHERE a.tournament_id=t) IS DISTINCT FROM acknowledgement''',
 }
 for before,after in changes.items():
  if source.count(before)!=1:raise ValueError('exact acknowledged-supply predecessor differs')
  source=source.replace(before,after)
 capture=json.loads((root/CAPTURE.parent/'acknowledged-supply-catalog.json').read_text())['function']
 if hashlib.md5(capture['definition'].encode()).hexdigest()!=capture['definition_md5'] or capture['definition_md5']!='c29dfa4a0ebef95fddeb8a0982ef07e1':raise ValueError('captured supply owner differs')
 pins=[('fn_ca_resume_original_paid_tournament_entry(uuid,jsonb)','20d43d50e8301979dd7b99b72ad36710','{postgres=X/postgres}'),('fn_ca_assign_tournament_player_seat_locked(uuid,uuid,uuid,integer)','0fe132756ddf22122c91aa0d7fd323cd','{postgres=X/postgres}'),('fn_ca_guard_mtt_admission_contract()','98363a25bad4495a4b32e7cd99354c37','{postgres=X/postgres}'),(capture['signature'],capture['definition_md5'],capture['acl'])]
 felt=json.loads((root/CAPTURE.parent/'felt-guard.json').read_text())['function']
 if hashlib.md5(felt['definition'].encode()).hexdigest()!=felt['definition_md5'] or felt['definition_md5']!='af7e8bee512e4fe9e7e383bdd73390fd':raise ValueError('captured deferred felt guard differs')
 branch='  IF v_felt > v_supply AND (v_felt - v_delta) <= v_supply THEN'
 corrected='''  IF v_felt > v_supply AND (v_felt - v_delta) <= v_supply
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_paid_stack_custody_receipts r
       JOIN public.table_seats s ON s.id=NEW.id
       WHERE r.transaction_id=pg_current_xact_id() AND r.state='seated'
         AND r.tournament_id=v_tournament_id AND r.user_id=NEW.user_id
         AND r.destination_table_id=NEW.table_id AND r.destination_seat_number=NEW.seat_number
         AND r.assignment->>'seat_id'=NEW.id::text
         AND r.assignment->>'occupancy_id'=NEW.occupancy_id::text
         AND s.user_id=NEW.user_id AND s.table_id=NEW.table_id AND s.seat_number=NEW.seat_number
         AND s.occupancy_id=NEW.occupancy_id AND s.left_at IS NULL AND s.stack=r.grant_chips
         AND v_was=0 AND v_now=r.grant_chips AND v_delta=r.grant_chips
         AND r.live_chips_before+r.grant_chips=v_felt
         AND (r.expected->>'acknowledged_supply')::numeric=v_supply
         AND r.expected->'supply_acknowledgement' IS NOT DISTINCT FROM
           (SELECT to_jsonb(a) FROM public.tournament_felt_supply_acknowledgements a WHERE a.tournament_id=v_tournament_id)
     ) THEN'''
 if felt['definition'].count(branch)!=1:raise ValueError('exact deferred guard branch differs')
 felt_successor=felt['definition'].replace(branch,corrected)
 pins.append((felt['signature'],felt['definition_md5'],felt['acl']))
 sql="-- Original paid custody preserves the distinct existing felt acknowledgement.\nBEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='8s';\nDO $preimage$ BEGIN\n"
 for sig,digest,acl in pins:
  sql+="IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid="+quoted('public.'+sig)+"::regprocedure AND md5(pg_get_functiondef(oid))="+quoted(digest)+" AND pg_get_userbyid(proowner)='postgres' AND proacl::text="+quoted(acl)+") THEN RAISE EXCEPTION 'ORIGINAL_PAID_ACK_PREIMAGE_CHANGED: %',"+quoted(sig)+"; END IF;\n"
 sql+="IF (SELECT count(*) FROM pg_trigger WHERE tgfoid='public.fn_ca_tournament_felt_may_not_exceed_supply()'::regprocedure)<>1 OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE tgrelid='public.table_seats'::regclass AND tgname='zzzzzz_tournament_felt_may_not_exceed_supply' AND tgfoid='public.fn_ca_tournament_felt_may_not_exceed_supply()'::regprocedure AND tgenabled='O' AND tgtype=21 AND tgdeferrable AND tginitdeferred AND tgqual IS NULL AND length(tgargs)=0 AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=t.tgrelid AND a.attnum=ANY(t.tgattr))=ARRAY['stack','left_at']) THEN RAISE EXCEPTION 'ORIGINAL_PAID_ACK_PREIMAGE_CHANGED: deferred attachment'; END IF;\n"
 sql+='END $preimage$;\n'+source+'\nREVOKE ALL ON FUNCTION public.fn_ca_resume_original_paid_tournament_entry(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;\n'+felt_successor+';\nREVOKE ALL ON FUNCTION public.fn_ca_tournament_felt_may_not_exceed_supply() FROM PUBLIC;\n'
 digest=hashlib.md5(source.split('$function$')[1].encode()).hexdigest()
 sql+="DO $postimage$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_resume_original_paid_tournament_entry(uuid,jsonb)'::regprocedure AND md5(prosrc)="+quoted(digest)+" AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_tournament_felt_may_not_exceed_supply()'::regprocedure AND md5(pg_get_functiondef(oid))="+quoted(hashlib.md5(felt_successor.encode()).hexdigest())+" AND pg_get_userbyid(proowner)='postgres' AND proacl::text="+quoted(felt['acl'])+") THEN RAISE EXCEPTION 'ORIGINAL_PAID_ACK_POSTIMAGE_CHANGED'; END IF; END $postimage$;\nCOMMIT;\n"
 return sql,source

def build_conserved(root=ROOT):
 rows=json.loads((root/CAPTURE.parent/'hand-authorities.json').read_text())
 deps=json.loads((root/CAPTURE.parent/'hand-dependencies.json').read_text())
 guard=next(r for r in rows if r['signature']=='fn_ca_tournament_felt_may_not_exceed_supply()')
 for r in rows+deps['functions']:
  if hashlib.md5(r['definition'].encode()).hexdigest()!=r['definition_md5']:raise ValueError('hand capture differs')
 marker='  IF v_felt > v_supply AND (v_felt - v_delta) <= v_supply\n'
 # The original immutable inventory is written by the actual seat trigger.
 # Require this exact trigger image and a conserved whole-table transaction.
 # Other tables, new occupancies and missing capture cannot lend it chips.
 proof='''     AND NOT EXISTS (
       SELECT 1 FROM public.union_pnl_inventory_events own
       WHERE own.transaction_id=pg_current_xact_id() AND own.source_name='table_seats'
         AND own.row_id=NEW.id AND own.operation=TG_OP
         AND own.after_row=public.fn_union_pnl_inventory_project('table_seats',to_jsonb(NEW))
         AND own.before_row=CASE WHEN TG_OP='UPDATE'
           THEN public.fn_union_pnl_inventory_project('table_seats',to_jsonb(OLD)) ELSE NULL END
         AND (SELECT count(*)>=2 AND bool_and((
                  e.operation='UPDATE'
                  AND e.before_row->>'table_id'=NEW.table_id::text
                  AND e.after_row->>'table_id'=NEW.table_id::text
                  AND e.before_row->>'user_id'=e.after_row->>'user_id'
                  AND e.before_row->>'occupancy_id'=e.after_row->>'occupancy_id'
                  AND e.before_row->>'joined_at'=e.after_row->>'joined_at') IS TRUE)
                AND sum(CASE WHEN e.after_row->>'left_at' IS NULL
                             THEN COALESCE((e.after_row->>'stack')::numeric,0) ELSE 0 END
                      - CASE WHEN e.before_row->>'left_at' IS NULL
                             THEN COALESCE((e.before_row->>'stack')::numeric,0) ELSE 0 END)=0
              FROM public.union_pnl_inventory_events e
              WHERE e.transaction_id=pg_current_xact_id() AND e.source_name='table_seats'
                AND (e.before_row->>'table_id'=NEW.table_id::text
                  OR e.after_row->>'table_id'=NEW.table_id::text)) IS TRUE
         AND NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_events scope
           WHERE scope.transaction_id=pg_current_xact_id() AND scope.source_name='tables'
             AND scope.row_id=NEW.table_id
             AND scope.before_row->'tournament_id' IS DISTINCT FROM scope.after_row->'tournament_id')
     )
'''
 if guard['definition'].count(marker)!=1:raise ValueError('conserved hand guard branch differs')
 successor=guard['definition'].replace(marker,marker+proof)
 pins=[r for r in rows+deps['functions'] if r['signature'].startswith(('fn_ca_tournament_felt_may_not_exceed_supply(', 'fn_union_pnl_inventory_observe(', 'fn_union_pnl_inventory_project(', 'fn_union_pnl_inventory_immutable(', 'fn_union_pnl_original_frame('))]
 sql="-- A conserved hand redistributes existing chips; it does not create supply.\nBEGIN;\nSET LOCAL lock_timeout='3s';\nSET LOCAL statement_timeout='8s';\nDO $preimage$ BEGIN\n"
 for r in pins:
  sql+="IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid="+quoted('public.'+r['signature'])+"::regprocedure AND md5(pg_get_functiondef(oid))="+quoted(r['definition_md5'])+" AND pg_get_userbyid(proowner)='postgres' AND proacl::text="+quoted(r['acl'])+") THEN RAISE EXCEPTION 'CONSERVED_HAND_PREIMAGE_CHANGED: %',"+quoted(r['signature'])+"; END IF;\n"
 for t in deps['triggers']:
  sql+="IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid="+quoted('public.'+t['table'])+"::regclass AND tgname="+quoted(t['name'])+" AND md5(pg_get_triggerdef(oid))="+quoted(hashlib.md5(t['definition'].encode()).hexdigest())+" AND tgenabled='O') THEN RAISE EXCEPTION 'CONSERVED_HAND_PREIMAGE_CHANGED: capture attachment'; END IF;\n"
 sql+="IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.union_pnl_inventory_events'::regclass AND pg_get_userbyid(relowner)='postgres' AND relacl::text='{postgres=arwdDxtm/postgres}' AND relrowsecurity) OR NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='public.union_pnl_inventory_transaction'::regclass AND indisvalid AND indisready AND pg_get_indexdef(indexrelid)='CREATE INDEX union_pnl_inventory_transaction ON public.union_pnl_inventory_events USING btree (transaction_id, source_name)') THEN RAISE EXCEPTION 'CONSERVED_HAND_PREIMAGE_CHANGED: private indexed inventory'; END IF;\n"
 sql+='END $preimage$;\n'+successor+';\nREVOKE ALL ON FUNCTION public.fn_ca_tournament_felt_may_not_exceed_supply() FROM PUBLIC;\n'
 digest=hashlib.md5(successor.encode()).hexdigest()
 sql+="DO $postimage$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_tournament_felt_may_not_exceed_supply()'::regprocedure AND md5(pg_get_functiondef(oid))="+quoted(digest)+" AND pg_get_userbyid(proowner)='postgres' AND proacl::text="+quoted(guard['acl'])+") THEN RAISE EXCEPTION 'CONSERVED_HAND_POSTIMAGE_CHANGED'; END IF; END $postimage$;\nCOMMIT;\n"
 return sql,successor

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--check',action='store_true');args=parser.parse_args()
 migration,successor=build()
 if args.check:
  if (ROOT/MIGRATION).read_text()!=migration:raise ValueError('generated custody migration differs')
 else:(ROOT/MIGRATION).write_text(migration)
 print(json.dumps({'migration':str(MIGRATION),'sha256':hashlib.sha256(migration.encode()).hexdigest(),'assignment_source_md5':hashlib.md5(successor.split('$function$')[1].encode()).hexdigest(),'assignment_definition_md5':hashlib.md5(successor.encode()).hexdigest()}))
 correction,authority=build_acknowledged()
 if args.check:
  if (ROOT/SUCCESSOR).read_text()!=correction:raise ValueError('generated acknowledged-supply migration differs')
 else:(ROOT/SUCCESSOR).write_text(correction)
 print(json.dumps({'migration':str(SUCCESSOR),'sha256':hashlib.sha256(correction.encode()).hexdigest(),'body_md5':hashlib.md5(authority.split('$function$')[1].encode()).hexdigest()}))
 correction,authority=build_conserved()
 if args.check:
  if (ROOT/HAND_SUCCESSOR).read_text()!=correction:raise ValueError('generated conserved-hand migration differs')
 else:(ROOT/HAND_SUCCESSOR).write_text(correction)
 print(json.dumps({'migration':str(HAND_SUCCESSOR),'sha256':hashlib.sha256(correction.encode()).hexdigest(),'definition_md5':hashlib.md5(authority.encode()).hexdigest()}))
