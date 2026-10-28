#!/usr/bin/env python3
"""Original native financial family plus bounded original R3 deadline regression."""
from pathlib import Path
root=Path(__file__).resolve().parents[2]
base=root/'scripts/ci/test-existing-transfer-discharge-postgres.py'
source=base.read_text()
marker="    for label,call in [('main',R2),('v3',R2V3),('cached-main',R2)]:"
assert source.count(marker)==1
extra=r'''    load(R/'scripts/ci/fixtures/rakeback-original-deadline/installed-171556.sql')
    q("CREATE FUNCTION deadline_invoice_delay()RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF current_setting('dr.deadline_delay',true)='on'THEN PERFORM pg_sleep(.04);END IF;RETURN NEW;END$$;CREATE TRIGGER deadline_invoice_delay AFTER INSERT ON settlement_invoices FOR EACH ROW EXECUTE FUNCTION deadline_invoice_delay();")
    probe='SELECT '+R2+";SET LOCAL app.weekly_accounting_chunked='on';SELECT set_config('app.weekly_accounting_scope_deadline',(clock_timestamp()+interval '1 millisecond')::text,true);SET LOCAL dr.deadline_delay='on';CREATE TEMP TABLE deadline_result AS SELECT "+R3+" r;SELECT caw_assert((SELECT(r->>'batch_committed')::boolean FROM deadline_result),'originaldeadline_partial_progress');SELECT caw_assert(EXISTS(SELECT FROM rakeback_periods WHERE status='pending')AND EXISTS(SELECT FROM rakeback_periods WHERE status='paid'),'paid_and_pending');SET CONSTRAINTS ALL IMMEDIATE;SET CONSTRAINTS ALL DEFERRED;SET LOCAL dr.deadline_delay='';SET LOCAL app.weekly_accounting_scope_deadline='2099-01-01';SELECT "+R3+';SELECT '+R3+';'
    ed_case('old90seconds-ignores-originaldeadline',probe,'originaldeadline_partial_progress')
    migration=R/'supabase/migrations/20261027175926_rakeback_batches_honor_the_original_close_deadline.sql'
    metadata=q("SELECT to_jsonb(p)-'prosrc'FROM pg_proc p WHERE oid='fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure").stdout.strip()
    frozen=q(migration.read_text().replace('BEGIN;','BEGIN;UPDATE dr_controls SET frozen=true;',1),check=False)
    assert frozen.returncode and 'rakeback_deadline_install_frozen'in frozen.stderr
    forced=q(migration.read_text().replace('COMMIT;',"DO $$BEGIN RAISE EXCEPTION 'deadline_install_rollback';END$$;COMMIT;"),check=False)
    assert forced.returncode and 'deadline_install_rollback'in forced.stderr
    assert q("SELECT md5(pg_get_functiondef('fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure))").stdout.strip()=='b07dc0dc2bdfa00973b4613e0cfb83d5'
    load(migration)
    assert q("SELECT to_jsonb(p)-'prosrc'FROM pg_proc p WHERE oid='fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure").stdout.strip()==metadata
    print('DEADLINE_POSTIMAGE',q("SELECT md5(pg_get_functiondef('fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure))").stdout.strip(),flush=True)
    replay=q(migration.read_text(),check=False);assert replay.returncode and 'rakeback_deadline_owner_preimage_changed'in replay.stderr
    results.append({'case':'exact-deadline-installer-frozen-rollback-metadata-acl-replay','passed':True})
    ed_case('deadline-clamp-keeps-original-partial-progress-postlude-and-replay',probe)
    ed_case('invalid-original-deadline-refused','SELECT '+R2+";SET LOCAL app.weekly_accounting_chunked='on';SET LOCAL app.weekly_accounting_scope_deadline='invalid';SELECT "+R3+';','invalid input syntax for type timestamp')
    ed_case('unchunked-malformed-unused-deadline-full-original-payment','SELECT '+R2+";SET LOCAL app.weekly_accounting_chunked='';SET LOCAL app.weekly_accounting_scope_deadline='invalid';SELECT "+R3+';SELECT '+R3+';')
'''
source=source.replace(marker,extra+marker)
exec(compile(source,str(base),'exec'),{'__name__':'__main__','__file__':str(base)})
