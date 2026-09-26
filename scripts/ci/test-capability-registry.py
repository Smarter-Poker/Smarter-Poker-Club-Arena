#!/usr/bin/env python3
"""Qualify the capability registry and accepted-event continuation in an isolated PostgreSQL cluster.

Installs supabase/migrations/20260924025555_one_capability_registry_and_accepted_event_continuation.sql
unchanged over a fixture that reproduces what it depends on (Supabase's default grants to anon and
authenticated, auth.uid()/auth.role(), fn_is_platform_admin(), tournaments with its live status CHECK,
ca_declared_money_triggers), then exercises every rule the design names. Evidence goes to --output.
"""
import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase/migrations/20260924025555_one_capability_registry_and_accepted_event_continuation.sql'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/capability-registry')
args = parser.parse_args()
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=False)
pg = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
cluster = Path(tempfile.mkdtemp(prefix='capability-registry-', dir='/tmp'))
socket = cluster / 'socket'
socket.mkdir(mode=0o700)
PORT = '55724'
cmd = [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
       '-h', str(socket), '-p', PORT, '-U', 'postgres', '-d', 'postgres']
results = {'scope': 'capability registry, readiness writer, public projection, accepted-event acceptance, '
                    'conclusion, backfill and continuation; isolated fixture, not whole-schema qualification',
           'cases': [], 'passed': False}

STAFF = '00000000-0000-4000-8000-00000000a001'
PLAYER = '00000000-0000-4000-8000-00000000a002'
CLUB = '00000000-0000-4000-8000-00000000c001'
UNION = '00000000-0000-4000-8000-00000000c002'
REFUSED_CLUB = '00000000-0000-4000-8000-00000000c0ff'
# Pre-install tournaments, one per status, plus flights under a running and a completed parent.
PRE = {
    'ANNOUNCED': '10000000-0000-4000-8000-000000000001',
    'REGISTERING': '10000000-0000-4000-8000-000000000002',
    'LATE_REG': '10000000-0000-4000-8000-000000000003',
    'RUNNING': '10000000-0000-4000-8000-000000000004',
    'COMPLETING': '10000000-0000-4000-8000-000000000005',
    'COMPLETED': '10000000-0000-4000-8000-000000000006',
    'CANCELLED': '10000000-0000-4000-8000-000000000007',
}
FLIGHT_OF_RUNNING = '10000000-0000-4000-8000-000000000008'
FLIGHT_OF_COMPLETED = '10000000-0000-4000-8000-000000000009'
NEW_T = '20000000-0000-4000-8000-000000000001'
PARENT_T = '20000000-0000-4000-8000-000000000002'
CHILD_T = '20000000-0000-4000-8000-000000000003'
UNKNOWN_T = '20000000-0000-4000-8000-0000000000ff'
WRITER = 'public.fn_set_capability_readiness'

FIXTURE = f"""
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- Supabase's defaults: every new table, sequence and function in public is
-- granted to the API roles unless a migration revokes it.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(coalesce(current_setting('request.jwt.claim.sub', true),
                         (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(coalesce(current_setting('request.jwt.claim.role', true),
                         (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')), '')::text $$;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO anon, authenticated, service_role;
-- Stand-in for the one staff authority; its production body is not in the repo.
CREATE TABLE public.fixture_platform_staff(user_id uuid PRIMARY KEY);
INSERT INTO public.fixture_platform_staff VALUES ('{STAFF}');
CREATE FUNCTION public.fn_is_platform_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.fixture_platform_staff s WHERE s.user_id = auth.uid()) $$;
REVOKE ALL ON FUNCTION public.fn_is_platform_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_is_platform_admin() TO authenticated, service_role;
CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text,
  status text NOT NULL DEFAULT 'ANNOUNCED',
  club_id uuid,
  union_id uuid,
  parent_tournament_id uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT tournaments_status_check CHECK (status IN
    ('ANNOUNCED','REGISTERING','LATE_REG','RUNNING','COMPLETING','COMPLETED','CANCELLED')));
-- Existing live triggers of the same kinds the new ones sit beside: a BEFORE
-- INSERT guard that rewrites nothing, and an AFTER UPDATE OF status writer.
CREATE TABLE public.fixture_status_log(tournament_id uuid, status text);
CREATE FUNCTION public.fixture_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.name = 'refused by an existing guard' THEN RAISE EXCEPTION 'existing guard' USING ERRCODE = 'P0001'; END IF; RETURN NEW; END $$;
CREATE TRIGGER tournaments_creation_guard BEFORE INSERT ON public.tournaments FOR EACH ROW EXECUTE FUNCTION public.fixture_guard();
CREATE FUNCTION public.fixture_log_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO public.fixture_status_log VALUES (NEW.id, NEW.status); RETURN NULL; END $$;
CREATE TRIGGER trg_release_seats_on_tournament_finish AFTER UPDATE OF status ON public.tournaments FOR EACH ROW EXECUTE FUNCTION public.fixture_log_status();
CREATE TABLE public.ca_declared_money_triggers(table_name text, trigger_name text, note text, PRIMARY KEY (table_name, trigger_name));
INSERT INTO public.tournaments (id, name, status, club_id, union_id, created_at) VALUES
""" + ',\n'.join(
    f"  ('{tid}', 'pre {st}', '{st}', '{CLUB}', '{UNION}', '2026-09-0{i + 1} 12:00:00+00')"
    for i, (st, tid) in enumerate(PRE.items())
) + f""",
  ('{FLIGHT_OF_RUNNING}', 'flight of running', 'REGISTERING', '{CLUB}', NULL, '2026-09-10 12:00:00+00'),
  ('{FLIGHT_OF_COMPLETED}', 'flight of completed', 'REGISTERING', '{CLUB}', NULL, '2026-09-10 12:00:00+00');
UPDATE public.tournaments SET parent_tournament_id = '{PRE['RUNNING']}' WHERE id = '{FLIGHT_OF_RUNNING}';
UPDATE public.tournaments SET parent_tournament_id = '{PRE['COMPLETED']}' WHERE id = '{FLIGHT_OF_COMPLETED}';
TRUNCATE public.fixture_status_log;
"""


def command(argv, sql=None):
    return subprocess.run([str(a) for a in argv], input=sql, text=True, capture_output=True, env=env, timeout=60)


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def run(name, sql, expected=None, error=None):
    r = command(cmd, sql)
    (out / (name + '.log')).write_text('-- SQL\n' + sql + '\n-- STDOUT\n' + r.stdout + '\n-- STDERR\n' + r.stderr)
    passed = (r.returncode != 0 and error in r.stderr) if error else r.returncode == 0
    got = r.stdout.rstrip('\n')
    if expected is not None:
        passed = passed and got == expected
    results['cases'].append({'name': name, 'passed': passed, 'expectedSqlstate': error,
                             'expected': expected, 'got': got if expected is not None else None})
    require(passed, name + ': expected ' + repr(expected) + ' got ' + repr(got) + '\n' + r.stderr[-1500:])
    return got


def identity(role, sub=None):
    claims = {'role': role}
    if sub:
        claims['sub'] = sub
    return ("SET LOCAL ROLE " + role + "; SELECT set_config('request.jwt.claims', '"
            + json.dumps(claims) + "', true) \\g /dev/null\n")


def probe(name, body, expected=None, error=None, role=None, sub=None):
    return run(name, 'BEGIN;\n' + (identity(role, sub) if role else '') + body + '\nROLLBACK;', expected, error)


def call(cap, readiness, version, rev, evidence='{}'):
    return f"{WRITER}('{cap}','{readiness}','{version}',{rev},'{evidence}'::jsonb)"


def write(cap, readiness, version, rev, evidence='{}'):
    return 'SELECT ' + call(cap, readiness, version, rev, evidence) + ';'



snapshot = ("SELECT md5(jsonb_build_object("
            "'caps',(SELECT jsonb_agg(to_jsonb(c) ORDER BY capability_id) FROM public.platform_capabilities c),"
            "'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.platform_capability_events e),"
            "'accepted',(SELECT jsonb_agg(to_jsonb(a) ORDER BY event_id) FROM public.accepted_event_operations a),"
            "'tournaments',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.tournaments t))::text);")
installer = MIGRATION.read_text()
backfill = re.search(r"INSERT INTO public\.accepted_event_operations\s*\n\s*\(event_kind[^;]*?FROM public\.tournaments t[^;]*;",
                     installer).group(0)
proofs = [m.group(1).strip() for m in re.finditer(r'^-- @live-proof: (.+?)\s*$', installer, re.M)]
try:
    version = command([pg / 'postgres', '--version']).stdout
    require(re.search(r'PostgreSQL\) 1[6-9]\.', version), 'PostgreSQL 16 or newer required, found ' + version)
    results['postgres'] = version.strip()
    r = command([pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust', '--auth-host=reject',
                 '--no-locale', '--encoding=UTF8'])
    require(r.returncode == 0, r.stderr)
    with (cluster / 'data/postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) + "'\nunix_socket_permissions=0700\n"
                "port=" + PORT + "\nshared_buffers='16MB'\nmax_connections=10\n")
    r = command([pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-w', 'start'])
    require(r.returncode == 0, r.stderr)
    run('fixture', FIXTURE)

    # ── installation ─────────────────────────────────────────────────────────
    drift = ("BEGIN; ALTER TABLE public.tournaments DROP CONSTRAINT tournaments_status_check;"
             " ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_status_check CHECK (status IN"
             " ('ANNOUNCED','REGISTERING','LATE_REG','RUNNING','PAUSED','COMPLETING','COMPLETED','CANCELLED'));\n")
    run('install-refuses-a-changed-status-vocabulary', drift + installer, error='CAPABILITY_REGISTRY_TOURNAMENT_STATUS_VOCABULARY_CHANGED')
    run('refused-install-left-nothing', "SELECT to_regclass('public.platform_capabilities') IS NULL AND to_regclass('public.accepted_event_operations') IS NULL AND (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.tournaments'::regclass AND tgname LIKE 'trg_tournaments_record_%') = 0;", 't')
    run('install', installer)
    run('install-declares-both-money-triggers', "SELECT string_agg(trigger_name, ',' ORDER BY trigger_name) FROM public.ca_declared_money_triggers WHERE table_name='tournaments';",
        'trg_tournaments_record_acceptance,trg_tournaments_record_conclusion')
    run('install-added-no-tournament-column', "SELECT count(*) FROM pg_attribute WHERE attrelid='public.tournaments'::regclass AND attnum>0 AND NOT attisdropped;", '8')
    for i, proof in enumerate(proofs):
        run(f'live-proof-{i + 1}', f'SELECT ({proof});', 't')
    require(len(proofs) == 6, f'expected 6 @live-proof lines, found {len(proofs)}')

    # ── registry seed and public projection ─────────────────────────────────
    run('seed-ids-and-readiness', "SELECT string_agg(capability_id || '=' || readiness || '@' || rule_version, ',' ORDER BY capability_id) FROM public.platform_capabilities;",
        'cash.fixed_limit.kill_pots=planned@kill-v1,cash.insurance_ev_cashout=deployed@insurance-v1,club.membership_cap=implemented@club-membership-v2,'
        'tournament.discovery.trait_filters=tested@trait-filters-v1,tournament.multi_day.multi_flight=planned@multi-flight-v1,'
        'tournament.multi_day.single_flight=planned@multi-day-v1,variant.ofc=excluded@retired')
    run('seed-history-one-event-per-row', "SELECT count(*) FILTER (WHERE from_readiness IS NULL AND actor_role='migration' AND revision=1) FROM public.platform_capability_events;", '7')
    run('available-only-deployed-or-verified', "SELECT string_agg(c || '=' || public.fn_capability_available(c)::text, ',' ORDER BY c) FROM unnest(ARRAY['cash.insurance_ev_cashout','cash.fixed_limit.kill_pots','club.membership_cap','variant.ofc','no.such_capability']) c;",
        'cash.fixed_limit.kill_pots=false,cash.insurance_ev_cashout=true,club.membership_cap=false,no.such_capability=false,variant.ofc=false')
    for role in ('anon', 'authenticated'):
        probe(f'{role}-reads-public-projection-without-evidence',
              "SELECT jsonb_array_length(p) || '|' || (SELECT string_agg(DISTINCT k, ',' ORDER BY k) FROM jsonb_array_elements(p) e, jsonb_object_keys(e) k) || '|' || (SELECT e->>'readiness' || ':' || (e->>'available') FROM jsonb_array_elements(p) e WHERE e->>'id'='variant.ofc') || '|' || (SELECT e->>'available' FROM jsonb_array_elements(p) e WHERE e->>'id'='cash.insurance_ev_cashout') FROM public.fn_platform_capabilities() p;",
              '7|available,compatibility,id,readiness,scope,title,variants,version|excluded:false|true', role=role)
    probe('projection-variants-for-kill-pots', "SELECT e->'variants' FROM jsonb_array_elements(public.fn_platform_capabilities()) e WHERE e->>'id'='cash.fixed_limit.kill_pots';", '["flh", "flo8"]', role='anon')

    # ── privileges ──────────────────────────────────────────────────────────
    for role in ('anon', 'authenticated'):
        for table in ('platform_capabilities', 'platform_capability_events', 'accepted_event_operations'):
            probe(f'{role}-cannot-select-{table}', f'SELECT count(*) FROM public.{table};', error='42501', role=role, sub=PLAYER)
            probe(f'{role}-cannot-delete-{table}', f'DELETE FROM public.{table};', error='42501', role=role, sub=PLAYER)
        probe(f'{role}-cannot-update-capabilities', "UPDATE public.platform_capabilities SET readiness='deployed';", error='42501', role=role, sub=PLAYER)
        probe(f'{role}-cannot-insert-capability', "INSERT INTO public.platform_capabilities(capability_id,rule_version,title,scope,readiness) VALUES ('x.y','v','X','platform','planned');", error='42501', role=role, sub=PLAYER)
        probe(f'{role}-cannot-insert-history', "INSERT INTO public.platform_capability_events(capability_id,revision,to_readiness,rule_version,actor_role) VALUES ('variant.ofc',9,'deployed','v','forged');", error='42501', role=role, sub=PLAYER)
        probe(f'{role}-cannot-insert-acceptance', f"INSERT INTO public.accepted_event_operations(event_kind,event_id,accepted_at) VALUES ('tournament','{UNKNOWN_T}',now());", error='42501', role=role, sub=PLAYER)
        probe(f'{role}-cannot-read-continuation', f"SELECT public.fn_event_continuation('tournament','{PRE['RUNNING']}');", error='42501', role=role, sub=PLAYER)
    probe('anon-cannot-execute-writer', write('club.membership_cap', 'tested', 'club-membership-v2', 1), error='42501', role='anon')
    probe('anon-cannot-execute-availability', "SELECT public.fn_capability_available('cash.insurance_ev_cashout');", error='42501', role='anon')
    probe('authenticated-reads-availability', "SELECT public.fn_capability_available('cash.insurance_ev_cashout');", 't', role='authenticated', sub=PLAYER)
    probe('authenticated-player-refused-by-writer', write('club.membership_cap', 'tested', 'club-membership-v2', 1), error='CAPABILITY_WRITER_REQUIRES_SERVICE_ROLE_OR_PLATFORM_STAFF', role='authenticated', sub=PLAYER)
    probe('service-role-reads-evidence', "SELECT readiness_evidence ? 'pull_requests' FROM public.platform_capabilities WHERE capability_id='cash.insurance_ev_cashout';", 't', role='service_role')
    probe('service-role-cannot-write-registry-directly', "UPDATE public.platform_capabilities SET readiness='deployed';", error='42501', role='service_role')
    probe('service-role-cannot-write-acceptance-directly', "DELETE FROM public.accepted_event_operations;", error='42501', role='service_role')
    probe('trigger-functions-not-callable', "SELECT has_function_privilege('authenticated','public.fn_tournament_record_acceptance()','EXECUTE') OR has_function_privilege('service_role','public.fn_tournament_record_conclusion()','EXECUTE') OR has_function_privilege('anon','public.fn_platform_capability_events_append_only()','EXECUTE');", 'f')

    # ── readiness writer ────────────────────────────────────────────────────
    before = run('snapshot-before-writer', snapshot)
    probe('writer-refuses-unknown-id', write('no.such_capability', 'tested', 'v1', 1), error='CAPABILITY_UNKNOWN', role='service_role')
    probe('writer-unknown-id-sqlstate', write('no.such_capability', 'tested', 'v1', 1), error='P0002', role='service_role')
    probe('writer-refuses-unknown-readiness', write('club.membership_cap', 'shipped', 'club-membership-v2', 1), error='CAPABILITY_READINESS_UNKNOWN', role='service_role')
    probe('writer-refuses-stale-revision', write('club.membership_cap', 'tested', 'club-membership-v2', 7), error='40001', role='service_role')
    probe('writer-refuses-leaving-excluded', write('variant.ofc', 'planned', 'ofc-v1', 1), error='CAPABILITY_EXCLUSION_IS_AN_OWNER_DECISION', role='service_role')
    probe('writer-refuses-leaving-excluded-even-with-evidence', write('variant.ofc', 'deployed', 'ofc-v1', 1, '{"pr":1}'), error='55000', role='service_role')
    probe('writer-refuses-entering-excluded', write('cash.fixed_limit.kill_pots', 'excluded', 'kill-v1', 1), error='CAPABILITY_EXCLUSION_IS_AN_OWNER_DECISION', role='service_role')
    probe('writer-refuses-deployed-without-evidence', write('club.membership_cap', 'deployed', 'club-membership-v2', 1), error='CAPABILITY_EVIDENCE_REQUIRED', role='service_role')
    probe('writer-refuses-verified-without-evidence', write('cash.insurance_ev_cashout', 'production_verified', 'insurance-v1', 1), error='CAPABILITY_EVIDENCE_REQUIRED', role='service_role')
    probe('writer-refuses-non-object-evidence', write('club.membership_cap', 'deployed', 'club-membership-v2', 1, '[1]'), error='CAPABILITY_EVIDENCE_MUST_BE_AN_OBJECT', role='service_role')
    probe('table-refuses-available-without-evidence-even-for-owner', "UPDATE public.platform_capabilities SET readiness='deployed' WHERE capability_id='club.membership_cap';", error='23514')
    require(run('refusals-changed-nothing', snapshot) == before, 'a refused write changed state')
    ev = '{"installed_migration":"20260923000000_cap","pr":5100}'
    run('writer-deploys-with-evidence',
        'BEGIN;\n' + identity('service_role') + 'SELECT ' + call('club.membership_cap', 'deployed', 'club-membership-v2', 1, ev)
        + " \\g /dev/null\nCOMMIT;\nSELECT readiness || '|' || revision || '|' || (readiness_evidence->>'pr') FROM public.platform_capabilities WHERE capability_id='club.membership_cap';",
        'deployed|2|5100')
    run('writer-event-recorded', "SELECT from_readiness || '>' || to_readiness || '|' || revision || '|' || actor_role || '|' || coalesce(actor::text,'<NULL>') FROM public.platform_capability_events WHERE capability_id='club.membership_cap' ORDER BY id DESC LIMIT 1;",
        'implemented>deployed|2|service_role|<NULL>')
    after_first = run('snapshot-after-first-transition', snapshot)
    probe('writer-replay-is-idempotent', "SELECT (r->>'event_recorded') || '|' || (r->>'revision') FROM " + call('club.membership_cap', 'deployed', 'club-membership-v2', 1, ev) + " r;", 'false|2', role='service_role')
    probe('writer-replay-with-other-evidence-is-stale', write('club.membership_cap', 'deployed', 'club-membership-v2', 1, '{"pr":1}'), error='CAPABILITY_REVISION_STALE', role='service_role')
    probe('writer-same-state-is-not-an-event', "SELECT (r->>'event_recorded') || '|' || (r->>'revision') FROM " + call('club.membership_cap', 'deployed', 'club-membership-v2', 2, ev) + " r;", 'false|2', role='service_role')
    require(run('replays-changed-nothing', snapshot) == after_first, 'a replay changed state')
    probe('writer-platform-staff-may-advance',
          "SELECT (r->>'readiness') || '|' || (r->>'revision') FROM " + call('tournament.discovery.trait_filters', 'deployed', 'trait-filters-v1', 1, '{"pr":5101}') + " r;\n"
          "RESET ROLE;\nSELECT actor_role || ':' || actor FROM public.platform_capability_events WHERE capability_id='tournament.discovery.trait_filters' ORDER BY id DESC LIMIT 1;",
          f'deployed|2\nplatform_admin:{STAFF}', role='authenticated', sub=STAFF)
    probe('writer-may-step-back-without-evidence', "SELECT (r->>'readiness') || '|' || (r->>'readiness_evidence') FROM " + call('club.membership_cap', 'tested', 'club-membership-v2', 2) + " r;", 'tested|{}', role='service_role')
    # Two writers holding the same expected revision: one wins, the other is stale.
    lock_key = 5524
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(run, 'concurrent-first-writer-wins',
                            'BEGIN;\n' + identity('service_role') + 'SELECT ' + call('cash.fixed_limit.kill_pots', 'implemented', 'kill-v1', 1)
                            + f" \\g /dev/null\nRESET ROLE; SELECT pg_advisory_lock({lock_key}) \\g /dev/null\nSELECT pg_sleep(1) \\g /dev/null\nCOMMIT;")
        deadline = time.monotonic() + 10
        while command(cmd, f"SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid={lock_key} AND granted);").stdout.strip() != 't':
            require(time.monotonic() < deadline, 'first writer did not reach its hold point')
            time.sleep(0.02)
        second = pool.submit(probe, 'concurrent-second-writer-is-stale',
                             write('cash.fixed_limit.kill_pots', 'tested', 'kill-v1', 1), None, 'CAPABILITY_REVISION_STALE', 'service_role')
        first.result()
        second.result()
    run('concurrent-final-state', "SELECT readiness || '|' || revision || '|' || (SELECT count(*) FROM public.platform_capability_events WHERE capability_id='cash.fixed_limit.kill_pots') FROM public.platform_capabilities WHERE capability_id='cash.fixed_limit.kill_pots';", 'implemented|2|2')

    # ── history is append-only, for everyone ────────────────────────────────
    run('history-refuses-update-by-owner', "UPDATE public.platform_capability_events SET evidence='{}' WHERE capability_id='club.membership_cap';", error='CAPABILITY_HISTORY_IS_APPEND_ONLY')
    run('history-refuses-delete-by-owner', "DELETE FROM public.platform_capability_events;", error='CAPABILITY_HISTORY_IS_APPEND_ONLY')
    run('history-refuses-truncate-by-owner', "TRUNCATE public.platform_capability_events;", error='CAPABILITY_HISTORY_IS_APPEND_ONLY')
    probe('history-refuses-update-by-service-role', "UPDATE public.platform_capability_events SET evidence='{}';", error='42501', role='service_role')
    run('history-intact', "SELECT count(*) FROM public.platform_capability_events;", '9')

    # ── backfill ────────────────────────────────────────────────────────────
    run('backfill-covers-exactly-non-terminal', "SELECT string_agg(t.status || ':' || (a.event_id IS NOT NULL)::text, ',' ORDER BY t.id) FROM public.tournaments t LEFT JOIN public.accepted_event_operations a ON a.event_kind='tournament' AND a.event_id=t.id;",
        'ANNOUNCED:true,REGISTERING:true,LATE_REG:true,RUNNING:true,COMPLETING:true,COMPLETED:false,CANCELLED:false,REGISTERING:true,REGISTERING:true')
    run('backfill-shape', "SELECT bool_and(a.authorization_basis = '{\"operator_access\":\"legacy_free\",\"recorded_by\":\"install_backfill\"}'::jsonb AND a.capability_versions = '{}'::jsonb AND a.accepted_by IS NULL AND a.accepted_at = t.created_at AND a.club_id = t.club_id AND a.union_id IS NOT DISTINCT FROM t.union_id AND a.parent_event_id IS NOT DISTINCT FROM t.parent_tournament_id AND a.concluded_at IS NULL AND a.continuation = 'through_conclusion') FROM public.accepted_event_operations a JOIN public.tournaments t ON t.id = a.event_id;", 't')
    backfilled = run('snapshot-before-backfill-replay', snapshot)
    run('backfill-is-idempotent', 'BEGIN;\n' + backfill + '\nCOMMIT;\nSELECT count(*) FROM public.accepted_event_operations;', '7')
    require(run('backfill-replay-changed-nothing', snapshot) == backfilled, 'backfill replay changed state')

    # ── acceptance is written with the tournament, and rolls back with it ──
    run('acceptance-same-transaction',
        f"BEGIN;\nINSERT INTO public.tournaments(id,name,club_id,union_id) VALUES ('{NEW_T}','new','{CLUB}','{UNION}') \\g /dev/null\n"
        f"SELECT (a.xmin = t.xmin)::text || '|' || (a.xmin::text = txid_current()::text)::text || '|' || a.capability_versions::text || '|' || (a.authorization_basis->>'operator_access') FROM public.accepted_event_operations a JOIN public.tournaments t ON t.id = a.event_id WHERE a.event_id='{NEW_T}';\nROLLBACK;",
        'true|true|{"club.membership_cap": "club-membership-v2", "cash.insurance_ev_cashout": "insurance-v1"}|legacy_free')
    run('acceptance-rolled-back-with-tournament', f"SELECT (SELECT count(*) FROM public.tournaments WHERE id='{NEW_T}') || '|' || (SELECT count(*) FROM public.accepted_event_operations WHERE event_id='{NEW_T}');", '0|0')
    run('refused-by-existing-guard-leaves-no-acceptance', f"INSERT INTO public.tournaments(id,name) VALUES ('{NEW_T}','refused by an existing guard');", error='existing guard')
    run('guard-refusal-left-nothing', f"SELECT count(*) FROM public.accepted_event_operations WHERE event_id='{NEW_T}';", '0')
    run('failure-to-record-acceptance-fails-the-insert',
        f"BEGIN;\nALTER TABLE public.accepted_event_operations ADD CONSTRAINT fixture_refuse CHECK (club_id IS DISTINCT FROM '{REFUSED_CLUB}');\n"
        f"INSERT INTO public.tournaments(id,name,club_id) VALUES ('{NEW_T}','refused acceptance','{REFUSED_CLUB}');\nCOMMIT;", error='23514')
    run('failed-acceptance-left-no-tournament', f"SELECT (SELECT count(*) FROM public.tournaments WHERE id='{NEW_T}') || '|' || (SELECT count(*) FROM pg_constraint WHERE conname='fixture_refuse');", '0|0')
    probe('authenticated-creator-is-recorded', f"INSERT INTO public.tournaments(id,name,club_id) VALUES ('{NEW_T}','by player','{CLUB}');\nRESET ROLE;\nSELECT accepted_by FROM public.accepted_event_operations WHERE event_id='{NEW_T}';", PLAYER, role='authenticated', sub=PLAYER)
    probe('service-spawn-has-no-creator', f"INSERT INTO public.tournaments(id,name,club_id) VALUES ('{NEW_T}','recurring spawn','{CLUB}');\nRESET ROLE;\nSELECT coalesce(accepted_by::text,'<NULL>') FROM public.accepted_event_operations WHERE event_id='{NEW_T}';", '<NULL>', role='service_role')
    probe('terminal-insert-is-accepted-and-concluded', f"INSERT INTO public.tournaments(id,name,status) VALUES ('{NEW_T}','cancelled at birth','CANCELLED');\nSELECT conclusion || '|' || (concluded_at IS NOT NULL)::text FROM public.accepted_event_operations WHERE event_id='{NEW_T}';", 'cancelled|true')

    # ── conclusion only on COMPLETED or CANCELLED ───────────────────────────
    conclusion = f"SELECT coalesce(conclusion,'<open>') FROM public.accepted_event_operations WHERE event_id='{NEW_T}';"
    run('lifecycle-create', f"INSERT INTO public.tournaments(id,name,club_id) VALUES ('{NEW_T}','lifecycle','{CLUB}');\n" + conclusion, '<open>')
    for st in ('REGISTERING', 'LATE_REG', 'RUNNING', 'COMPLETING'):
        run(f'lifecycle-{st.lower()}-does-not-conclude', f"UPDATE public.tournaments SET status='{st}' WHERE id='{NEW_T}';\n" + conclusion, '<open>')
    run('lifecycle-other-column-does-not-conclude', f"UPDATE public.tournaments SET name='renamed', updated_at=now() WHERE id='{NEW_T}';\n" + conclusion, '<open>')
    run('lifecycle-completed-concludes', f"UPDATE public.tournaments SET status='COMPLETED' WHERE id='{NEW_T}';\n" + f"SELECT conclusion || '|' || (concluded_at IS NOT NULL)::text FROM public.accepted_event_operations WHERE event_id='{NEW_T}';", 'completed|true')
    first_concluded = run('lifecycle-concluded-at', f"SELECT concluded_at FROM public.accepted_event_operations WHERE event_id='{NEW_T}';")
    run('lifecycle-later-status-keeps-first-conclusion', f"UPDATE public.tournaments SET status='CANCELLED' WHERE id='{NEW_T}';\nSELECT conclusion || '|' || (concluded_at = '{first_concluded}')::text FROM public.accepted_event_operations WHERE event_id='{NEW_T}';", 'completed|true')
    run('lifecycle-cancelled-concludes', f"UPDATE public.tournaments SET status='CANCELLED' WHERE id='{PRE['ANNOUNCED']}';\nSELECT conclusion FROM public.accepted_event_operations WHERE event_id='{PRE['ANNOUNCED']}';", 'cancelled')
    run('existing-status-trigger-still-fires', "SELECT count(*) FROM public.fixture_status_log;", '7')

    # ── continuation, inherited through parent_event_id ─────────────────────
    def cont(tid):
        return f"SELECT (c->>'accepted') || '|' || (c->>'continuation_active') || '|' || coalesce(c->>'continuation_via','<none>') FROM public.fn_event_continuation('tournament','{tid}') c;"
    probe('continuation-active-event', cont(PRE['RUNNING']), f"true|true|{PRE['RUNNING']}", role='service_role')
    probe('continuation-concluded-event', cont(NEW_T), 'true|false|<none>', role='service_role')
    probe('continuation-unknown-event', cont(UNKNOWN_T), 'false|false|<none>', role='service_role')
    probe('continuation-never-accepted-terminal-event', cont(PRE['COMPLETED']), 'false|false|<none>', role='service_role')
    probe('continuation-unknown-kind', f"SELECT (c->>'accepted') || '|' || (c->>'continuation_active') FROM public.fn_event_continuation('cash_session','{PRE['RUNNING']}') c;", 'false|false', role='service_role')
    probe('continuation-shape', f"SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(public.fn_event_continuation('tournament','{PRE['RUNNING']}')) k;",
          'accepted,accepted_at,capability_versions,club_id,concluded_at,conclusion,continuation_active,continuation_via,parent_event_id,union_id', role='service_role')
    run('flight-inherits-from-running-parent',
        f"UPDATE public.tournaments SET status='COMPLETED' WHERE id='{FLIGHT_OF_RUNNING}';\n" + cont(FLIGHT_OF_RUNNING), f"true|true|{PRE['RUNNING']}")
    run('flight-of-unaccepted-parent-has-only-its-own', cont(FLIGHT_OF_COMPLETED), f"true|true|{FLIGHT_OF_COMPLETED}")
    run('parent-and-child-through-triggers',
        f"INSERT INTO public.tournaments(id,name,club_id) VALUES ('{PARENT_T}','parent','{CLUB}');\n"
        f"INSERT INTO public.tournaments(id,name,club_id,parent_tournament_id) VALUES ('{CHILD_T}','day 1a','{CLUB}','{PARENT_T}');\n"
        f"UPDATE public.tournaments SET status='COMPLETED' WHERE id='{CHILD_T}';\n"
        f"SELECT parent_event_id FROM public.accepted_event_operations WHERE event_id='{CHILD_T}';", PARENT_T)
    run('concluded-flight-continues-while-parent-is-open', cont(CHILD_T), f"true|true|{PARENT_T}")
    run('parent-conclusion-ends-the-flight', f"UPDATE public.tournaments SET status='CANCELLED' WHERE id='{PARENT_T}';\n" + cont(CHILD_T), 'true|false|<none>')
    probe('continuation-terminates-on-a-cycle',
          f"UPDATE public.accepted_event_operations SET parent_event_id='{CHILD_T}' WHERE event_id='{PARENT_T}';\n" + cont(CHILD_T), 'true|false|<none>')

    run('final-live-proofs', 'SELECT ' + ' AND '.join(f'({p})' for p in proofs) + ';', 't')
    results['passed'] = True
finally:
    if (cluster / 'data/postmaster.pid').exists():
        r = command([pg / 'pg_ctl', '-D', cluster / 'data', '-m', 'fast', '-w', 'stop'])
        require(r.returncode == 0, 'Could not stop owned cluster: ' + r.stderr)
    if (cluster / 'server.log').exists():
        shutil.copyfile(cluster / 'server.log', out / 'server.log')
    require(not (cluster / 'data/postmaster.pid').exists(), 'Owned cluster still running')
    shutil.rmtree(cluster)
    results['ownedClusterRemoved'] = not cluster.exists()
    (out / 'RESULTS.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps({'passed': results['passed'], 'cases': len(results['cases']), 'evidence': str(out)}))
