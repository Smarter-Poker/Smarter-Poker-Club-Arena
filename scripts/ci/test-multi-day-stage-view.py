#!/usr/bin/env python3
"""Multi-day stage view and operator doors (20260924063656).

Real PostgreSQL, private socket, disposable cluster. The fixture, the
production functions loaded from their newest migration, the capability
registry and the four multi-day foundation migrations are taken from
scripts/ci/test-multi-day-stage-foundation.py itself (imported, never
re-typed), so the two harnesses cannot drift apart. On top of that fixture
this harness installs 20260924063656 and proves, as a signed-in browser
caller (role authenticated, a JWT subject and a session id):

  - who may call: anon and service_role are refused by the grants; a caller
    with no subject, or with a revoked session, is refused before anything is
    read or written;
  - the capability gate: both doors refuse while the capability is below
    deployed and write nothing; the read still answers (a running event is
    never stranded by a withdrawn capability);
  - authority: the doors ask fn_can_create_games for the event's club and
    refuse everybody else; the view answers tournament_not_found for an event
    the caller could not read;
  - delegation and idempotent replay: every validation reason and every
    replay comes back from the service-role RPC unchanged;
  - own-bag-only visibility: after a real bag each player sees exactly their
    own stack and bounty head and no other player's id; the only thing about
    other players is the top-10 chip leaders by display name; a horse reads
    and is read exactly like a human;
  - the Day 2 seat: once resumed, the view reports the caller's own live
    chair, and nobody else's.

The three production helpers the doors call and this harness cannot load from
a migration (fn_can_create_games, fn_caller_session_is_live and
fn_poker_can_read_games have no complete definition in supabase/migrations/ or
depend on the whole club schema) are stood in by minimal functions over tiny
tables, so each refusal is driven by exactly the input the real one reads.

Usage: PG_BIN=/usr/lib/postgresql/17/bin python3 scripts/ci/test-multi-day-stage-view.py
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
spec = importlib.util.spec_from_file_location('multi_day_foundation', HERE / 'test-multi-day-stage-foundation.py')
F = importlib.util.module_from_spec(spec)
spec.loader.exec_module(F)

MIG = F.MIG
CANDIDATE = '20260924063656_multi_day_stage_view_and_operator_doors.sql'
T1, T2, T4, CLUB = F.T1, F.T2, F.T4, F.CLUB
USERS, HORSE, STACKS = F.USERS, F.HORSE, F.STACKS
OPERATOR = 'f7000000-0000-4000-8000-000000000001'
OUTSIDER = 'f7000000-0000-4000-8000-000000000002'   # signed in, not a club reader
RAILBIRD = 'f7000000-0000-4000-8000-000000000003'   # club reader, never entered
SESSION = 'a7000000-0000-4000-8000-000000000001'
DEAD_SESSION = 'a7000000-0000-4000-8000-0000000000ff'
MISSING = 'a1000000-0000-4000-8000-0000000000ee'
PLAN = {'time_zone': 'America/Chicago',
        'stages': [{'stage_no': 1, 'end_after_level': 12},
                   {'stage_no': 2, 'scheduled_start_utc': '2099-01-01T17:00:00Z'}]}

STANDINS = r"""
-- The three production helpers the doors and the view consult, reduced to the
-- one input each really reads.
CREATE TABLE auth.sessions (id uuid PRIMARY KEY);
CREATE TABLE public.harness_game_creators (club_id uuid, user_id uuid, PRIMARY KEY (club_id, user_id));
CREATE TABLE public.harness_game_readers (club_id uuid, user_id uuid, PRIMARY KEY (club_id, user_id));
CREATE FUNCTION public.fn_caller_session_is_live() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, auth AS $$
  SELECT COALESCE(auth.role() = 'service_role', false) OR EXISTS (
    SELECT 1 FROM auth.sessions s
     WHERE s.id = (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id')::uuid) $$;
CREATE FUNCTION public.fn_can_create_games(p_club_id uuid, p_user_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.harness_game_creators g WHERE g.club_id = p_club_id AND g.user_id = p_user_id) $$;
CREATE FUNCTION public.fn_poker_can_read_games(p_club_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.harness_game_readers g WHERE g.club_id = p_club_id AND g.user_id = auth.uid()) $$;
-- The seat label the view prints.
ALTER TABLE public.tables ADD COLUMN name text;
"""


def claims(uid, session=SESSION):
    body = {'role': 'authenticated'}
    if uid is not None:
        body['sub'] = uid
    if session is not None:
        body['session_id'] = session
    return json.dumps(body)


def as_user(c, uid, call, session=SESSION, error=None):
    sql = ("SET ROLE authenticated; SET request.jwt.claims = '%s'; SELECT (%s)::text;"
           % (claims(uid, session), call))
    if error is not None:
        return c.psql(sql, error=error)
    return json.loads(c.psql(sql).splitlines()[-1])


def view(c, uid, tournament=T1, session=SESSION):
    return as_user(c, uid, "public.fn_tournament_stage_view('%s')" % tournament, session)


def seal(c, uid, tournament, plan, session=SESSION, error=None):
    return as_user(c, uid, "public.fn_operator_seal_stage_plan('%s', '%s'::jsonb)" % (tournament, json.dumps(plan)),
                   session, error)


def reschedule(c, uid, start_sql, generation, reason='venue change', stage=2, session=SESSION, error=None):
    return as_user(c, uid, "public.fn_operator_reschedule_stage('%s', %d, %s, %d, '%s')"
                   % (T1, stage, start_sql, generation, reason), session, error)


def count(c, table):
    return c.val('SELECT count(*) FROM public.%s' % table)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--capability-migration', default=None,
                        help='path to 20260924025555_*.sql when it is not yet in supabase/migrations/')
    args = parser.parse_args()
    capability = Path(args.capability_migration) if args.capability_migration else next(iter(sorted(MIG.glob('20260924025555_*.sql'))), None)
    if capability is None or not capability.is_file():
        print('FAIL the multi-day stage view depends on the capability registry migration 20260924025555; '
              'pass --capability-migration PATH when it is not in supabase/migrations/.', file=sys.stderr)
        return 2
    if os.geteuid() == 0:
        print('FAIL run as a non-root user (initdb refuses root)', file=sys.stderr)
        return 2
    with tempfile.TemporaryDirectory(prefix='multi-day-view-') as directory:
        os.chmod(directory, 0o700)
        c = F.Cluster(directory)
        try:
            c.start()
            run_all(c, capability)
        finally:
            c.stop()
    print('PASS multi-day stage view and operator doors: %d cases on PostgreSQL %s' % (len(F.PASSED), F.PG))
    return 0


def run_all(c, capability):
    ok = F.ok
    c.psql(F.FIXTURE)
    c.psql((MIG / '20260429i_x17_widen_tournaments_status_completing.sql').read_text())
    for file_name, name in F.SOURCES:
        c.psql(F.function_source(file_name, name))
    c.psql(F.TRIGGERS)
    c.psql(capability.read_text())
    F.seed_event(c)
    c.psql((MIG / '20260902052302_a_half_guarded_feature_is_a_feature_that_can_be_half_built.sql').read_text())
    # The production money-RPC DDL guard the foundation harness carries.
    c.psql(F.MONEY_REGISTRY_GUARD)
    for name in F.CANDIDATES:
        c.psql((MIG / name).read_text())

    # ---- the migration refuses without its prerequisites ------------------
    c.psql((MIG / CANDIDATE).read_text(), error='MULTI_DAY_VIEW_PREREQUISITES_MISSING')
    c.psql(STANDINS)
    c.psql((MIG / CANDIDATE).read_text())
    c.psql((MIG / CANDIDATE).read_text(), error='MULTI_DAY_VIEW_NAME_TAKEN')
    proofs = re.findall(r'^-- @live-proof: (.+?)\s*$', (MIG / CANDIDATE).read_text(), re.M)
    assert proofs
    for proof in proofs:
        assert c.val('SELECT (%s)::text' % proof) == 'true', proof
    ok('installs_after_the_foundation_and_its_live_proof_holds', '%d proof(s); prerequisites and name refused' % len(proofs))

    c.psql("INSERT INTO auth.sessions VALUES ('%s');" % SESSION)
    c.psql("INSERT INTO public.harness_game_creators VALUES ('%s','%s');" % (CLUB, OPERATOR))
    for uid in USERS + [OPERATOR, RAILBIRD]:
        c.psql("INSERT INTO public.harness_game_readers VALUES ('%s','%s');" % (CLUB, uid))

    # ---- grants --------------------------------------------------------------
    for role in ('anon', 'service_role'):
        c.psql("SET ROLE %s; SELECT public.fn_tournament_stage_view('%s');" % (role, T1), error='permission denied')
        c.psql("SET ROLE %s; SELECT public.fn_operator_seal_stage_plan('%s', '{}'::jsonb);" % (role, T1), error='permission denied')
        c.psql("SET ROLE %s; SELECT public.fn_operator_reschedule_stage('%s', 2, now(), 1, 'x');" % (role, T1), error='permission denied')
    # The service-role RPCs themselves stay closed to a browser.
    as_user(c, OPERATOR, "public.fn_seal_tournament_stage_plan('%s', '{}'::jsonb)" % T1, error='permission denied')
    as_user(c, OPERATOR, "public.fn_reschedule_tournament_stage('%s', 2, now(), 1, 'x')" % T1, error='permission denied')
    ok('only_authenticated_may_call_and_the_service_rpcs_stay_closed', 'anon and service_role refused')

    # ---- no subject, dead session --------------------------------------------
    assert view(c, None) == {'ok': False, 'reason': 'not_authenticated'}
    assert view(c, USERS[0], session=DEAD_SESSION) == {'ok': False, 'reason': 'session_revoked'}
    seal(c, None, T1, PLAN, error='Authentication required')
    seal(c, OPERATOR, T1, PLAN, session=DEAD_SESSION, error='SESSION_REVOKED')
    reschedule(c, OPERATOR, "now() + interval '1 day'", 1, session=DEAD_SESSION, error='SESSION_REVOKED')
    assert count(c, 'tournament_stage_plans') == '0'
    ok('no_subject_or_a_revoked_session_is_refused_first', 'nothing read, nothing written')

    # ---- capability below deployed -------------------------------------------
    assert seal(c, OPERATOR, T1, PLAN) == {'ok': False, 'reason': 'capability_unavailable'}
    assert reschedule(c, OPERATOR, "now() + interval '1 day'", 1) == {'ok': False, 'reason': 'capability_unavailable'}
    assert count(c, 'tournament_stage_plans') == '0'
    got = view(c, USERS[0])
    assert got == {'ok': True, 'tournament_id': T1, 'status': 'REGISTERING', 'plan': None}, got
    ok('doors_refuse_below_deployed_and_the_read_reports_no_plan', 'capability planned')

    F.set_capability(c, 'deployed', 1)

    # ---- authority -------------------------------------------------------------
    for uid in (USERS[0], RAILBIRD, OUTSIDER):
        assert seal(c, uid, T1, PLAN) == {'ok': False, 'reason': 'not_authorised'}, uid
        assert reschedule(c, uid, "now() + interval '1 day'", 1) == {'ok': False, 'reason': 'not_authorised'}, uid
    assert seal(c, OPERATOR, MISSING, PLAN) == {'ok': False, 'reason': 'tournament_not_found'}
    assert count(c, 'tournament_stage_plans') == '0'
    assert view(c, OUTSIDER) == {'ok': False, 'reason': 'tournament_not_found'}
    assert view(c, USERS[0], tournament=MISSING) == {'ok': False, 'reason': 'tournament_not_found'}
    ok('doors_ask_the_club_authority_and_the_read_hides_unreadable_events', 'player, railbird and outsider refused')

    # ---- delegation and idempotent replay -------------------------------------
    bad = seal(c, OPERATOR, T4, dict(PLAN, time_zone='Mars/Olympus'))
    assert bad == {'ok': False, 'reason': 'time_zone_unknown'}, bad
    early = seal(c, OPERATOR, T4, {'time_zone': 'UTC', 'stages': [{'stage_no': 1, 'end_after_level': 4}, PLAN['stages'][1]]})
    assert early['reason'] == 'entry_window_crosses_day_end', early
    sealed = seal(c, OPERATOR, T1, PLAN)
    assert sealed['ok'] and sealed['replay'] is False and sealed['stage_count'] == 2, sealed
    again = seal(c, OPERATOR, T1, PLAN)
    assert again['ok'] and again['replay'] is True and again['plan_hash'] == sealed['plan_hash'], again
    other = seal(c, OPERATOR, T1, dict(PLAN, time_zone='UTC'))
    assert other['reason'] == 'plan_already_sealed', other
    assert count(c, 'tournament_stage_plans') == '1'
    assert c.val("SELECT count(*) FROM public.tournament_stage_transitions WHERE kind='seal'") == '1'
    assert c.val("SELECT count(*) FROM public.tournaments WHERE id='%s' AND NOT is_multi_day AND total_days=1" % T1) == '1'
    ok('seal_door_delegates_validation_and_replays_one_receipt', 'two invalid plans refused by the RPC; one seal')

    # ---- the read before the launch ---------------------------------------------
    before = view(c, USERS[0])
    assert before['ok'] and before['status'] == 'REGISTERING', before
    assert before['plan'] == {'rule_version': 'multi-day-v1', 'time_zone': 'America/Chicago', 'stage_count': 2}, before
    assert [s['state'] for s in before['stages']] == ['planned', 'planned'], before
    assert before['stages'][0]['end_after_level'] == 12 and before['stages'][1]['end_after_level'] is None
    assert before['current_stage'] == {'stage_no': 1, 'day_no': 1, 'state': 'planned'}, before
    assert before['next_start']['stage_no'] == 2 and before['next_start']['time_zone'] == 'America/Chicago', before
    assert before['next_start']['scheduled_start_utc'].startswith('2099-01-01T17:00:00'), before
    assert before['my_bag'] is None and before['my_seat'] is None and before['chip_leaders'] == [] and before['bag'] is None
    ok('read_before_the_launch_is_the_schedule_and_its_zone')

    # ---- a real Day 1 and a real bag (service role, as the engine) ----------------
    F.launch_and_play(c)
    F.heartbeat(c)
    assert c.rpc("public.fn_begin_stage_end('%s', '%s', 1, 12)" % (T1, F.LEASE))['ok']
    bag = c.rpc("public.fn_bag_tournament_stage('%s', '%s', 1, '%s'::jsonb)" % (T1, F.LEASE, F.watermarks(c)))
    assert bag['ok'] and bag['players'] == 6, bag

    order = sorted(range(6), key=lambda i: (-STACKS[i], 'player%d' % i))
    expected_leaders = [{'rank': n + 1, 'display_name': 'player%d' % i, 'stack': STACKS[i]} for n, i in enumerate(order)]
    for i, uid in enumerate(USERS):
        got = view(c, uid)
        assert got['status'] == 'BAGGED', got
        assert got['current_stage'] == {'stage_no': 1, 'day_no': 1, 'state': 'bagged'}, got
        assert got['next_start']['state'] == 'scheduled' and got['next_start']['schedule_generation'] == 1, got
        assert got['my_bag'] == {'stage_no': 1, 'day_no': 1, 'stack': STACKS[i], 'bounty_head': 100 + i}, (uid, got)
        assert got['my_seat'] is None, got
        assert got['bag'] == {'stage_no': 1, 'day_no': 1, 'players': 6}, got
        assert got['chip_leaders'] == expected_leaders, got
        text = json.dumps(got)
        for j, other in enumerate(USERS):
            assert other not in text, (uid, other)
        for key in ('user_id', 'is_horse', 'horse_id', 'club_id', 'registration_id'):
            assert key not in text, (uid, key)
    railbird = view(c, RAILBIRD)
    assert railbird['my_bag'] is None and railbird['chip_leaders'] == expected_leaders, railbird
    horse = view(c, HORSE)
    human = view(c, USERS[3])
    assert set(horse) == set(human) and set(horse['my_bag']) == set(human['my_bag'])
    assert {'rank': order.index(5) + 1, 'display_name': 'player5', 'stack': STACKS[5]} in horse['chip_leaders']
    ok('each_player_sees_only_their_own_bag_and_the_top_ten_by_name',
       '6 players, no other id in any answer, horse read like a human')

    # ---- ten leaders, never more ---------------------------------------------------
    # Six more bags (smaller stacks, no roster name) inside a transaction that
    # rolls back: twelve bagged, ten listed, the two shortest left out.
    out = c.psql(
        "BEGIN; SELECT set_config('app.multi_day_stage_writer', '%s', true);"
        " INSERT INTO public.tournament_stage_bags (tournament_id, stage_no, bag_id, registration_id, user_id, stack,"
        "   bounty_head, source_table_id, source_seat_id, source_seat_number)"
        " SELECT '%s', 1, '%s', gen_random_uuid(), gen_random_uuid(), n, 0, '%s', gen_random_uuid(), 9"
        "   FROM generate_series(1, 6) n;"
        " SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims = '%s';"
        " SELECT (public.fn_tournament_stage_view('%s'))::text; ROLLBACK;"
        % (T1, T1, bag['bag_id'], F.TABLES[0], claims(USERS[0]), T1))
    padded = json.loads([line for line in out.splitlines() if line.startswith('{')][-1])
    assert padded['bag']['players'] == 12, padded
    assert len(padded['chip_leaders']) == 10, padded
    assert [l['stack'] for l in padded['chip_leaders'][-4:]] == [6, 5, 4, 3], padded
    assert padded['chip_leaders'][-1]['display_name'] == 'Player', padded
    assert c.val("SELECT count(*) FROM public.tournament_stage_bags") == '6'
    ok('the_leader_list_is_capped_at_ten', '12 bagged, 10 listed, a missing roster name reads Player')

    # ---- reschedule door --------------------------------------------------------------
    stale = reschedule(c, OPERATOR, "'2098-06-01T17:00:00Z'", 7)
    assert stale['reason'] == 'schedule_generation_stale' and stale['schedule_generation'] == 1, stale
    past = reschedule(c, OPERATOR, "now() - interval '1 minute'", 1)
    assert past['reason'] == 'start_not_in_future', past
    moved = reschedule(c, OPERATOR, "'2098-06-01T17:00:00Z'", 1)
    assert moved['ok'] and moved['replay'] is False and moved['schedule_generation'] == 2, moved
    replay = reschedule(c, OPERATOR, "'2098-06-01T17:00:00Z'", 1)
    assert replay['ok'] and replay['replay'] is True, replay
    assert c.val("SELECT count(*) FROM public.tournament_stage_transitions WHERE kind='reschedule'") == '1'
    after = view(c, USERS[0])
    assert after['next_start']['schedule_generation'] == 2, after
    assert after['next_start']['scheduled_start_utc'].startswith('2098-06-01T17:00:00'), after
    F.set_capability(c, 'tested', 2)
    assert reschedule(c, OPERATOR, "'2098-07-01T17:00:00Z'", 2) == {'ok': False, 'reason': 'capability_unavailable'}
    assert view(c, USERS[0])['my_bag']['stack'] == STACKS[0]   # a withdrawn capability strands nobody
    F.set_capability(c, 'deployed', 3)
    assert seal(c, OPERATOR, T2, PLAN)['reason'] == 'tournament_not_plannable'
    ok('reschedule_door_delegates_replays_and_refuses_when_withdrawn', 'generation 1 -> 2, one receipt')

    # ---- resume, then the Day 2 seat -----------------------------------------------------
    moved = reschedule(c, OPERATOR, 'clock_timestamp() + interval \'2 seconds\'', 2, reason='start now')
    assert moved['ok'] and moved['schedule_generation'] == 3, moved
    time.sleep(2.5)
    for n, tid in enumerate(F.DAY2_TABLES):
        c.psql("INSERT INTO public.tables (id, tournament_id, club_id, status, name) VALUES ('%s','%s','%s','waiting','Table %d');"
               % (tid, T1, CLUB, n + 4))
    F.heartbeat(c)
    level = json.dumps({'index': 13, 'small_blind': 400, 'big_blind': 800, 'ante': 800, 'duration_ms': 1200000})
    begun = c.rpc("public.fn_begin_stage_resume('%s', 2, gen_random_uuid(), 3, '%s', '%s'::jsonb)" % (T1, F.LEASE, level))
    assert begun['ok'], begun
    rid = begun['resume_id']
    during = view(c, USERS[0])
    assert during['next_start']['state'] == 'resuming' and during['my_seat'] is None, during
    ents = c.psql("SELECT e.id || '|' || e.user_id FROM public.tournament_qualification_entitlements e"
                  " WHERE e.tournament_id='%s' ORDER BY e.user_id;" % T1).splitlines()
    seats = {}
    for n, row in enumerate(ents):
        ent, uid = row.split('|')
        table, seat = F.DAY2_TABLES[n % 2], n // 2 + 1
        seats[uid] = (table, 'Table %d' % (n % 2 + 4), seat)
        assert c.rpc("public.fn_seat_stage_entitlement('%s', '%s', '%s', '%s', '%s', %d)"
                     % (T1, rid, F.LEASE, ent, table, seat))['ok']
    assert c.rpc("public.fn_complete_stage_resume('%s', '%s', '%s')" % (T1, rid, F.LEASE))['ok']
    for uid in USERS:
        got = view(c, uid)
        table, name, seat = seats[uid]
        assert got['status'] == 'RUNNING' and got['current_stage'] == {'stage_no': 2, 'day_no': 2, 'state': 'running'}, got
        assert got['my_seat'] == {'stage_no': 2, 'day_no': 2, 'table_id': table, 'table_name': name, 'seat_number': seat}, got
        assert got['next_start'] is None, got
        for other in USERS:
            if other != uid:
                assert other not in json.dumps(got)
    assert view(c, RAILBIRD)['my_seat'] is None
    ok('after_the_resume_each_player_reads_only_their_own_day_two_chair', '6 chairs, horse included')


if __name__ == '__main__':
    sys.exit(main())
