"""Two real sessions race the same completed week; restart/replay must be inert."""
import json,subprocess,time,select

def qualify(sql,q,O):
    address="union_id='fade0000-0000-0000-0000-000000000001' AND period_end='2026-10-26 07:00Z'"
    sql("INSERT INTO union_accounting_runs(union_id,period_start,period_end,scheduled_at,status,attempts,result) VALUES('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z','2026-10-26 09:00Z','running',1,'{}');",'race-running-record')
    update="UPDATE union_accounting_runs SET status='complete',result='{\"success\":true}' WHERE "+address+';'
    first=subprocess.Popen([str(x) for x in q],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
    second=None
    try:
        first.stdin.write("BEGIN;SET LOCAL timezone='America/Chicago';"+update+"SELECT 'FIRST_PAID';\n");first.stdin.flush()
        assert select.select([first.stdout],[],[],30)[0] and first.stdout.readline().strip()=='FIRST_PAID','first payout did not reach held completion'
        second=subprocess.Popen([str(x) for x in q]+['-c',"SET application_name='midway-promo-race-two';SET timezone='UTC';"+update],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        deadline=time.monotonic()+10
        while sql("SELECT EXISTS(SELECT FROM pg_stat_activity WHERE application_name='midway-promo-race-two' AND wait_event_type='Lock');",'race-lock-observation')!='t':
            assert time.monotonic()<deadline and second.poll() is None,'second session did not wait on financial owner'
            time.sleep(.03)
        first.stdin.write('COMMIT;\n\\q\n');first.stdin.flush();out,err=first.communicate(timeout=30)
        (O/'race-first.stderr').write_text(err);assert first.returncode==0,err
        out,err=second.communicate(timeout=30);(O/'race-second.stderr').write_text(err);assert second.returncode==0,err
        result=json.loads(sql("SELECT jsonb_build_object('runs',(SELECT count(*) FROM union_weekly_horse_promo_runs WHERE period_end='2026-10-26 07:00Z'),'paid',(SELECT paid FROM union_weekly_horse_promo_runs WHERE period_end='2026-10-26 07:00Z'),'recipients',(SELECT count(*) FROM union_weekly_horse_promo_recipients WHERE run_id=(SELECT id FROM union_weekly_horse_promo_runs WHERE period_end='2026-10-26 07:00Z')),'remaining',(SELECT promo_wallet FROM union_wallets WHERE union_id='fade0000-0000-0000-0000-000000000001'));",'race-result'))
        assert result=={'runs':1,'paid':25.01,'recipients':2,'remaining':25.01},result
        sql(update,'fresh-session-replay')
        assert sql("SELECT paid||':'||eligible_wallets FROM union_weekly_horse_promo_runs WHERE period_end='2026-10-26 07:00Z';",'restart-result')=='25.01:2'
        (O/'concurrency.json').write_text(json.dumps(result,indent=2))
    finally:
        for child in [first,second]:
            if child and child.poll() is None:child.terminate();child.communicate(timeout=10)
