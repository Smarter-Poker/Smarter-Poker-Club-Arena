"""Compose the one retained-save lane substitution from the installed bounded-wait image."""
import hashlib, importlib.util
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
MIGRATION='supabase/migrations/20261029231647_retained_original_hands_share_their_tournament_table_lane.sql'
SIG='public.fn_f06_retain_hand_continuation(uuid,uuid,uuid,bigint,bigint,text,text)'
LANE='public.fn_ca_f06_share_table_lane(uuid,uuid,uuid)'
OLD="PERFORM smarter_private.f06_prefix(p_tournament_id, p_lease_generation, '{}', ARRAY[p_table_id]);"
NEW='PERFORM public.fn_ca_f06_share_table_lane(p_tournament_id, p_lease_generation, p_table_id);'

def render():
 spec=importlib.util.spec_from_file_location('bounded_wait',Path(__file__).with_name('build-maintenance-lane.py'))
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 _,rows,_=module.render('unused')
 row=next(x for x in rows if 'retain_hand_continuation(' in x['signature'])
 before=row['definition'].replace(row['old'],module.NEW)
 assert hashlib.md5(before.encode()).hexdigest()=='e5001407fe6ae37667f73a292812985d'
 assert before.count(OLD)==1
 after=before.replace(OLD,NEW)
 def predicate(sig,full,body):
  return "EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('"+sig+"') AND md5(pg_get_functiondef(p.oid))='"+full+"' AND md5(p.prosrc)='"+body+"' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private'])"
 full=hashlib.md5(after.encode()).hexdigest();body=hashlib.md5(after.split('$function$')[1].encode()).hexdigest()
 lane=predicate(LANE,'7ac5aeac3454c71ded85ff88655a3357','4305570df07bbe284d224c0afe3c7d02')
 pre=predicate(SIG,'e5001407fe6ae37667f73a292812985d','e53111a8d13236f9a107df003177496f')
 proof=predicate(SIG,full,body)+' AND '+lane
 lit=lambda x:"'"+x.replace("'","''")+"'"
 sql="""-- A retained original belongs to one table, not the exclusive tournament settlement lane.
-- Version reserved by scripts/new-migration.mjs. Production 2026-10-29 22:45Z:
-- sibling post-commit projection held T shared while waiting on statistics rows;
-- retained saves requested T exclusive and timed out before saving their originals.
-- Use the installed per-table lane: lease fence, G/T shared, exact table/seats.
-- Every original, sequence, disposition, freeze and financial guard stays byte-identical.
-- Tournament-wide authorities remain exclusive. This does not fix every statistics/lease wait.
-- @live-proof: """+proof+"\nBEGIN;\nSET LOCAL lock_timeout='1s';\nSET LOCAL statement_timeout='5s';\nDO $replace$ DECLARE d text;post text;BEGIN\n IF NOT ("+pre+' AND '+lane+") THEN RAISE EXCEPTION 'HAND_CONTINUATION_SHARED_LANE_PREIMAGE_CHANGED' USING ERRCODE='55000'; END IF;\n d:=pg_get_functiondef('"+SIG+"'::regprocedure);\n IF (length(d)-length(replace(d,"+lit(OLD)+",'')))<>length("+lit(OLD)+") THEN RAISE EXCEPTION 'HAND_CONTINUATION_SHARED_LANE_SHAPE_CHANGED'; END IF;\n EXECUTE replace(d,"+lit(OLD)+","+lit(NEW)+");\n post:=pg_get_functiondef('"+SIG+"'::regprocedure);\n IF replace(post,"+lit(NEW)+","+lit(OLD)+") IS DISTINCT FROM d OR NOT ("+proof+") THEN RAISE EXCEPTION 'HAND_CONTINUATION_SHARED_LANE_POSTIMAGE_CHANGED'; END IF;\nEND $replace$;\nCOMMIT;\n"
 return sql,before,after,proof
if __name__=='__main__':
 sql,_,_,_=render();(ROOT/MIGRATION).write_text(sql)
