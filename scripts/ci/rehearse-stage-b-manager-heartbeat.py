#!/usr/bin/env python3
"""Rehearse Stage-B manager admission against current lease authorities.

Uses an existing explicitly owned synthetic event only. Saves exact function
restoration before commit; no trigger is disabled and no payment row is written.
The real mystery-reveal fixture and every reveal mutation are rollback-only.
The fixture ages its own lease for the takeover case instead of waiting 30s.
Requires an explicit handoff from the full_stage1 fixture owner before running.
"""
import argparse
import concurrent.futures
import hashlib
import json
import re
import subprocess
import time
from pathlib import Path
import psycopg2

ROOT = Path(__file__).resolve().parents[2]
TID = '96010000-0000-0000-0000-000000000003'
OTHER = '97000000-0000-4000-8000-000000000032'
GEN = '97000000-0000-4000-8000-000000000041'
NEXT = '97000000-0000-4000-8000-000000000042'
SIGNATURES = [
    'smarter_private.fn_smarter_data_api_pre_request()',
    'public.fn_assert_tournament_manager_write_scope(uuid)',
    'public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)',
    'public.heartbeat_tournament_leases_v4(text,jsonb,integer)',
]

def function(source, name):
    match = re.search(r'CREATE (?:OR REPLACE )?FUNCTION '+re.escape(name)+r'\(.*?\bAS\s+(\$\w*\$)(.*?)\1;', source, re.S | re.I)
    if not match:
        raise AssertionError('missing definition: '+name)
    return match[0], match[2]

def replacement(source, start, end):
    expr = source.split(start, 1)[1].split(end, 1)[0]
    return ''.join(x.replace("''", "'").replace('\\n', '\n') for x in re.findall(r"E'((?:[^']|'')*)'", expr))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--socket', required=True)
    ap.add_argument('--port', type=int, required=True)
    ap.add_argument('--database', required=True)
    ap.add_argument('--expected-events', type=int, default=11)
    ap.add_argument('--output', required=True)
    ap.add_argument('--restore-journal', required=True)
    args = ap.parse_args()
    if args.database != 'full_stage1' or args.port != 55473 or not args.socket.startswith('/tmp/codex-chip-drift-cutover-'):
        raise SystemExit('refusing a database outside the explicitly owned rehearsal')
    def connect(label):
        c = psycopg2.connect(host=args.socket, port=args.port, dbname=args.database, user='postgres', application_name='codex-stageb-'+label)
        c.autocommit = True
        return c
    admin = connect('admin')
    def sql(c, query, params=None):
        with c.cursor() as cur:
            cur.execute(query, params)
            return cur.fetchall() if cur.description else None
    checks = []
    def check(ok, name):
        if not ok:
            raise AssertionError(name)
        checks.append(name)
        print('PASS', name, flush=True)
    def catalog():
        return sql(admin, """SELECT jsonb_build_object(
          'functions',(SELECT md5(string_agg(concat_ws('|',p.oid::regprocedure::text,pg_get_functiondef(p.oid),p.proowner::text,p.proacl::text,p.proconfig::text),E'\\n' ORDER BY p.oid::regprocedure::text)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','smarter_private') AND p.prokind IN ('f','p')),
          'triggers',(SELECT md5(string_agg(concat_ws('|',t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)),E'\\n' ORDER BY t.tgrelid::regclass::text,t.tgname)) FROM pg_trigger t WHERE NOT t.tgisinternal),
          'users',(SELECT count(*) FROM auth.users),'events',(SELECT count(*) FROM public.tournaments),'leases',(SELECT count(*) FROM public.engine_tournament_leases))""")[0][0]
    check(sql(admin, "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()")[0][0] == 0, 'owned database has no other sessions')
    before = catalog()
    check(before['events'] == args.expected_events, 'owned fixture has the explicitly expected synthetic event count')
    check(sql(admin, 'SELECT name FROM public.tournaments WHERE id=%s',(TID,))[0][0] == 'Current Shared Reserve 3', 'existing event is the specifically owned synthetic fixture')
    old_lease=sql(admin,'SELECT to_jsonb(l) FROM public.engine_tournament_leases l WHERE tournament_id=%s',(TID,))
    old_lease=old_lease[0][0] if old_lease else None
    restore = []
    for signature in SIGNATURES:
        rows = sql(admin, 'SELECT pg_get_functiondef(oid),proacl::text FROM pg_proc WHERE oid=to_regprocedure(%s)', (signature,))
        restore.append({'signature': signature, 'definition': rows[0][0] if rows else None, 'acl': rows[0][1] if rows else None})
    Path(args.restore_journal).write_text(json.dumps({'before': before, 'functions': restore, 'lease':old_lease, 'tournament_id':TID}, indent=2)+'\n')
    paths = {
      'stage_a':'supabase/migrations/20260908125958_tournament_manager_requests_carry_lease_authority.sql',
      'takeover':'supabase/migrations/20260908042900_tournament_leases_have_fencing_generations.sql',
      'heartbeat':'supabase/migrations/20260908221010_lease_heartbeats_skip_busy_generations.sql',
      'busy_fix':'supabase/migrations/20260910063559_a_busy_manager_keeps_its_lease.sql',
      'stage_b':'scripts/deploy/phase-three-strict-tournament-cutover.sql',
    }
    src = {k:(ROOT/v).read_text() for k,v in paths.items()}
    old = subprocess.check_output(['git','show','be6855907166c49ed5645fe4b351b93415dd0810:scripts/deploy/phase-three-strict-tournament-cutover.sql'],cwd=ROOT,text=True)
    old_hook, old_body = function(old, 'smarter_private.fn_smarter_data_api_pre_request')
    check(hashlib.md5(old_body.encode()).hexdigest() == '6812e4d06b27aa2888c852c93f94dcfd', 'regression source is the prior prepared hook')
    fixed_hook, fixed_body = function(src['stage_b'], 'smarter_private.fn_smarter_data_api_pre_request')
    helper, _ = function(src['stage_b'], 'public.fn_assert_tournament_manager_write_scope')
    claim, _ = function(src['takeover'], 'public.claim_tournament_lease_v2')
    claim_anchor = '  INSERT INTO public.engine_tournament_leases AS l ('
    claim_new = replacement(src['busy_fix'], 'v_claim_new    text :=', 'BEGIN\n  -- 1. the hook')
    check(claim.count(claim_anchor) == 1, 'takeover transform has one exact anchor')
    claim = claim.replace(claim_anchor, claim_new)
    _, claim_body = function(claim, 'public.claim_tournament_lease_v2')
    heartbeat, heart_body = function(src['heartbeat'], 'public.heartbeat_tournament_leases_v4')
    check(hashlib.md5(claim_body.encode()).hexdigest() == 'd1b5100c2b9f92bec5fd1680b0b4f230', 'takeover source exactly matches current live body')
    check(hashlib.md5(heart_body.encode()).hexdigest() == '5e6c99545e07c21efcb50e5cb3441c14', 'heartbeat source exactly matches current live body')
    a, _ = function(src['stage_a'], 'smarter_private.fn_smarter_data_api_pre_request')
    hook_new = replacement(src['busy_fix'], 'v_hook_new    text :=', 'v_claim_anchor text :=')
    a = a.replace('     FOR SHARE;\n  END IF;', hook_new)
    _, a_body = function(a, 'smarter_private.fn_smarter_data_api_pre_request')
    check(hashlib.md5(a_body.encode()).hexdigest() == 'ab227471f29f2944ebd64909622b6af7', 'tracked hook transform exactly matches live preimage')
    manager = connect('manager')
    heartbeat_conn = connect('heartbeat')
    takeover_conn = connect('takeover')
    all_conns = [manager, heartbeat_conn, takeover_conn]
    altered = False
    def request(c, generation=GEN, actor='tournament-manager', role='service_role', path='rpc/fn_begin_tournament_deal_review', tournament=TID, user=None, begin=True):
        if begin: sql(c, 'BEGIN')
        headers = {} if not actor else {'x-smarter-data-actor':actor,'x-smarter-data-protocol':'2' if actor=='tournament-manager' else '1'}
        if actor=='tournament-manager':
            headers.update({'x-smarter-tournament-id':tournament,'x-smarter-tournament-lease-generation':generation})
        sql(c, "SELECT set_config('request.headers',%s,true),set_config('request.jwt.claims',%s,true),set_config('request.method','POST',true),set_config('request.path',%s,true)",(json.dumps(headers),json.dumps({'role':role, **({'sub':user} if user else {})}),path))
        sql(c, 'SET LOCAL ROLE '+role)
        sql(c, 'SELECT smarter_private.fn_smarter_data_api_pre_request()')
        sql(c, 'RESET ROLE')
    def denied(c, work, code, name):
        try:
            work()
        except psycopg2.Error as exc:
            sql(c,'ROLLBACK')
            check(exc.pgcode==code,name)
        else:
            sql(c,'ROLLBACK')
            raise AssertionError(name+' unexpectedly passed')
    try:
        sql(admin,'BEGIN')
        for definition in [old_hook,helper,claim,heartbeat]:
            sql(admin,definition)
        sql(admin,'REVOKE ALL ON FUNCTION public.heartbeat_tournament_leases_v4(text,jsonb,integer) FROM PUBLIC,anon,authenticated')
        sql(admin,'GRANT EXECUTE ON FUNCTION public.heartbeat_tournament_leases_v4(text,jsonb,integer) TO service_role')
        sql(admin,'DELETE FROM public.engine_tournament_leases WHERE tournament_id=%s',(TID,))
        sql(admin,"INSERT INTO public.engine_tournament_leases(tournament_id,instance_id,engine_version,lease_generation,protocol_version) VALUES(%s,'owned-manager','native-rehearsal',%s,2)",(TID,GEN))
        sql(admin,'COMMIT'); altered=True
        request(manager)
        claims=json.dumps([{'tournament_id':TID,'lease_generation':GEN}])
        reg=sql(heartbeat_conn,'SELECT state FROM public.heartbeat_tournament_leases_v4(%s,%s::jsonb,30)',('owned-manager',claims))[0][0]
        check(reg=='busy','prior prepared FOR SHARE hook reproduces skipped heartbeat')
        sql(manager,'ROLLBACK')
        sql(admin,fixed_hook)
        request(manager)
        check(sql(manager,"SELECT current_setting('app.smarter_manager_request_fenced',true)")[0][0]=='protocol-2','admitted manager receives exact lease proof')
        sql(manager,'SELECT public.fn_assert_tournament_manager_write_scope(%s)',(TID,))
        checks.append('scope helper accepts matching tournament')
        for i in range(2):
            state=sql(heartbeat_conn,'SELECT state FROM public.heartbeat_tournament_leases_v4(%s,%s::jsonb,30)',('owned-manager',claims))[0][0]
            check(state=='kept','heartbeat renews during held manager request '+str(i+1))
        # Deterministically make this owned row eligible for takeover while
        # the admitted request remains in flight, without sleeping thirty seconds.
        sql(heartbeat_conn,"UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp()-interval '31 seconds' WHERE tournament_id=%s",(TID,))
        def claim_new_owner():
            return sql(takeover_conn,'SELECT granted,lease_generation FROM public.claim_tournament_lease_v2(%s,%s,%s,%s,30)',(TID,'owned-new-manager','native-rehearsal',NEXT))[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            future=executor.submit(claim_new_owner)
            try:
                deadline=time.monotonic()+5
                waited=False
                while time.monotonic()<deadline:
                    if sql(admin,"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='codex-stageb-takeover' AND wait_event_type='Lock')")[0][0]:
                        waited=True;break
                    if future.done():break
                    time.sleep(.02)
                check(waited and not future.done(),'exact takeover blocks behind admitted manager transaction')
                check(sql(admin,'SELECT lease_generation::text FROM public.engine_tournament_leases WHERE tournament_id=%s',(TID,))[0][0]==GEN,'blocked takeover cannot replace in-flight generation')
            finally:
                sql(manager,'COMMIT')
            granted,generation=future.result(timeout=5)
            check(granted and str(generation)==NEXT,'takeover commits new generation only after manager release')
        denied(manager,lambda:request(manager,generation=GEN),'42501','old generation is fenced after takeover')
        request(manager,generation=NEXT)
        sql(manager,'SELECT public.fn_assert_tournament_manager_write_scope(%s)',(TID,))
        check(True,'new generation passes hook and scope')
        denied(manager,lambda:sql(manager,'SELECT public.fn_assert_tournament_manager_write_scope(%s)',(OTHER,)),'42501','manager cannot cross tournament scope')
        for path in ['rpc/fn_begin_tournament_deal_review','rest/v1/rpc/fn_close_tournament_deal_review','rpc/fn_complete_tournament_terminal_proposal']:
            denied(manager,lambda p=path:request(manager,actor='service',path=p),'42501','ordinary service cannot call manager-only '+path)
        denied(manager,lambda:request(manager,actor='',path='rpc/heartbeat_tournament_leases_v4'),'42501','unmarked heartbeat-v4 request refuses')
        for path in ['rpc/process_tournament_rebuy','rest/v1/rpc/fn_decline_tournament_rebuy','rpc/fn_mystery_bounty_reveal']:
            request(manager,actor='',role='authenticated',path=path)
            check(sql(manager,"SELECT current_setting('app.smarter_data_actor',true),current_setting('app.smarter_manager_request_fenced',true)")[0]==('browser',''),'player route stays compatible without manager proof '+path)
            sql(manager,'ROLLBACK')
        reveal = sql(admin, "SELECT md5(prosrc),proacl::text,proconfig,pg_get_userbyid(proowner),prosecdef FROM pg_proc WHERE oid='public.fn_mystery_bounty_reveal(uuid,uuid,boolean)'::regprocedure")[0]
        check((reveal[0],reveal[2],reveal[3],reveal[4]) == ('5578ec53c8a531eeba47d448ae9af1b1',['search_path=public, pg_temp'],'postgres',True), 'real reveal body and configuration exactly match live hardened authority')
        for role, actor in [('anon',''),('service_role',''),('service_role','service'),('authenticated','tournament-manager')]:
            denied(manager,lambda r=role,a=actor:request(manager,role=r,actor=a,path='rpc/fn_mystery_bounty_reveal'), '42501', 'reveal refuses unsupported caller '+role+'/'+(actor or 'unmarked'))
        players = [r[0] for r in sql(admin,'SELECT user_id::text FROM public.tournament_players WHERE tournament_id=%s ORDER BY user_id',(TID,))]
        check(len(players)>=3, 'reveal fixture reuses three existing owned event players')
        revealer, outsider, eliminated = players[:3]
        award='97000000-0000-4000-8000-000000000061'
        chest='97000000-0000-4000-8000-000000000062'
        def seed_reveal():
            sql(manager,'BEGIN')
            # The historical fixture has default PUBLIC execute; compose the
            # source-owned live grants only in this rollback-only transaction.
            sql(manager,'REVOKE ALL ON FUNCTION public.fn_mystery_bounty_reveal(uuid,uuid,boolean) FROM PUBLIC,anon,authenticated,service_role')
            sql(manager,'GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_reveal(uuid,uuid,boolean) TO authenticated,service_role')
            check(sql(manager,"SELECT proacl::text FROM pg_proc WHERE oid='public.fn_mystery_bounty_reveal(uuid,uuid,boolean)'::regprocedure")[0][0]=='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}','rollback-only reveal fixture uses exact live grants')
            sql(manager,"INSERT INTO public.tournament_bounty_chests(id,tournament_id,seq,tier,amount_cents,status) VALUES(%s,%s,970061,'base',100,'reserved')",(chest,TID))
            sql(manager,"INSERT INTO public.tournament_bounty_awards(id,tournament_id,chest_id,eliminated_user_id,amount_cents,tier,status,op_id,hand_id) VALUES(%s,%s,%s,%s,100,'base','reserved',%s,'owned-hook-reveal')",(award,TID,chest,eliminated,award))
            sql(manager,'INSERT INTO public.tournament_bounty_award_recipients(award_id,user_id,amount_cents,is_designated_revealer) VALUES(%s,%s,100,true)',(award,revealer))
            sql(manager,'UPDATE public.tournament_bounty_chests SET award_id=%s WHERE id=%s',(award,chest))
            sql(manager,'SET CONSTRAINTS ALL IMMEDIATE')
        def reveal_call(user, supplied_actor, auto, path='rpc/fn_mystery_bounty_reveal', actor='', role='authenticated', begin=False):
            request(manager,generation=NEXT,actor=actor,role=role,path=path,user=user,begin=begin)
            sql(manager,'SET LOCAL ROLE '+role)
            result=sql(manager,'SELECT public.fn_mystery_bounty_reveal(%s,%s,%s)',(award,supplied_actor,auto))[0][0]
            sql(manager,'RESET ROLE')
            return result
        for auto in [False,True]:
            seed_reveal()
            result=reveal_call(outsider,revealer,auto)
            check(result=={'ok':False,'reason':'not_the_revealer'},'real reveal refuses forged actor with auto='+str(auto))
            check(sql(manager,'SELECT status FROM public.tournament_bounty_awards WHERE id=%s',(award,))[0][0]=='reserved', 'refused reveal leaves award reserved auto='+str(auto))
            sql(manager,'ROLLBACK')
        seed_reveal()
        result=reveal_call(revealer,outsider,False,path='rest/v1/rpc/fn_mystery_bounty_reveal')
        check(result['ok'] and result['amount_cents']==100 and result['designated_revealer']==revealer,'real authenticated reveal uses verified identity and succeeds through gateway route')
        check(sql(manager,"SELECT current_setting('app.smarter_data_actor',true),current_setting('app.smarter_manager_request_fenced',true)")[0]==('browser',''),'real player reveal receives no manager proof')
        check(sql(manager,'SELECT a.status,c.status,a.paid_at,r.paid_at FROM public.tournament_bounty_awards a JOIN public.tournament_bounty_chests c ON c.id=a.chest_id JOIN public.tournament_bounty_award_recipients r ON r.award_id=a.id WHERE a.id=%s',(award,))[0]==('revealed','revealed',None,None),'real reveal changes visibility without invoking payment')
        replay=reveal_call(revealer,outsider,True)
        check(replay==result,'real player reveal replay returns the exact stored award')
        sql(manager,'ROLLBACK')
        seed_reveal()
        result=reveal_call(None,None,True,actor='tournament-manager',role='service_role')
        check(result['ok'] and result['amount_cents']==100,'exact current manager can still auto-reveal through real authority')
        check(sql(manager,"SELECT current_setting('app.smarter_manager_request_fenced',true)")[0][0]=='protocol-2','manager auto-reveal retains the lease proof')
        sql(manager,'ROLLBACK')
        check(sql(admin,'SELECT (SELECT count(*) FROM public.tournament_bounty_awards WHERE id=%s)+(SELECT count(*) FROM public.tournament_bounty_chests WHERE id=%s)+(SELECT count(*) FROM public.tournament_bounty_award_recipients WHERE award_id=%s)',(award,chest,award))[0][0]==0,'all reveal fixture rows and mutations rolled back')
    finally:
        for c in all_conns:
            try: sql(c,'ROLLBACK')
            except psycopg2.Error: pass
            c.close()
        sql(admin,'ROLLBACK')
        if altered:
            sql(admin,'BEGIN')
            sql(admin,'DELETE FROM public.engine_tournament_leases WHERE tournament_id=%s',(TID,))
            if old_lease is not None:
                sql(admin,'INSERT INTO public.engine_tournament_leases SELECT (jsonb_populate_record(NULL::public.engine_tournament_leases,%s::jsonb)).*',(json.dumps(old_lease),))
            for original in restore:
                sql(admin,original['definition'] if original['definition'] else 'DROP FUNCTION '+original['signature'])
            sql(admin,'COMMIT')
        after=catalog()
        check(after==before,'complete function and trigger catalogs plus fixture counts restored exactly')
        admin.close()
    evidence={'status':'passed','checks':checks,'assertions':len(checks),'live_hook_preimage_md5':hashlib.md5(a_body.encode()).hexdigest(),'prepared_hook_md5':hashlib.md5(fixed_body.encode()).hexdigest(),'claim_body_md5':hashlib.md5(claim_body.encode()).hexdigest(),'heartbeat_body_md5':hashlib.md5(heart_body.encode()).hexdigest(),'reveal_body_md5':'5578ec53c8a531eeba47d448ae9af1b1','source_sha256':{paths[k]:hashlib.sha256(v.encode()).hexdigest() for k,v in src.items()},'before':before,'after':after,'production_ddl_applied':False,'scope':'Native PostgreSQL17 request-context, genuine heartbeat and takeover functions. The owned fixture ages its lease for takeover; no production browser or engine adoption is claimed.'}
    Path(args.output).write_text(json.dumps(evidence,indent=2)+'\n')
    print(json.dumps({'status':'passed','assertions':len(checks),'output':args.output}),flush=True)

if __name__=='__main__':
    main()
