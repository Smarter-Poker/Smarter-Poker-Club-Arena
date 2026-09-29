#!/usr/bin/env python3
"""A member's club status is changed only by the server.

Owned-cluster proof for
supabase/migrations/20260924045900_member_status_is_changed_only_by_the_server.sql.

The fixture is minimal tables plus FAITHFUL copies of the guards and server
paths that touch club_members.status, read at run time from the files that
carry them, never retyped:

  * supabase/migrations/20260906091646_...: fn_guard_membership_lifecycle_write,
    fn_remove_settled_club_member (departure), fn_join_club (join and rejoin);
  * scripts/ci/fixtures/mtt-unlimited/accounting-schema.sql (production dump
    of 2026-09-18): is_club_admin, fn_club_role_rank, fn_membership_approval_gate,
    fn_club_members_role_guard, fn_enforce_four_club_limit,
    fn_audit_club_member_change, fn_audit_actor_role,
    lock_club_cashier_hierarchy_mutation;
  * the BBJ replay historical production dump: fn_join_club_membership_impl,
    fn_review_join_request (pending -> active by staff).

The RLS policy club_members_update and the browser column grant on status are
the production ones given in the migration header. First the defect is
reproduced (a suspended member reactivates themselves), then the real
migration file is applied and every case below is asserted.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/member-status-server-owned')
args = parser.parse_args()
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=False)
pg = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
env['LC_ALL'] = 'C'
port = '55693'
cluster = Path(tempfile.mkdtemp(prefix='member-status-', dir='/tmp'))
socket = cluster / 'socket'
socket.mkdir(mode=0o700)
cmd = [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
       '-h', str(socket), '-p', port, '-U', 'postgres', '-d', 'postgres']
results = {'scope': 'club_members.status writers, guard and RPC; not money or lifecycle rules',
           'cases': [], 'passed': False}

MIGRATION = ROOT / 'supabase/migrations/20260924045900_member_status_is_changed_only_by_the_server.sql'
LIFECYCLE = ROOT / 'supabase/migrations/20260906091646_cashier_requests_and_membership_deletes_are_server_owned.sql'
DUMP = ROOT / 'scripts/ci/fixtures/mtt-unlimited/accounting-schema.sql'
HISTORY = ROOT / 'scripts/ci/probes/bbj-bank-replay/funded/source/internal-ledger-native-fixture-0006/build/10-historical-schema.sql'

OPEN = '10000000-0000-4000-8000-00000000000a'    # requires_approval = false
GATED = '10000000-0000-4000-8000-00000000000b'   # requires_approval = true
OWNER = '00000000-0000-4000-8000-000000000001'
ADMIN = '00000000-0000-4000-8000-000000000002'
COOWNER = '00000000-0000-4000-8000-000000000003'
PLAYER = '00000000-0000-4000-8000-000000000004'
SUSPENDED = '00000000-0000-4000-8000-000000000005'
OUTSIDER = '00000000-0000-4000-8000-000000000006'
PLATFORM = '00000000-0000-4000-8000-000000000007'
ADMIN2 = '00000000-0000-4000-8000-000000000008'
PENDING = '00000000-0000-4000-8000-000000000009'
BANNED = '00000000-0000-4000-8000-000000000010'
# The guard's own refusal, so an RLS 42501 cannot pass for it.
GUARD = '42501: club_members.status must be changed through fn_club_set_member_status'


def command(argv, sql=None):
    return subprocess.run([str(a) for a in argv], input=sql, text=True, capture_output=True, env=env, timeout=60)


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def extract(path, start, end):
    """One exact definition, from its CREATE line to its closing dollar tag."""
    text = path.read_text()
    i = text.find(start)
    require(i >= 0 and text.find(start, i + 1) < 0, f'{path.name}: expected exactly one {start!r}')
    j = text.find(end, i)
    require(j > i, f'{path.name}: no end for {start!r}')
    return text[i:j + len(end)] + '\n'


def run(name, sql, expected=None, error=None):
    r = command(cmd, sql)
    (out / (name + '.log')).write_text(r.stdout + r.stderr)
    passed = (r.returncode != 0 and error in r.stderr) if error else r.returncode == 0
    if expected is not None:
        passed = passed and r.stdout.rstrip('\n') == expected
    results['cases'].append({'name': name, 'passed': passed, 'expectedError': error})
    require(passed, name + ': ' + r.stdout[-800:] + r.stderr[-1500:])
    return r.stdout.rstrip('\n')


def probe(name, body, expected=None, error=None):
    return run(name, 'BEGIN;\n' + body + '\nROLLBACK;', expected, error)


def who(uid, role='authenticated'):
    """Become a PostgREST caller: the role, and the JWT claims auth.uid() reads."""
    claims = json.dumps({'sub': uid, 'role': role}) if uid else json.dumps({'role': role})
    return f"RESET ROLE; SET LOCAL request.jwt.claims = '{claims}'; SET LOCAL ROLE {role};\n"


def rpc(club, user, status, reason=None, field="coalesce(r->>'error', r->>'new_status')"):
    reason_sql = 'NULL' if reason is None else "'" + reason.replace("'", "''") + "'"
    return (f"SELECT {field} FROM (SELECT public.fn_club_set_member_status("
            f"'{club}','{user}','{status}',{reason_sql}) r) x;")


def status_of(club, user):
    return f"RESET ROLE; SELECT status FROM club_members WHERE club_id='{club}' AND user_id='{user}';"


FIXTURE = r"""
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text $$;
-- Supabase gives every new public function to the browser roles by default,
-- which is what the migration's REVOKE has to undo.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;

CREATE TABLE profiles (id uuid PRIMARY KEY, is_admin boolean DEFAULT false, is_horse boolean DEFAULT false);
CREATE TABLE clubs (
  id uuid PRIMARY KEY, name text, owner_id uuid, requires_approval boolean DEFAULT false,
  asset text DEFAULT 'chips', is_union boolean DEFAULT false, member_count integer DEFAULT 0,
  lifecycle_status text NOT NULL DEFAULT 'active', updated_at timestamptz);
CREATE TABLE club_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES clubs(id), user_id uuid NOT NULL,
  role text CHECK (role IN ('owner','co_owner','admin','super_agent','agent','sub_agent','player')),
  status text DEFAULT 'active', agent_id uuid, parent_agent_id uuid, invited_by uuid,
  tier text, rank_level integer, orange_ball_status text,
  chip_balance numeric(20,2) NOT NULL DEFAULT 0, held_chips numeric DEFAULT 0,
  locked_chips integer DEFAULT 0, promo_balance numeric(14,2) DEFAULT 0,
  credit_limit numeric(15,2) DEFAULT 0, credit_used numeric(15,2) DEFAULT 0,
  diamonds integer NOT NULL DEFAULT 0, is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  membership_lifecycle_status text NOT NULL DEFAULT 'active'
    CHECK (membership_lifecycle_status IN ('active','departed')),
  departed_at timestamptz, departed_by uuid, departure_reason text,
  UNIQUE (club_id, user_id));
CREATE TABLE audit_trail (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid NOT NULL, actor_role text NOT NULL
    CHECK (actor_role IN ('owner','co_owner','admin','super_agent','agent','sub_agent','player',
                          'host','union_admin','platform_admin','system')),
  action text NOT NULL, target_type text NOT NULL, target_id uuid, club_id uuid, agent_id uuid,
  amount numeric(20,4), currency text DEFAULT 'CHIPS', before_state jsonb, after_state jsonb,
  reason text, created_at timestamptz NOT NULL DEFAULT now());
-- What fn_remove_settled_club_member reads before a departure. Empty here.
CREATE TABLE agents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_id uuid, user_id uuid);
CREATE TABLE tables (id uuid PRIMARY KEY, club_id uuid);
CREATE TABLE table_seats (id uuid PRIMARY KEY, table_id uuid, user_id uuid, left_at timestamptz);
CREATE TABLE tournaments (id uuid PRIMARY KEY, club_id uuid);
CREATE TABLE tournament_players (id uuid PRIMARY KEY, tournament_id uuid, user_id uuid, status text);
CREATE TABLE cashout_requests (id uuid PRIMARY KEY, club_id uuid, player_id uuid, agent_id uuid, status text);
CREATE TABLE chip_escrow (id uuid PRIMARY KEY, cashout_request_id uuid, player_id uuid, released_at timestamptz);
CREATE TABLE chip_escrow_holds (id uuid PRIMARY KEY, club_id uuid, user_id uuid, status text);
CREATE TABLE tournament_tickets (id uuid PRIMARY KEY, club_id uuid, holder_id uuid, status text);
CREATE TABLE chip_requests (id uuid PRIMARY KEY, club_id uuid, requester_id uuid, approver_id uuid, status text);
-- Production register of reviewed triggers on money tables (2026-09-18 dump).
CREATE TABLE ca_declared_money_triggers (table_name text NOT NULL, trigger_name text NOT NULL,
  declared_at timestamptz NOT NULL DEFAULT now(), note text, PRIMARY KEY (table_name, trigger_name));
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated;
-- Production: authenticated holds column UPDATE on status and most columns.
GRANT UPDATE (status, role, updated_at, agent_id, credit_limit, credit_used) ON club_members TO authenticated;

"""

TRIGGERS = r"""
ALTER TABLE club_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY club_members_select ON club_members FOR SELECT USING (true);
CREATE POLICY club_members_update ON club_members FOR UPDATE
  USING (user_id = auth.uid() OR is_club_admin(club_id, auth.uid()))
  WITH CHECK (is_club_admin(club_id, auth.uid())
              OR (user_id = auth.uid() AND role IN ('member','player') AND credit_limit = 0
                  AND credit_used = 0 AND agent_id IS NULL AND parent_agent_id IS NULL));
CREATE TRIGGER lock_cashier_hierarchy_update BEFORE UPDATE OF club_id, agent_id, role, status ON club_members FOR EACH ROW EXECUTE FUNCTION lock_club_cashier_hierarchy_mutation();
CREATE TRIGGER trg_approval_gate_ins BEFORE INSERT ON club_members FOR EACH ROW EXECUTE FUNCTION fn_membership_approval_gate();
CREATE TRIGGER trg_approval_gate_upd BEFORE UPDATE OF status ON club_members FOR EACH ROW EXECUTE FUNCTION fn_membership_approval_gate();
CREATE TRIGGER trg_audit_club_member_update AFTER UPDATE OF role, status ON club_members FOR EACH ROW EXECUTE FUNCTION fn_audit_club_member_change();
CREATE TRIGGER trg_club_members_guard_lifecycle_write BEFORE UPDATE ON club_members FOR EACH ROW EXECUTE FUNCTION fn_guard_membership_lifecycle_write();
CREATE TRIGGER trg_club_members_role_guard BEFORE UPDATE ON club_members FOR EACH ROW EXECUTE FUNCTION fn_club_members_role_guard();
CREATE TRIGGER trg_four_club_limit_ins BEFORE INSERT ON club_members FOR EACH ROW EXECUTE FUNCTION fn_enforce_four_club_limit();
CREATE TRIGGER trg_four_club_limit_upd BEFORE UPDATE OF status ON club_members FOR EACH ROW EXECUTE FUNCTION fn_enforce_four_club_limit();
"""

SEED = f"""
INSERT INTO profiles (id, is_admin) VALUES
  ('{OWNER}',false),('{ADMIN}',false),('{COOWNER}',false),('{PLAYER}',false),('{SUSPENDED}',false),
  ('{OUTSIDER}',false),('{PLATFORM}',true),('{ADMIN2}',false),('{PENDING}',false),('{BANNED}',false);
INSERT INTO clubs (id, name, owner_id, requires_approval) VALUES
  ('{OPEN}','Open Club','{OWNER}',false), ('{GATED}','Gated Club','{OWNER}',true);
INSERT INTO club_members (club_id, user_id, role, status) VALUES
  ('{OPEN}','{OWNER}','owner','active'), ('{OPEN}','{COOWNER}','co_owner','active'),
  ('{OPEN}','{ADMIN}','admin','active'), ('{OPEN}','{ADMIN2}','admin','active'),
  ('{OPEN}','{PLAYER}','player','active'), ('{OPEN}','{SUSPENDED}','player','suspended'),
  ('{OPEN}','{BANNED}','player','banned'),
  ('{GATED}','{OWNER}','owner','active'), ('{GATED}','{ADMIN}','admin','active'),
  ('{GATED}','{PENDING}','player','pending');
"""

snapshot = ("SELECT md5(coalesce((SELECT string_agg(to_jsonb(m)::text, ',' ORDER BY club_id, user_id) FROM club_members m),'')"
            " || coalesce((SELECT string_agg(to_jsonb(a)::text, ',' ORDER BY id) FROM audit_trail a),''));")

try:
    version = command([pg / 'postgres', '--version']).stdout.strip()
    results['postgres'] = version
    require(re.search(r'PostgreSQL\) 1[6-9]\.', version), 'PostgreSQL 16 or newer required: ' + version)
    r = command([pg / 'initdb', '-D', cluster / 'data', '-U', 'postgres', '--auth-local=trust',
                 '--auth-host=reject', '--no-locale', '--encoding=UTF8'])
    require(r.returncode == 0, r.stderr)
    with (cluster / 'data/postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='" + str(socket) + "'\n"
                "unix_socket_permissions=0700\nport=" + port + "\nshared_buffers='16MB'\nmax_connections=10\n")
    r = command([pg / 'pg_ctl', '-D', cluster / 'data', '-l', cluster / 'server.log', '-w', 'start'])
    require(r.returncode == 0, r.stderr)

    functions = ''.join([
        extract(DUMP, 'CREATE OR REPLACE FUNCTION public.is_club_admin(p_club_id uuid, p_user_id uuid)', '$function$;'),
        extract(DUMP, 'CREATE OR REPLACE FUNCTION public.fn_club_role_rank(', '$function$;'),
        extract(DUMP, 'CREATE OR REPLACE FUNCTION public.fn_membership_approval_gate(', '$function$;'),
        extract(DUMP, 'CREATE OR REPLACE FUNCTION public.fn_club_members_role_guard(', '$function$;'),
        extract(DUMP, 'CREATE OR REPLACE FUNCTION public.fn_enforce_four_club_limit(', '$function$;'),
        extract(DUMP, 'CREATE OR REPLACE FUNCTION public.fn_audit_actor_role(', '$function$;'),
        extract(DUMP, 'CREATE OR REPLACE FUNCTION public.fn_audit_club_member_change(', '$function$;'),
        extract(DUMP, 'CREATE OR REPLACE FUNCTION public.lock_club_cashier_hierarchy_mutation(', '$function$;'),
        extract(LIFECYCLE, 'CREATE OR REPLACE FUNCTION public.fn_guard_membership_lifecycle_write(', '$function$;'),
        extract(LIFECYCLE, 'CREATE OR REPLACE FUNCTION public.fn_remove_settled_club_member(', '$function$;'),
        extract(HISTORY, 'CREATE FUNCTION public.fn_join_club_membership_impl(', '\n$$;'),
        extract(HISTORY, 'CREATE FUNCTION public.fn_review_join_request(', '\n$$;'),
        extract(LIFECYCLE, 'CREATE OR REPLACE FUNCTION public.fn_join_club(', '$function$;'),
    ])
    run('fixture', FIXTURE + functions + TRIGGERS + SEED)

    # ---- The defect, reproduced before the migration --------------------------------
    probe('baseline-suspended-member-reactivates-self',
          who(SUSPENDED) + f"UPDATE club_members SET status='active' WHERE club_id='{OPEN}' AND user_id='{SUSPENDED}' RETURNING status;",
          'active')
    probe('baseline-banned-member-unbans-self',
          who(BANNED) + f"UPDATE club_members SET status='active' WHERE club_id='{OPEN}' AND user_id='{BANNED}' RETURNING status;",
          'active')
    before = run('snapshot-before', snapshot)

    # ---- Install, and refuse a second install ---------------------------------------
    run('install', MIGRATION.read_text())
    require(run('install-leaves-data-alone', snapshot) == before, 'The migration rewrote membership or audit rows')
    run('reapply-refused', MIGRATION.read_text(), error='refusing to re-apply')
    run('reapply-left-one-guard',
        "SELECT count(*) FROM pg_trigger WHERE tgrelid='club_members'::regclass AND tgname='trg_club_members_status_guard';", '1')
    run('guard-declared-as-a-money-trigger',
        "SELECT count(*) FROM ca_declared_money_triggers WHERE table_name='club_members' AND trigger_name='trg_club_members_status_guard' AND length(note) > 40;", '1')

    # ---- The browser can no longer write status ---------------------------------------
    probe('suspended-member-cannot-reactivate-self',
          who(SUSPENDED) + f"UPDATE club_members SET status='active' WHERE club_id='{OPEN}' AND user_id='{SUSPENDED}';",
          error=GUARD)
    probe('banned-member-cannot-unban-self',
          who(BANNED) + f"UPDATE club_members SET status='active' WHERE club_id='{OPEN}' AND user_id='{BANNED}';",
          error=GUARD)
    probe('suspended-member-cannot-reactivate-self-through-the-rpc',
          who(SUSPENDED) + rpc(OPEN, SUSPENDED, 'active'),
          'You Cannot Change Your Own Membership Status')
    probe('pending-member-cannot-self-approve-in-a-gated-club',
          who(PENDING) + f"UPDATE club_members SET status='active' WHERE club_id='{GATED}' AND user_id='{PENDING}';",
          error='23514: This club requires owner approval')
    probe('staff-direct-browser-write-is-refused-too',
          who(ADMIN) + f"UPDATE club_members SET status='suspended' WHERE club_id='{OPEN}' AND user_id='{PLAYER}';",
          error=GUARD)
    probe('a-non-status-self-update-still-works',
          who(PLAYER) + f"UPDATE club_members SET updated_at=now() WHERE club_id='{OPEN}' AND user_id='{PLAYER}' RETURNING status;",
          'active')

    # ---- Staff suspend, ban and reinstate through the RPC, with a receipt -------------
    probe('admin-suspends-and-reinstates-with-audit',
          who(ADMIN) + rpc(OPEN, PLAYER, 'suspended', 'Chip Dumping Review') + '\n'
          + status_of(OPEN, PLAYER) + '\n'
          + who(ADMIN) + rpc(OPEN, PLAYER, 'active') + '\n'
          + status_of(OPEN, PLAYER) + '\n'
          + f"SELECT string_agg(actor_role || ':' || action || ':' || (before_state->>'status') || '>' || (after_state->>'status') || ':' || coalesce(reason,'-'), ' | ' ORDER BY action DESC, before_state->>'status') "
            f"FROM audit_trail WHERE club_id='{OPEN}' AND target_id='{PLAYER}';",
          'suspended\nsuspended\nactive\nactive\n'
          'admin:set_member_status:active>suspended:Chip Dumping Review | admin:set_member_status:suspended>active:No Reason Given | '
          'admin:member_status_change:active>suspended:- | admin:member_status_change:suspended>active:-')
    probe('the-rpc-returns-its-audit-row-as-the-receipt',
          who(ADMIN) + f"SELECT public.fn_club_set_member_status('{OPEN}','{PLAYER}','banned','Collusion')->>'audit_id' AS aid \\gset\n"
          + "RESET ROLE; SELECT action || ':' || reason FROM audit_trail WHERE id = :'aid';",
          'set_member_status:Collusion')
    probe('a-member-suspended-by-staff-stays-suspended',
          who(ADMIN) + rpc(OPEN, PLAYER, 'suspended') + '\n'
          + who(PLAYER) + f"UPDATE club_members SET status='active' WHERE club_id='{OPEN}' AND user_id='{PLAYER}';",
          error=GUARD)
    probe('the-rpc-setting-does-not-outlive-its-own-update',
          who(ADMIN) + rpc(OPEN, PLAYER, 'suspended') + '\n'
          + f"UPDATE club_members SET status='active' WHERE club_id='{OPEN}' AND user_id='{SUSPENDED}';",
          error=GUARD)
    probe('admin-reinstates-a-suspended-member',
          who(ADMIN) + rpc(OPEN, SUSPENDED, 'active', 'Review Cleared'), 'active')
    probe('admin-unbans-a-banned-member',
          who(ADMIN) + rpc(OPEN, BANNED, 'active'), 'active')
    probe('owner-suspends-an-admin',
          who(OWNER) + rpc(OPEN, ADMIN, 'suspended'), 'suspended')
    probe('owner-suspends-and-reinstates-staff-in-an-approval-club',
          who(OWNER) + rpc(GATED, ADMIN, 'suspended') + '\n' + who(OWNER) + rpc(GATED, ADMIN, 'active'),
          'suspended\nactive')
    probe('platform-admin-suspends-with-its-own-role-on-the-receipt',
          who(PLATFORM) + rpc(OPEN, PLAYER, 'suspended') + '\n'
          + f"RESET ROLE; SELECT actor_role FROM audit_trail WHERE action='set_member_status' AND target_id='{PLAYER}';",
          'suspended\nplatform_admin')
    probe('the-same-status-twice-is-unchanged-not-an-error',
          who(ADMIN) + rpc(OPEN, SUSPENDED, 'suspended', field="(r->>'success') || ':' || (r->>'unchanged')"),
          'true:true')

    # ---- Refusals ------------------------------------------------------------------
    probe('player-cannot-call-the-rpc-on-another-member',
          who(PLAYER) + rpc(OPEN, SUSPENDED, 'active') + '\n' + status_of(OPEN, SUSPENDED),
          'Only Club Staff Can Suspend, Ban Or Reinstate A Member\nsuspended')
    probe('outsider-cannot-call-the-rpc',
          who(OUTSIDER) + rpc(OPEN, PLAYER, 'suspended'),
          'Only Club Staff Can Suspend, Ban Or Reinstate A Member')
    for actor, label in ((ADMIN, 'admin'), (COOWNER, 'co-owner'), (PLATFORM, 'platform-admin')):
        probe(f'{label}-cannot-suspend-the-owner', who(actor) + rpc(OPEN, OWNER, 'suspended'),
              "The Club Owner's Membership Cannot Be Suspended Or Banned")
    probe('admin-cannot-suspend-a-co-owner', who(ADMIN) + rpc(OPEN, COOWNER, 'suspended'),
          'Staff Can Only Change The Status Of Members Ranked Below Them')
    probe('admin-cannot-suspend-another-admin', who(ADMIN) + rpc(OPEN, ADMIN2, 'banned'),
          'Staff Can Only Change The Status Of Members Ranked Below Them')
    probe('only-active-suspended-or-banned-can-be-set', who(ADMIN) + rpc(OPEN, PLAYER, 'left'),
          'A Member Can Only Be Set Active, Suspended Or Banned')
    probe('a-pending-request-is-reviewed-not-reinstated', who(ADMIN) + rpc(GATED, PENDING, 'active'),
          'Approve Or Deny This Join Request Instead')
    probe('anon-cannot-execute-the-rpc', who(None, 'anon') + rpc(OPEN, PLAYER, 'suspended'), error='42501: permission denied for function fn_club_set_member_status')
    run('rpc-grants-are-authenticated-only',
        "SELECT has_function_privilege('authenticated', p, 'EXECUTE')::text || has_function_privilege('anon', p, 'EXECUTE')::text"
        " || has_function_privilege('service_role', p, 'EXECUTE')::text"
        " FROM (SELECT 'public.fn_club_set_member_status(uuid,uuid,text,text)'::regprocedure p) x;",
        'truefalsefalse')

    # ---- Every legitimate server path still works ---------------------------------------
    probe('join-an-open-club-is-active',
          who(OUTSIDER) + f"SELECT public.fn_join_club('{OPEN}')->>'status';", 'active')
    probe('join-a-gated-club-is-pending-then-staff-approval-activates',
          who(OUTSIDER) + f"SELECT public.fn_join_club('{GATED}')->>'status';\n"
          + who(ADMIN) + f"SELECT public.fn_review_join_request('{GATED}','{OUTSIDER}',true)->>'success';\n"
          + status_of(GATED, OUTSIDER),
          'pending\ntrue\nactive')
    probe('staff-approve-an-existing-pending-request',
          who(ADMIN) + f"SELECT public.fn_review_join_request('{GATED}','{PENDING}',true)->>'success';\n"
          + status_of(GATED, PENDING), 'true\nactive')
    probe('departure-then-rejoin',
          who(ADMIN) + f"SELECT public.fn_remove_settled_club_member('{OPEN}','{PLAYER}')->>'success';\n"
          + f"RESET ROLE; SELECT status || ':' || membership_lifecycle_status FROM club_members WHERE club_id='{OPEN}' AND user_id='{PLAYER}';\n"
          + who(ADMIN) + rpc(OPEN, PLAYER, 'active') + '\n'
          + who(PLAYER) + f"SELECT (r->>'status') || ':' || (r->>'membership_lifecycle_status') FROM (SELECT public.fn_join_club('{OPEN}') r) x;",
          'true\nsuspended:departed\nThis Member Has Left The Club And Must Rejoin First\nactive:active')
    probe('service-role-writes-status-directly',
          who(None, 'service_role') + f"UPDATE club_members SET status='banned' WHERE club_id='{OPEN}' AND user_id='{PLAYER}' RETURNING status;",
          'banned')
    probe('postgres-writes-status-directly',
          f"UPDATE club_members SET status='suspended' WHERE club_id='{OPEN}' AND user_id='{PLAYER}' RETURNING status;",
          'suspended')

    require(run('all-probes-rolled-back', snapshot) == before, 'A rolled back probe leaked data')
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
    print(json.dumps({'passed': results['passed'], 'cases': len(results['cases'])}))
