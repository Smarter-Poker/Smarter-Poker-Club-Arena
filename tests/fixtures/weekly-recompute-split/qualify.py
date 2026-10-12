"""Native exact split-recompute checks over real original synthetic hand sources."""
import json, os, subprocess, time
from pathlib import Path

def qualify(pg, base, socket, port, total_hands=20000):
    pg, base, socket = Path(pg), Path(base), Path(socket)
    common = ['-U','postgres','-h',str(socket),'-p',str(port)]
    setting = "SET search_path=fixture_clock,public,pg_catalog,pg_temp; SET request.jwt.claims='{\"role\":\"service_role\",\"sub\":\"00000000-0000-0000-0000-000000000900\"}';"
    results = {'sourceHands':total_hands+1, 'expectedSources':2*(total_hands+1), 'attempts':[]}
    def q(sql, db='postgres'):
        t=time.monotonic()
        r=subprocess.run([str(pg/'psql'),'-X','-q','-At','-v','ON_ERROR_STOP=1',*common,'-d',db],input=setting+sql,text=True,capture_output=True)
        if r.returncode: raise AssertionError(r.stderr)
        return r.stdout.strip(),time.monotonic()-t
    def j(sql,db='postgres'):
        out,elapsed=q(sql,db)
        return json.loads(out.splitlines()[-1]),elapsed
    def clone(name):
        subprocess.run([str(pg/'createdb'),*common,'-T','postgres',name],check=True,capture_output=True)
    def assert_sql(sql,db='postgres'):
        value,_=q('SELECT ('+sql+') IS TRUE;',db)
        assert value=='t', (db,sql,value)
    q("UPDATE fixture.native_clock SET at_time='2026-09-15 12:00Z';")
    assert_sql("(SELECT count(*) FROM accounting_cash_rake_sources WHERE club_id=fixture.u(104))="+str(2*(total_hands+1)))
    assert_sql("(SELECT sum(rake_credit) FROM accounting_cash_rake_sources WHERE club_id=fixture.u(104))="+str(2+total_hands*.02))
    q("SELECT fixture.assert(NOT EXISTS(SELECT 1 FROM rake_records r LEFT JOIN accounting_cash_accrual_batches b ON b.rake_record_id=r.id WHERE r.rake_amount>0 AND b.status IS DISTINCT FROM 'accrued'),'All original source owners accrued before daemon cursor'); INSERT INTO daemon_state(daemon,high_water_mark,high_water_mark_id) SELECT 'rakeback_settler',created_at,id FROM rake_records WHERE rake_amount>0 ORDER BY created_at DESC,id DESC LIMIT 1 ON CONFLICT(daemon) DO UPDATE SET high_water_mark=excluded.high_water_mark,high_water_mark_id=excluded.high_water_mark_id;")
    for name in ['recompute_whole_v2','recompute_split_v2','recompute_refusal_v2']: clone(name)
    fallback="fn_rakeback_recompute_split(fixture.u(104),'2026-09-07','2026-09-13') IS NULL"
    assert_sql(fallback,'recompute_split_v2')
    whole,t=j("SELECT fn_rakeback_recompute_periods(fixture.u(104),'2026-09-07','2026-09-13',NULL);",'recompute_whole_v2')
    assert whole['status']=='ready' and whole['written']==2 and whole['confirmed_players']==2, whole
    results['wholeSeconds']=t
    prefix="SET app.weekly_accounting_chunked='on'; SET app.weekly_accounting_scope_budget='8 minutes'; SELECT set_config('app.weekly_accounting_scope_deadline',(clock_timestamp()+interval '6 minutes')::text,false);"
    call="SELECT fn_rakeback_recompute_split(fixture.u(104),'2026-09-07','2026-09-13');"
    crashed=False
    for attempt in range(300):
        answer,elapsed=j(prefix+call,'recompute_split_v2')
        results['attempts'].append({'answer':answer,'seconds':elapsed})
        (base/'split-recompute-progress.json').write_text(json.dumps(results,indent=2))
        if attempt==0:
            assert_sql("(SELECT jsonb_array_length(value->'pages')=2 FROM accounting_recompute_split_parts WHERE kind='players')",'recompute_split_v2')
        if attempt==9:
            q("UPDATE fixture.native_clock SET at_time=at_time+interval '13 hours';",'recompute_split_v2')
        if attempt==10:
            assert_sql('(SELECT count(*)=1 FROM accounting_recompute_split_parts)','recompute_split_v2')
            results['expiredPartsRebuilt']=True
        if not crashed:
            count,_=q("SELECT count(*) FROM accounting_recompute_split_parts WHERE kind='write';",'recompute_split_v2')
            if count=='1':
                assert answer['status']=='in_progress' and answer['stage']=='write',answer
                assert_sql('(SELECT count(*)=1 FROM rakeback_periods)','recompute_split_v2')
                native=dict(os.environ,LC_ALL='C',LANG='C')
                subprocess.run([str(pg/'pg_ctl'),'-D',str(base/'data'),'-m','immediate','-w','stop'],check=True,capture_output=True,env=native)
                subprocess.run([str(pg/'pg_ctl'),'-D',str(base/'data'),'-l',str(base/'server.log'),'-o',f"-k {socket} -p {port} -h ''",'-w','start'],check=True,capture_output=True,env=native)
                assert_sql('(SELECT count(*)=0 FROM accounting_recompute_split_parts)','recompute_split_v2')
                assert_sql('(SELECT count(*)=1 FROM rakeback_periods)','recompute_split_v2')
                crashed=True
        if answer['status']!='in_progress':break
    assert crashed and answer['status']=='ready' and answer['confirmed_players']==2,answer
    results['crashAfterOneCommittedWrite']=True
    results['maxSplitAttemptSeconds']=max(x['seconds'] for x in results['attempts'])
    # Independent arithmetic: each player earns 10% of 1+N*0.01 original rake.
    from decimal import Decimal
    expected=(Decimal(1)+Decimal(total_hands)/100)/10
    for db in ['recompute_whole_v2','recompute_split_v2']:
        assert_sql(f"(SELECT count(*)=2 AND bool_and(rakeback_amount={expected}) FROM rakeback_periods)",db)
        assert_sql('(SELECT count(*)=2 FROM accounting_rakeback_period_calculations)',db)
    # A corrupt retained source must be refused by both owners with no payable.
    # Fault injection is confined to this isolated transaction and rolled back.
    fault="BEGIN; ALTER TABLE accounting_cash_rake_sources DISABLE TRIGGER USER; UPDATE accounting_cash_rake_sources SET contract=jsonb_set(contract,'{attribution_id}',to_jsonb(fixture.u(99999)::text)) WHERE id=(SELECT id FROM accounting_cash_rake_sources ORDER BY id LIMIT 1); ALTER TABLE accounting_cash_rake_sources ENABLE TRIGGER USER;"
    negative,_=q(fault+"SELECT fn_rakeback_recompute_periods(fixture.u(104),'2026-09-07','2026-09-13',NULL); SET app.weekly_accounting_chunked='on'; SELECT set_config('app.weekly_accounting_scope_deadline',(clock_timestamp()+interval '8 minutes')::text,false);"+call+"SELECT count(*) FROM rakeback_periods; ROLLBACK;",'recompute_refusal_v2')
    negatives=[json.loads(x) for x in negative.splitlines() if x.startswith('{')]
    assert len(negatives)==2 and all(x['reason']=='cash_source_receipts_incomplete' and x['source_count']==1 for x in negatives),negatives
    assert negative.splitlines()[-1]=='0',negative
    results['corruptSourceRefused']=True
    def snapshot(db):
        return j("SELECT jsonb_build_object('members',(SELECT jsonb_agg(jsonb_build_array(user_id,club_id,chip_balance) ORDER BY user_id,club_id) FROM club_members),'unions',(SELECT jsonb_agg(jsonb_build_array(union_id,chip_balance,rake_wallet) ORDER BY union_id) FROM union_wallets),'clubs',(SELECT jsonb_agg(jsonb_build_array(id,chip_treasury) ORDER BY id) FROM clubs),'invoices',(SELECT count(*) FROM settlement_invoices),'messages',(SELECT count(*) FROM social_messages),'deliveries',(SELECT count(*) FROM accounting_invoice_deliveries),'notifications',(SELECT count(*) FROM notifications),'ledger',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.category,x.club_id) FROM (SELECT category,club_id,sum(amount) amount,count(*) n FROM chip_ledger GROUP BY category,club_id)x));",db)[0]
    # Finish each real accounting book through its current coordinator.
    for db,chunked in [('recompute_whole_v2',False),('recompute_split_v2',True)]:
        visits=[]
        for visit in range(12):
            r,elapsed=j(('SET app.weekly_accounting_chunked=\'on\';' if chunked else '')+"SELECT fn_process_weekly_accounting_scope(fixture.u(203),NULL);",db)
            assert r['success'] is True and r.get('failed',0)==0,r
            visits.append({'result':r,'seconds':elapsed})
            if r.get('checked')==0: break
        else: raise AssertionError('finite close did not finish')
        assert_sql("(SELECT status='complete' FROM union_accounting_runs WHERE union_id=fixture.u(203))",db)
        assert_sql(f"(SELECT count(*)=2 AND bool_and(status='paid' AND rakeback_amount={expected}) FROM rakeback_periods)",db)
        assert_sql(f"(SELECT count(*)=2 AND bool_and(chip_balance=200+{expected}) FROM club_members WHERE user_id IN(fixture.u(907),fixture.u(908)))",db)
        assert_sql(f"(SELECT rake_wallet=0 AND chip_balance=1000+{2*expected} FROM union_wallets WHERE union_id=fixture.u(203))",db)
        assert_sql("(SELECT count(*)>=2 AND bool_and(i.message_sent AND i.chips_transferred) FROM settlement_invoices i JOIN chip_ledger l ON l.id=i.source_ledger_id WHERE l.category='rakeback')",db)
        assert_sql("(SELECT count(*)>=3 AND bool_and(m.id IS NOT NULL AND n.id IS NOT NULL AND m.message_type='invoice') FROM accounting_invoice_deliveries d LEFT JOIN social_messages m ON m.id=d.message_id LEFT JOIN notifications n ON n.id=d.notification_id)",db)
        before=snapshot(db)
        replay,_=j(('SET app.weekly_accounting_chunked=\'on\';' if chunked else '')+"SELECT fn_process_weekly_accounting_scope(fixture.u(203),NULL);",db)
        after=snapshot(db)
        assert replay['success'] is True and replay.get('checked')==0 and replay.get('failed',0)==0,replay
        assert before==after,(db,'completed-book replay changed financial or delivery state',before,after)
        results[db+'Replay']={'result':replay,'before':before,'after':after}
        results[db+'Visits']=visits
    assert snapshot('recompute_whole_v2')==snapshot('recompute_split_v2'),'whole/split financial outcomes differ'
    results['financialOutcomesEqual']=True
    (base/'split-recompute-results.json').write_text(json.dumps(results,indent=2))
    print('PASS exact split recompute, natural two pages, partial-write crash, source refusal, complete current settlement and replay',flush=True)
    return results

def run_qualification(root, pg, base, socket, port, run):
    """Reuse the maintained weekly fixture assembly, then qualify exact6031."""
    import hashlib
    root,pg,base,socket=map(Path,(root,pg,base,socket))
    fx=root/'tests/fixtures/weekly-recompute-split'
    binding=json.loads((fx/'source-binding.json').read_text())
    for relative,expected in binding['repository_files'].items():
        assert hashlib.sha256((root/relative).read_bytes()).hexdigest()==expected, relative
    (base/'split-tested-source-binding.json').write_text(json.dumps(binding,indent=2)+'\n')
    pieces=[]
    for glob,start,end in [('20261003155132*','CREATE TABLE public.accounting_close_gates','COMMENT ON TABLE'),('20261003140241*','CREATE UNLOGGED TABLE public.accounting_close_partials','COMMENT ON TABLE'),('20261003162308*','ALTER TABLE public.accounting_close_partials','CREATE FUNCTION public.fn_settle_accounting_rakeback_window')]:
        source=next((root/'supabase/migrations').glob(glob)).read_text()
        pieces.append(source[source.index(start):source.index(end)])
    rows=json.loads((fx/'current-owners.json').read_text())+json.loads((fx/'current-stage-dependencies.json').read_text())
    pieces.extend(row['definition']+';' for row in rows)
    run('SET check_function_bodies=off;\n'+'\n'.join(pieces),'split-current-dependencies')
    checks=[]
    for row in rows:
        expected=row.get('definition_md5',hashlib.md5(row['definition'].encode()).hexdigest())
        checks.append("SELECT fixture.assert(md5(pg_get_functiondef('%s'::regprocedure))='%s','Exact observed dependency %s');"%(row['signature'],expected,row['signature']))
    run('\n'.join(checks),'split-exact-dependency-binding')
    run(next((root/'supabase/migrations').glob('20261003232339*')).read_text(),'split-exact-candidate')
    run((root/'tests/fixtures/union-weekly-basis/regression.sql').read_text(),'split-original-events')
    seed=(root/'tests/fixtures/union-weekly-basis/raked-regression.sql').read_text()
    seed=seed[:seed.index('DO $$ DECLARE original text;')]
    # Two independently funded payable players, one human and one horse.
    # The synthetic seed changes before original admissions; no passing money
    # receipt, financial function body or source contract is fabricated.
    seed=seed.replace('UPDATE union_clubs SET rate_cash=0.9',"UPDATE club_members SET club_id=fixture.u(104) WHERE user_id=fixture.u(908);\nUPDATE union_clubs SET rate_cash=0.9")
    seed=seed.replace('1,100,false','1,300,false').replace('2,100,false,fixture.u(203)','2,300,false,fixture.u(104)')
    seed=seed.replace("UPDATE fixture.native_clock SET at_time='2026-09-15 12:00Z';",'')
    run(seed,'split-two-funded-players')
    run((fx/'generate-original-hands.sql').read_text(),'split-volume-generator')
    settings="SET search_path=fixture_clock,public,pg_catalog,pg_temp; SET request.jwt.claims='{\"role\":\"service_role\",\"sub\":\"00000000-0000-0000-0000-000000000900\"}';"
    times=[]
    for offset in range(0,20000,1000):
        started=time.monotonic()
        run(settings+f'SELECT fixture.generate_original_hands({2000001+offset},1000);',f'split-original-hands-{offset}')
        times.append({'firstHand':2000001+offset,'count':1000,'seconds':time.monotonic()-started})
    (base/'split-source-volume.json').write_text(json.dumps(times,indent=2))
    return qualify(pg,base,socket,port)
