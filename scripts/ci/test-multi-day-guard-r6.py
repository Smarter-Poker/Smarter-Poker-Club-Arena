#!/usr/bin/env python3
"""Multi-day release R6: the unbuilt guard admits a sealed plan (20260924232849).

Real PostgreSQL, private socket, disposable cluster. The fixture, the
production functions loaded from their newest migration, the capability
registry, the four multi-day foundation migrations and the stage view with its
operator doors are taken from scripts/ci/test-multi-day-stage-foundation.py and
scripts/ci/test-multi-day-stage-view.py themselves (imported, never re-typed),
so the three harnesses cannot drift apart. The foundation harness carries
production's money-RPC registry DDL guard (MONEY_REGISTRY_GUARD), and so does
this one. fn_uncollected_entry_check, whose description R6 updates, is loaded
from its newest definition (20260902052604).

What it proves:

  - before R6 the badge write is refused even with a sealed plan and the
    capability deployed, and the seal writes no badge;
  - R6 refuses to install, changing nothing, when either replaced function's
    source differs from its pinned preimage, when the guard's trigger is not
    the seven-column trigger, and when a plan was sealed before it;
  - after R6: a badge with no plan is refused (update and insert); a sealed
    plan with a different day count is refused; a withdrawn capability refuses
    the badge; the exact plan badge with the capability available is admitted;
    the five structure columns are refused always, with or without a plan;
  - the seal (service role and the operator door) writes is_multi_day and
    total_days in the same transaction as the plan, and a replay writes
    nothing;
  - the full two-day run (seal, launch, day end, bag, reschedule, resume,
    seat, complete) still passes with R6 installed, and the badge is intact.

Usage: PG_BIN=/usr/lib/postgresql/17/bin python3 scripts/ci/test-multi-day-guard-r6.py
Must not run as root (initdb refuses). Prints one PASS line per case.
"""
import argparse
import importlib.util
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('multi_day_stage_view', HERE / 'test-multi-day-stage-view.py')
V = importlib.util.module_from_spec(spec)
spec.loader.exec_module(V)
F = V.F

MIG = F.MIG
CANDIDATE = '20260924232849_multi_day_guard_admits_a_sealed_plan.sql'
GUARD_MIGRATION = '20260902052302_a_half_guarded_feature_is_a_feature_that_can_be_half_built.sql'
UNCOLLECTED_MIGRATION = '20260902052604_is_xmtt_means_union_event_not_multi_day.sql'
T1, T2, T3, T4, CLUB = F.T1, F.T2, F.T3, F.T4, F.CLUB
T5 = 'a1000000-0000-4000-8000-000000000005'   # a three-day event sealed through the operator door
USERS, STACKS = F.USERS, F.STACKS
GUARD_PRE = '428b31045fc54a32e6207a6c15200cf5'
SEAL_PRE = '7d41b8e3b192cf4d9ec4f13ed34a72f1'
GUARD_POST = 'e6d43459c396f7e2b9ad4103d8a0ab21'
SEAL_POST = '6c562ca24eb23ee3a9c1b8b00c1e3983'
PLAN = V.PLAN
THREE_DAYS = {'time_zone': 'Europe/London',
              'stages': [{'stage_no': 1, 'end_after_level': 12},
                         {'stage_no': 2, 'end_after_level': 20, 'scheduled_start_utc': '2099-01-01T17:00:00Z'},
                         {'stage_no': 3, 'scheduled_start_utc': '2099-01-02T17:00:00Z'}]}
STRUCTURE = [('day_number', '2'), ('parent_tournament_id', "'%s'" % T2), ('survivors_advance_to', "'%s'" % T2),
             ('flight_number', '2'), ('flight_end_chips_snapshot', "'{}'::jsonb")]


def md5_of(c, signature):
    return c.val("SELECT md5(prosrc) FROM pg_proc WHERE oid = '%s'::regprocedure" % signature)


def sources(c):
    return (md5_of(c, 'public.fn_tournaments_refuse_unbuilt_multi_day()'),
            md5_of(c, 'public.fn_seal_tournament_stage_plan(uuid,jsonb)'))


def badge(c, tournament):
    return c.val("SELECT is_multi_day || ':' || total_days FROM public.tournaments WHERE id = '%s'" % tournament)


def seal(c, tournament, plan):
    return c.rpc("public.fn_seal_tournament_stage_plan('%s', '%s'::jsonb)" % (tournament, json.dumps(plan)))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--capability-migration', default=None,
                        help='path to 20260924025555_*.sql when it is not yet in supabase/migrations/')
    args = parser.parse_args()
    capability = Path(args.capability_migration) if args.capability_migration else next(iter(sorted(MIG.glob('20260924025555_*.sql'))), None)
    if capability is None or not capability.is_file():
        print('FAIL multi-day R6 depends on the capability registry migration 20260924025555; '
              'pass --capability-migration PATH when it is not in supabase/migrations/.', file=sys.stderr)
        return 2
    if os.geteuid() == 0:
        print('FAIL run as a non-root user (initdb refuses root)', file=sys.stderr)
        return 2
    with tempfile.TemporaryDirectory(prefix='multi-day-r6-') as directory:
        os.chmod(directory, 0o700)
        c = F.Cluster(directory)
        try:
            c.start()
            run_all(c, capability)
        finally:
            c.stop()
    print('PASS multi-day R6 guard admits a sealed plan: %d cases on PostgreSQL %s' % (len(F.PASSED), F.PG))
    return 0


def run_all(c, capability):
    ok = F.ok
    r6 = (MIG / CANDIDATE).read_text()
    c.psql(F.FIXTURE)
    c.psql((MIG / '20260429i_x17_widen_tournaments_status_completing.sql').read_text())
    for file_name, name in F.SOURCES:
        c.psql(F.function_source(file_name, name))
    c.psql(F.TRIGGERS)
    c.psql(capability.read_text())
    F.seed_event(c)
    c.psql("INSERT INTO public.tournaments (id, name, club_id, status, tournament_type, variant, start_time,"
           " late_reg_levels, rebuy_levels, addon_levels)"
           " VALUES ('%s', 'Three Day Festival', '%s', 'REGISTERING', 'MTT', 'nlh', now() + interval '1 hour', 2, 0, 0);"
           % (T5, CLUB))
    c.psql((MIG / GUARD_MIGRATION).read_text())
    c.psql(F.MONEY_REGISTRY_GUARD)
    # plpgsql binds its tables when called, not when created, so the real
    # definition loads without the wallet and rake tables it reads.
    c.psql(F.function_source(UNCOLLECTED_MIGRATION, 'fn_uncollected_entry_check'))
    for name in F.CANDIDATES:
        c.psql((MIG / name).read_text())
    c.psql(V.STANDINS)
    c.psql((MIG / V.CANDIDATE).read_text())
    c.psql("INSERT INTO auth.sessions VALUES ('%s');" % V.SESSION)
    c.psql("INSERT INTO public.harness_game_creators VALUES ('%s','%s');" % (CLUB, V.OPERATOR))
    assert sources(c) == (GUARD_PRE, SEAL_PRE), sources(c)
    ok('preimages_are_the_repository_definitions', 'guard %s, seal %s' % (GUARD_PRE, SEAL_PRE))

    F.set_capability(c, 'deployed', 1)

    # ---- before R6: the old guard refuses the badge even with a sealed plan ----
    c.psql("BEGIN; SET LOCAL ROLE service_role;"
           " SELECT (public.fn_seal_tournament_stage_plan('%s', '%s'::jsonb))::text; RESET ROLE;"
           " DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.tournaments t WHERE t.id = '%s'"
           "   AND (t.is_multi_day OR t.total_days > 1)) THEN RAISE EXCEPTION 'the pre-R6 seal wrote a badge'; END IF; END $$;"
           " UPDATE public.tournaments SET is_multi_day = true, total_days = 2 WHERE id = '%s'; COMMIT;"
           % (T4, json.dumps(PLAN), T4, T4), error='Multi day tournaments are not built yet')
    assert c.val("SELECT count(*) FROM public.tournament_stage_plans") == '0'
    assert badge(c, T4) == 'false:1'
    ok('before_r6_the_seal_writes_no_badge_and_the_badge_write_is_refused', 'capability deployed, plan sealed')

    # ---- R6 refuses a plan sealed before it --------------------------------------
    assert seal(c, T4, PLAN)['ok']
    c.psql(r6, error='MULTI_DAY_R6_PLAN_SEALED_BEFORE_THE_BADGE')
    assert sources(c) == (GUARD_PRE, SEAL_PRE)
    # Harness-only: take the pre-R6 plan back out (the permanence triggers are
    # bypassed by replica mode) so the rest of the run starts clean.
    c.psql("BEGIN; SET LOCAL session_replication_role = replica;"
           " DELETE FROM public.tournament_stage_transitions WHERE tournament_id = '%s';"
           " DELETE FROM public.tournament_stages WHERE tournament_id = '%s';"
           " DELETE FROM public.tournament_stage_plans WHERE tournament_id = '%s'; COMMIT;" % (T4, T4, T4))
    assert c.val("SELECT count(*) FROM public.tournament_stage_plans") == '0'
    ok('r6_refuses_a_plan_sealed_before_it', 'nothing replaced')

    # ---- R6 refuses source drift and trigger drift, changing nothing -------------
    # Anchored at a line start: the migration's ROLLBACK comment also names
    # CREATE OR REPLACE FUNCTION, which F.function_source would start from.
    guard = re.search(r'^CREATE OR REPLACE FUNCTION public\.fn_tournaments_refuse_unbuilt_multi_day\(\).*?'
                      r'\bAS (\$\w*\$).*?\1\s*;', (MIG / GUARD_MIGRATION).read_text(), re.S | re.M).group(0)
    assert guard.count('  RETURN NEW;\nEND') == 1
    c.psql(guard.replace('  RETURN NEW;\nEND', '  RETURN NEW;\n\nEND'))
    c.psql(r6, error='MULTI_DAY_R6_SOURCE_DRIFT: fn_tournaments_refuse_unbuilt_multi_day')
    c.psql(guard)
    seal_source = F.function_source(F.CANDIDATES[3], 'fn_seal_tournament_stage_plan').replace(
        'CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION', 1)
    anchor = "  v_rows jsonb := '[]'::jsonb;\n"
    assert seal_source.count(anchor) == 1
    c.psql(seal_source.replace(anchor, anchor + '\n'))
    c.psql(r6, error='MULTI_DAY_R6_SOURCE_DRIFT: fn_seal_tournament_stage_plan')
    c.psql(seal_source)
    c.psql("DROP TRIGGER trg_tournaments_refuse_unbuilt_multi_day ON public.tournaments;"
           " CREATE TRIGGER trg_tournaments_refuse_unbuilt_multi_day BEFORE INSERT OR UPDATE OF is_multi_day, total_days"
           " ON public.tournaments FOR EACH ROW EXECUTE FUNCTION public.fn_tournaments_refuse_unbuilt_multi_day();")
    c.psql(r6, error='MULTI_DAY_R6_TRIGGER_DRIFT')
    c.psql((MIG / GUARD_MIGRATION).read_text())   # the seven-column trigger, with its own probe
    assert sources(c) == (GUARD_PRE, SEAL_PRE), sources(c)
    ok('r6_refuses_source_and_trigger_drift_and_changes_nothing', 'guard, seal and trigger drift refused')

    # ---- install ---------------------------------------------------------------------
    c.psql(r6)
    assert sources(c) == (GUARD_POST, SEAL_POST), sources(c)
    proofs = re.findall(r'--\s*@live-proof:\s*(.+?)\s*$', r6, re.M)
    assert len(proofs) == 5, proofs
    earlier = []
    for name in F.CANDIDATES + [V.CANDIDATE]:
        earlier += re.findall(r'--\s*@live-proof:\s*(.+?)\s*$', (MIG / name).read_text(), re.M)
    for proof in proofs + earlier:
        assert c.val('SELECT (%s)::text' % proof) == 'true', proof
    assert c.val("SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_tournaments_refuse_unbuilt_multi_day'") == '1'
    c.psql(r6, error='MULTI_DAY_R6_SOURCE_DRIFT')   # a second install is refused, not re-applied
    ok('r6_installs_under_the_money_registry_guard_and_every_live_proof_holds',
       '%d R6 proofs, %d earlier proofs' % (len(proofs), len(earlier)))

    # ---- after R6, no plan: the badge is refused ---------------------------------------
    for sql in ("UPDATE public.tournaments SET is_multi_day = true, total_days = 2 WHERE id = '%s';" % T3,
                "UPDATE public.tournaments SET total_days = 3 WHERE id = '%s';" % T3,
                "UPDATE public.tournaments SET is_multi_day = true WHERE id = '%s';" % T3,
                "INSERT INTO public.tournaments (name, status, is_multi_day, total_days) VALUES ('born badged', 'ANNOUNCED', true, 2);"):
        c.psql(sql, error='MULTI_DAY_BADGE_REFUSED (no_sealed_plan)')
    c.psql("UPDATE public.tournaments SET is_multi_day = false, total_days = 1 WHERE id = '%s';" % T3)
    c.psql("INSERT INTO public.tournaments (name, status) VALUES ('ordinary', 'ANNOUNCED');")
    assert badge(c, T3) == 'false:1'
    ok('after_r6_a_badge_without_a_sealed_plan_is_refused', 'update and insert refused; ordinary values pass')

    # ---- the structure columns are refused, with no plan -------------------------------
    for column, value in STRUCTURE:
        c.psql("UPDATE public.tournaments SET %s = %s WHERE id = '%s';" % (column, value, T3),
               error='MULTI_DAY_STRUCTURE_COLUMN_REFUSED: %s' % column)
    c.psql("INSERT INTO public.tournaments (name, status, day_number) VALUES ('day two row', 'ANNOUNCED', 2);",
           error='MULTI_DAY_STRUCTURE_COLUMN_REFUSED: day_number')

    # ---- the seal writes the badge, in the seal's own transaction -----------------------
    bad = seal(c, T4, dict(PLAN, time_zone='Mars/Olympus'))
    assert bad == {'ok': False, 'reason': 'time_zone_unknown'}, bad
    assert badge(c, T4) == 'false:1'
    sealed = seal(c, T1, PLAN)
    assert sealed['ok'] and sealed['replay'] is False and sealed['stage_count'] == 2, sealed
    assert badge(c, T1) == 'true:2'
    assert c.val("SELECT t.xmin = xid(p.transaction_id) FROM public.tournaments t"
                 " JOIN public.tournament_stage_plans p ON p.tournament_id = t.id WHERE t.id = '%s'" % T1) == 't'
    xmin = c.val("SELECT xmin FROM public.tournaments WHERE id = '%s'" % T1)
    again = seal(c, T1, PLAN)
    assert again['ok'] and again['replay'] is True, again
    assert c.val("SELECT xmin FROM public.tournaments WHERE id = '%s'" % T1) == xmin
    assert c.val("SELECT count(*) FROM public.tournament_stage_transitions WHERE tournament_id = '%s' AND kind = 'seal'" % T1) == '1'
    door = V.seal(c, V.OPERATOR, T5, THREE_DAYS)
    assert door['ok'] and door['replay'] is False and door['stage_count'] == 3, door
    assert badge(c, T5) == 'true:3'
    assert V.seal(c, V.OPERATOR, T5, THREE_DAYS)['replay'] is True
    ok('the_seal_writes_the_badge_in_the_same_transaction_as_the_plan',
       'service role 2 days, operator door 3 days, replay writes nothing')

    # ---- a sealed plan with a different day count is refused ----------------------------
    for sql in ("UPDATE public.tournaments SET total_days = 3 WHERE id = '%s';" % T1,
                "UPDATE public.tournaments SET is_multi_day = true, total_days = 2 WHERE id = '%s';" % T5,
                "UPDATE public.tournaments SET is_multi_day = false WHERE id = '%s';" % T1,
                "UPDATE public.tournaments SET is_multi_day = false, total_days = 1 WHERE id = '%s';" % T1,
                "UPDATE public.tournaments SET total_days = NULL WHERE id = '%s';" % T1):
        c.psql(sql, error='MULTI_DAY_BADGE_REFUSED (badge_differs_from_plan)')
    assert badge(c, T1) == 'true:2' and badge(c, T5) == 'true:3'
    ok('a_sealed_plan_with_a_different_day_count_is_refused', 'and a sealed event cannot drop its badge')

    # ---- the exact plan badge is admitted with the capability available -----------------
    c.psql("UPDATE public.tournaments SET is_multi_day = true, total_days = 2 WHERE id = '%s';" % T1)
    c.psql("UPDATE public.tournaments SET total_days = 3 WHERE id = '%s';" % T5)
    ok('the_exact_plan_badge_is_admitted_with_the_capability_available')

    # ---- structure columns stay refused on a sealed, badged event -----------------------
    for column, value in STRUCTURE:
        c.psql("UPDATE public.tournaments SET %s = %s WHERE id = '%s';" % (column, value, T1),
               error='MULTI_DAY_STRUCTURE_COLUMN_REFUSED: %s' % column)
    c.psql("UPDATE public.tournaments SET is_multi_day = true, total_days = 2, day_number = 2 WHERE id = '%s';" % T1,
           error='MULTI_DAY_STRUCTURE_COLUMN_REFUSED: day_number')
    ok('structure_columns_are_refused_always', '5 columns, with and without a sealed plan, update and insert')

    # ---- capability withdrawn --------------------------------------------------------------
    F.set_capability(c, 'tested', 2)
    c.psql("UPDATE public.tournaments SET is_multi_day = true, total_days = 2 WHERE id = '%s';" % T1,
           error='MULTI_DAY_BADGE_REFUSED (capability_unavailable)')
    assert seal(c, T3, PLAN) == {'ok': False, 'reason': 'capability_unavailable'}
    assert badge(c, T3) == 'false:1' and badge(c, T1) == 'true:2'
    F.set_capability(c, 'deployed', 3)
    ok('a_withdrawn_capability_refuses_the_badge_write', 'the sealed event keeps its badge')

    # ---- the full two-day run still passes with R6 installed ------------------------------
    F.launch_and_play(c)
    total = sum(STACKS)
    F.heartbeat(c)
    assert c.rpc("public.fn_begin_stage_end('%s', '%s', 1, 12)" % (T1, F.LEASE))['ok']
    bag = c.rpc("public.fn_bag_tournament_stage('%s', '%s', 1, '%s'::jsonb)" % (T1, F.LEASE, F.watermarks(c)))
    assert bag['ok'] and bag['players'] == 6 and float(bag['total_chips']) == total, bag
    assert c.val("SELECT status FROM public.tournaments WHERE id = '%s'" % T1) == 'BAGGED'
    moved = c.rpc("public.fn_reschedule_tournament_stage('%s', 2, clock_timestamp() + interval '2 seconds', 1, 'start now')" % T1)
    assert moved['ok'] and moved['schedule_generation'] == 2, moved
    time.sleep(2.5)
    for tid in F.DAY2_TABLES:
        c.psql("INSERT INTO public.tables (id, tournament_id, club_id, status, name) VALUES ('%s','%s','%s','waiting','Day Two');"
               % (tid, T1, CLUB))
    F.heartbeat(c)
    level = json.dumps({'index': 13, 'small_blind': 400, 'big_blind': 800, 'ante': 800, 'duration_ms': 1200000})
    begun = c.rpc("public.fn_begin_stage_resume('%s', 2, gen_random_uuid(), 2, '%s', '%s'::jsonb)" % (T1, F.LEASE, level))
    assert begun['ok'], begun
    entitlements = c.psql("SELECT id FROM public.tournament_qualification_entitlements WHERE tournament_id = '%s' ORDER BY id;" % T1).splitlines()
    assert len(entitlements) == 6
    for n, ent in enumerate(entitlements):
        got = c.rpc("public.fn_seat_stage_entitlement('%s', '%s', '%s', '%s', '%s', %d)"
                    % (T1, begun['resume_id'], F.LEASE, ent, F.DAY2_TABLES[n % 2], n // 2 + 1))
        assert got['ok'], got
    assert c.rpc("public.fn_complete_stage_resume('%s', '%s', '%s')" % (T1, begun['resume_id'], F.LEASE))['ok']
    after = {
        "SELECT status FROM public.tournaments WHERE id='%s'" % T1: 'RUNNING',
        "SELECT string_agg(stage_no || '=' || state, ',' ORDER BY stage_no) FROM public.tournament_stages WHERE tournament_id='%s'" % T1: '1=closed,2=running',
        "SELECT sum(s.stack)::bigint FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id WHERE t.tournament_id='%s' AND s.left_at IS NULL" % T1: str(total),
        "SELECT sum(chips) FROM public.tournament_players WHERE tournament_id='%s' AND status='playing'" % T1: str(total),
        "SELECT count(*) FROM public.tournament_qualification_entitlements WHERE tournament_id='%s' AND state='consumed'" % T1: '6',
        "SELECT is_multi_day || ':' || total_days || ':' || day_number FROM public.tournaments WHERE id='%s'" % T1: 'true:2:1',
    }
    for query, expected in after.items():
        assert c.val(query) == expected, (query, c.val(query), expected)
    c.psql("UPDATE public.tournaments SET day_number = 2 WHERE id = '%s';" % T1,
           error='MULTI_DAY_STRUCTURE_COLUMN_REFUSED: day_number')
    ok('the_full_two_day_run_passes_with_r6_installed',
       'bag, reschedule, resume: %s chips conserved, badge true:2 on one row' % format(total, ','))


if __name__ == '__main__':
    sys.exit(main())
