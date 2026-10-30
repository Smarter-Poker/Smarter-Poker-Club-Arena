"""Focused native helpers for the explicit started-event abort authority.
Only physical opening scenes/certificates are synthetic. Money uses real doors.
"""
import hashlib,json
from pathlib import Path
DATA=Path(__file__).resolve().parent/'fixtures/tournament-abort'
GEN='ab000000-0000-4000-8000-000000000001'
SERVICE="SELECT set_config('request.jwt.claims','{\"role\":\"service_role\"}',true),set_config('request.jwt.claim.role','service_role',true),set_config('request.jwt.claim.sub','',true);"

def sql_file(e,db,name,sql):
    p=e.output/(name+'.sql');p.write_text(sql);return e.sql(db,file=p,label=name,seconds=120)

def install_f06_extension(e,db,root):
    relations=json.loads((DATA/'current-relations.json').read_text())+json.loads((DATA/'hand-dependencies.json').read_text())+json.loads((DATA/'immutable-guard-relations.json').read_text())+json.loads((DATA/'chip-credit-receipt-relations.json').read_text())
    # Exact captured table columns and local PK/unique/check semantics. Existing
    # real financial relations retain their triggers and constraints unchanged.
    sql='SET check_function_bodies=off;CREATE SCHEMA IF NOT EXISTS smarter_private;'
    for r in relations:
        cols=[]
        for c in r['columns']:
            default=' DEFAULT '+c['default'] if c['default'] and 'nextval(' not in c['default'] else ''
            cols.append('"'+c['name']+'" '+c['type']+default+(' NOT NULL' if c['notnull'] else ''))
        constraints=[x['definition'] for x in r['constraints'] or []]
        sql+='CREATE TABLE IF NOT EXISTS '+r['relation']+'('+','.join(cols+constraints)+');'
        for c in r['columns']:
            default=' DEFAULT '+c['default'] if c['default'] and 'nextval(' not in c['default'] else ''
            sql+='ALTER TABLE '+r['relation']+' ADD COLUMN IF NOT EXISTS "'+c['name']+'" '+c['type']+default+';'
    sql+='ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS f06_lifecycle bigint NOT NULL DEFAULT 1;'
    sql+='ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS is_deleted boolean DEFAULT false;'
    sql+='ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS payout_depth_percent numeric;'
    funcs=json.loads((DATA/'pending-dependencies.json').read_text())+json.loads((DATA/'current-functions.json').read_text())+json.loads((DATA/'current-receipt-reader.json').read_text())+json.loads((DATA/'current-accounting-dependencies.json').read_text())+json.loads((DATA/'current-rake-owner.json').read_text())+json.loads((DATA/'immutable-guard-dependencies.json').read_text())+json.loads((DATA/'legacy-guard-proof.json').read_text())+json.loads((DATA/'current-chip-award-overlay.json').read_text())+json.loads((DATA/'chip-overlay-dependencies.json').read_text())+json.loads((DATA/'chip-overlay-payout-dependency.json').read_text())+json.loads((DATA/'chip-prior-award-credit-dependency.json').read_text())+json.loads((DATA/'chip-prior-award-wallet-dependencies.json').read_text())+json.loads((DATA/'chip-prior-award-ledger-writer.json').read_text())
    for f in funcs:
        assert hashlib.md5(f['definition'].encode()).hexdigest()==f.get('definition_md5',hashlib.md5(f['definition'].encode()).hexdigest())
        sig=f['signature'] if f['signature'].startswith('smarter_private.') else 'public.'+f['signature']
        sql+=f['definition']+';REVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC,anon,authenticated,service_role;'
        if not sig.startswith('smarter_private.'):sql+='GRANT EXECUTE ON FUNCTION '+sig+' TO service_role;'
    capture=json.loads((DATA/'chip-prior-credit-capture.json').read_text())
    for f in capture['functions']:
        assert hashlib.md5(f['definition'].encode()).hexdigest()==f['definition_md5']
        sql+=f['definition']+';'
    for t in capture['triggers']:
        sql+='DROP TRIGGER IF EXISTS '+t['name']+' ON public.'+t['relation']+';'+t['definition']+';'
    guards=json.loads((DATA/'current-immutable-guards.json').read_text())
    for f in guards['functions']:
        assert hashlib.md5(f['definition'].encode()).hexdigest()==f['definition_md5']
        sql+=f['definition']+';'
    for t in guards['triggers']:
        sql+='DROP TRIGGER IF EXISTS '+t['name']+' ON public.'+t['relation']+';'+t['definition']+';'
    sql_file(e,db,'actual-f06-extension',sql)
    e.report['source_sha256'].update({str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in DATA.glob('*.json')})

def prepare_quiesced(e,db,event,operation,table_id):
    # Called only in the disposable native cluster after genuine charges/awards.
    # Physical engine behavior is qualified by the connected engine regression;
    # this local scene exercises the actual generation/custody/ACK DB authority.
    sql='BEGIN;'+SERVICE+"SET LOCAL session_replication_role=replica;"
    sql+="UPDATE public.tournaments SET status='RUNNING',started_at=coalesce(started_at,clock_timestamp()) WHERE id='"+event+"';"
    sql+="INSERT INTO public.tables(id,name,tournament_id,status,lifecycle,current_players,game_type,club_id,seat_game_scope,seat_admission_key,f06_lifecycle) SELECT '"+table_id+"','Native abort original',id,'running','live',0,'tournament',club_id,'table:"+table_id+"','tournament:"+event+"',1 FROM public.tournaments WHERE id='"+event+"' ON CONFLICT(id) DO NOTHING;"
    sql+="INSERT INTO public.engine_tournament_leases(tournament_id,instance_id,engine_version,lease_generation,protocol_version) VALUES('"+event+"','native-abort','native-abort','"+GEN+"',2) ON CONFLICT(tournament_id) DO UPDATE SET heartbeat_at=clock_timestamp(),lease_generation=EXCLUDED.lease_generation,protocol_version=2;"
    sql+="INSERT INTO public.tournament_players(tournament_id,user_id,status,chips,club_id) SELECT DISTINCT c.target_id,c.user_id,'playing',1000,c.arena_id FROM public.poker_diamond_custody c WHERE c.target_id='"+event+"' AND c.purpose='tournament_entry' AND NOT EXISTS(SELECT 1 FROM public.tournament_players p WHERE p.tournament_id=c.target_id AND p.user_id=c.user_id);"
    sql+="SET LOCAL session_replication_role=origin;SELECT public.fn_ca_request_tournament_abort('"+operation+"',ARRAY['"+event+"'::uuid],'Native explicitly requested original-charge refund');"
    sql+="SELECT set_config('app.smarter_data_actor','tournament-manager',true),set_config('app.smarter_tournament_id','"+event+"',true),set_config('app.smarter_tournament_lease_generation','"+GEN+"',true);"
    evidence={'kind':'tournament_abort_boundary_v1','certificate_version':1,'physical_stopped':True,'parked_before_retirement':True,'drained':True,'manager_tail_joined':True,'pending_writers':0,'bank_state_write_pending':False,'lifecycle':1,'hand_number':0,'source_table_ids':[table_id]}
    sql+="SELECT public.fn_ca_ack_tournament_abort_boundary('"+operation+"','"+event+"','"+table_id+"','"+GEN+"',0,'"+json.dumps(evidence)+"'::jsonb);COMMIT;"
    sql_file(e,db,'quiesce-'+event[-4:],sql)
    _,out,_=e.sql(db,"BEGIN;"+SERVICE+"SELECT public.fn_ca_tournament_abort_stop_state('"+operation+"','"+event+"');COMMIT;",label='money-hash-'+event[-4:])
    state=json.loads(out.strip().splitlines()[-1])
    assert state['state']=='quiesced' and state['current_boundary_valid'] is True
    assert state['quiescence_generation']==GEN and state['current_generation']==GEN
    assert all(isinstance(row['lifecycle'],str) and row['lifecycle'].isdigit() for row in state['tables'])
    return state['money_hash']
