#!/usr/bin/env python3
"""Disposable PG17 proof of the service-only individual public-history reader.
No DSN/remote connection accepted. Synthetic histories only, no financial writes.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid

ROOT=Path(__file__).resolve().parents[2]
MIGRATION=ROOT/'supabase/migrations/20261025214230_horse_own_public_history_read.sql'
V2_MIGRATION=ROOT/'supabase/migrations/20261027041304_horse_own_public_history_context_before_horizon.sql'
V3_MIGRATION=ROOT/'supabase/migrations/20261027143251_horse_own_public_history_validates_only_the_selected_horizon.sql'
PG=Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin'))
BASE=Path(os.environ.get('TMPDIR') or os.environ.get('RUNNER_TEMP') or tempfile.gettempdir())
if sys.platform=='darwin' and not str(BASE).startswith('/Volumes/SmarterWork/agent-work/'):
    raise RuntimeError('TMPDIR must use the task-owned external SSD')
ENV={k:v for k,v in os.environ.items() if not k.startswith('PG')}
ENV.update(LANG='C',LC_ALL='C')
def uid(n): return str(uuid.UUID(int=n))
def lit(v): return "'"+json.dumps(v).replace("'","''")+"'::jsonb"

def main():
    checks=[]
    if os.geteuid()==0: raise RuntimeError('initdb requires non-root')
    with tempfile.TemporaryDirectory(prefix='horse-own-history-',dir=BASE) as raw, tempfile.TemporaryDirectory(prefix='oh-',dir=BASE.parents[1]) as sock:
        data=Path(raw)/'data'
        def command(args,sql=None):
            return subprocess.run(list(map(str,args)),input=sql,text=True,capture_output=True,env=ENV,timeout=60)
        def run(sql,ok=True):
            r=command([PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',sock,'-p','55498','-U','postgres','-d','postgres'],sql)
            if (r.returncode==0)!=ok: raise AssertionError(r.stderr or r.stdout)
            return r.stdout.strip() if ok else r.stderr
        def check(name,condition):
            if not condition: raise AssertionError(name)
            checks.append(name)
        def read(actor=1,variant='nlh',fmt='cash',count=2,before='2026-10-25T02:00:00Z',role='service_role',claim='service_role',ok=True,legacy=False,v2=False):
            function='fn_horse_own_public_history_read' if legacy else ('fn_horse_own_public_history_read_v2' if v2 else 'fn_horse_own_public_history_read_v3')
            sql=f"SET ROLE {role}; SET request.jwt.claim.role='{claim}'; SELECT public.{function}('{uid(actor)}','{variant}','{fmt}',{count},'{before}');"
            r=run(sql,ok)
            return (json.loads(r) if r else None) if ok else r
        def hand(n,variant='nlh',tournament=None,position='BTN',count=2,end='2026-10-25T01:00:00Z',observer=1,extra_actions=None):
            h=uid(1000+n);table=uid(100)
            actions=extra_actions if extra_actions is not None else [dict(seat=1,userId=uid(observer),action='raise',amount=6,stage='preflop',timestamp=1,isFullRaise=True,cards=['secret_private_cards']),dict(seat=2,userId=uid(2),action='fold',amount=0,stage='preflop',timestamp=2)]
            t='NULL' if tournament is None else "'"+uid(tournament)+"'::uuid"
            run(f"INSERT INTO hand_history VALUES ('{h}','{table}',{1000000+n},'{variant}',{t},2,'{end}',{lit(actions)},{lit([dict(userId=uid(observer)),dict(userId=uid(2)),dict(userId=uid(3))])},'{json.dumps(['secret_private_cards'])}'::jsonb);")
            for actor,seat,pos,net in [(observer,1,position,2),(2,2,'BB',-2)]:
                run(f"INSERT INTO ca_hand_facts VALUES ('{h}','{uid(actor)}','{table}',{t},'{end}','{variant}',{seat},'{pos}',{count},{net},'{json.dumps(['secret_fact_cards'])}'::jsonb);")
        r=command([PG/'initdb','-D',data,'-U','postgres','-A','trust','--no-locale'])
        if r.returncode: raise RuntimeError(r.stderr)
        r=command([PG/'pg_ctl','-D',data,'-l',Path(raw)/'postgres.log','-o',f'-k {sock} -p 55498 -c listen_addresses= -c fsync=off','-w','start'])
        if r.returncode: raise RuntimeError(r.stderr)
        try:
            run("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth; CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT current_setting('request.jwt.claim.role',true)$$; CREATE TABLE profiles(id uuid PRIMARY KEY,is_horse boolean,status text,horse_status text); CREATE TABLE ca_horse_fleet_register(horse_id uuid PRIMARY KEY,retired_at timestamptz); CREATE TABLE tournaments(id uuid PRIMARY KEY,format_contract text,table_size integer,max_players integer); CREATE TABLE hand_history(id uuid PRIMARY KEY,table_id uuid,hand_number bigint,game_variant text,tournament_id uuid,big_blind numeric,ended_at timestamptz,actions jsonb,players jsonb,hole_cards jsonb); CREATE TABLE ca_hand_facts(hand_id uuid,user_id uuid,table_id uuid,tournament_id uuid,played_at timestamptz,game_variant text,seat smallint,position text,players_dealt smallint,net numeric,hole_cards jsonb,PRIMARY KEY(hand_id,user_id)); CREATE INDEX idx_ca_hand_facts_user_time ON ca_hand_facts(user_id,played_at DESC);")
            for actor in [1,2,3]:
                run(f"INSERT INTO profiles VALUES ('{uid(actor)}',true,'active','available'); INSERT INTO ca_horse_fleet_register VALUES ('{uid(actor)}',NULL);")
            run(MIGRATION.read_text())
            legacy_md5=run("SELECT md5(pg_get_functiondef('public.fn_horse_own_public_history_read(uuid,text,text,integer,timestamptz)'::regprocedure));")
            run(V2_MIGRATION.read_text())
            check('old serving engines retain their exact reader',legacy_md5==run("SELECT md5(pg_get_functiondef('public.fn_horse_own_public_history_read(uuid,text,text,integer,timestamptz)'::regprocedure));"))
            v2_md5=run("SELECT md5(pg_get_functiondef('public.fn_horse_own_public_history_read_v2(uuid,text,text,integer,timestamptz)'::regprocedure));")
            run(V3_MIGRATION.read_text())
            check('serving v2 retains its exact reader',v2_md5==run("SELECT md5(pg_get_functiondef('public.fn_horse_own_public_history_read_v2(uuid,text,text,integer,timestamptz)'::regprocedure));"))
            check('v1 remains unchanged after v3 installation',legacy_md5==run("SELECT md5(pg_get_functiondef('public.fn_horse_own_public_history_read(uuid,text,text,integer,timestamptz)'::regprocedure));"))
            hand(1)
            p=read()
            check('one original observer hand restored',len(p['window']['hands'])==1)
            check('definition checksum is provided',len(p['definitionMd5'])==32)
            print(json.dumps(dict(definitionMd5=p['definitionMd5'])),flush=True)
            check('adapter pins the exact native definition',p['definitionMd5'] in (ROOT/'server/src/services/HorseOwnPublicHistory.ts').read_text())
            check('no cards from actions, history or facts',all(x not in json.dumps(p) for x in ['secret','hole_cards','cards']))
            check('public wagers and complete public results remain',p['window']['hands'][0]['actions'][0]['amount']==6 and len(p['window']['hands'][0]['results'])==2)
            check('other RLS roster chair proves no participation',read(actor=3)['window']['hands']==[])
            hand(2,position='UNKNOWN')
            check('unknown original position is refused',len(read()['window']['hands'])==1)
            hand(99)
            run("UPDATE hand_history SET hand_number=99 WHERE id='"+uid(1099)+"';")
            check('legacy unbound hand nonce stays unavailable',len(read()['window']['hands'])==1)
            hand(3,variant='plo5')
            check('exact variant remains separate',len(read()['window']['hands'])==1 and len(read(variant='plo5')['window']['hands'])==1)
            check('exact dealt count remains separate',read(count=6)['window']['hands']==[])
            for n,contract,size,fmt in [(10,'mtt-v2',9,'mtt'),(11,'sng-v1',6,'sng'),(12,'spin-v1',3,'spin'),(13,'sng-v1',2,'hu_sng'),(14,None,9,None)]:
                marker='NULL' if contract is None else "'"+contract+"'"
                run(f"INSERT INTO tournaments VALUES ('{uid(n)}',{marker},{size},{size});")
                hand(n,tournament=n)
                if fmt: check('persisted '+fmt+' remains separate',len(read(fmt=fmt)['window']['hands'])==1)
            check('cash never imports tournament results',len(read()['window']['hands'])==1)
            # One valid older PLO5 observation must survive >512 newer
            # other-variant/size/format facts from the same original observer.
            run(f"INSERT INTO hand_history SELECT ('00000000-0000-0000-0003-'||lpad(n::text,12,'0'))::uuid,'{uid(100)}',3000000+n,'plo6',NULL,2,'2026-10-25T01:05:00Z'::timestamptz+n*interval '1 second','[]'::jsonb,'[]'::jsonb,'[]'::jsonb FROM generate_series(1,600) n; INSERT INTO ca_hand_facts SELECT id,'{uid(1)}',table_id,NULL,ended_at,'plo6',1,'BTN',6,0,'[]'::jsonb FROM hand_history WHERE hand_number>3000000;")
            check('original reader reproduces context starvation',read(variant='plo5',legacy=True)['window']['hands']==[])
            check('requested variant survives newer other-context traffic',len(read(variant='plo5')['window']['hands'])==1)
            run("UPDATE hand_history SET game_variant='nlh' WHERE hand_number>3000000; UPDATE ca_hand_facts SET game_variant='nlh' WHERE hand_id IN(SELECT id FROM hand_history WHERE hand_number>3000000);")
            check('original reader reproduces dealt-count starvation',read(count=2,legacy=True)['window']['hands']==[])
            check('requested dealt count survives newer same-variant traffic',len(read(count=2)['window']['hands'])==1)
            run(f"UPDATE hand_history SET tournament_id='{uid(10)}' WHERE hand_number>3000000; UPDATE ca_hand_facts SET tournament_id='{uid(10)}',players_dealt=2 WHERE hand_id IN(SELECT id FROM hand_history WHERE hand_number>3000000);")
            check('original reader reproduces tournament-format starvation',read(fmt='sng',legacy=True)['window']['hands']==[])
            check('requested format survives newer same-variant same-size traffic',len(read(fmt='sng')['window']['hands'])==1)
            check('requested cash survives newer tournaments of the same variant and size',len(read()['window']['hands'])==1)
            run("DELETE FROM ca_hand_facts WHERE hand_id IN(SELECT id FROM hand_history WHERE hand_number>3000000); DELETE FROM hand_history WHERE hand_number>3000000;")

            check('past cutoff excludes later public hands',read(before='2026-10-25T00:59:59Z')['window']['hands']==[])
            for role in ['anon','authenticated']:
                check(role+' cannot invoke even with forged service claim','permission denied' in read(role=role,claim='service_role',ok=False))
            check('service identity claim required','service_role required' in read(claim='authenticated',ok=False))
            check('bad context rejected','invalid individual history context' in read(count=11,ok=False))
            for actor in range(100,162):
                run(f"INSERT INTO profiles VALUES ('{uid(actor)}',true,'deleted','disabled'); INSERT INTO ca_horse_fleet_register VALUES ('{uid(actor)}','2026-10-01');")
                check('retired '+str(actor)+' stays unavailable',read(actor=actor) is None)
            check('reader never changes retired state',run("SELECT count(*) FROM profiles p JOIN ca_horse_fleet_register r ON r.horse_id=p.id WHERE p.status='deleted' AND p.horse_status='disabled' AND r.retired_at IS NOT NULL;")=='62')
            # Generate bounded public metadata only, using the same isolated rows.
            run(f"INSERT INTO hand_history SELECT ('00000000-0000-0000-0001-'||lpad(n::text,12,'0'))::uuid,'{uid(100)}',1010000+n,'nlh',NULL,2,'2026-10-25T01:10:00Z'::timestamptz+n*interval '1 second','[]'::jsonb,'[]'::jsonb,'[\"secret\"]'::jsonb FROM generate_series(1,600) n; INSERT INTO ca_hand_facts SELECT id,'{uid(1)}',table_id,NULL,ended_at,'nlh',1,'BTN',2,0,'[\"secret\"]'::jsonb FROM hand_history WHERE hand_number>1010000;")
            limited=read()['window']
            check('retained history bounded to 64 hands',len(limited['hands'])==64 and limited['capped'] is True)
            check('window admits most recent hands in chronological order',limited['hands'][0]['handNumber']==1010537 and limited['hands'][-1]['handNumber']==1010600)
            check('incomplete public results never invent other players',limited['hands'][0]['results'] is None)
            # Replay identical immutable data through both readers. Include a
            # skewed observer with many newer other-context hands, equal times,
            # invalid recent HH rows, and invalid original participation.
            run(f"INSERT INTO hand_history SELECT ('00000000-0000-0000-0004-'||lpad(n::text,12,'0'))::uuid,'{uid(100)}',4000000+n,'plo6',NULL,2,'2026-10-25T01:30:00Z'::timestamptz,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb FROM generate_series(1,20000) n; INSERT INTO ca_hand_facts SELECT id,'{uid(1)}',table_id,NULL,ended_at,'plo6',1,'BTN',6,0,'[]'::jsonb FROM hand_history WHERE hand_number>4000000;")
            run("UPDATE hand_history SET ended_at='2026-10-25T01:20:00Z' WHERE hand_number BETWEEN 1010001 AND 1010600; UPDATE ca_hand_facts SET played_at='2026-10-25T01:20:00Z' WHERE hand_id IN(SELECT id FROM hand_history WHERE hand_number BETWEEN 1010001 AND 1010600); ANALYZE hand_history; ANALYZE ca_hand_facts;")
            def equivalent(name,**context):
                check(name,read(**context)['window']==read(v2=True,**context)['window'])
            equivalent('v3 preserves tied time and hand ID ordering')
            for fmt in ['mtt','sng','spin','hu_sng']:
                equivalent('v3 preserves original '+fmt+' boundaries',fmt=fmt)
            equivalent('v3 preserves other variant and dealt-count contexts',variant='plo6',count=6)
            def history_plan(version):
                definition=run(f"SELECT pg_get_functiondef('public.fn_horse_own_public_history_read_v{version}(uuid,text,text,integer,timestamptz)'::regprocedure);")
                query=definition[definition.index('  WITH candidates'):definition.index('\n\n  RETURN jsonb_build_object')].replace(' INTO v_window','')
                for key,value in dict(p_observer=f"'{uid(1)}'::uuid",p_variant="'nlh'::text",p_format="'cash'::text",p_dealt_count='2',p_before="'2026-10-25T02:00:00Z'::timestamptz").items(): query=query.replace(key,value)
                explained=json.loads(run('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+query))[0]
                def nodes(node):
                    yield node
                    for child in node.get('Plans',[]): yield from nodes(child)
                probes=[n for n in nodes(explained['Plan']) if n.get('Relation Name')=='hand_history']
                if len(probes)!=1 or probes[0]['Node Type']!='Index Scan':
                    raise AssertionError('original HH lookup plan is not an index lookup: '+json.dumps(probes))
                top=explained['Plan']
                return dict(hhLookups=probes[0]['Actual Loops'],bufferAccesses=top['Shared Hit Blocks']+top['Shared Read Blocks'],executionMs=explained['Execution Time'])
            plans=dict(v2=history_plan(2),v3=history_plan(3))
            print(json.dumps(dict(historyPlans=plans)),flush=True)
            check('v2 reproduces 512 validated HH rows before retaining 64',plans['v2']['hhLookups']==512)
            check('v3 stops after the same 64 valid HH rows',plans['v3']['hhLookups']==64)
            check('v3 reduces full-query buffer work',plans['v3']['bufferAccesses']<plans['v2']['bufferAccesses'])
            # Newest invalid HH rows must be passed, never counted as one of
            # the 64 valid hands. Invalid fact seats/positions never enter the
            # identical 512-candidate horizon in either version.
            run("UPDATE hand_history SET hand_number=99 WHERE hand_number BETWEEN 1010576 AND 1010600; UPDATE ca_hand_facts SET seat=0 WHERE hand_id IN(SELECT id FROM hand_history WHERE hand_number BETWEEN 1010566 AND 1010575); UPDATE ca_hand_facts SET position='UNKNOWN' WHERE hand_id IN(SELECT id FROM hand_history WHERE hand_number BETWEEN 1010556 AND 1010565);")
            equivalent('v3 finds valid older HH after invalid newest rows and excludes invalid original seats/positions')
            invalid_plans=dict(v2=history_plan(2),v3=history_plan(3))
            print(json.dumps(dict(invalidNewestHistoryPlans=invalid_plans)),flush=True)
            check('v3 performs only the 25 refused plus 64 accepted HH lookups',invalid_plans['v3']['hhLookups']==89)
            run("DELETE FROM hand_history WHERE id IN(SELECT hand_id FROM ca_hand_facts WHERE user_id='"+uid(1)+"' AND game_variant='nlh' AND players_dealt=2 AND seat BETWEEN 1 AND 10 AND position IN ('BTN','SB','BB','UTG','UTG+1','UTG+2','UTG+3','MP','LJ','HJ','CO') ORDER BY played_at DESC,hand_id DESC LIMIT 5);")
            equivalent('v3 skips missing newest HH without losing the valid older hands')
            # Even valid older HH cannot escape the same 512 candidate bound.
            run("UPDATE hand_history SET hand_number=99 WHERE id IN(SELECT hand_id FROM ca_hand_facts WHERE user_id='"+uid(1)+"' AND game_variant='nlh' AND players_dealt=2 AND seat BETWEEN 1 AND 10 AND position IN ('BTN','SB','BB','UTG','UTG+1','UTG+2','UTG+3','MP','LJ','HJ','CO') ORDER BY played_at DESC,hand_id DESC LIMIT 512);")
            equivalent('v3 never searches beyond the original 512 context candidates')
            check('512 invalid newest candidates leave older valid hands unavailable',read()['window']['hands']==[])
            heavy=[dict(seat=1 if i%2==0 else 2,userId=uid(1 if i%2==0 else 2),action='call',amount=2,stage='preflop',timestamp=i+1,cards=['secret']) for i in range(256)]
            run(f"INSERT INTO hand_history SELECT ('00000000-0000-0000-0002-'||lpad(n::text,12,'0'))::uuid,'{uid(100)}',2000000+n,'nlh',NULL,2,'2026-10-25T01:40:00Z'::timestamptz+n*interval '1 second',{lit(heavy)},'[]'::jsonb,'[]'::jsonb FROM generate_series(1,64) n; INSERT INTO ca_hand_facts SELECT id,'{uid(1)}',table_id,NULL,ended_at,'nlh',1,'BTN',2,0,'[]'::jsonb FROM hand_history WHERE hand_number BETWEEN 2000001 AND 2000064;")
            equivalent('v3 preserves complete-hand byte capping without refilling from older candidates')
            byte_limited=read()['window']
            check('large windows keep complete hands within byte budget',0<len(byte_limited['hands'])<64 and byte_limited['capped'] is True and len(json.dumps(byte_limited).encode())<256*1024)
            check('public hand actions are never truncated',all(len(h['actions'])==256 for h in byte_limited['hands']))
            check('large payload still excludes every card',all(x not in json.dumps(byte_limited) for x in ['secret','hole_cards','cards']))
            # Realistic sparse-context regression: v2 must filter context before
            # its horizon, without fetching the observer's other contexts' heap.
            # Include a wide private canary to expose scattered heap work, never
            # include it in the index or reader projection.
            # Keep these 100k sparse-only facts distinct from v3's 20k skew hands.
            run(f"INSERT INTO ca_hand_facts SELECT ('00000000-0000-0000-0005-'||lpad(n::text,12,'0'))::uuid,'{uid(1)}','{uid(100)}',NULL,'2026-10-25T01:15:00Z'::timestamptz+n*interval '0.01 second','plo6',1,'BTN',6,0,to_jsonb(repeat('secret_private_canary',32)) FROM generate_series(1,100000) n; ANALYZE ca_hand_facts;")
            sparse_before=read(variant='plo5')
            empty_before=read(variant='plo8')
            def candidates_plan(variant):
                source=V2_MIGRATION.read_text()
                sql=source[source.index('SELECT f.hand_id'):source.index('  ), matched AS')]
                for key,value in [('p_observer',"'"+uid(1)+"'::uuid"),('p_variant',"'"+variant+"'"),('p_format',"'cash'"),('p_dealt_count','2'),('p_before',"'2026-10-25T02:00:00Z'::timestamptz")]:
                    sql=sql.replace(key,value)
                return json.loads(run('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+sql))[0]
            def walk(plan):
                yield plan
                for child in plan.get('Plans',[]): yield from walk(child)
            before_plan=candidates_plan('plo5')
            check('baseline reproduces irrelevant-context heap filtering',sum(n.get('Rows Removed by Filter',0)*n.get('Actual Loops',1) for n in walk(before_plan['Plan']))>=99999)
            index_migration=ROOT/'supabase/migrations/20261027150929_horse_public_history_context_cover.sql'
            module=(ROOT/'scripts/ci/migration-concurrent-preamble.mjs').as_uri()
            code="import{readFileSync}from'node:fs';import{splitConcurrentPreamble}from'"+module+"';const s=splitConcurrentPreamble(readFileSync(process.argv[1],'utf8'));if(!s.ok||s.indexes.length!==1)throw Error('shape');console.log(JSON.stringify(s));"
            split=command(['node','--input-type=module','-e',code,index_migration])
            if split.returncode: raise AssertionError(split.stderr)
            shape=json.loads(split.stdout)
            definition_before=run("SELECT md5(pg_get_functiondef('public.fn_horse_own_public_history_read_v2(uuid,text,text,integer,timestamptz)'::regprocedure));")
            run(shape['indexes'][0]['statement']);run(shape['body'])
            # All fixture rows are immutable: qualify genuine index-only access.
            run('VACUUM ANALYZE ca_hand_facts')
            after_plan=candidates_plan('plo5')
            scans=[n for n in walk(after_plan['Plan']) if n.get('Index Name')=='ca_hand_facts_observer_context_cover']
            check('sparse context uses covering observer variant count time range',len(scans)==1 and scans[0]['Node Type']=='Index Only Scan' and all(k in scans[0]['Index Cond'] for k in ['user_id','game_variant','players_dealt','played_at']))
            check('sparse context avoids irrelevant heap reads',scans[0].get('Heap Fetches',0)<=scans[0]['Actual Rows'] and sum(n.get('Rows Removed by Filter',0) for n in walk(after_plan['Plan']))==0)
            check('sparse and absent contexts preserve byte-exact public history',read(variant='plo5')==sparse_before and read(variant='plo8')==empty_before)
            check('running engine exact source receipt remains compatible',definition_before==run("SELECT md5(pg_get_functiondef('public.fn_horse_own_public_history_read_v2(uuid,text,text,integer,timestamptz)'::regprocedure));"))
            # The same physical key is usable after PL/pgSQL switches to a
            # generic cached plan. No force_custom_plan runtime workaround.
            source=V2_MIGRATION.read_text();sql=source[source.index('SELECT f.hand_id'):source.index('  ), matched AS')]
            for key,value in [('p_observer','$1'),('p_variant','$2'),('p_dealt_count','$3'),('p_before','$4'),('p_format','$5')]: sql=sql.replace(key,value)
            generic=json.loads(run("SET plan_cache_mode=force_generic_plan; PREPARE context_read(uuid,text,integer,timestamptz,text) AS "+sql+"; EXPLAIN(FORMAT JSON) EXECUTE context_read('"+uid(1)+"','plo5',2,'2026-10-25T02:00:00Z','cash');"))[0]['Plan']
            check('generic cached reader plan uses the same context cover',any(n.get('Index Name')=='ca_hand_facts_observer_context_cover' for n in walk(generic)))
            run('DROP INDEX ca_hand_facts_observer_context_cover; CREATE INDEX ca_hand_facts_observer_context_cover ON ca_hand_facts(user_id,played_at);')
            check('wrong named preexisting index is refused','horse_history_context_cover_shape_changed' in run(shape['body'],False))
            run('DROP INDEX ca_hand_facts_observer_context_cover;');run(shape['indexes'][0]['statement']);run(shape['body'])
            print(json.dumps(dict(performance=dict(before_ms=before_plan['Execution Time'],after_ms=after_plan['Execution Time'],before_blocks=before_plan['Plan'].get('Shared Hit Blocks',0)+before_plan['Plan'].get('Shared Read Blocks',0),after_blocks=after_plan['Plan'].get('Shared Hit Blocks',0)+after_plan['Plan'].get('Shared Read Blocks',0)))))
            print(json.dumps(dict(checks=checks,passed=len(checks),definitionMd5=p['definitionMd5'])))
        finally:
            r=command([PG/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
            if r.returncode: raise RuntimeError(r.stderr)
if __name__=='__main__': main()
