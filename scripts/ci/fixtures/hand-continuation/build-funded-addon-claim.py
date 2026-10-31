"""Preserve a separately funded immutable original add-on receipt when claiming a hand."""
import hashlib,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
MIGRATION='supabase/migrations/20261029081924_original_continuation_preserves_funded_addons.sql'

def render():
 import importlib.util
 p=ROOT/'scripts/ci/fixtures/hand-continuation/build-maintenance-lane.py';sp=importlib.util.spec_from_file_location('wait_builder',p);b=importlib.util.module_from_spec(sp);sp.loader.exec_module(b)
 _,rows,_=b.render('')
 row=next(x for x in rows if x['signature']=='fn_f06_claim_hand_continuation(uuid,uuid,uuid)')
 pre=row['definition'].replace(row['old'],b.NEW)
 old="AND s.stack = (x->>'stack_before')::numeric)) THEN"
 new="""AND (s.stack = (x->>'stack_before')::numeric
                  OR EXISTS (
                    -- An add-on bought after this original was retained is
                    -- outside the hand. Its immutable funded receipt proves
                    -- the exact credit; delta settlement preserves it.
                    SELECT 1 FROM public.tournament_players tp
                    JOIN public.tournament_participant_funding_receipts r
                      ON r.registration_id=tp.id AND r.tournament_id=tp.tournament_id
                     AND r.user_id=tp.user_id
                    WHERE tp.tournament_id=p_tournament_id AND tp.user_id=s.user_id
                      AND tp.table_id=s.table_id AND tp.seat_number=s.seat_number
                      AND tp.add_on IS TRUE AND tp.chips=s.stack
                      AND r.operation='addon' AND r.observed_at>c.created_at
                      AND r.purchase_key='tourney:'||p_tournament_id::text||':addon:'||s.user_id::text
                      AND r.custody_result->>'success'='true'
                      AND r.registration_snapshot->>'id'=tp.id::text
                      AND r.registration_snapshot->>'tournament_id'=p_tournament_id::text
                      AND r.registration_snapshot->>'user_id'=s.user_id::text
                      AND r.registration_snapshot->>'table_id'=s.table_id::text
                      AND (r.registration_snapshot->>'seat_number')::integer=s.seat_number
                      AND r.registration_snapshot->>'add_on'='true'
                      AND (r.registration_snapshot->>'chips')::numeric=s.stack
                      AND r.tournament_snapshot->>'id'=p_tournament_id::text
                      AND (r.tournament_snapshot->>'addon_chips')::numeric>0
                      AND r.amount=(r.tournament_snapshot->>'addon_cost')::numeric
                      AND s.stack=(x->>'stack_before')::numeric
                        +(r.tournament_snapshot->>'addon_chips')::numeric)))) THEN"""
 assert pre.count(old)==1
 post=pre.replace(old,new);full=hashlib.md5(post.encode()).hexdigest();body=hashlib.md5(post.split('$function$')[1].encode()).hexdigest()
 proof="EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_f06_claim_hand_continuation(uuid,uuid,uuid)') AND md5(p.prosrc)='"+body+"' AND md5(pg_get_functiondef(p.oid))='"+full+"' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private'])"
 receipt="EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.fn_ca_tournament_accounting_evidence_immutable()'::regprocedure AND md5(p.prosrc)='45d556a440dc8cb930ef48f291a395dd' AND p.proowner='postgres'::regrole) AND (SELECT count(*)=2 FROM pg_trigger t WHERE t.tgrelid='public.tournament_participant_funding_receipts'::regclass AND t.tgname IN('original_evidence_immutable','original_evidence_no_truncate') AND t.tgfoid='public.fn_ca_tournament_accounting_evidence_immutable()'::regprocedure AND t.tgenabled='O' AND NOT t.tgisinternal)"
 lit=lambda z:"'"+z.replace("'","''")+"'"
 s="-- Same original hand, plus a separately funded immutable post-anchor add-on.\n-- Never rewrite the original private controller, prehand baseline, chairs or live stacks.\n-- @live-proof: "+proof+"\nBEGIN;\nSET LOCAL lock_timeout='1s';\nSET LOCAL statement_timeout='5s';\nDO $addon$ DECLARE f regprocedure:='public.fn_f06_claim_hand_continuation(uuid,uuid,uuid)'::regprocedure;d text;BEGIN\n"
 s+=" IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f AND md5(p.prosrc)='42dc66013ad08ec677bf1bd0c2fd6fe6' AND md5(pg_get_functiondef(p.oid))='90ddd69be6ba6378789f2e4ab0aa6fea' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN RAISE EXCEPTION 'HAND_CONTINUATION_ADDON_PREIMAGE_CHANGED' USING ERRCODE='55000';END IF;\n"
 s+=" IF NOT ("+receipt+") THEN RAISE EXCEPTION 'HAND_CONTINUATION_ADDON_EVIDENCE_CHANGED' USING ERRCODE='55000';END IF;\n d:=pg_get_functiondef(f);IF length(d)-length(replace(d,"+lit(old)+",''))<>length("+lit(old)+") THEN RAISE EXCEPTION 'HAND_CONTINUATION_ADDON_SHAPE_CHANGED';END IF;\n EXECUTE replace(d,"+lit(old)+","+lit(new)+");\n IF NOT ("+proof+") THEN RAISE EXCEPTION 'HAND_CONTINUATION_ADDON_POSTIMAGE_CHANGED';END IF;\nEND $addon$;\nCOMMIT;\n"
 return s,pre,post,proof,body,full
if __name__=='__main__':
 s,*rest=render();(ROOT/MIGRATION).write_text(s);print(rest[-2:])
