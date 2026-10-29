"""Exact installed continuation preimages; only replace the first maintenance lane door."""
import hashlib,json,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
HELPER='smarter_private.lock_hand_continuation_maintenance_lane()'
NEW='PERFORM '+HELPER+';'

def render(migration):
 rows=json.loads((ROOT/'scripts/ci/fixtures/hand-continuation/maintenance-lane-preimages.json').read_text())
 pattern=r"IF NOT pg_try_advisory_xact_lock_shared\(530090,1\) THEN\n\s+RAISE EXCEPTION 'HAND_CONTINUATION_MAINTENANCE_BUSY' USING ERRCODE='55P03'; END IF;"
 changes=[]
 for row in rows:
  d=row['definition']; matches=list(re.finditer(pattern,d));assert len(matches)==1
  old=matches[0].group();post=d.replace(old,NEW)
  body=post.split('$function$')[1]
  row.update(old=old,post_full_md5=hashlib.md5(post.encode()).hexdigest(),post_body_md5=hashlib.md5(body.encode()).hexdigest())
  changes.append(row)
 predicates=["(p.oid='public."+x['signature']+"'::regprocedure AND md5(pg_get_functiondef(p.oid))='"+x['post_full_md5']+"' AND md5(p.prosrc)='"+x['post_body_md5']+"')" for x in changes]
 proof="(SELECT count(*)=3 FROM pg_proc p WHERE ("+' OR '.join(predicates)+") AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) AND EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('"+HELPER+"') AND p.proowner='postgres'::regrole AND NOT p.prosecdef AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog','lock_timeout=1s'] AND position('pg_advisory_xact_lock_shared(530090,1)' IN p.prosrc)>0)"
 s="-- Ordinary transient maintenance-lane writers must not discard private original continuations.\n-- Bounded one-second wait on the SAME first shared lane; freeze and every financial/lease guard unchanged.\n-- @live-proof: "+proof+"\nBEGIN;\nSET LOCAL lock_timeout='1s';\nSET LOCAL statement_timeout='5s';\n"
 s+="DO $pre$ BEGIN IF to_regprocedure('"+HELPER+"') IS NOT NULL THEN RAISE EXCEPTION 'HAND_CONTINUATION_WAIT_HELPER_EXISTS'; END IF; END $pre$;\n"
 s+="CREATE FUNCTION "+HELPER+" RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog SET lock_timeout='1s' AS $wait$\nBEGIN\n PERFORM pg_advisory_xact_lock_shared(530090,1);\nEND $wait$;\nREVOKE ALL ON FUNCTION "+HELPER+" FROM PUBLIC,anon,authenticated,service_role;\n"
 s+="DO $replace$ DECLARE f regprocedure;d text;BEGIN\n"
 for x in changes:
  lit=lambda z:"'"+z.replace("'","''")+"'"
  s+=" f:='public."+x['signature']+"'::regprocedure;\n IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=f AND md5(pg_get_functiondef(p.oid))='"+x['full_md5']+"' AND md5(p.prosrc)='"+x['body_md5']+"' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']) THEN RAISE EXCEPTION 'HAND_CONTINUATION_WAIT_PREIMAGE_CHANGED' USING ERRCODE='55000'; END IF;\n d:=pg_get_functiondef(f);\n IF (length(d)-length(replace(d,"+lit(x['old'])+",'')))<>length("+lit(x['old'])+") THEN RAISE EXCEPTION 'HAND_CONTINUATION_WAIT_SHAPE_CHANGED';END IF;\n EXECUTE replace(d,"+lit(x['old'])+","+lit(NEW)+");\n"
 s+=" IF NOT ("+proof+") THEN RAISE EXCEPTION 'HAND_CONTINUATION_WAIT_POSTIMAGE_CHANGED'; END IF;\nEND $replace$;\nCOMMIT;\n"
 return s,changes,proof
if __name__=='__main__':
 import sys
 s,rows,proof=render(sys.argv[1]);p=ROOT/sys.argv[1];p.write_text(s);print(json.dumps([{k:v for k,v in x.items() if k not in ('definition','old')} for x in rows],indent=2))
