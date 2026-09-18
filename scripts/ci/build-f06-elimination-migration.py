"""Render the exact current elimination/F06 composition, without changing money terms."""
from pathlib import Path
import hashlib
import json
import re
import sys

ROOT = Path(__file__).resolve().parents[2]
CAPTURE = ROOT / 'scripts/ci/fixtures/f06-accepted-elimination/current-authorities-20260918.json'

def literal(value):
    return "'" + value.replace("'", "''") + "'"

def once(text, old, new):
    if text.count(old) != 1:
        raise ValueError('exact elimination source seam changed: ' + old[:100])
    return text.replace(old, new, 1)

def identity(row):
    s = row['signature']
    return s if '.' in s.split('(')[0] else 'public.' + s

def cleanup(candidate, relation):
    return "\n  DELETE FROM smarter_private.f06_elimination_dispatch\n   WHERE xid=txid_current() AND candidate_id="+candidate+"\n     AND relation_name='"+relation+"';\n"

def roster_auth(player, candidate, prize):
    return """  -- Only this validated claim can authorize its exact next roster write.
  -- No request setting or public API can mint this transaction-local proof.
  INSERT INTO smarter_private.f06_elimination_dispatch
    (xid,relation_name,row_id,candidate_id,old_record,new_record)
  SELECT txid_current(),'tournament_players',"""+player+".id,"+candidate+",to_jsonb("+player+"),\n    to_jsonb("+player+")||jsonb_build_object('status','eliminated',\n      'position',p_position,'prize',"+prize+",'eliminated_at',v_bust_at)\n  WHERE EXISTS(SELECT 1 FROM smarter_private.f06_operations o\n    WHERE o.source_table_id="+player+".table_id\n      AND o.state NOT IN ('acknowledged','withdrawn_before_manifest'));\n"

def seat_auth(candidate, predicate):
    return """  -- Closing the exact already-zero seat belongs to the same proven bust.
  INSERT INTO smarter_private.f06_elimination_dispatch
    (xid,relation_name,row_id,candidate_id,old_record,new_record)
  SELECT txid_current(),'table_seats',s.id,"""+candidate+""",to_jsonb(s),
    to_jsonb(s)||jsonb_build_object('left_at',now())
  FROM public.table_seats s
  JOIN public.tournament_knockout_candidates c ON c.id="""+candidate+"""
  WHERE """+predicate+""" AND s.left_at IS NULL
    AND s.stack=0 AND s.id=c.seat_id AND s.joined_at=c.seat_joined_at
    AND s.table_id=c.table_id AND s.user_id=c.eliminated_user_id
    AND EXISTS(SELECT 1 FROM smarter_private.f06_operations o
      WHERE o.source_table_id=s.table_id
        AND o.state NOT IN ('acknowledged','withdrawn_before_manifest'));
"""

GUARD = """
 -- A validated elimination is neither a hand dispatch nor a seat move. The
 -- private core authorizes exactly one row image immediately before its CAS;
 -- this BEFORE trigger consumes it, so later writes cannot reuse it. Existing
 -- lane acquisition above still serializes the source/manifest transition.
 IF TG_OP='UPDATE' AND src=dst AND oldj->>'user_id'=newj->>'user_id'
 AND ((TG_TABLE_NAME='tournament_players' AND oldj->>'status'='playing'
       AND newj->>'status'='eliminated' AND oldj->'chips'='0'::jsonb
       AND newj->'chips'='0'::jsonb)
   OR (TG_TABLE_NAME='table_seats' AND oldj->>'left_at' IS NULL
       AND newj->>'left_at' IS NOT NULL AND oldj->'stack'='0'::jsonb
       AND newj->'stack'='0'::jsonb))
 AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_operations o
   WHERE o.source_table_id=src
     AND o.state NOT IN ('acknowledged','withdrawn_before_manifest')
     AND (o.state<>'park_requested' OR o.manifest IS NOT NULL
       OR o.revision<>0 OR o.custody_id IS NOT NULL OR o.custody_generation IS NOT NULL
       OR o.close_receipt IS NOT NULL OR o.cleanup_kind IS NOT NULL
       OR to_jsonb(o)->>'abort_receipt_id' IS NOT NULL
       OR EXISTS(SELECT 1 FROM smarter_private.f06_members m WHERE m.break_id=o.break_id)
       OR EXISTS(SELECT 1 FROM smarter_private.f06_attempts a WHERE a.break_id=o.break_id))) THEN
   DELETE FROM smarter_private.f06_elimination_dispatch d
   USING public.tournament_knockout_candidates c
   WHERE d.xid=txid_current() AND d.relation_name=TG_TABLE_NAME
     AND d.row_id=(oldj->>'id')::uuid AND d.candidate_id=c.id
     AND d.old_record=oldj AND d.new_record=newj
     AND c.tournament_id=t AND c.table_id=src AND c.eliminated_user_id=u
     AND c.state='pending' AND c.stack_after=0
     AND (TG_TABLE_NAME='tournament_players' AND oldj->>'tournament_id'=t::text
       OR TG_TABLE_NAME='table_seats' AND c.seat_id=(oldj->>'id')::uuid
         AND c.seat_joined_at=(oldj->>'joined_at')::timestamptz);
   IF FOUND THEN RETURN NEW; END IF;
 END IF;
"""

def render():
    rows=json.loads(CAPTURE.read_text())['rows']
    if len(rows)!=6:
        raise ValueError('exact six current authorities required')
    checks=[]
    post=[]
    for r in rows:
        d=r['definition'];tag=re.search(r'\bAS\s+(\$\w*\$)',d)[1]
        body=d.split(tag)[1]
        if hashlib.md5(d.encode()).hexdigest()!=r['definition_md5'] or hashlib.md5(body.encode()).hexdigest()!=r['source_md5']:
            raise ValueError('captured authority bytes changed')
        grants=sorted(r['grants'],key=lambda x:(x['role'],x['privilege']))
        sig=identity(r)
        checks.append("DO $preimage$ DECLARE a jsonb; BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure("+literal(sig)+") AND md5(pg_get_functiondef(oid))="+literal(r['definition_md5'])+" AND pg_get_userbyid(proowner)="+literal(r['owner'])+") THEN RAISE EXCEPTION 'F06_ELIMINATION_AUTHORITY_DRIFT: %',"+literal(sig)+"; END IF; SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,x.privilege_type) INTO a FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE p.oid="+literal(sig)+"::regprocedure; IF a IS DISTINCT FROM "+literal(json.dumps(grants))+"::jsonb THEN RAISE EXCEPTION 'F06_ELIMINATION_ACL_DRIFT: %',"+literal(sig)+"; END IF; END $preimage$;")
        if 'fn_claim_bounty_legacy_' in sig:
            d=once(d,'  UPDATE public.tournament_players tp\n',roster_auth('v_player','v_candidate.id','p_prize')+'  UPDATE public.tournament_players tp\n')
            d=once(d,'  v_claimed:=true;',cleanup('v_candidate.id','tournament_players')+'  v_claimed:=true;')
            d=once(d,'  UPDATE public.table_seats s\n',seat_auth('v_candidate.id','s.table_id=p_table_id AND s.user_id=p_eliminated_user_id')+'  UPDATE public.table_seats s\n')
            d=once(d,'  UPDATE public.tables tb\n',cleanup('v_candidate.id','table_seats')+'  UPDATE public.tables tb\n')
        elif 'fn_eliminate_player_legacy_' in sig:
            d=once(d,'  UPDATE public.tournament_players\n',roster_auth('v_p','v_resolved_candidate_id','round(p_prize,2)')+'  UPDATE public.tournament_players\n')
            d=once(d,'  WITH released AS (',cleanup('v_resolved_candidate_id','tournament_players')+seat_auth('v_resolved_candidate_id','s.user_id=p_user_id')+'  WITH released AS (')
            d=once(d,'  UPDATE public.tables tb SET current_players=(',cleanup('v_resolved_candidate_id','table_seats')+'  UPDATE public.tables tb SET current_players=(')
        elif 'f06_source_guard' in sig:
            seam=" IF NOT bound THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;\n"
            d=once(d,seam,seam+GUARD)
        else:
            continue
        # CREATE OR REPLACE preserves current owner/ACL. Authenticate both below.
        verified=checks[-1].replace('$preimage$','$postimage$').replace(r['definition_md5'],hashlib.md5(d.encode()).hexdigest()).replace('AUTHORITY_DRIFT','POSTIMAGE_DRIFT')
        post.append(d.rstrip().rstrip(';')+';\n'+verified)
    header="""-- Exact accepted elimination may finish before a source manifest is frozen.
-- No park withdrawal, money formula, candidate proof or public API change.
-- money-trigger-ok: table_seats.a00_f06_source_seat because its exact enabled trigger definition is checked and retained; only the private owning function is composed below.
-- money-trigger-ok: tournament_players.a00_f06_source_roster because its exact enabled trigger definition is checked and retained; only the private owning function is composed below.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
"""
    triggers="""DO $triggers$ BEGIN
 IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND
   ((tgrelid='public.table_seats'::regclass AND tgname='a00_f06_source_seat'
     AND pg_get_triggerdef(oid)='CREATE TRIGGER a00_f06_source_seat BEFORE INSERT OR DELETE OR UPDATE OF table_id, user_id, seat_number, left_at ON public.table_seats FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard()')
    OR (tgrelid='public.tournament_players'::regclass AND tgname='a00_f06_source_roster'
     AND pg_get_triggerdef(oid)='CREATE TRIGGER a00_f06_source_roster BEFORE INSERT OR DELETE OR UPDATE OF table_id, user_id, seat_number, status ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard()')) AND tgenabled='O')<>2 THEN
 RAISE EXCEPTION 'F06_ELIMINATION_TRIGGER_DRIFT'; END IF;
END $triggers$;
CREATE TABLE smarter_private.f06_elimination_dispatch(
 xid bigint NOT NULL,relation_name text NOT NULL CHECK(relation_name IN ('tournament_players','table_seats')),
 row_id uuid NOT NULL,candidate_id uuid NOT NULL,old_record jsonb NOT NULL,new_record jsonb NOT NULL,
 PRIMARY KEY(xid,relation_name,row_id));
ALTER TABLE smarter_private.f06_elimination_dispatch OWNER TO postgres;
ALTER TABLE smarter_private.f06_elimination_dispatch ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.f06_elimination_dispatch FROM PUBLIC,anon,authenticated,service_role;
"""
    return header+'\n'.join(checks)+'\n'+triggers+'\n'.join(post)+'\nCOMMIT;\n'

if __name__=='__main__':
    Path(sys.argv[1]).write_text(render())
