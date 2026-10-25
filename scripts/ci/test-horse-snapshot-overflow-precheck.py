#!/usr/bin/env python3
"""Qualify the horse observation snapshot's overflow precheck in native PostgreSQL.

No production connection. Builds the snapshot's source tables, installs the
function's migration chain up to 20261022034135 (the predecessor), keeps that
definition under a second name, then applies 20261022054023 through its own
preimage guard (and replays it). Every scenario is read by both definitions in
one statement snapshot and must agree:

  * every snapshot answer is byte-identical (the precheck never admits);
  * 512 hands is a snapshot, 513 is hand_budget_exceeded with no hands;
  * the outbox-pending / voided-index / roster-over-index cases are unchanged;
  * orphan index rows (hand pruned) and index rows outside the window never
    count toward overflow;
  * an overflowing window is refused WITHOUT reading hand_history payload:
    the refusal plan touches only the two indexes.
"""
import argparse
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
MIG = ROOT / 'supabase/migrations'
CHAIN = [
    MIG / '20260912193321_horse_committed_observation_snapshot.sql',
    MIG / '20260913195856_require_atomic_horse_observation_sources.sql',
    MIG / '20261022034135_horse_observation_snapshot_finds_hands_through_the_player_in.sql',
]
NEW = MIG / '20261022054023_horse_observation_snapshot_refuses_an_overflowing_window_fro.sql'
DRAINS = MIG / '20261025042223_horse_capture_drains_in_order.sql'
PREDECESSOR_MD5 = 'd1df5793f8117878ba28553c08ea922c'
parser = argparse.ArgumentParser()
parser.add_argument('--pg-bin', default=os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
parser.add_argument('--port', default=os.environ.get('PG_PORT', '55442'))
args = parser.parse_args()
pg = Path(args.pg_bin)
base = Path(tempfile.mkdtemp(prefix='horse-overflow-', dir=os.environ.get('RUNNER_TEMP')))
data, sock = base / 'data', base / 'sock'
sock.mkdir()
env = {'PATH': str(pg) + ':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
started = False

ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'


def hid(n):
    return 'cccccccc-cccc-4ccc-8ccc-' + str(n).zfill(12)


def run(argv, sql=None):
    r = subprocess.run([str(a) for a in argv], input=sql, text=True, capture_output=True, env=env, timeout=300)
    if r.returncode:
        raise RuntimeError(r.stdout + r.stderr)
    return r.stdout.strip()


def q(sql):
    return run([pg / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', args.port,
                '-U', 'postgres', '-d', 'postgres'], sql)


SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE hand_history(table_id uuid NOT NULL DEFAULT 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  hand_number bigint GENERATED ALWAYS AS IDENTITY (START WITH 1000000), id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL, players jsonb, actions jsonb, hole_cards jsonb);
CREATE INDEX roster ON hand_history USING gin(players jsonb_path_ops);
CREATE INDEX idx_hand_history_time_identity ON hand_history (created_at) INCLUDE (id, table_id, hand_number);
CREATE TABLE hand_atomic_commits(hand_id uuid UNIQUE NOT NULL, table_id uuid NOT NULL,
  hand_number bigint UNIQUE NOT NULL, payload_hash text NOT NULL);
CREATE TABLE ca_hand_player_idx(user_id uuid NOT NULL, created_at timestamptz NOT NULL, hand_id uuid NOT NULL,
  PRIMARY KEY(user_id, hand_id));
CREATE INDEX idx_ca_hand_player_idx_user_time ON ca_hand_player_idx(user_id, created_at DESC);
CREATE TABLE hand_projection_outbox(hand_id uuid PRIMARY KEY, table_id uuid, hand_number bigint);
CREATE TABLE ca_hand_fact_revisions(hand_id uuid, user_id uuid, kind text);
GRANT SELECT ON hand_history, hand_atomic_commits, ca_hand_player_idx, hand_projection_outbox,
  ca_hand_fact_revisions TO service_role;
"""


def insert_sql(n, offset_s, user=ACTOR, actions='[{"action":"bb","secret":"x"}]', index=True, receipt=True):
    s = (f"INSERT INTO hand_history(id,created_at,players,actions,hole_cards) VALUES('{hid(n)}', "
         f"now() - interval '{offset_s} seconds', '[{{\"userId\":\"{user}\"}}]'::jsonb, '{actions}'::jsonb, '[]');")
    if receipt:
        s += (f"INSERT INTO hand_atomic_commits SELECT id,table_id,hand_number,repeat('a',64) "
              f"FROM hand_history WHERE id='{hid(n)}';")
    if index:
        s += f"INSERT INTO ca_hand_player_idx SELECT '{user}',created_at,id FROM hand_history WHERE id='{hid(n)}';"
    return s


def compare(label, window_s=3600):
    """Both definitions in ONE statement: same snapshot, same statement_timestamp."""
    out = q("SET ROLE service_role; WITH w AS (SELECT floor(extract(epoch FROM statement_timestamp())*1000)::bigint - 1 AS t) "
            f"SELECT jsonb_build_object('old', public.fn_horse_snapshot_before('{ACTOR}', w.t - {window_s * 1000}, w.t), "
            f"'new', public.fn_horse_committed_observation_snapshot('{ACTOR}', w.t - {window_s * 1000}, w.t)) FROM w;")
    r = json.loads(out.splitlines()[-1])
    old, new = r['old'], r['new']
    if old.get('reason') == 'hand_budget_exceeded':
        # The refusal is the same answer; the old one also measured payload
        # it then discarded, the new one did not read it.
        for k in ('version', 'status', 'reason', 'actor', 'fromMs', 'throughMs', 'readAtMs',
                  'coverage', 'acceptance', 'hands'):
            assert old[k] == new[k], (label, k, old, new)
        assert new['hands'] == [] and new['handCount'] == 513 and new['actionCount'] is None, (label, new)
    else:
        assert old == new, (label, old, new)
    return old, new


try:
    run([pg / 'initdb', '-D', data, '-U', 'postgres', '-A', 'trust', '--no-locale', '--encoding=UTF8'])
    run([pg / 'pg_ctl', '-D', data, '-w', '-l', base / 'server.log', '-o',
         f"-k {sock} -p {args.port} -c listen_addresses=''", 'start'])
    started = True
    q(SCHEMA)
    for m in CHAIN:
        q(m.read_text())
    md5 = q("SELECT md5(pg_get_functiondef('public.fn_horse_committed_observation_snapshot(uuid,bigint,bigint)'::regprocedure))")
    assert md5 == PREDECESSOR_MD5, 'predecessor chain does not reproduce production: ' + md5
    old_def = q("SELECT pg_get_functiondef('public.fn_horse_committed_observation_snapshot(uuid,bigint,bigint)'::regprocedure)")
    q(old_def.replace('public.fn_horse_committed_observation_snapshot(', 'public.fn_horse_snapshot_before(', 1)
      + ";\nGRANT EXECUTE ON FUNCTION public.fn_horse_snapshot_before(uuid,bigint,bigint) TO service_role;")
    q(NEW.read_text())
    q(NEW.read_text())  # replay accepted by its own guard
    acl = q("SELECT proacl::text FROM pg_proc WHERE oid='public.fn_horse_committed_observation_snapshot(uuid,bigint,bigint)'::regprocedure")
    assert 'service_role=X' in acl and 'anon' not in acl and 'authenticated' not in acl, acl
    flags = q("SELECT provolatile::text||prosecdef::text FROM pg_proc WHERE oid='public.fn_horse_committed_observation_snapshot(uuid,bigint,bigint)'::regprocedure")
    assert flags == 'sfalse', flags
    results = []

    # Empty, then a normal mixed window with another player's hands around it.
    old, _ = compare('empty')
    assert old['status'] == 'snapshot' and old['handCount'] == 0
    q(''.join(insert_sql(n, 10 + n) for n in range(40)) + ''.join(insert_sql(1000 + n, 20 + n, OTHER) for n in range(30)))
    old, _ = compare('forty')
    assert old['handCount'] == 40
    results.append('40 hands identical')

    # Exactly at the budget, then one over.
    q('TRUNCATE hand_history, hand_atomic_commits, ca_hand_player_idx, hand_projection_outbox, ca_hand_fact_revisions;'
      + ''.join(insert_sql(n, 5 + (n % 300)) for n in range(512)))
    old, _ = compare('512')
    assert old['status'] == 'snapshot' and old['handCount'] == 512
    q(insert_sql(512, 7))
    old, new = compare('513')
    assert old['reason'] == 'hand_budget_exceeded'
    results.append('512 snapshot identical, 513 refused identically')

    # Index rows that must NOT count: orphans (history pruned) and rows
    # outside the window. 400 real + 200 orphan + 200 outside = snapshot.
    q('TRUNCATE hand_history, hand_atomic_commits, ca_hand_player_idx, hand_projection_outbox, ca_hand_fact_revisions;'
      + ''.join(insert_sql(n, 5 + n) for n in range(400))
      + ''.join(insert_sql(2000 + n, 30 + n) for n in range(200))
      + f"DELETE FROM hand_history WHERE id BETWEEN '{hid(2000)}' AND '{hid(2199)}';"
      + ''.join(insert_sql(4000 + n, 7200 + n) for n in range(200)))
    old, _ = compare('orphans and out-of-window')
    assert old['status'] == 'snapshot' and old['handCount'] == 400, old
    results.append('orphan and out-of-window index rows never cause a refusal')

    # Index-missing paths still found by the snapshot (outbox, voided fact),
    # and an index row naming the actor for a hand whose roster does not.
    q('TRUNCATE hand_history, hand_atomic_commits, ca_hand_player_idx, hand_projection_outbox, ca_hand_fact_revisions;'
      + insert_sql(1, 10) + insert_sql(2, 11, index=False) + insert_sql(3, 12, index=False) + insert_sql(4, 13, OTHER)
      + f"INSERT INTO hand_projection_outbox SELECT id,table_id,hand_number FROM hand_history WHERE id='{hid(2)}';"
      + f"INSERT INTO ca_hand_fact_revisions VALUES('{hid(3)}','{ACTOR}','void');"
      + f"INSERT INTO ca_hand_player_idx SELECT '{ACTOR}',created_at,id FROM hand_history WHERE id='{hid(4)}';")
    old, _ = compare('outbox, void, roster-over-index')
    assert sorted(h['id'] for h in old['hands']) == [hid(1), hid(2), hid(3)], old
    results.append('outbox / voided / roster-over-index unchanged')

    # Other refusals are untouched: a missing receipt under the budget.
    q('TRUNCATE hand_history, hand_atomic_commits, ca_hand_player_idx, hand_projection_outbox, ca_hand_fact_revisions;'
      + insert_sql(1, 10) + insert_sql(2, 11, receipt=False))
    old, _ = compare('missing receipt')
    assert old['reason'] == 'atomic_receipt_missing'

    # Overflow is decided before any history payload is read: on a refusal
    # the precheck's plan reads the two indexes only.
    q('TRUNCATE hand_history, hand_atomic_commits, ca_hand_player_idx, hand_projection_outbox, ca_hand_fact_revisions;'
      + ''.join(insert_sql(n, 5 + n) for n in range(700)) + 'ANALYZE;')
    old, _ = compare('700 overflow', 21600)
    assert old['reason'] == 'hand_budget_exceeded'
    # The precheck reads only index columns of hand_history (created_at, id,
    # both in idx_hand_history_time_identity) and nothing of the roster or
    # payload. Asserted on the installed definition: a plan pinned on a
    # fixture this small flips join order and proves nothing about
    # production, where the measured plan is an index-only scan (header).
    d = q("SELECT pg_get_functiondef('public.fn_horse_committed_observation_snapshot(uuid,bigint,bigint)'::regprocedure)")
    pre = d[d.index('SELECT count(*)::integer INTO v_count FROM ('):d.index('LIMIT 513) overflow')]
    assert 'h.created_at = i.created_at AND h.id = i.hand_id' in pre, pre
    for banned in ('players', 'actions', 'hand_atomic_commits', 'hole_cards'):
        assert banned not in pre, (banned, pre)
    assert d.index('LIMIT 513) overflow') < d.index('WITH found AS MATERIALIZED'), 'precheck must run before the read'
    results.append('overflow refused before any roster or payload read')

    # 20261025042223 (horse capture drains in order) moves the same precheck
    # into fn_horse_capture_hand_budget_through, which also returns where the
    # 512th hand falls. Its own native proof is
    # scripts/ci/test-horse-capture-drains-in-order.py; here the successor is
    # held to the same refusal and the same index-only read. Only its two
    # snapshot functions are installed: its guard needs the capture functions
    # this fixture does not build.
    drains = DRAINS.read_text()
    for name in ('fn_horse_capture_hand_budget_through', 'fn_horse_committed_observation_snapshot'):
        m = re.search(r'CREATE OR REPLACE FUNCTION public\.' + name + r'\(.*?\$function\$;', drains, re.S)
        assert m, name
        q(m.group(0))
    q('GRANT EXECUTE ON FUNCTION public.fn_horse_capture_hand_budget_through(uuid,bigint,bigint,integer) TO service_role;')
    _, new = compare('700 overflow after drains-in-order', 21600)
    assert new['reason'] == 'hand_budget_exceeded' and new['hands'] == [], new
    assert isinstance(new.get('budgetThroughMs'), int), new
    compare_after = q(f"SET ROLE service_role; SELECT public.fn_horse_committed_observation_snapshot('{ACTOR}', "
                      f"{new['fromMs']}, {new['budgetThroughMs']})")
    assert json.loads(compare_after.splitlines()[-1])['handCount'] == 512, compare_after
    h = q("SELECT prosrc FROM pg_proc WHERE proname='fn_horse_capture_hand_budget_through'")
    assert 'h.created_at = i.created_at AND h.id = i.hand_id' in h and 'LIMIT 513' in h, h
    for banned in ('players', 'actions', 'hand_atomic_commits', 'hole_cards'):
        assert banned not in re.sub(r'--[^\n]*', '', h), (banned, h)
    d = q("SELECT pg_get_functiondef('public.fn_horse_committed_observation_snapshot(uuid,bigint,bigint)'::regprocedure)")
    assert d.index('fn_horse_capture_hand_budget_through') < d.index('WITH found AS MATERIALIZED'), d
    results.append('the successor refuses the same window from the index and names the 512th hand')
    print(json.dumps({'scenarios': results, 'identical': True}))
finally:
    if started:
        subprocess.run([str(pg / 'pg_ctl'), '-D', str(data), '-m', 'immediate', 'stop'], env=env, capture_output=True)
    shutil.rmtree(base, ignore_errors=True)
