"""Permit retention is a reader; SHARE excludes state writers but permits FK readers."""
import hashlib,importlib.util
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
MIGRATION='supabase/migrations/20261031031334_retained_hand_permit_readers_allow_settlement_foreign_keys.sql'
def render():
 spec=importlib.util.spec_from_file_location('retain_shared',Path(__file__).with_name('build-retain-shared-lane.py'));b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
 _,_,before,_=b.render()
 old='AND tournament_id = p_tournament_id FOR UPDATE;'
 new='AND tournament_id = p_tournament_id FOR SHARE;'
 assert before.count(old)==1
 after=before.replace(old,new)
 assert hashlib.md5(before.encode()).hexdigest()=='95a7b245fe68c5a361fc04a1362f5b11'
 def check(d):return "EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='"+b.SIG+"'::regprocedure AND md5(pg_get_functiondef(p.oid))='"+hashlib.md5(d.encode()).hexdigest()+"' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private'])"
 sql='-- @live-proof: '+check(after)+"\n-- Production deadlocks: retained save owns table then waits on permit FOR UPDATE;\n-- settlement owns the dispatch FK KEY SHARE on that permit then waits on table.\n-- Retention does not update the permit. SHARE retains state-writer exclusion\n-- while allowing the FK reader. Table/seat and continuation locks are unchanged.\nBEGIN;\nSET LOCAL lock_timeout='1s';\nSET LOCAL statement_timeout='5s';\nDO $pin$ BEGIN IF NOT ("+check(before)+") THEN RAISE EXCEPTION 'RETAIN_PERMIT_READER_PREIMAGE_CHANGED';END IF;END $pin$;\n"+after+";\nDO $post$ BEGIN IF NOT ("+check(after)+") THEN RAISE EXCEPTION 'RETAIN_PERMIT_READER_POSTIMAGE_CHANGED';END IF;END $post$;\nCOMMIT;\n"
 sql=sql.replace(after+';\n',after+';\nREVOKE ALL ON FUNCTION '+b.SIG+' FROM PUBLIC,anon,authenticated;\nGRANT EXECUTE ON FUNCTION '+b.SIG+' TO service_role;\n')
 return sql,before,after
if __name__=='__main__':
 sql,_,_=render();(ROOT/MIGRATION).write_text(sql)
