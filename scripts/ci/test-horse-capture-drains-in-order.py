#!/usr/bin/env python3
"""Qualify 20261025042223_horse_capture_drains_in_order.sql in native PostgreSQL.

No production connection. Builds the capture, discovery and snapshot source
tables, installs every replaced function from the migration that last wrote
it (the exact pre-images production carries, by md5), then applies the new
migration through its own pre-image guard, replays it, and proves:

  * the guard refuses a body it did not measure, and the post-image keeps
    SECURITY DEFINER / INVOKER, volatility, settings and service_role-only
    grants;
  * claims take the oldest request first, not the most recently touched;
  * a claimed slice ends at the 512-hand boundary, a success continues to the
    end of the request (no 3x overshoot), and the next claim ends it again at
    the boundary, so a success is never followed by a refine;
  * a timed-out (source_unavailable) slice is refined narrower at once, like
    source_budget_exceeded;
  * the snapshot's precheck still refuses more than 512 hands, returns the
    512th hand's boundary, and a read of (from, boundary] is a snapshot;
  * discovery resumes a new epoch at the boundary after the previous epoch's
    end instead of the newest boundary, and steps over only expired windows.
"""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
MIG = ROOT / 'supabase/migrations'
NEW = MIG / '20261025042223_horse_capture_drains_in_order.sql'
# Where each replaced function's production body was last written.
PREIMAGES = {
    'fn_claim_horse_observation_capture':
        ('20260914041305_preserve_horse_capture_source_witnesses.sql', 'fe2b696a91799229417765107f1781e4'),
    'fn_finish_horse_observation_capture':
        ('20260914032826_recover_horse_observation_capture_slices.sql', 'c4851c48d6be944246e135c5c7142b7f'),
    'fn_discover_horse_observation_requests':
        ('20261017040330_horse_capture_terminal_gaps_free_their_slots.sql', '105a4349232226552dd175535f6bb167'),
    'fn_horse_committed_observation_snapshot':
        ('20261022054023_horse_observation_snapshot_refuses_an_overflowing_window_fro.sql',
         'e1ce00018f43c4517b6b5dc52f762734'),
    'fn_admit_horse_observation_capture':
        ('20261017040330_horse_capture_terminal_gaps_free_their_slots.sql', '22f1d6f7a09a3eaa19bb3fc398297010'),
    'fn_horse_discovery_state':
        ('20260914053355_discover_bounded_horse_observation_requests.sql', None),
}
parser = argparse.ArgumentParser()
parser.add_argument('--pg-bin', default=os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
parser.add_argument('--port', default=os.environ.get('PG_PORT', '55443'))
args = parser.parse_args()
pg = Path(args.pg_bin)
base = Path(tempfile.mkdtemp(prefix='horse-capture-order-', dir=os.environ.get('RUNNER_TEMP')))
data, sock = base / 'data', base / 'sock'
sock.mkdir()
env = {'PATH': str(pg) + ':/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
started = False

ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
H = 18000000


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


def qj(sql):
    return json.loads(q(sql).splitlines()[-1])


def fails(sql, needle):
    try:
        q(sql)
    except RuntimeError as e:
        assert needle in str(e), str(e)[-600:]
        return
    raise AssertionError('expected a refusal containing ' + needle)


def function_sql(path, name):
    """The CREATE FUNCTION statement for `name`, exactly as the file has it."""
    s = path.read_text()
    m = re.search(r'CREATE (?:OR REPLACE )?FUNCTION public\.' + name + r'\(.*?\$function\$.*?\$function\$;', s, re.S)
    assert m, (path.name, name)
    return m.group(0).replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION', 1)


SCHEMA = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE hand_history(table_id uuid NOT NULL DEFAULT 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  hand_number bigint GENERATED ALWAYS AS IDENTITY (START WITH 1000000), id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL, players jsonb, actions jsonb, hole_cards jsonb);
CREATE INDEX idx_hand_history_time_identity ON hand_history (created_at) INCLUDE (id, table_id, hand_number);
CREATE TABLE hand_atomic_commits(hand_id uuid UNIQUE NOT NULL, table_id uuid NOT NULL,
  hand_number bigint UNIQUE NOT NULL, payload_hash text NOT NULL);
CREATE TABLE ca_hand_player_idx(user_id uuid NOT NULL, created_at timestamptz NOT NULL, hand_id uuid NOT NULL,
  PRIMARY KEY(user_id, hand_id));
CREATE INDEX idx_ca_hand_player_idx_user_time ON ca_hand_player_idx(user_id, created_at DESC);
CREATE TABLE hand_projection_outbox(hand_id uuid PRIMARY KEY, table_id uuid, hand_number bigint);
CREATE TABLE ca_hand_fact_revisions(hand_id uuid, user_id uuid, kind text);
CREATE TABLE public.horse_observation_capture_work (
  request_key text PRIMARY KEY, actor_id uuid NOT NULL, from_ms bigint NOT NULL, through_ms bigint NOT NULL,
  state text NOT NULL DEFAULT 'queued', created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(), lease_token uuid, lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0, reason text, batch_key text, batch_digest text, observations integer,
  admitted_at timestamptz, cursor_ms bigint, slice_through_ms bigint, segments integer NOT NULL DEFAULT 0,
  captured_observations bigint NOT NULL DEFAULT 0,
  CHECK((cursor_ms IS NULL AND slice_through_ms IS NULL) OR (cursor_ms>=from_ms AND cursor_ms<=through_ms
    AND slice_through_ms>=cursor_ms AND slice_through_ms<=through_ms)));
CREATE TABLE public.horse_observation_capture_receipts (
  request_key text NOT NULL, lease_token uuid NOT NULL, from_ms bigint NOT NULL, through_ms bigint NOT NULL,
  payload_digest text NOT NULL, acknowledgment jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  source_witness text, source_witness_digest text, PRIMARY KEY(request_key,lease_token), UNIQUE(request_key,from_ms));
CREATE TABLE public.horse_observation_discovery_epochs (
  epoch_key text PRIMARY KEY, from_ms bigint NOT NULL, through_ms bigint NOT NULL UNIQUE,
  cursor_ms bigint NOT NULL, slice_through_ms bigint NOT NULL, state text NOT NULL DEFAULT 'pending',
  segments integer NOT NULL DEFAULT 0, actors integer NOT NULL DEFAULT 0, evidence_bytes integer NOT NULL DEFAULT 0,
  failures integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz,
  previous_through_ms bigint, skipped_epochs integer NOT NULL DEFAULT 0, reason text);
CREATE TABLE public.horse_observation_discovery_segments (epoch_key text, from_ms bigint, through_ms bigint,
  snapshot_id text, read_at_ms bigint, source_digest text, hands integer, source_actors integer,
  actor_digest text, novel_actors uuid[], admitted_actors integer NOT NULL DEFAULT 0, PRIMARY KEY(epoch_key,from_ms));
CREATE TABLE public.horse_observation_discovery_members (epoch_key text, actor_id uuid, request_key text,
  source_from_ms bigint, PRIMARY KEY(epoch_key,actor_id));
-- The journal queue is out of scope: it accepts every batch as durable.
CREATE FUNCTION public.fn_queue_horse_adaptive_batch(p_payload text) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('version',1,'status','durable','batchKey',p_payload::jsonb->>1,
    'batchDigest',encode(sha256(convert_to(p_payload,'UTF8')),'hex'),
    'observations',jsonb_array_length(p_payload::jsonb->7)) $f$;
GRANT SELECT ON hand_history, hand_atomic_commits, ca_hand_player_idx, hand_projection_outbox,
  ca_hand_fact_revisions TO service_role;
"""


def hands_sql(user, first, count, start_ms, step_ms):
    """`count` hands for `user`, ids from `first`, at start_ms + i*step_ms."""
    return (f"INSERT INTO hand_history(id,created_at,players,actions,hole_cards) "
            f"SELECT ('cccccccc-cccc-4ccc-8ccc-'||lpad(({first}+g)::text,12,'0'))::uuid, "
            f"to_timestamp(({start_ms}::bigint+g::bigint*{step_ms})/1000.0), "
            f"jsonb_build_array(jsonb_build_object('userId','{user}')), '[{{\"action\":\"bb\"}}]'::jsonb, '[]' "
            f"FROM generate_series(0,{count - 1}) g;"
            f"INSERT INTO hand_atomic_commits SELECT id,table_id,hand_number,repeat('a',64) FROM hand_history h "
            f"WHERE NOT EXISTS (SELECT 1 FROM hand_atomic_commits a WHERE a.hand_id=h.id);"
            f"INSERT INTO ca_hand_player_idx SELECT '{user}',created_at,id FROM hand_history h "
            f"WHERE h.players @> jsonb_build_array(jsonb_build_object('userId','{user}')) "
            f"ON CONFLICT DO NOTHING;")


def key_of(actor, f, t):
    return hashlib.sha256('|'.join(['horse-source-request-v1', actor, str(f), str(t)]).encode()).hexdigest()


def request_sql(actor, f, t, created_offset_s, available_offset_s=0, state='queued'):
    return (f"INSERT INTO horse_observation_capture_work(request_key,actor_id,from_ms,through_ms,state,created_at,available_at) "
            f"VALUES('{key_of(actor, f, t)}','{actor}',{f},{t},'{state}',now()-interval '{created_offset_s} seconds',"
            f"now()-interval '{available_offset_s} seconds');")


def payload(actor, f, t):
    actor_key = hashlib.sha256(json.dumps(['adaptive-actor-v1', actor], separators=(',', ':')).encode()).hexdigest()
    return json.dumps([1, 'e' * 64, actor_key, f, t, 'f' * 64, {}, []], separators=(',', ':'))


try:
    run([pg / 'initdb', '-D', data, '-U', 'postgres', '-A', 'trust', '--no-locale', '--encoding=UTF8'])
    run([pg / 'pg_ctl', '-D', data, '-w', '-l', base / 'server.log', '-o',
         f"-k {sock} -p {args.port} -c listen_addresses=''", 'start'])
    started = True
    q(SCHEMA)
    # The exact production pre-images, installed from the files that wrote them.
    for name, (file, expected) in PREIMAGES.items():
        q(function_sql(MIG / file, name))
        if expected:
            got = q(f"SELECT md5(prosrc) FROM pg_proc WHERE proname='{name}'")
            assert got == expected, ('pre-image does not reproduce production', name, got)
    q("""REVOKE ALL ON FUNCTION public.fn_claim_horse_observation_capture(uuid),
           public.fn_finish_horse_observation_capture(text,uuid,text,text),
           public.fn_discover_horse_observation_requests(),
           public.fn_horse_committed_observation_snapshot(uuid,bigint,bigint) FROM PUBLIC, anon, authenticated;
         GRANT EXECUTE ON FUNCTION public.fn_claim_horse_observation_capture(uuid),
           public.fn_finish_horse_observation_capture(text,uuid,text,text),
           public.fn_discover_horse_observation_requests(),
           public.fn_horse_committed_observation_snapshot(uuid,bigint,bigint) TO service_role;""")
    results = []

    # 1. The guard refuses a body it did not measure, and installs nothing.
    sql = NEW.read_text()
    original_claim = function_sql(MIG / PREIMAGES['fn_claim_horse_observation_capture'][0],
                                  'fn_claim_horse_observation_capture')
    q(original_claim.replace("RAISE EXCEPTION 'HORSE_CAPTURE_INVALID_TOKEN'", "RAISE EXCEPTION 'DRIFTED'"))
    fails(sql, 'HORSE_CAPTURE_DRAINS_IN_ORDER_PREIMAGE_CHANGED')
    assert q("SELECT count(*) FROM pg_proc WHERE proname='fn_horse_capture_hand_budget_through'") == '0'
    q(original_claim)
    q('GRANT EXECUTE ON FUNCTION public.fn_claim_horse_observation_capture(uuid) TO service_role;'
      'REVOKE ALL ON FUNCTION public.fn_claim_horse_observation_capture(uuid) FROM PUBLIC;')
    results.append('pre-image guard refuses an unmeasured body and installs nothing')

    # 2. Install, then replay through its own post-image.
    q(sql)
    q(sql)
    results.append('installs once and replays')

    now_ms = int(q("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint"))
    f0 = now_ms - 6 * 3600 * 1000
    t0 = now_ms - 60000

    # 3. The budget boundary: 1000 hands one second apart.
    q(hands_sql(ACTOR, 0, 1000, f0 + 1000, 1000))
    b = int(q(f"SELECT public.fn_horse_capture_hand_budget_through('{ACTOR}',{f0},{t0},512)"))
    assert b == f0 + 512 * 1000, b
    n = int(q(f"SELECT count(*) FROM ca_hand_player_idx WHERE user_id='{ACTOR}' "
              f"AND created_at>to_timestamp({f0}/1000.0) AND created_at<=to_timestamp({b}/1000.0)"))
    assert n == 512, n
    assert int(q(f"SELECT public.fn_horse_capture_hand_budget_through('{ACTOR}',{f0},{f0 + 300000},512)")) == f0 + 300000
    half = int(q(f"SELECT public.fn_horse_capture_hand_budget_through('{ACTOR}',{f0},{f0 + 300000},NULL)"))
    assert half == f0 + 150 * 1000, half
    results.append('the 512th hand ends the slice; a smaller window is left whole; NULL halves by hands')

    # 4. The snapshot still refuses, now with the boundary, and the boundary reads.
    snap = qj(f"SET ROLE service_role; SELECT public.fn_horse_committed_observation_snapshot('{ACTOR}',{f0},{t0})")
    assert snap['status'] == 'unavailable' and snap['reason'] == 'hand_budget_exceeded', snap
    assert snap['handCount'] == 513 and snap['hands'] == [] and snap['budgetThroughMs'] == b, snap
    snap = qj(f"SET ROLE service_role; SELECT public.fn_horse_committed_observation_snapshot('{ACTOR}',{f0},{b})")
    assert snap['status'] == 'snapshot' and snap['handCount'] == 512, snap
    results.append('the snapshot refuses 513, names the boundary, and reads exactly 512 to it')

    # 5. Oldest request first, not the most recently touched.
    q(request_sql(OTHER, f0, t0, 600, 3000) + request_sql(ACTOR, f0, t0, 3600, 0))
    claim = qj("SELECT public.fn_claim_horse_observation_capture('11111111-1111-4111-8111-111111111111')")
    assert claim['status'] == 'claimed' and claim['actorId'] == ACTOR, claim
    assert claim['sliceFromMs'] == f0 and claim['sliceThroughMs'] == b, claim
    results.append('the oldest request is claimed first and its slice ends at the boundary')

    # 6. A success continues to the end of the request, then is re-bounded.
    key = claim['requestKey']
    ack = qj(f"SELECT public.fn_finish_horse_observation_capture('{key}','11111111-1111-4111-8111-111111111111',"
             f"'{payload(ACTOR, f0, b)}',NULL)")
    assert ack['status'] == 'continued' and ack['nextFromMs'] == b and ack['nextThroughMs'] == t0, ack
    claim = qj("SELECT public.fn_claim_horse_observation_capture('22222222-2222-4222-8222-222222222222')")
    assert claim['requestKey'] == key, ('the started request keeps the lane', claim)
    assert claim['sliceFromMs'] == b and claim['sliceThroughMs'] == t0, claim  # 488 hands remain: whole rest
    ack = qj(f"SELECT public.fn_finish_horse_observation_capture('{key}','22222222-2222-4222-8222-222222222222',"
             f"'{payload(ACTOR, b, t0)}',NULL)")
    assert ack['status'] == 'captured' and ack['segments'] == 2, ack
    refines = q(f"SELECT count(*) FROM horse_observation_capture_work WHERE reason LIKE '%refined%'")
    assert refines == '0', refines
    results.append('a success continues to the end of the request and drains it in two reads, with no refine')

    # 7. A timeout is refined narrower at once, like a budget refusal.
    claim = qj("SELECT public.fn_claim_horse_observation_capture('33333333-3333-4333-8333-333333333333')")
    assert claim['actorId'] == OTHER, claim
    k2 = claim['requestKey']
    ack = qj(f"SELECT public.fn_finish_horse_observation_capture('{k2}','33333333-3333-4333-8333-333333333333',"
             f"NULL,'source_unavailable')")
    assert ack['status'] == 'refined' and ack['nextFromMs'] == f0 and f0 < ack['nextThroughMs'] < t0, ack
    row = qj(f"SELECT row_to_json(w) FROM horse_observation_capture_work w WHERE request_key='{k2}'")
    assert row['reason'] == 'source_unavailable_refined' and row['state'] == 'queued', row
    q(f"UPDATE horse_observation_capture_work SET lease_token=NULL WHERE request_key='{k2}'")
    claim = qj("SELECT public.fn_claim_horse_observation_capture('44444444-4444-4444-8444-444444444444')")
    ack = qj(f"SELECT public.fn_finish_horse_observation_capture('{k2}','44444444-4444-4444-8444-444444444444',"
             f"NULL,'source_budget_exceeded')")
    assert ack['status'] == 'refined', ack
    results.append('a timed-out slice is refined at once instead of retried at the same width')

    # 8. Discovery resumes after the previous epoch instead of skipping.
    newest = (now_ms // H) * H - 60000
    prev = newest - 2 * H
    if prev - 21600000 < now_ms - 82800000 + H:
        prev = newest - H  # keep the resumed window inside the readable day
    q(f"INSERT INTO horse_observation_discovery_epochs(epoch_key,from_ms,through_ms,cursor_ms,slice_through_ms,state,finished_at) "
      f"VALUES(repeat('0',64),{prev - 21600000},{prev},{prev},{prev},'discovered',now());")
    q("UPDATE horse_observation_capture_work SET state='captured' WHERE state<>'captured';"
      "UPDATE horse_observation_capture_work SET cursor_ms=through_ms, slice_through_ms=through_ms, segments=2, admitted_at=now();")
    d = qj("SELECT public.fn_discover_horse_observation_requests()")
    e = qj("SELECT row_to_json(e) FROM horse_observation_discovery_epochs e WHERE state='pending'")
    assert e['through_ms'] == prev + H and e['from_ms'] == prev + H - 21600000, (e, d)
    assert e['skipped_epochs'] == 0 and e['previous_through_ms'] == prev, e
    results.append('a new epoch resumes at the boundary after the previous one')

    # A previous epoch past the readable day: only the expired windows are stepped over.
    q("TRUNCATE horse_observation_discovery_epochs;")
    old = newest - 8 * H
    q(f"INSERT INTO horse_observation_discovery_epochs(epoch_key,from_ms,through_ms,cursor_ms,slice_through_ms,state,finished_at) "
      f"VALUES(repeat('0',64),{old - 21600000},{old},{old},{old},'gap',now());")
    qj("SELECT public.fn_discover_horse_observation_requests()")
    e = qj("SELECT row_to_json(e) FROM horse_observation_discovery_epochs e WHERE state='pending'")
    assert e['through_ms'] < newest and e['from_ms'] >= now_ms - 82800000 - 1, e
    assert e['from_ms'] - H < now_ms - 82800000, ('an earlier readable window was skipped', e)
    results.append('only windows past the readable day are stepped over')

    # 9. Security mode, volatility, settings and grants are exactly as installed.
    acl = q("""SELECT string_agg(proname||':'||prosecdef::text||':'||provolatile::text||':'||array_to_string(proconfig,';')||':'||
               has_function_privilege('service_role',oid,'EXECUTE')::text||has_function_privilege('anon',oid,'EXECUTE')::text||
               has_function_privilege('authenticated',oid,'EXECUTE')::text,E'\\n' ORDER BY proname) FROM pg_proc
               WHERE proname IN ('fn_claim_horse_observation_capture','fn_finish_horse_observation_capture',
                 'fn_discover_horse_observation_requests','fn_horse_committed_observation_snapshot',
                 'fn_horse_capture_hand_budget_through')""")
    assert len(acl.splitlines()) == 5, acl
    for part in acl.splitlines():
        assert part.endswith(':truefalsefalse'), part
    assert 'fn_horse_committed_observation_snapshot:false:s:' in acl, acl
    assert 'fn_claim_horse_observation_capture:true:v:' in acl, acl
    results.append('security mode, volatility, settings and grants preserved')
    print(json.dumps({'scenarios': results}))
finally:
    if started:
        subprocess.run([str(pg / 'pg_ctl'), '-D', str(data), '-m', 'immediate', 'stop'], env=env, capture_output=True)
    shutil.rmtree(base, ignore_errors=True)
