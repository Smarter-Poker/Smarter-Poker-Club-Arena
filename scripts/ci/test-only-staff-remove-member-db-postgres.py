#!/usr/bin/env python3
"""Qualify 20261012132509_only_staff_can_remove_a_member on a private
PostgreSQL 17 cluster (127.0.0.1, a free port in 55950-55999, trust auth, a
temporary data directory under $TMPDIR). Nothing here reaches production.

Production's public.fn_remove_settled_club_member(uuid,uuid) - SECURITY
DEFINER, EXECUTE for every signed-in player - was edited by hand outside any
migration: a signed-out caller became the all-zero user, the caller check was
gone and every settlement check was dropped ("BYPASSED SEAT CHECKS FOR BOT
RETIREMENT!"). The harness installs that live body byte for byte (definition
md5 acdfe7bc..., source md5 081b54ee..., from
tests/fixtures/union-owner-membership-db/fixture.sql), the union owner guard
(20261012112707) exactly as main installs it, and the settlement tables the
reviewed body reads (tests/fixtures/only-staff-remove-member-db/fixture.sql).

FAIL BEFORE: a signed-in stranger removes a member of a club they are not in,
and the club owner; a plain member removes another member; staff remove the
owner, the owner removes themselves or a staff member; a member seated at a
live table, holding chips or diamonds, in a tournament, in escrow, with a
chip request or with a downline is removed; a caller with no signed-in user
removes a member; no departure is audited. PASS AFTER: every one of those is
refused with the reviewed words; the owner, a co-owner and an admin still
remove a settled member, audited, records retained, no chip moved; the union
owner guard still refuses; anon still cannot call it. A drifted body, a
rolled-back run and a browser role each install nothing, and a re-run changes
nothing.
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
MIG = MIGS / "20261012132509_only_staff_can_remove_a_member.sql"
REVIEWED = MIGS / "20260929062121_staff_can_remove_a_settled_member_again.sql"
UNION_MIG = MIGS / "20261012112707_the_union_owner_is_a_member_of_every_club.sql"
UNION_FIXTURE = ROOT / "tests/fixtures/union-owner-membership-db/fixture.sql"
FIXTURE = ROOT / "tests/fixtures/only-staff-remove-member-db/fixture.sql"
PG = Path(os.environ.get("PG_BIN") or next((p for p in ("/usr/lib/postgresql/17/bin", "/opt/homebrew/opt/postgresql@17/bin")
                                            if (Path(p) / "initdb").exists()), "/usr/lib/postgresql/17/bin"))
SIG = "public.fn_remove_settled_club_member(uuid,uuid)"
LIVE_DEF = "acdfe7bc5b3138c9c188cdf1e8e24f22"
LIVE_SRC = "081b54ee2f9dd672bc1c7deee24a8119"
LIVE_ACL = "{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}"
ENV = {"PATH": f"{PG}:/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}

MIGRATION = MIG.read_text()
POST = re.search(r"^-- @live-proof: \(SELECT md5\(pg_get_functiondef\('" + re.escape(SIG) + r"'::regprocedure\)\) = '([0-9a-f_A-Z]{8,32})'\)$",
                 MIGRATION, re.M).group(1)
PROOFS = [m.group(1).strip() for m in re.finditer(r"^-- @live-proof: (.+)$", MIGRATION, re.M)]
BODY = re.search(r"c_body constant text := \$body\$\n(.*?)\n\$body\$;", MIGRATION, re.S).group(1)


def reviewed_body():
    """The function as 20260929062121 wrote it, with 20261012061427's one change (40001 -> 55000)."""
    a = REVIEWED.read_text()
    i = a.index("CREATE OR REPLACE FUNCTION public.fn_remove_settled_club_member(")
    j = a.index("$function$;", a.index("AS $function$", i)) + len("$function$;")
    body = a[i:j]
    assert body.count("USING ERRCODE = '40001'") == 1
    return body.replace("USING ERRCODE = '40001'", "USING ERRCODE = '55000'")


# The union owner guard, exactly as its own harness rebuilds production's gates.
def rebuild_source_gate():
    a = (MIGS / "20260901090000_club_card_human_realtime_stats.sql").read_text()
    s = "public.fn_require_explicit_club_membership_source()"
    i = a.index(f"CREATE OR REPLACE FUNCTION {s}")
    j = a.index("$function$;", a.index("AS $function$", i)) + len("$function$;")
    return a[i:j] + f"\nREVOKE ALL ON FUNCTION {s} FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION {s} TO service_role;\n"


def rebuild_cap():
    s = "public.fn_enforce_four_club_limit()"
    a = (MIGS / "20260908125235_a_player_may_belong_to_ten_clubs.sql").read_text()
    i = a.index(f"CREATE OR REPLACE FUNCTION {s}")
    j = a.index("$fn$;", a.index("AS $fn$", i)) + len("$fn$;")
    b = (MIGS / "20260922153234_one_club_membership_cap_one_count_one_lock.sql").read_text()
    old = re.search(r"\$trg_old\$(.*?)\$trg_old\$", b, re.S).group(1)
    new = re.search(r"\$trg_new\$(.*?)\$trg_new\$", b, re.S).group(1)
    return s, a[i:j] + f"\nREVOKE ALL ON FUNCTION {s} FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION {s} TO service_role;\n", old, new


SOURCE_GATE = rebuild_source_gate()
CAP_SIG, CAP_FIRST, CAP_OLD, CAP_NEW = rebuild_cap()
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
    for candidate in range(55950, 56000):
        try:
            probe_socket.bind(("127.0.0.1", candidate))
            PORT = candidate
            break
        except OSError:
            continue
assert PORT, "no free port in 55950-55999"
cluster = Path(tempfile.mkdtemp(prefix="only-staff-remove-", dir=os.environ.get("TMPDIR")))
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
CO, ADMIN, COOWNER, PA, PB, SEATED, CHIPS, DIAMONDS, ENTRY, ESCROW, REQ, AGENTP, DOWN, GONE, STRANGER, OTHER, UOWNER, PC, PD = (
    u(i) for i in range(1, 20))
C1, C2 = u(201), u(202)
U1 = u(101)
T1, TR1 = u(301), u(302)
JOIN = "app.club_membership_source"

SEED = f"""
INSERT INTO public.profiles(id, username) VALUES
  ('{CO}', 'club owner'), ('{ADMIN}', 'admin'), ('{COOWNER}', 'co-owner'), ('{PA}', 'player a'),
  ('{PB}', 'player b'), ('{SEATED}', 'seated'), ('{CHIPS}', 'chips'), ('{DIAMONDS}', 'diamonds'),
  ('{ENTRY}', 'entry'), ('{ESCROW}', 'escrow'), ('{REQ}', 'request'), ('{AGENTP}', 'agent parent'),
  ('{DOWN}', 'downline'), ('{GONE}', 'departed'), ('{STRANGER}', 'stranger'), ('{OTHER}', 'other owner'),
  ('{UOWNER}', 'union owner'), ('{PC}', 'player c'), ('{PD}', 'player d');
INSERT INTO public.clubs(id, name, owner_id) VALUES ('{C1}', 'One', '{CO}'), ('{C2}', 'Two', '{OTHER}');
BEGIN;
SELECT set_config('{JOIN}', 'join_club', true);
INSERT INTO public.club_members(club_id, user_id, role, status, is_active, membership_lifecycle_status,
                                departed_at, departure_reason, agent_id) VALUES
  ('{C1}', '{CO}', 'owner', 'active', true, 'active', NULL, NULL, NULL),
  ('{C1}', '{ADMIN}', 'admin', 'active', true, 'active', NULL, NULL, NULL),
  ('{C1}', '{COOWNER}', 'co_owner', 'active', true, 'active', NULL, NULL, NULL),
  ('{C1}', '{PA}', 'player', 'active', true, 'active', NULL, NULL, NULL),
  ('{C1}', '{PB}', 'player', 'approved', true, 'active', NULL, NULL, NULL),
  ('{C1}', '{PC}', 'player', 'active', true, 'active', NULL, NULL, NULL),
  ('{C1}', '{PD}', 'player', 'active', true, 'active', NULL, NULL, NULL),
  ('{C1}', '{SEATED}', 'player', 'active', true, 'active', NULL, NULL, NULL),
  ('{C1}', '{CHIPS}', 'player', 'active', true, 'active', NULL, NULL, NULL),
  ('{C1}', '{DIAMONDS}', 'player', 'active', true, 'active', NULL, NULL, NULL),
  ('{C1}', '{ENTRY}', 'player', 'active', true, 'active', NULL, NULL, NULL),
  ('{C1}', '{ESCROW}', 'player', 'active', true, 'active', NULL, NULL, NULL),
  ('{C1}', '{REQ}', 'player', 'active', true, 'active', NULL, NULL, NULL),
  ('{C1}', '{AGENTP}', 'player', 'active', true, 'active', NULL, NULL, NULL),
  ('{C1}', '{DOWN}', 'player', 'active', true, 'active', NULL, NULL, '{AGENTP}'),
  ('{C1}', '{GONE}', 'player', 'suspended', false, 'departed', now(), 'Removed By Club Staff', NULL),
  ('{C2}', '{OTHER}', 'owner', 'active', true, 'active', NULL, NULL, NULL),
  ('{C2}', '{STRANGER}', 'player', 'active', true, 'active', NULL, NULL, NULL);
COMMIT;
UPDATE public.club_members SET chip_balance = 500 WHERE club_id = '{C1}' AND user_id = '{CHIPS}';
UPDATE public.club_members SET diamonds = 5 WHERE club_id = '{C1}' AND user_id = '{DIAMONDS}';
INSERT INTO public.tables(id, club_id) VALUES ('{T1}', '{C1}');
INSERT INTO public.table_seats(table_id, user_id, left_at) VALUES ('{T1}', '{SEATED}', NULL), ('{T1}', '{PA}', now());
INSERT INTO public.tournaments(id, club_id) VALUES ('{TR1}', '{C1}');
INSERT INTO public.tournament_players(tournament_id, user_id, status) VALUES ('{TR1}', '{ENTRY}', 'registered'), ('{TR1}', '{PA}', 'busted');
INSERT INTO public.chip_escrow_holds(club_id, user_id, status) VALUES ('{C1}', '{ESCROW}', 'held');
INSERT INTO public.chip_requests(club_id, requester_id, approver_id, status) VALUES ('{C1}', '{REQ}', NULL, 'pending');
INSERT INTO public.unions(id, name, owner_id) VALUES ('{U1}', 'Midway', '{UOWNER}');
INSERT INTO public.union_clubs(union_id, club_id) VALUES ('{U1}', '{C1}');
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


def quiet(sql):
    return "\\o /dev/null\n" + sql + "\n\\o"


def case(*body):
    return "BEGIN;\n" + quiet(TRY) + "\n" + "\n".join(body) + "\nROLLBACK;"


def as_role(role, uid=None):
    claims = '{"role":"%s"%s}' % (role, f',"sub":"{uid}"' if uid else "")
    return f"SET LOCAL ROLE {role};\n" + quiet(f"SELECT set_config('request.jwt.claims', '{claims}', true);")


def remove(actor, club, target, field="error", role="authenticated"):
    """Call the door as `actor` (None: no signed-in user); report the refusal words or 'ok'."""
    pick = (f"coalesce(x->>'error', 'ok')" if field == "error" else f"x->>'{field}'")
    return "\n".join([
        as_role(role, actor),
        f"SELECT pg_temp.try($q$SELECT {pick} FROM (SELECT public.fn_remove_settled_club_member('{club}', '{target}') x) s$q$);",
        "RESET ROLE;",
    ])


def state(club, user):
    return (f"SELECT concat_ws('/', membership_lifecycle_status, status, is_active, departed_by,"
            f" (SELECT count(*) FROM public.audit_trail a WHERE a.action = 'depart_club_member' AND a.club_id = '{club}' AND a.target_id = '{user}'))"
            f" FROM public.club_members WHERE club_id = '{club}' AND user_id = '{user}';")


def quietly(sql):
    return quiet(sql)


ONLY_STAFF = "Only Club Staff Can Remove A Member"
OWNER_KEPT = "The Club Owner Cannot Be Removed"
SETTLE = "Settle Every Member Balance, Credit Line And Diamond Balance Before Removing Them"

# (name, script, wanted last line). Every script runs in a transaction it rolls back.
CASES = [
    # -- who may call it --
    ("a signed-in stranger cannot remove a member of a club they are not in",
     lambda: case(remove(STRANGER, C1, PA)), ONLY_STAFF),
    ("the stranger's attempt leaves the membership active",
     lambda: case(quietly(remove(STRANGER, C1, PA)), state(C1, PA)), "active/active/t/0"),
    ("a signed-in stranger cannot remove the club owner",
     lambda: case(remove(STRANGER, C1, CO)), ONLY_STAFF),
    ("a plain member cannot remove another member",
     lambda: case(remove(PB, C1, PA)), ONLY_STAFF),
    ("a caller with no signed-in user (service role, no user) is refused",
     lambda: case(remove(None, C1, PA, role="service_role")), "Authentication Required"),
    ("anon still cannot call it",
     lambda: case(remove(None, C1, PA, role="anon")), "refused:permission denied for function fn_remove_settled_club_member"),
    # -- who may be removed --
    ("a club admin cannot remove the club owner",
     lambda: case(remove(ADMIN, C1, CO)), OWNER_KEPT),
    ("the owner cannot remove themselves",
     lambda: case(remove(CO, C1, CO)), OWNER_KEPT),
    ("club staff must be demoted before removal",
     lambda: case(remove(CO, C1, ADMIN)), "Demote Club Staff To Player Before Marking The Membership Departed"),
    ("a member seated at a live table is refused",
     lambda: case(remove(CO, C1, SEATED)), "Remove This Member From Live Tables First"),
    ("a member holding chips is refused",
     lambda: case(remove(CO, C1, CHIPS)), SETTLE),
    ("a member holding diamonds is refused",
     lambda: case(remove(CO, C1, DIAMONDS)), SETTLE),
    ("a member registered in a tournament is refused",
     lambda: case(remove(CO, C1, ENTRY)), "Settle This Member's Tournament Entry First"),
    ("a member with chips held in escrow is refused",
     lambda: case(remove(CO, C1, ESCROW)), "Release This Member's Escrow First"),
    ("a member with a pending chip request is refused",
     lambda: case(remove(CO, C1, REQ)), "Resolve This Member's Chip Requests First"),
    ("a member with a downline is refused",
     lambda: case(remove(CO, C1, AGENTP)), "Reassign This Member's Downline Before Removing Them"),
    ("the union owner cannot be removed while the club is in the union",
     lambda: case(remove(CO, C1, UOWNER)), "refused:UNION_OWNER_MEMBERSHIP_REQUIRED"),
    # -- what staff can still do --
    ("the club owner removes a settled member",
     lambda: case(remove(CO, C1, PA)), "ok"),
    ("the departure keeps the row, records who did it and writes one audit row",
     lambda: case(quietly(remove(CO, C1, PA)), state(C1, PA)), f"departed/suspended/f/{CO}/1"),
    ("a co-owner removes a settled member",
     lambda: case(remove(COOWNER, C1, PC)), "ok"),
    ("a club admin removes a settled member",
     lambda: case(remove(ADMIN, C1, PD)), "ok"),
    ("a member already departed is reported as departed",
     lambda: case(remove(CO, C1, GONE, field="already_departed")), "true"),
    ("a removal moves no chips",
     lambda: case(quietly(remove(CO, C1, PA)), "SELECT (SELECT count(*) FROM public.chip_ledger) || '/' || (SELECT sum(chip_balance)::int FROM public.club_members);"),
     None),  # filled with the seeded money below
]

FAIL_BEFORE = {
    "a signed-in stranger cannot remove a member of a club they are not in",
    "the stranger's attempt leaves the membership active",
    "a signed-in stranger cannot remove the club owner",
    "a plain member cannot remove another member",
    "a caller with no signed-in user (service role, no user) is refused",
    "a club admin cannot remove the club owner",
    "the owner cannot remove themselves",
    "club staff must be demoted before removal",
    "a member seated at a live table is refused",
    "a member holding chips is refused",
    "a member holding diamonds is refused",
    "a member registered in a tournament is refused",
    "a member with chips held in escrow is refused",
    "a member with a pending chip request is refused",
    "a member with a downline is refused",
    "the departure keeps the row, records who did it and writes one audit row",
}


def last(out):
    return out.splitlines()[-1] if out else ""


def observe(db, money_want):
    seen = {}
    for name, sql, want in CASES:
        want = money_want if want is None else want
        got = last(q(db, sql()))
        seen[name] = got == want
        if got != want:
            print(f"  observed {name!r}: {got!r} (wanted {want!r})", flush=True)
    return seen


def catalog(db):
    return q(db, """SELECT md5(concat_ws('|',
      (SELECT string_agg(p.oid::regprocedure::text || md5(pg_get_functiondef(p.oid)) || coalesce(p.proacl::text, ''), ',' ORDER BY p.oid::regprocedure::text)
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace),
      (SELECT string_agg(tgrelid::regclass::text || '.' || tgname, ',' ORDER BY tgrelid::regclass::text, tgname) FROM pg_trigger WHERE NOT tgisinternal),
      (SELECT string_agg(to_jsonb(m)::text, ',' ORDER BY m.club_id, m.user_id) FROM public.club_members m),
      (SELECT count(*) FROM public.audit_trail),
      (SELECT count(*) FROM public.chip_ledger)))""")


def money(db):
    return q(db, "SELECT (SELECT count(*) FROM public.chip_ledger) || '/' || (SELECT sum(chip_balance)::int FROM public.club_members)")


def posture(db):
    return q(db, f"""SELECT json_build_array(pg_get_userbyid(proowner), prosecdef, provolatile, proacl::text,
      pg_get_function_result(oid), pg_get_function_identity_arguments(oid)) FROM pg_proc WHERE oid = '{SIG}'::regprocedure""")


def proofs(db):
    out = []
    for p in PROOFS:
        r = subprocess.run(psql(db), input=f"SELECT ({p})::text;", capture_output=True, text=True, env=ENV, timeout=60)
        out.append(r.stdout.strip() if r.returncode == 0 else "error")
    return out


def install(db):
    q("postgres", f"CREATE DATABASE {db} OWNER postgres", user="fixture_bootstrap")
    q(db, "ALTER SCHEMA public OWNER TO postgres", user="fixture_bootstrap")
    q(db, UNION_FIXTURE.read_text())
    q(db, FIXTURE.read_text())
    q(db, SOURCE_GATE)
    q(db, CAP_FIRST)
    cap = q(db, f"SELECT pg_get_functiondef('{CAP_SIG}'::regprocedure)")
    assert cap.count(CAP_OLD) == 1, "20260922153234 anchor"
    q(db, "BEGIN;\n" + cap.replace(CAP_OLD, CAP_NEW) + ";\nCOMMIT;")
    q(db, GATE_TRIGGERS)
    q(db, SEED)
    run(psql(db), UNION_MIG.read_text())   # 20261012112707 lands before this migration


try:
    require(BODY == reviewed_body(),
            "the migration's body is 20260929062121's reviewed function byte for byte, with 20261012061427's 55000")
    for word in ("bypass", "BYPASS", "00000000-0000-0000-0000-000000000000"):
        require(word not in BODY, f"the reinstated body holds no {word!r}")

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

    # The declared postimage is the md5 of the reviewed body installed over the live one.
    install("scratch")
    q("scratch", BODY)
    computed = q("scratch", f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure))")
    require(POST == computed, f"the migration's postimage md5 is the reviewed body's ({computed})")

    install("live")
    require(q("live", f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure)) || '/' || md5(prosrc) || '/' || proacl::text FROM pg_proc WHERE oid = '{SIG}'::regprocedure")
            == f"{LIVE_DEF}/{LIVE_SRC}/{LIVE_ACL}",
            f"production's drifted body is installed byte for byte (definition md5 {LIVE_DEF}, source md5 {LIVE_SRC}, grants {LIVE_ACL})")
    require(q("live", "SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_union_owner_membership_is_kept'") == "1",
            "the union owner guard (20261012112707) is installed first, as on production")
    early = proofs("live")
    require(len(PROOFS) == 2 and all(p != "true" for p in early), f"no @live-proof is true before the install ({early})")

    seeded_money = money("live")
    before = observe("live", seeded_money)
    failing = {k for k, ok in before.items() if not ok}
    require(failing == FAIL_BEFORE, f"production's body fails exactly the {len(FAIL_BEFORE)} authorization and settlement cases "
            f"(unexpected: {sorted(failing ^ FAIL_BEFORE)})")
    before_posture = posture("live")

    # A drifted body refuses the whole file.
    install("drift")
    d = q("drift", f"SELECT pg_get_functiondef('{SIG}'::regprocedure)")
    q("drift", "BEGIN;\n" + d.replace("'Member Not Found'", "'Member Not Found.'") + ";\nCOMMIT;")
    drift_catalog = catalog("drift")
    run(psql("drift"), MIGRATION, expect_fail="ONLY_STAFF_REMOVE_PREIMAGE_CHANGED")
    require(catalog("drift") == drift_catalog, "a drifted body refuses the file and installs nothing")

    live_catalog = catalog("live")
    run(psql("live"), MIGRATION.replace("\nCOMMIT;\n", "\nROLLBACK;\n"))
    require(catalog("live") == live_catalog, "a rolled-back run changes nothing")
    run(psql("live"), "SET ROLE authenticated;\n" + MIGRATION, expect_fail="ERROR")
    require(catalog("live") == live_catalog, "a browser role cannot install it")

    out = run(psql("live"), MIGRATION)
    require("fn_remove_settled_club_member reinstated" in out.stderr, "the install reports the reinstated body")
    require(q("live", f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure))") == POST, f"the installed body is the reviewed text (md5 {POST})")
    require(posture("live") == before_posture, "owner, SECURITY DEFINER, volatility, grants, result and arguments are unchanged")
    require(q("live", f"SELECT proconfig::text FROM pg_proc WHERE oid = '{SIG}'::regprocedure") == '{"search_path=public, pg_temp",lock_timeout=5s}',
            "the reviewed settings return: search_path public, pg_temp and a 5s lock timeout")
    require(q("live", f"SELECT has_function_privilege('authenticated', '{SIG}', 'EXECUTE') AND has_function_privilege('service_role', '{SIG}', 'EXECUTE')"
                      f" AND NOT has_function_privilege('anon', '{SIG}', 'EXECUTE')") == "t",
            "signed-in players and the service role may call it; anon may not")
    require(money("live") == seeded_money, f"the install moved no chips ({seeded_money})")

    after = observe("live", seeded_money)
    require(all(after.values()), f"all {len(after)} cases pass after the install "
            f"(failing: {sorted(k for k, ok in after.items() if not ok)})")
    require(proofs("live") == ["true"] * len(PROOFS), "every @live-proof is true after the install")

    settled = catalog("live")
    out = run(psql("live"), MIGRATION)
    require("already the reviewed body; skipping" in out.stderr and catalog("live") == settled,
            "a re-run installs nothing twice and changes nothing")
    require(all(observe("live", seeded_money).values()), "every case still passes after the re-run")
    print(f"PASS: only club staff can remove a member ({len(FAIL_BEFORE)} of {len(before)} cases fail before, "
          f"{len(after)} of {len(after)} pass after)", flush=True)
finally:
    if started:
        run([PG / "pg_ctl", "-D", data, "-m", "fast", "-w", "stop"])
    shutil.rmtree(cluster, ignore_errors=True)
