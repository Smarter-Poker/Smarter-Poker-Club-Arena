#!/usr/bin/env python3
"""A heavy hour's finished v3 thaw releases at the advertised end, not after it.

Disposable PostgreSQL only; no production connection or credentials. Loads the
exact installed authority (scripts/ci/fixtures/on-time-start), installs the
current production fn_thaw_platform (20261018172103), reproduces the late
release on a board with 400 level clocks, then installs the candidate and
proves the same board releases exactly at the advertised end with every clock
credited the full five minutes once, money and rosters unchanged, both freeze
predicates closed until that instant, and the late fallback still fail-closed.
"""
import importlib.util
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PREVIOUS = ROOT / 'supabase/migrations/20261018172103_prepare_the_certified_thaw_before_the_advertised_hour.sql'
CANDIDATE = ROOT / 'supabase/migrations/20261020011548_a_heavy_thaw_releases_on_the_hour_when_nothing_is_left_to_cr.sql'
spec = importlib.util.spec_from_file_location('on_time', ROOT / 'scripts/ci/test-on-time-maintenance-thaw.py')
ot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ot)
base, FIX, TOKEN, SIG, require = ot.base, ot.FIX, ot.TOKEN, ot.SIG, ot.require
LEVEL_CLOCKS = 400  # ten 40-row installments: the old runway is 44 s

SEED = r"""
INSERT INTO public.tournaments(status,level_started_at,on_break)
 SELECT 'RUNNING',clock_timestamp()-interval '20 minutes',false FROM generate_series(1,%d);
INSERT INTO public.tables(status,bomb_pot_next_due_at,break_eligible_since,cluster_id)
 SELECT 'playing',clock_timestamp()+interval '1 minute',clock_timestamp()-interval '1 minute',gen_random_uuid()
 FROM generate_series(1,3);
INSERT INTO public.table_seats(table_id,seat_number,user_id,stack,sit_out_at)
 SELECT id,1,gen_random_uuid(),12345.67,clock_timestamp()-interval '1 minute' FROM public.tables;
INSERT INTO public.test_wallets(balance) VALUES(76543.21);
INSERT INTO public.chip_transactions(reversible_until) SELECT clock_timestamp()+interval '1 minute' FROM generate_series(1,250);
INSERT INTO public.lightning_cluster_drain(cluster_id,request_id,deadline_at)
 SELECT gen_random_uuid(),gen_random_uuid(),clock_timestamp()+interval '1 minute';
CREATE TRIGGER zz_freeze_entry_guard BEFORE INSERT OR UPDATE OF left_at,user_id ON public.table_seats
 FOR EACH ROW EXECUTE FUNCTION public.fn_refuse_new_entries_while_frozen();
""" % LEVEL_CLOCKS

BEFORE = r"""
DROP TABLE IF EXISTS public.test_level_before, public.test_reversible_before;
CREATE TABLE public.test_level_before AS SELECT id,level_started_at FROM public.tournaments;
CREATE TABLE public.test_reversible_before AS SELECT id,reversible_until FROM public.chip_transactions;
"""

def thaw(c):
    calls = 0
    for _ in range(40):
        r = ot.call(c)
        calls += 1
        if r.get('complete'):
            return r, calls
        require(r.get('ok') is True and r.get('retryable') is True, 'partial installment stays recoverable')
    raise AssertionError('thaw did not complete in 40 committed calls')

def ledger(c):
    return c.val("SELECT jsonb_build_object('late_s',round(extract(epoch FROM release_target_at-due_at)::numeric,3),'frozen',frozen_seconds,'gen',release_generation)::text FROM public.engine_maintenance_thaws CROSS JOIN public.test_parameters")

def main():
    with tempfile.TemporaryDirectory(prefix='hour-release-') as directory:
        c = base.Cluster(directory)
        try:
            c.start()
            c.psql(base.FIXTURE + ot.EXTRA)
            c.psql((FIX / 'bypass.sql').read_text() + (FIX / 'authority.sql').read_text())
            c.psql(PREVIOUS.read_text())
            require(c.val("SELECT md5(prosrc) FROM pg_proc WHERE oid='%s'::regprocedure" % SIG) == 'fcd26a9d89479b005435adda3902c964', 'production authority installed exactly')
            c.psql(SEED)

            # 1. The installed authority: a finished thaw 30 s before :00 on a
            #    heavy board plans its release past the advertised end.
            ot.reset(c, 270)
            r, _ = thaw(c)
            late = c.val("SELECT extract(epoch FROM release_target_at-due_at)::numeric FROM public.engine_maintenance_thaws CROSS JOIN public.test_parameters")
            require(float(late) > 5, 'installed authority reproduces the late heavy-hour release (%s s past the end)' % late)

            # 2. The candidate refuses a live break, then installs once.
            ot.reset(c, 100)
            c.psql(CANDIDATE.read_text(), error='HOUR_RELEASE_REQUIRES_QUIESCENT_CUTOVER')
            c.psql('TRUNCATE public.engine_maintenance_break, public.engine_maintenance_thaws, public.engine_maintenance_thaw_targets;')
            c.psql(CANDIDATE.read_text())
            post = c.val("SELECT md5(prosrc) FROM pg_proc WHERE oid='%s'::regprocedure" % SIG)
            require(post == 'f7540547dbea11a05e4bdc5b33162986', 'candidate body installed exactly')
            c.psql(CANDIDATE.read_text(), error='HOUR_RELEASE_PREIMAGE_DRIFT')
            require(c.val("SELECT (NOT has_function_privilege('anon','%s','EXECUTE') AND NOT has_function_privilege('authenticated','%s','EXECUTE') AND has_function_privilege('service_role','%s','EXECUTE'))::text" % (SIG, SIG, SIG)) == 'true', 'service-only execution unchanged')

            # 3. Early calls are still refused and create nothing.
            ot.reset(c, 100)
            require(ot.call(c)['reason'] == 'maintenance_break_not_due', 'early preparation still refused')
            require(c.val('SELECT count(*) FROM public.engine_maintenance_thaws') == '0', 'early refusal creates no checkpoint')

            # 4. The same heavy board, same 30 s: release exactly at the end.
            ot.reset(c, 270)
            c.psql(BEFORE)
            money = ot.fingerprint(c)
            r, calls = thaw(c)
            require(calls > 1, 'qualification crosses committed installment boundaries (%d calls)' % calls)
            require(c.val('SELECT (release_target_at=due_at AND frozen_seconds=300 AND release_generation=1)::text FROM public.engine_maintenance_thaws CROSS JOIN public.test_parameters') == 'true', 'heavy board releases exactly at the advertised end ' + ledger(c))
            require(c.val("SELECT (count(*) >= %d)::text FROM public.engine_maintenance_thaw_targets WHERE step='level_started_at'" % LEVEL_CLOCKS) == 'true', 'every level clock is a target')
            require(c.val('SELECT bool_and(credited_seconds=300)::text FROM public.engine_maintenance_thaw_targets') == 'true', 'every target credited exactly the full five minutes')
            require(c.val("SELECT bool_and(t.level_started_at=b.level_started_at+interval '300 seconds')::text FROM public.tournaments t JOIN public.test_level_before b USING(id)") == 'true', 'all level clocks shift exactly once by 300 s')
            require(c.val("SELECT bool_and(t.reversible_until=b.reversible_until+interval '300 seconds')::text FROM public.chip_transactions t JOIN public.test_reversible_before b USING(id)") == 'true', 'reversal windows shift exactly once by 300 s')
            require(ot.fingerprint(c) == money, 'wallets, stacks, seats and registrations unchanged')
            require(c.val('SELECT (public.fn_platform_frozen() AND public.fn_entry_purchases_frozen())::text') == 'true', 'both freeze predicates hold until the certified end')
            c.psql("INSERT INTO public.table_seats(table_id,seat_number,user_id,stack) SELECT id,2,gen_random_uuid(),10 FROM public.tables LIMIT 1", error='PLATFORM_FROZEN')
            require(ot.call(c)['reason'] == 'release_receipt_recovered', 'lost completion response recovers the same receipt')
            require(ot.fingerprint(c) == money, 'receipt replay moves nothing')
            wait = float(c.val('SELECT greatest(0,extract(epoch FROM due_at-clock_timestamp())) FROM public.test_parameters'))
            time.sleep(wait + 0.05)
            require(c.val('SELECT (NOT public.fn_platform_frozen() AND NOT public.fn_entry_purchases_frozen())::text') == 'true', 'doors open at the advertised end')

            # 5. Too close to the end for even the 8 s floor: the original
            #    runway applies, the release is later than the end and the
            #    platform stays frozen until it.
            ot.reset(c, 296)
            r, _ = thaw(c)
            require(float(r['effective_frozen_seconds']) > 300, 'a tail that cannot fit keeps the fail-closed extended runway ' + ledger(c))
            require(c.val('SELECT public.fn_platform_frozen()::text') == 'true', 'fallback stays frozen until its credited endpoint')

            # 6. A late checkpoint (opened after the end) is unchanged too.
            ot.reset(c, 301)
            r, _ = thaw(c)
            require(float(r['effective_frozen_seconds']) > 301, 'a checkpoint opened after the end keeps extended credit')
            print('PASS heavy-hour release qualification; production_writes=False', flush=True)
        finally:
            c.stop()

if __name__ == '__main__':
    main()
