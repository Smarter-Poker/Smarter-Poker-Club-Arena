"""Contained original-paid-scope component regression; no production capacity claim.

Called by test-own-agent-financial-postgres.py using its original three paid
books and isolated PostgreSQL connection. All dependency DDL and negative
mutations belong to one BEGIN/ROLLBACK, with nested exception savepoints.
"""
import hashlib,json,re
from types import SimpleNamespace

def run(q,R,OWN):
    binding=json.loads((OWN/'source-binding.json').read_text())
    for name,digest in binding['files'].items():
        assert hashlib.sha256((OWN/name).read_bytes()).hexdigest()==digest,('standalone replay fixture drift',name)
    for relative,digest in binding['source_sha256'].items():
        assert hashlib.sha256((R/relative).read_bytes()).hexdigest()==digest,('standalone source drift',relative)
    candidate=R/'supabase/accounting/standalone-paid-replay/fn_prepare_accounting_week.sql'
    assert hashlib.sha256(candidate.read_bytes()).hexdigest()=='592c0f790bfce904bf1508a8f64ae0222d59dd5ea2a490a08c4b15bf9f221e27'
    # Accumulate dependency hydration rather than opening independent sessions.
    statements=[]
    def collect(sql,**unused):
        statements.append(sql.rstrip().rstrip(';')+';')
        return SimpleNamespace(stdout='f',returncode=0,stderr='')
    def load(path): collect('SET check_function_bodies=off;'+path.read_text().rstrip()+';')
    scope={'q':collect,'load':load,'R':R,'OWN':OWN,'BASE':R/'tests/fixtures/weekly-close-scale','json':json,'re':re,'Path':type(R)}
    setup=OWN/'dependency_setup.py'
    exec(compile(setup.read_text(),str(setup),'exec'),scope)
    cases=[];sql=['BEGIN;SET LOCAL test.own_namespace=\'old1\';SET LOCAL app.weekly_accounting_chunked=\'on\';',
      "CREATE TEMP TABLE spr_baseline AS SELECT caw_money()money,own_paid_proof()paid,(SELECT to_jsonb(p)-'prosrc'FROM pg_proc p WHERE oid='fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure)meta;"]
    sql.extend(statements)
    args="NULL,caw_u('club'),'2026-10-05 07:00Z','2026-10-12 07:00Z'"
    R2="public.fn_settle_accounting_commission_stage('club',caw_u('club'),'2026-10-05 07:00+00','2026-10-12 07:00+00')"
    R3=R2.replace('commission','rakeback')
    def add(name,body):
        sql.append(body);cases.append({'case':'standalone-paid-replay-'+name,'passed':True})
    def control(name,body,state,message):
        # A successful operation raises a distinct test failure; only the exact
        # expected business/schema refusal rolls its mutation back and passes.
        add(name,"DO $spr$BEGIN BEGIN "+body+";RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='standalone_replay_expected_refusal_missing';EXCEPTION WHEN SQLSTATE '"+state+"'THEN "+("IF SQLERRM NOT LIKE '%"+message+"%'THEN RAISE;END IF;"if message else'')+" END;END $spr$;")
    sql.append('SET check_function_bodies=off;'+(OWN/'before.sql').read_text()+';')
    add('before-996-causal-reconciliation',"SELECT caw_assert(md5(pg_get_functiondef('fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure))='9960208f5b5398132a8e702497bbb3ba','exact original preimage');SELECT caw_assert((fn_prepare_accounting_week("+args+"))->>'success'='false'AND(fn_prepare_accounting_week("+args+"))::text LIKE '%legacy_or_paid_period_requires_reconciliation%','original paid standalone false refusal');")
    installer_helper=OWN/'installer_regression.py'
    installer_ns={}
    exec(compile(installer_helper.read_text(),str(installer_helper),'exec'),installer_ns)
    installer_sql,installer_cases=installer_ns['build'](R,OWN)
    sql.extend(installer_sql);cases.extend(installer_cases)
    for mode in ['on','off']:
        add('actual-prepare-'+mode,"SET LOCAL app.weekly_accounting_chunked='"+mode+"';SELECT caw_assert((fn_prepare_accounting_week("+args+"))->>'paid_scope_replay'='true','standalone paid replay');SELECT caw_assert(("+R2+")->>'duplicate'='true'AND("+R3+")->>'duplicate'='true','original downstream duplicate receipts');")
    sql.append("SET LOCAL app.weekly_accounting_chunked='on';")
    for name,change in [('r3-incomplete','SET completed_at=NULL'),('r2-incomplete','SET completed_at=NULL'),('r3-routing',"SET result=jsonb_set(result,'{routing_version}','99')"),('r3-source',"SET result=jsonb_set(result,'{source_version}','99')"),('r3-shortfall',"SET result=jsonb_set(result,'{shortfalls}','1')"),('r2-missing','DELETE')]:
        n=2 if name.startswith('r2')else 3
        mut=('DELETE FROM accounting_routed_settlement_runs'if change=='DELETE'else'UPDATE accounting_routed_settlement_runs '+change)+" WHERE scope_id=caw_u('club')AND round_no="+str(n)
        control(name,mut+';PERFORM fn_prepare_accounting_week('+args+')','23502'if name.endswith('incomplete')else'55000',''if name.endswith('incomplete')else'original_paid_scope_replay_not_confirmed')
    coord=(OWN/'actual-coordinator.sql').read_text()
    start=coord.index("          IF v_stage2->>'success' IS DISTINCT FROM 'true' OR v_stage3->>'success' IS DISTINCT FROM 'true'",coord.index('-- Standalone'))
    guard=coord[start:coord.index('          v_credit:=',start)]
    assert guard.count('weekly_routing_receipt_not_confirmed')==1
    prefix="DECLARE v_stage2 jsonb;v_stage3 jsonb;v_club record;v_from timestamptz:='2026-10-05 07:00Z';v_end timestamptz:='2026-10-12 07:00Z';BEGIN SELECT caw_u('club')id INTO v_club;v_stage2:="+R2+';v_stage3:='+R3+';'
    for name,change in [('positive',''),('stage2-routing',"v_stage2:=jsonb_set(v_stage2,'{routing_version}','99');"),('stage3-source',"v_stage3:=jsonb_set(v_stage3,'{source_version}','99');"),('stage3-shortfall',"v_stage3:=jsonb_set(v_stage3,'{shortfalls}','1');"),('receipt-mismatch',"v_stage3:=jsonb_set(v_stage3,'{unexpected}','true');")]:
        body='DO $coordinator$'+prefix+change+guard+'END $coordinator$'
        if name=='positive':add('coordinator-operative-'+name,body+';')
        else:control('coordinator-operative-'+name,body,'23514','weekly_routing_receipt_not_confirmed')
    for name,change in [('missing-r3',"DELETE FROM accounting_routed_settlement_runs WHERE scope_id=caw_u('club')AND round_no=3"),('foreign-scope-r3',"UPDATE accounting_routed_settlement_runs SET standalone_club_id=caw_u('other')WHERE scope_id=caw_u('club')AND round_no=3"),('other-week-r3',"UPDATE accounting_routed_settlement_runs SET period_start=period_start-interval '7 days',period_end=period_end-interval '7 days'WHERE scope_id=caw_u('club')AND round_no=3")]:
        add(name+'-original-fallback',"DO $fallback$DECLARE r jsonb;BEGIN BEGIN "+change+';r:=fn_prepare_accounting_week('+args+");PERFORM caw_assert(NOT(r?'paid_scope_replay')AND r::text LIKE '%legacy_or_paid_period_requires_reconciliation%','original fallback');RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='rollback_verified_fallback';EXCEPTION WHEN SQLSTATE 'P0002'THEN IF SQLERRM<>'rollback_verified_fallback'THEN RAISE;END IF;WHEN SQLSTATE '23514'THEN IF SQLERRM NOT LIKE '%own_agent_interpretation_week_already_paid%'THEN RAISE;END IF;END;END $fallback$;")
    add('metadata-and-all-original-paid-books-unchanged',"SELECT caw_assert((SELECT meta=(SELECT to_jsonb(p)-'prosrc'FROM pg_proc p WHERE oid='fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure)AND money=caw_money()AND paid=own_paid_proof()FROM spr_baseline),'metadata and all financial rows unchanged');SELECT caw_assert((SELECT five=own_paid_proof()AND six=(SELECT jsonb_agg(to_jsonb(r)ORDER BY scope_kind,scope_id,round_no)FROM accounting_routed_settlement_runs r)AND certs=(SELECT md5(jsonb_agg(to_jsonb(c)ORDER BY id)::text)FROM accounting_rakeback_period_calculations c)AND sources=(SELECT md5(jsonb_agg(to_jsonb(c)ORDER BY id)::text)FROM accounting_cash_rake_sources c)FROM own_original_paid),'five hashes six headers raw sources certificates unchanged');SELECT caw_assert(NOT EXISTS(SELECT FROM accounting_own_agent_interpretations)AND NOT EXISTS(SELECT FROM accounting_own_agent_preparation_versions)AND NOT EXISTS(SELECT FROM accounting_rakeback_wallet_transfers),'no paid-book upgrade or money minted');")
    sql.append('SET CONSTRAINTS ALL IMMEDIATE;ROLLBACK;')
    rollback_sql="SELECT jsonb_build_object('functions',(SELECT jsonb_agg(jsonb_build_object('metadata',to_jsonb(p),'definition',pg_get_functiondef(p.oid))ORDER BY p.oid)FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','smarter_private')AND p.proname IN('fn_prepare_accounting_week','fn_platform_frozen','original_inventory_proof_sources_match','original_inventory_basis_generation')),'history',(SELECT jsonb_agg(to_jsonb(h)ORDER BY version)FROM supabase_migrations.schema_migrations h))"
    catalog_before=q(rollback_sql).stdout
    before=q('SELECT caw_money();').stdout
    q('\n'.join(sql))
    assert q('SELECT caw_money();').stdout==before,'contained regression leaked money'
    assert q(rollback_sql).stdout==catalog_before,'contained regression leaked owner/history DDL'
    cases.append({'case':'standalone-paid-installer-outer-rollback-retains-original-owner-metadata-history-and-money','passed':True})
    return {'cases':cases,'coordinator_guard_sha256':hashlib.sha256(guard.encode()).hexdigest(),'limitations':['Actual operative coordinator guard only; full scheduler and production capacity not certified']}
