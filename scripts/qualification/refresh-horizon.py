#!/usr/bin/env python3
"""The open-week refresh reads only what has been accrued: proved on an isolated cluster, before and
after 20261019094914_commission_keys_in_club_order_refresh_reads_accrued.

    PG_BIN=/usr/lib/postgresql/17/bin \
    python3 scripts/qualification/refresh-horizon.py --work <short empty dir> [--out result.json]

It builds its OWN PostgreSQL 17 cluster with chip-deadlocks.py's machinery (unix socket in a private
directory, no TCP listener) over chip-deadlocks-schema.sql, and loads production's
fn_union_rake_basis_refresh from refresh-horizon-live.sql (pg_get_functiondef captured read-only on
2026-10-19; the run refuses to measure unless its md5 is c88e99cda4f091c9e48b0f6b173651a4, the
preimage the migration pins).

The one stub is fn_union_rake_basis_windowed, the basis reader the refresh hands its horizon to. It
records the horizon it was given and applies the clause of fn_accounting_union_earned_plan_v3 that a
refused source trips: a bank receipt of this union in [start, through) whose accrual batch is not
'accrued' raises union_cash_sources_do_not_match_bank:<n> (the refusal production writes to
financial_alerts every hour since 2026-10-19 07:35 UTC).

Fixture (one union, a window that opened two hours ago, the settler cursor 50 minutes in):
  r10 banked +10 min, accrued      r20 banked +20 min, REFUSED (work 'blocked', no batch)
  r30 banked +30 min, accrued      x15 banked +15 min, refused, ANOTHER union
  old banked before the window, refused
The migration is executed WHOLE (its file, one BEGIN/COMMIT, every pin) over production's three
bodies: the cash batch and retry brought to their live md5s by the 20261001 blocks, and the refresh.
BEFORE reads through the cursor and is refused; AFTER reads through +20 min and succeeds. When the
retry accrues r20, AFTER reads through the cursor again. A union with nothing refused reads exactly
as before.
"""
import argparse, importlib.util, json, pathlib, time, uuid

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
_spec = importlib.util.spec_from_file_location('chip_deadlocks', HERE / 'chip-deadlocks.py')
cd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cd)
cd.PORT = '55493'  # its own port: never the chip-deadlocks run's
MIGRATION = ROOT / ('supabase/migrations/'
                    '20261019094914_commission_keys_in_club_order_refresh_reads_accrued.sql')
LIVE_MD5 = 'c88e99cda4f091c9e48b0f6b173651a4'
SIG = 'public.fn_union_rake_basis_refresh(uuid,timestamptz,timestamptz)'

EXTRA = """
CREATE TABLE public.daemon_state (daemon text PRIMARY KEY, high_water_mark timestamptz, high_water_mark_id uuid);
CREATE TABLE public.union_rake_basis_snapshot (union_id uuid NOT NULL, period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL, through timestamptz, computed_at timestamptz, compute_ms integer, detail jsonb,
  input_stamp jsonb, UNIQUE (union_id, period_start, period_end));
CREATE OR REPLACE FUNCTION public.fn_is_platform_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
CREATE TABLE public.harness_windowed_calls (union_id uuid, period_start timestamptz, through timestamptz);
CREATE OR REPLACE FUNCTION public.fn_union_rake_basis_windowed(p_union_id uuid, p_start timestamptz, p_through timestamptz)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE issue_count int;
BEGIN
  INSERT INTO public.harness_windowed_calls VALUES (p_union_id, p_start, p_through);
  -- fn_accounting_union_earned_plan_v3's union_cash_sources_do_not_match_bank, the batch leg.
  SELECT count(*) INTO issue_count FROM public.accounting_cash_bank_receipts c
    LEFT JOIN public.accounting_cash_accrual_batches b ON b.rake_record_id = c.rake_record_id
   WHERE c.union_id = p_union_id AND c.banked_at >= p_start AND c.banked_at < p_through
     AND b.status IS DISTINCT FROM 'accrued';
  IF issue_count > 0 THEN RAISE EXCEPTION 'union_cash_sources_do_not_match_bank:%', issue_count USING ERRCODE = '55000'; END IF;
  RETURN jsonb_build_object('status', 'ready', 'basis_detail', '[]'::jsonb);
END $$;
"""


def load_live(cl):
    cl.psql(cd.DB, '-f', str(HERE / 'refresh-horizon-live.sql'))
    cl.q("REVOKE ALL ON FUNCTION %s FROM PUBLIC; GRANT EXECUTE ON FUNCTION %s TO service_role;" % (SIG, SIG))
    got = cl.q("SELECT md5(pg_get_functiondef('%s'::regprocedure))" % SIG)
    if got != LIVE_MD5:
        raise SystemExit('REFUSED: the loaded refresh is not production\'s (md5 %s)' % got)


PRODUCTION = {'fn_credit_agent_commissions_batch': ('d4572f3e1efd9c85a0025cc2906c6fae', '33e0be86d6a2a88f18be4ec4e058cadd'),
              'fn_retry_cash_accounting_sources': ('3788581d5e8f1953663b8929b4688d0a', 'e9b28c51e08c1754a475658f9720db40'),
              'fn_union_rake_basis_refresh': (LIVE_MD5, '9fdc0af3d23759ab843ce122ecaefb03')}


def md5s(cl):
    return dict(line.split('|') for line in cl.q(
        "SELECT p.proname, md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
        "WHERE n.nspname = 'public' AND p.proname IN (%s)" % ','.join("'%s'" % k for k in PRODUCTION)).splitlines())


def apply_whole_migration(cl):
    """The migration file itself, executed whole: one BEGIN/COMMIT, both blocks, every pin."""
    cl.psql(cd.DB, '-f', str(MIGRATION))
    return md5s(cl)


def bank(cl, union, club, rr, minutes, accrued, blocked):
    cl.q("INSERT INTO public.accounting_cash_bank_receipts (rake_record_id, union_id, club_id, union_transaction_id, "
         "club_ledger_id, banked_at, amount) VALUES ('%s','%s','%s',gen_random_uuid(),gen_random_uuid(),"
         "(SELECT high_water_mark FROM harness_t0) + interval '%s minutes', 0.95);" % (rr, union, club, minutes))
    if accrued:
        cl.q("INSERT INTO public.accounting_cash_accrual_batches (rake_record_id, hand_id, earned_at, source_fingerprint, status) "
             "VALUES ('%s', gen_random_uuid(), (SELECT high_water_mark FROM harness_t0) + interval '%s minutes', 'h', 'accrued');"
             % (rr, minutes))
    if blocked or accrued:
        cl.q("INSERT INTO public.accounting_cash_source_work (rake_record_id, receipt_id, source_fingerprint, status, attempts, "
             "next_attempt_at) VALUES ('%s', gen_random_uuid(), 'h', '%s', 1, now() + interval '1 minute');"
             % (rr, 'blocked' if blocked else 'accrued'))


def refresh(cl, union):
    try:
        out = json.loads(cl.q("SELECT public.fn_union_rake_basis_refresh('%s', (SELECT high_water_mark FROM harness_t0), "
                              "(SELECT high_water_mark FROM harness_t0) + interval '7 days')" % union))
    except RuntimeError as e:
        msg = str(e)
        return {'refused': msg[msg.find('ERROR'):].split('\n')[0]}
    for k in ('through', 'accrued_through', 'unaccrued_from'):
        if out.get(k):
            out[k + '_min'] = round(float(cl.q("SELECT extract(epoch FROM '%s'::timestamptz - (SELECT high_water_mark FROM harness_t0)) / 60"
                                               % out[k])), 3)
    return {k: out.get(k) for k in ('success', 'skipped', 'error', 'through_min', 'accrued_through_min', 'unaccrued_from_min')
            if k in out}


def scenario(cl, state):
    U, V, Q = (str(uuid.uuid4()) for _ in range(3))
    C = str(uuid.uuid4())
    r = {n: str(uuid.uuid4()) for n in ('r10', 'r20', 'r30', 'x15', 'old', 'q10')}
    cl.q("DELETE FROM public.union_rake_basis_snapshot; DELETE FROM public.harness_windowed_calls;")
    bank(cl, U, C, r['r10'], 10, accrued=True, blocked=False)
    bank(cl, U, C, r['r20'], 20, accrued=False, blocked=True)
    bank(cl, U, C, r['r30'], 30, accrued=True, blocked=False)
    bank(cl, V, C, r['x15'], 15, accrued=False, blocked=True)
    bank(cl, U, C, r['old'], -30, accrued=False, blocked=True)
    bank(cl, Q, C, r['q10'], 10, accrued=True, blocked=False)
    out = {'refused_source_in_window': refresh(cl, U)}
    out['windowed_horizon_min'] = cl.q(
        "SELECT round(extract(epoch FROM max(through) - (SELECT high_water_mark FROM harness_t0)) / 60, 3) "
        "FROM harness_windowed_calls WHERE union_id = '%s'" % U) or None
    out['union_with_nothing_refused'] = refresh(cl, Q)
    # The retry accrues r20 (its batch and its work, as fn_process_cash_accounting_source writes them).
    cl.q("INSERT INTO public.accounting_cash_accrual_batches (rake_record_id, hand_id, earned_at, source_fingerprint, status) "
         "VALUES ('%s', gen_random_uuid(), (SELECT high_water_mark FROM harness_t0) + interval '20 minutes', 'h', 'accrued');"
         "UPDATE public.accounting_cash_source_work SET status = 'accrued', attempts = 2 WHERE rake_record_id = '%s';"
         % (r['r20'], r['r20']))
    out['after_the_retry_accrues_it'] = refresh(cl, U)
    # A refused source exactly at the window's start holds the whole window, by name.
    W = str(uuid.uuid4())
    bank(cl, W, C, str(uuid.uuid4()), 0, accrued=False, blocked=True)
    out['refused_source_at_window_start'] = refresh(cl, W)
    cl.q("DELETE FROM public.accounting_cash_source_work; DELETE FROM public.accounting_cash_accrual_batches; "
         "DELETE FROM public.accounting_cash_bank_receipts;")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--work', required=True)
    ap.add_argument('--out')
    a = ap.parse_args()
    work = pathlib.Path(a.work).resolve()
    work.mkdir(parents=True, exist_ok=True)
    cl = cd.Cluster(work)
    cl.start()
    report = {'started': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    try:
        report['postgres'] = cl.psql('postgres', '-c', 'SELECT version()')
        report['functions_pinned_and_verified'] = cd.build(cl)
        # The cash batch and retry as production runs them today: the 20261001 blocks, in order, over
        # the pinned 2026-10-01 bodies (chip-deadlocks.py's 'after' state).
        for path in (cd.MIGRATION, cd.REVERT, cd.KEYS_FIX):
            cd.apply_migration(cl, path)
        cl.q(EXTRA)
        load_live(cl)
        report['production_md5'] = md5s(cl)
        if report['production_md5'] != {k: v[0] for k, v in PRODUCTION.items()}:
            raise SystemExit('REFUSED: the three bodies are not production\'s: %s' % report['production_md5'])
        report['live_md5'] = LIVE_MD5
        # The window opened two hours ago; the settler's cursor is 50 minutes into it.
        cl.q("CREATE TABLE harness_t0 AS SELECT date_trunc('minute', now()) - interval '2 hours' AS high_water_mark;"
             "INSERT INTO public.daemon_state (daemon, high_water_mark) "
             "SELECT 'rakeback_settler', high_water_mark + interval '50 minutes' FROM harness_t0;")
        report['before'] = scenario(cl, 'before')
        report['after_md5'] = apply_whole_migration(cl)
        report['after'] = scenario(cl, 'after')
    finally:
        cl.stop()
    b, f = report['before'], report['after']
    ok = (report['after_md5'] == {k: v[1] for k, v in PRODUCTION.items()}
          and b['refused_source_in_window'] == {'refused': 'ERROR:  union_cash_sources_do_not_match_bank:1'}
          and f['refused_source_in_window'] == {'success': True, 'skipped': False, 'through_min': 20.0,
                                                'accrued_through_min': 50.0, 'unaccrued_from_min': 20.0}
          and f['windowed_horizon_min'] == '20.000'
          and b['union_with_nothing_refused'] == {'success': True, 'skipped': False, 'through_min': 50.0,
                                                  'accrued_through_min': 50.0}
          and f['union_with_nothing_refused'] == {'success': True, 'skipped': False, 'through_min': 50.0,
                                                  'accrued_through_min': 50.0}
          and f['after_the_retry_accrues_it'] == {'success': True, 'skipped': False, 'through_min': 50.0,
                                                  'accrued_through_min': 50.0}
          and b['refused_source_at_window_start'] == {'refused': 'ERROR:  union_cash_sources_do_not_match_bank:1'}
          and f['refused_source_at_window_start'] == {'success': False, 'error': 'accrual_not_yet_in_window',
                                                      'accrued_through_min': 50.0, 'unaccrued_from_min': 0.0})
    report['passed'] = ok
    report['finished'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    print(json.dumps({k: report[k] for k in ('before', 'after', 'after_md5', 'passed')}, indent=2))
    print('REFRESH HORIZON: %s' % ('reads only what is accrued' if ok else 'NOT AS CLAIMED'))
    if a.out:
        pathlib.Path(a.out).write_text(json.dumps(report, indent=2) + '\n')
    return 0 if ok else 1


if __name__ == '__main__':
    raise SystemExit(main())
