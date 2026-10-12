#!/usr/bin/env python3
"""Qualify 20261012112707_the_union_owner_is_a_member_of_every_club on a
private PostgreSQL 17 cluster (127.0.0.1, a free port in 55900-55949, trust
auth, a temporary data directory under $TMPDIR). Nothing here reaches
production.

Dan, 2026-10-12: "union owner MUST BE A MEMBER OF EVERY CLUB THAT JOINS."

The two functions the migration replaces are rebuilt from main's own
migrations exactly as production holds them, each checked against the
definition md5 production reports:
  fn_require_explicit_club_membership_source  20260901090000      3c4e9aa5...
  fn_enforce_four_club_limit                  20260908125235, then
                                              20260922153234's edit 6df4cf34...
The tables, the removal doors and the staff gates are stand-ins with
production's live bodies (tests/fixtures/union-owner-membership-db/fixture.sql).

FAIL BEFORE: a club joins a union and the union owner is not a member; a
union owner banned in a club joins anyway; the club can remove, ban, suspend or
let the owner leave while the club is in the union; a change of union owner
leaves the new owner outside the clubs. PASS AFTER: every join path (approval or
direct add, a founding club, a reassignment, a re-join after leaving, a pending
row, an owner at the 10-club cap) leaves the owner an active member, as an
ordinary player when there was no row; an existing owner or player row is kept;
the guard refuses every removal door while the club is in the union and allows
it after the club leaves; a transfer adds the new owner; a banned or suspended
owner refuses the join; no chips, ledger rows or staff powers follow; the
backfill creates and activates exactly what was missing. A drifted gate, a
banned owner already in a union, a rolled-back run and a browser role each
install nothing, and a re-run changes nothing.
"""
import hashlib
import os
import re
import shutil
import socket
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIGS = ROOT / "supabase/migrations"
MIG = MIGS / "20261012112707_the_union_owner_is_a_member_of_every_club.sql"
FIXTURE = ROOT / "tests/fixtures/union-owner-membership-db/fixture.sql"
PG = Path(os.environ.get("PG_BIN") or next((p for p in ("/usr/lib/postgresql/17/bin", "/opt/homebrew/opt/postgresql@17/bin")
                                            if (Path(p) / "initdb").exists()), "/usr/lib/postgresql/17/bin"))
SOURCE_SIG = "public.fn_require_explicit_club_membership_source()"
CAP_SIG = "public.fn_enforce_four_club_limit()"
LIVE_SOURCE_DEF = "3c4e9aa515a8b8c8226fdf18332156a3"
LIVE_SOURCE_SRC = "6a71248fcfe2288300d268be68272244"
LIVE_CAP_DEF = "6df4cf3478e10b3f108357567c25c98b"
LIVE_CAP_SRC = "bb5c6b8a337c465a90cee58c2efcc496"
ENV = {"PATH": f"{PG}:/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}

MIGRATION = MIG.read_text()
POST_SOURCE = re.search(r"^-- @live-proof: \(SELECT md5\(pg_get_functiondef\('" + re.escape(SOURCE_SIG) + r"'::regprocedure\)\) = '([0-9a-f]{32})'\)$",
                        MIGRATION, re.M).group(1)
POST_CAP = re.search(r"^-- @live-proof: \(SELECT md5\(pg_get_functiondef\('" + re.escape(CAP_SIG) + r"'::regprocedure\)\) = '([0-9a-f]{32})'\)$",
                     MIGRATION, re.M).group(1)
PROOFS = [m.group(1).strip() for m in re.finditer(r"^-- @live-proof: (.+)$", MIGRATION, re.M)]
FIXTURE_SQL = FIXTURE.read_text()


def md5(s):
    return hashlib.md5(s.encode()).hexdigest()


def rebuild_source_gate():
    """fn_require_explicit_club_membership_source, as 20260901090000 wrote it."""
    a = (MIGS / "20260901090000_club_card_human_realtime_stats.sql").read_text()
    i = a.index(f"CREATE OR REPLACE FUNCTION {SOURCE_SIG}")
    j = a.index("$function$;", a.index("AS $function$", i)) + len("$function$;")
    return a[i:j] + "\n" + (
        f"REVOKE ALL ON FUNCTION {SOURCE_SIG} FROM PUBLIC, anon, authenticated;\n"   # 20260901232323
        f"GRANT EXECUTE ON FUNCTION {SOURCE_SIG} TO service_role;\n")


def rebuild_cap_first():
    """fn_enforce_four_club_limit, as 20260908125235 wrote it (20260922153234 edits it in place)."""
    a = (MIGS / "20260908125235_a_player_may_belong_to_ten_clubs.sql").read_text()
    i = a.index(f"CREATE OR REPLACE FUNCTION {CAP_SIG}")
    j = a.index("$fn$;", a.index("AS $fn$", i)) + len("$fn$;")
    return a[i:j] + "\n" + (
        f"REVOKE ALL ON FUNCTION {CAP_SIG} FROM PUBLIC, anon, authenticated;\n"
        f"GRANT EXECUTE ON FUNCTION {CAP_SIG} TO service_role;\n")


def cap_edit():
    """20260922153234's exact substitution over the trigger."""
    b = (MIGS / "20260922153234_one_club_membership_cap_one_count_one_lock.sql").read_text()
    old = re.search(r"\$trg_old\$(.*?)\$trg_old\$", b, re.S).group(1)
    new = re.search(r"\$trg_new\$(.*?)\$trg_new\$", b, re.S).group(1)
    return old, new


SOURCE_GATE = rebuild_source_gate()
CAP_FIRST = rebuild_cap_first()
CAP_OLD, CAP_NEW = cap_edit()
GATE_TRIGGERS = """
CREATE TRIGGER trg_club_members_require_explicit_join BEFORE INSERT ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_require_explicit_club_membership_source();
CREATE TRIGGER trg_four_club_limit_ins BEFORE INSERT ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_four_club_limit();
CREATE TRIGGER trg_four_club_limit_upd BEFORE UPDATE OF status ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_four_club_limit();
"""

with socket.socket() as probe_socket:
    PORT = None
    for candidate in range(55900, 55950):
        try:
            probe_socket.bind(("127.0.0.1", candidate))
            PORT = candidate
            break
        except OSError:
            continue
assert PORT, "no free port in 55900-55949"
cluster = Path(tempfile.mkdtemp(prefix="union-owner-db-", dir=os.environ.get("TMPDIR")))
data = cluster / "data"
started = False


def psql(db, user="postgres"):
    return [str(PG / "psql"), "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", str(PORT), "-U", user, "-d", db]


def run(argv, text=None, expect_fail=None):
    p = subprocess.run([str(a) for a in argv], input=text, capture_output=True, text=True, env=ENV, timeout=300)
    if expect_fail is not None:
        if p.returncode == 0 or expect_fail not in p.stderr:
            raise AssertionError(f"expected failure containing {expect_fail!r}\n{p.stdout}\n{p.stderr[-3000:]}")
        return p
    if p.returncode:
        raise RuntimeError(p.stdout[-3000:] + p.stderr[-3000:])
    return p


def q(db, sql, user="postgres"):
    return run(psql(db, user), sql).stdout.strip()


def require(cond, label):
    if not cond:
        raise AssertionError("FAIL: " + label)
    print("PASS: " + label, flush=True)


def u(n):
    return f"00000000-0000-4000-8000-{n:012d}"


# People
OWNER, OWNER2, CO, PLAYER, CAPPED, BROWSER = u(1), u(2), u(3), u(4), u(5), u(6)
# Unions
U1, U2, U3, U4 = u(101), u(102), u(103), u(104)
# Clubs: in U1 before the install
CA, CB, CC, CD, CL = u(201), u(202), u(203), u(204), u(205)
# Clubs outside any union
CF, CG, CH, CI, CJ, CK = u(211), u(212), u(213), u(214), u(215), u(216)
CAPS = [u(300 + i) for i in range(10)]
JOIN = "app.club_membership_source"

SEED = f"""
INSERT INTO public.profiles(id, username) VALUES
  ('{OWNER}', 'union owner'), ('{OWNER2}', 'second owner'), ('{CO}', 'club owner'),
  ('{PLAYER}', 'player'), ('{CAPPED}', 'capped owner'), ('{BROWSER}', 'browser');
INSERT INTO public.clubs(id, name, owner_id) VALUES
  ('{CA}', 'A', '{OWNER}'), ('{CB}', 'B', '{CO}'), ('{CC}', 'C', '{CO}'), ('{CD}', 'D', '{CO}'),
  ('{CL}', 'L', '{CO}'), ('{CF}', 'F', '{CO}'), ('{CG}', 'G', '{CO}'), ('{CH}', 'H', '{CO}'),
  ('{CI}', 'I', '{OWNER}'), ('{CJ}', 'J', '{CO}'), ('{CK}', 'K', '{CO}')
  {''.join(f", ('{c}', 'cap {i}', '{CO}')" for i, c in enumerate(CAPS))};
INSERT INTO public.unions(id, name, owner_id) VALUES
  ('{U1}', 'Midway', '{OWNER}'), ('{U2}', 'Second', '{OWNER2}'), ('{U4}', 'Capped', '{CAPPED}');
BEGIN;
SELECT set_config('{JOIN}', 'join_club', true);
INSERT INTO public.club_members(club_id, user_id, role, status, is_active, membership_lifecycle_status,
                                departed_at, departure_reason, chip_balance) VALUES
  ('{CA}', '{OWNER}', 'owner', 'active', true, 'active', NULL, NULL, 0),
  ('{CB}', '{CO}', 'owner', 'active', true, 'active', NULL, NULL, 0),
  ('{CB}', '{PLAYER}', 'player', 'approved', true, 'active', NULL, NULL, 0),
  ('{CC}', '{OWNER}', 'player', 'pending', true, 'active', NULL, NULL, 0),
  ('{CD}', '{OWNER}', 'agent', 'suspended', false, 'departed', now(), 'Removed By Club Staff', 0),
  ('{CL}', '{CO}', 'owner', 'active', true, 'active', NULL, NULL, 0),
  ('{CL}', '{OWNER}', 'player', 'active', true, 'active', NULL, NULL, 0),
  ('{CL}', '{PLAYER}', 'player', 'active', true, 'active', NULL, NULL, 0),
  ('{CA}', '{PLAYER}', 'player', 'banned', true, 'active', NULL, NULL, 0),
  ('{CG}', '{OWNER}', 'player', 'suspended', false, 'departed', now(), 'Left', 0),
  ('{CH}', '{OWNER}', 'player', 'pending', true, 'active', NULL, NULL, 0),
  ('{CI}', '{OWNER}', 'owner', 'active', true, 'active', NULL, NULL, 0),
  ('{CJ}', '{OWNER}', 'player', 'banned', true, 'active', NULL, NULL, 0),
  ('{CK}', '{OWNER}', 'player', 'suspended', true, 'active', NULL, NULL, 0)
  {''.join(f", ('{c}', '{CAPPED}', 'player', 'active', true, 'active', NULL, NULL, 0)" for c in CAPS)};
COMMIT;
INSERT INTO public.union_clubs(union_id, club_id) VALUES
  ('{U1}', '{CA}'), ('{U1}', '{CB}'), ('{U1}', '{CC}'), ('{U1}', '{CD}'), ('{U1}', '{CL}');
"""

TRY = r"""CREATE FUNCTION pg_temp.try(p_sql text) RETURNS text LANGUAGE plpgsql AS $t$
DECLARE r text;
BEGIN
  BEGIN
    EXECUTE p_sql INTO r;
    RETURN COALESCE(r, 'ok');
  EXCEPTION WHEN OTHERS THEN
    RETURN 'refused:' || split_part(SQLERRM, ':', 1);
  END;
END $t$;
"""


def as_user(uid):
    return f"SELECT set_config('request.jwt.claims', '{{\"sub\":\"{uid}\",\"role\":\"authenticated\"}}', true);"


def member(club, user):
    """'t' when user holds an ACTIVE membership in club."""
    return (f"SELECT EXISTS (SELECT 1 FROM public.club_members cm WHERE cm.club_id = '{club}' AND cm.user_id = '{user}'"
            " AND cm.membership_lifecycle_status = 'active' AND COALESCE(cm.status, 'active') IN ('active', 'approved')"
            " AND COALESCE(cm.is_active, true));")


def case(*body):
    return "BEGIN;\n\\o /dev/null\n" + TRY + "\\o\n" + "\n".join(body) + "\nROLLBACK;"


def join(union, club, role="service_role"):
    return (f"SET LOCAL ROLE {role};\n"
            f"SELECT pg_temp.try($q$INSERT INTO public.union_clubs(union_id, club_id) VALUES ('{union}', '{club}') RETURNING 'joined'$q$);\n"
            "RESET ROLE;")


def quiet(sql):
    return "\\o /dev/null\n" + sql + "\n\\o"


def removal(call, actor=None):
    lines = []
    if actor:
        lines += ["SET LOCAL ROLE authenticated;", quiet(as_user(actor))]
    lines.append(f"SELECT pg_temp.try($q${call}$q$);")
    if actor:
        lines.append("RESET ROLE;")
    return "\n".join(lines)


def ledger_and_role(club, user):
    return (f"SELECT concat_ws('|', (SELECT role || '/' || chip_balance::int FROM public.club_members WHERE club_id = '{club}' AND user_id = '{user}'),"
            " (SELECT count(*) FROM public.chip_ledger),"
            f" (SELECT count(*) FROM public.audit_trail WHERE club_id = '{club}' AND target_id = '{user}' AND action = 'club_join_active'),"
            f" current_setting('{JOIN}', true));")


def leave_union(union, club):
    return quiet(f"DELETE FROM public.union_clubs WHERE union_id = '{union}' AND club_id = '{club}';")


# (name, script, wanted last line). Every script runs in a transaction it rolls back.
CASES = [
    # ── Join paths ──
    ("a club joining a union (approval or direct add) makes the union owner an active member",
     lambda: case(quiet(join(U1, CF)), member(CF, OWNER)), "t"),
    ("the new membership is an ordinary player membership with no chips, no ledger row, one join audit row, and the source setting restored",
     lambda: case(quiet(join(U1, CF)), ledger_and_role(CF, OWNER)), "player/0|0|1|"),
    ("an earlier session setting is restored after the union join",
     lambda: case(quiet(f"SELECT set_config('{JOIN}', 'join_club', true);"), quiet(join(U1, CF)),
                  f"SELECT current_setting('{JOIN}', true);"), "join_club"),
    ("a founding club of a new union makes its owner a member",
     lambda: case(quiet(f"INSERT INTO public.unions(id, name, owner_id) VALUES ('{U3}', 'New', '{OWNER2}');"),
                  quiet(join(U3, CF)), member(CF, OWNER2)), "t"),
    ("a club reassigned to another union gets that union's owner",
     lambda: case(quiet(f"UPDATE public.union_clubs SET union_id = '{U2}' WHERE union_id = '{U1}' AND club_id = '{CL}';"),
                  member(CL, OWNER2)), "t"),
    ("a re-join after the owner left the club activates the departed membership",
     lambda: case(quiet(join(U1, CG)), member(CG, OWNER)), "t"),
    ("a pending membership is activated by the join",
     lambda: case(quiet(join(U1, CH)), member(CH, OWNER)), "t"),
    ("the join creates no second row for an owner already a member",
     lambda: case(quiet(join(U1, CH)), f"SELECT count(*) FROM public.club_members WHERE club_id = '{CH}' AND user_id = '{OWNER}';"), "1"),
    ("an owner who already owns the club keeps the owner role",
     lambda: case(quiet(join(U1, CI)), f"SELECT role FROM public.club_members WHERE club_id = '{CI}' AND user_id = '{OWNER}';"), "owner"),
    ("an owner already in ten clubs still becomes a member when a club joins",
     lambda: case(quiet(join(U4, CF)), member(CF, CAPPED)), "t"),
    ("Join A Club over the ten-club cap is still refused",
     lambda: case(f"SELECT set_config('{JOIN}', 'join_club', true) IS NULL;",
                  f"SELECT pg_temp.try($q$INSERT INTO public.club_members(club_id, user_id) VALUES ('{CF}', '{CAPPED}') RETURNING 'joined'$q$);"),
     "refused:You can only be a member of up to 10 clubs. Leave a club to join a new one."),
    ("a membership written without a source is still refused",
     lambda: case(f"SELECT pg_temp.try($q$INSERT INTO public.club_members(club_id, user_id) VALUES ('{CF}', '{PLAYER}') RETURNING 'joined'$q$);"),
     "refused:MEMBERSHIP_REQUIRES_JOIN"),
    ("a union owner banned in the club refuses the join",
     lambda: case(join(U1, CJ)), "refused:UNION_OWNER_BANNED_IN_CLUB"),
    ("a union owner suspended in the club refuses the join",
     lambda: case(join(U1, CK)), "refused:UNION_OWNER_SUSPENDED_IN_CLUB"),
    ("the refused join leaves the ban in place",
     lambda: case(quiet(join(U1, CJ)), f"SELECT status FROM public.club_members WHERE club_id = '{CJ}' AND user_id = '{OWNER}';"), "banned"),
    ("a new union owner becomes a member of every club in the union",
     lambda: case(quiet(f"UPDATE public.unions SET owner_id = '{OWNER2}' WHERE id = '{U1}';"),
                  f"SELECT count(*) FILTER (WHERE m) || '/' || count(*) FROM (SELECT EXISTS (SELECT 1 FROM public.club_members cm WHERE cm.club_id = uc.club_id AND cm.user_id = '{OWNER2}' AND cm.membership_lifecycle_status = 'active' AND cm.status IN ('active','approved')) AS m FROM public.union_clubs uc WHERE uc.union_id = '{U1}') x;"),
     "5/5"),
    ("a union cannot pass to someone banned in one of its clubs",
     lambda: case(f"SELECT pg_temp.try($q$UPDATE public.unions SET owner_id = '{PLAYER}' WHERE id = '{U1}' RETURNING 'moved'$q$);"),
     "refused:UNION_OWNER_BANNED_IN_CLUB"),
    # ── The guard ──
    ("staff cannot remove the union owner while the club is in the union",
     lambda: case(removal(f"SELECT public.fn_remove_settled_club_member('{CL}', '{OWNER}')::text", CO)),
     "refused:UNION_OWNER_MEMBERSHIP_REQUIRED"),
    ("staff cannot ban the union owner while the club is in the union",
     lambda: case(removal(f"SELECT public.fn_club_set_member_status('{CL}', '{OWNER}', 'banned', 'x')->>'error'", CO)),
     "refused:UNION_OWNER_MEMBERSHIP_REQUIRED"),
    ("staff cannot suspend the union owner while the club is in the union",
     lambda: case(removal(f"SELECT public.fn_club_set_member_status('{CL}', '{OWNER}', 'suspended', 'x')->>'error'", CO)),
     "refused:UNION_OWNER_MEMBERSHIP_REQUIRED"),
    ("the union owner cannot leave a club of the union",
     lambda: case(removal(f"SELECT public.fn_member_leave_to_treasury('{CL}', '{OWNER}')::text", OWNER)),
     "refused:UNION_OWNER_MEMBERSHIP_REQUIRED"),
    ("a direct delete of the union owner's membership is refused",
     lambda: case(removal(f"DELETE FROM public.club_members WHERE club_id = '{CL}' AND user_id = '{OWNER}' RETURNING 'deleted'")),
     "refused:UNION_OWNER_MEMBERSHIP_REQUIRED"),
    ("a direct deactivation by the service role is refused",
     lambda: case("SET LOCAL ROLE service_role;",
                  f"SELECT pg_temp.try($q$UPDATE public.club_members SET is_active = false WHERE club_id = '{CL}' AND user_id = '{OWNER}' RETURNING 'deactivated'$q$);"),
     "refused:UNION_OWNER_MEMBERSHIP_REQUIRED"),
    ("moving the union owner's membership to another club is refused",
     lambda: case(removal(f"UPDATE public.club_members SET club_id = '{CF}' WHERE club_id = '{CL}' AND user_id = '{OWNER}' RETURNING 'moved'")),
     "refused:UNION_OWNER_MEMBERSHIP_REQUIRED"),
    ("a role change is not a removal and is allowed",
     lambda: case(removal(f"UPDATE public.club_members SET role = 'agent' WHERE club_id = '{CL}' AND user_id = '{OWNER}' RETURNING role")),
     "agent"),
    ("an ordinary member can still be removed",
     lambda: case(removal(f"SELECT public.fn_remove_settled_club_member('{CL}', '{PLAYER}')->>'success'", CO)), "true"),
    ("when the club leaves the union the membership stays",
     lambda: case(leave_union(U1, CL), member(CL, OWNER)), "t"),
    ("after the club leaves the union the club may remove the former union owner",
     lambda: case(leave_union(U1, CL), removal(f"SELECT public.fn_remove_settled_club_member('{CL}', '{OWNER}')->>'success'", CO)), "true"),
    ("after the union changes hands the old owner's membership is ordinary",
     lambda: case(quiet(f"UPDATE public.unions SET owner_id = '{OWNER2}' WHERE id = '{U1}';"),
                  removal(f"SELECT public.fn_remove_settled_club_member('{CL}', '{OWNER}')->>'success'", CO)), "true"),
    ("deleting the club still takes its memberships with it",
     lambda: case(f"SELECT pg_temp.try($q$DELETE FROM public.clubs WHERE id = '{CL}' RETURNING 'deleted'$q$);",
                  ), "deleted"),
]

STATE = [
    ("the backfill made the union owner an ordinary player in the club that had no row",
     lambda db: q(db, f"SELECT role || '/' || status || '/' || chip_balance::int FROM public.club_members WHERE club_id = '{CB}' AND user_id = '{OWNER}'"),
     "player/active/0"),
    ("the backfill activated the pending membership",
     lambda db: q(db, member(CC, OWNER)), "t"),
    ("the backfill reactivated the departed membership and kept its role",
     lambda db: q(db, f"SELECT role || '/' || status || '/' || membership_lifecycle_status || '/' || is_active FROM public.club_members WHERE club_id = '{CD}' AND user_id = '{OWNER}'"),
     "agent/active/active/true"),
    ("the backfill left the owner's own club membership as it was",
     lambda db: q(db, f"SELECT role FROM public.club_members WHERE club_id = '{CA}' AND user_id = '{OWNER}'"), "owner"),
    ("every club in a union holds its union owner",
     lambda db: q(db, f"SELECT count(*) FROM public.union_clubs uc JOIN public.unions u ON u.id = uc.union_id WHERE NOT EXISTS (SELECT 1 FROM public.club_members cm WHERE cm.club_id = uc.club_id AND cm.user_id = u.owner_id AND cm.membership_lifecycle_status = 'active' AND cm.status IN ('active','approved'))"),
     "0"),
]

FAIL_BEFORE = {
    "a club joining a union (approval or direct add) makes the union owner an active member",
    "the new membership is an ordinary player membership with no chips, no ledger row, one join audit row, and the source setting restored",
    "a founding club of a new union makes its owner a member",
    "a club reassigned to another union gets that union's owner",
    "a re-join after the owner left the club activates the departed membership",
    "a pending membership is activated by the join",
    "an owner already in ten clubs still becomes a member when a club joins",
    "a union owner banned in the club refuses the join",
    "a union owner suspended in the club refuses the join",
    "a new union owner becomes a member of every club in the union",
    "a union cannot pass to someone banned in one of its clubs",
    "staff cannot remove the union owner while the club is in the union",
    "staff cannot ban the union owner while the club is in the union",
    "staff cannot suspend the union owner while the club is in the union",
    "the union owner cannot leave a club of the union",
    "a direct delete of the union owner's membership is refused",
    "a direct deactivation by the service role is refused",
    "moving the union owner's membership to another club is refused",
    "the backfill made the union owner an ordinary player in the club that had no row",
    "the backfill activated the pending membership",
    "the backfill reactivated the departed membership and kept its role",
    "every club in a union holds its union owner",
}


def last(out):
    return out.splitlines()[-1] if out else ""


def observe(db):
    seen = {}
    for name, sql, want in CASES:
        got = last(q(db, sql()))
        seen[name] = got == want
        if got != want:
            print(f"  observed {name!r}: {got!r} (wanted {want!r})", flush=True)
    for name, read, want in STATE:
        got = read(db)
        seen[name] = got == want
        if got != want:
            print(f"  observed {name!r}: {got!r} (wanted {want!r})", flush=True)
    return seen


def gates(db):
    """What the union owner may do in club B, as the browser would ask."""
    return q(db, f"""SET ROLE authenticated;
\\o /dev/null
{as_user(OWNER)}
\\o
SELECT concat_ws('|', public.ca_can_view_club_finances('{CB}'), public.fn_club_is_staff('{CB}', '{OWNER}'),
  public.is_club_admin('{CB}', '{OWNER}'), public.fn_can_create_games('{CB}', '{OWNER}'),
  COALESCE(public.fn_club_bank_role('{CB}', '{OWNER}'), 'none'));""", user="browser")


def catalog(db):
    return q(db, """SELECT md5(concat_ws('|',
      (SELECT string_agg(p.oid::regprocedure::text || md5(pg_get_functiondef(p.oid)) || coalesce(p.proacl::text, ''), ',' ORDER BY p.oid::regprocedure::text)
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace),
      (SELECT string_agg(tgrelid::regclass::text || '.' || tgname, ',' ORDER BY tgrelid::regclass::text, tgname) FROM pg_trigger WHERE NOT tgisinternal),
      (SELECT string_agg(table_name || '.' || trigger_name, ',' ORDER BY table_name, trigger_name) FROM public.ca_declared_money_triggers),
      (SELECT string_agg(to_jsonb(m)::text, ',' ORDER BY m.club_id, m.user_id) FROM public.club_members m),
      (SELECT string_agg(union_id || club_id::text, ',' ORDER BY union_id, club_id) FROM public.union_clubs),
      (SELECT count(*) FROM public.chip_ledger)))""")


def money(db):
    return q(db, "SELECT (SELECT count(*) FROM public.chip_ledger) || '/' || (SELECT COALESCE(sum(chip_balance), 0)::int FROM public.club_members)")


def posture(db, sig):
    return q(db, f"""SELECT json_build_array(pg_get_userbyid(proowner), prosecdef, provolatile, proconfig, proacl::text[],
      pg_get_function_result(oid)) FROM pg_proc WHERE oid = '{sig}'::regprocedure""")


def proofs(db):
    out = []
    for p in PROOFS:
        r = subprocess.run(psql(db), input=f"SELECT ({p})::text;", capture_output=True, text=True, env=ENV, timeout=60)
        out.append(r.stdout.strip() if r.returncode == 0 else "error")
    return out


def install(db, seed=SEED):
    q("postgres", f"CREATE DATABASE {db} OWNER postgres", user="fixture_bootstrap")
    q(db, "ALTER SCHEMA public OWNER TO postgres", user="fixture_bootstrap")
    q(db, FIXTURE_SQL)
    q(db, SOURCE_GATE)
    q(db, CAP_FIRST)
    assert q(db, f"SELECT md5(pg_get_functiondef('{CAP_SIG}'::regprocedure))") == "4c27b1c5f7b438dfa569699d19f2200a", "20260908125235 cap"
    cap = q(db, f"SELECT pg_get_functiondef('{CAP_SIG}'::regprocedure)")
    assert cap.count(CAP_OLD) == 1, "20260922153234 anchor"
    q(db, "BEGIN;\n" + cap.replace(CAP_OLD, CAP_NEW) + ";\nCOMMIT;")
    q(db, GATE_TRIGGERS)
    q(db, seed)


try:
    run([PG / "initdb", "-D", data, "-U", "fixture_bootstrap", "--auth-local=trust", "--auth-host=trust", "--no-locale", "-E", "UTF8"])
    with (data / "postgresql.conf").open("a") as f:
        f.write(f"\nlisten_addresses='127.0.0.1'\nport={PORT}\nunix_socket_directories=''\nfsync=off\nautovacuum=off\ntimezone='UTC'\n")
    run([PG / "pg_ctl", "-D", data, "-l", cluster / "server.log", "-w", "start"])
    started = True
    print(f"PostgreSQL: {q('postgres', 'SHOW server_version', user='fixture_bootstrap')} on port {PORT}", flush=True)
    q("postgres", "CREATE ROLE postgres LOGIN NOSUPERUSER CREATEDB CREATEROLE; CREATE ROLE anon; CREATE ROLE authenticated; "
                  "CREATE ROLE service_role; GRANT anon, authenticated, service_role TO postgres WITH SET TRUE; "
                  "CREATE ROLE browser LOGIN; GRANT authenticated TO browser WITH SET TRUE;",
      user="fixture_bootstrap")

    install("live")
    for sig, d, s in ((SOURCE_SIG, LIVE_SOURCE_DEF, LIVE_SOURCE_SRC), (CAP_SIG, LIVE_CAP_DEF, LIVE_CAP_SRC)):
        require(q("live", f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure)) || md5(prosrc) FROM pg_proc WHERE oid = '{sig}'::regprocedure") == d + s,
                f"production's {sig} rebuilt from main's migrations byte for byte (definition md5 {d})")
    early = proofs("live")
    require(len(PROOFS) == 5 and all(p != "true" for p in early), f"no @live-proof is true before the install ({early})")

    before = observe("live")
    failing = {k for k, ok in before.items() if not ok}
    require(failing == FAIL_BEFORE, f"production's behaviour fails exactly the {len(FAIL_BEFORE)} union-owner cases "
            f"(unexpected: {sorted(failing ^ FAIL_BEFORE)})")
    before_postures = [posture("live", s) for s in (SOURCE_SIG, CAP_SIG)]
    before_gates, before_money = gates("live"), money("live")
    require(before_gates == "f|f|f|t|none",
            f"before: the union owner has no finance, staff or bank role in a union club and may create games there through the union ({before_gates})")

    # A drifted gate refuses the whole file.
    install("drift")
    q("drift", SOURCE_GATE.replace("'club_owner_create')", "'club_owner_create' )"))
    drift_catalog = catalog("drift")
    run(psql("drift"), MIGRATION, expect_fail="UNION_OWNER_MEMBERSHIP_PREIMAGE_CHANGED")
    require(catalog("drift") == drift_catalog, "a drifted gate refuses the file and installs nothing")

    # A union owner already banned in a club of their union refuses the whole file.
    install("conflict")
    q("conflict", f"INSERT INTO public.union_clubs(union_id, club_id) VALUES ('{U1}', '{CJ}')")
    conflict_catalog = catalog("conflict")
    run(psql("conflict"), MIGRATION, expect_fail="UNION_OWNER_BANNED_IN_CLUB")
    require(catalog("conflict") == conflict_catalog,
            "a union owner banned in a club of the union refuses the backfill, never unbans, and installs nothing")

    live_catalog = catalog("live")
    run(psql("live"), MIGRATION.replace("\nCOMMIT;\n", "\nROLLBACK;\n"))
    require(catalog("live") == live_catalog, "a rolled-back run changes nothing")
    run(psql("live"), "SET ROLE authenticated;\n" + MIGRATION, expect_fail="ERROR")
    require(catalog("live") == live_catalog, "a browser role cannot install it")

    out = run(psql("live"), MIGRATION)
    require("backfill inserted 1, activated 2, already members 2" in out.stderr,
            "the backfill inserts the one missing membership, activates the pending and departed ones, and keeps the two already there")
    require(q("live", f"SELECT md5(pg_get_functiondef('{SOURCE_SIG}'::regprocedure))") == POST_SOURCE
            and q("live", f"SELECT md5(pg_get_functiondef('{CAP_SIG}'::regprocedure))") == POST_CAP,
            f"the installed gates are the reviewed text (md5 {POST_SOURCE}, {POST_CAP})")
    require([posture("live", s) for s in (SOURCE_SIG, CAP_SIG)] == before_postures,
            "both gates keep their owner, SECURITY DEFINER, search_path, result and grants")
    require(q("live", "SELECT count(*) FROM public.ca_declared_money_triggers WHERE table_name = 'club_members' "
                      "AND trigger_name = 'trg_union_owner_membership_is_kept'") == "1",
            "the new club_members trigger declares itself in ca_declared_money_triggers")
    require(q("live", "SELECT bool_and(NOT has_function_privilege(r, p.oid, 'EXECUTE')) FROM pg_proc p, unnest(ARRAY['anon', 'authenticated']) r "
                      "WHERE p.proname IN ('fn_union_owner_holds_membership', 'fn_union_clubs_owner_joins_the_club', "
                      "'fn_unions_new_owner_joins_every_club', 'fn_union_owner_membership_is_kept')") == "t",
            "no browser role can execute any of the four new functions")
    require(money("live") == before_money, f"the install moved no chips and wrote no ledger row ({before_money})")
    after_gates = gates("live")
    require(after_gates == "f|f|f|t|player",
            f"after: the membership is a player's - no finance view, no staff, no admin, games only through the union as before ({after_gates})")

    after = observe("live")
    require(all(after.values()), f"all {len(after)} union-owner cases pass after the install "
            f"(failing: {sorted(k for k, ok in after.items() if not ok)})")
    require(proofs("live") == ["true"] * len(PROOFS), "every @live-proof is true after the install")

    settled = catalog("live")
    out = run(psql("live"), MIGRATION)
    require("already admits union_owner_membership" in out.stderr and "backfill inserted 0, activated 0, already members 5" in out.stderr
            and catalog("live") == settled, "a re-run installs nothing twice and changes no row")
    require(all(observe("live").values()), "every case still passes after the re-run")
    print(f"PASS: the union owner is a member of every club ({len(FAIL_BEFORE)} of {len(before)} cases fail before, "
          f"{len(after)} of {len(after)} pass after)", flush=True)
finally:
    if started:
        run([PG / "pg_ctl", "-D", data, "-m", "fast", "-w", "stop"])
    shutil.rmtree(cluster, ignore_errors=True)
