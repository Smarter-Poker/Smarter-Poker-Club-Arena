#!/usr/bin/env python3
"""Qualify 20261012040851_tournament_chat_is_off_by_default on a private
PostgreSQL 17 cluster (127.0.0.1, a free port in 55800-55849, trust auth, a
temporary data directory under $TMPDIR). Nothing here reaches production.

Dan, 2026-10-11: "Off by default for all tournaments. Spins and Sit N Gos can
have chat on." Existing schedules and not-yet-started tournaments switch too.

The governed creator behind fn_create_tournament is rebuilt from main's own
migrations exactly as production holds it (20260903172703, then the
20260911112409 overlays, the 20260912044409 guard and the 20260917065000
edits), each step checked against the md5 its migration pinned, and the result
against production's definition md5 bf284ab7932447a7d2e49a1fa7deb9d8. The
tables and the guards the UPDATE meets are stand-ins
(tests/fixtures/tournament-chat-default-db/fixture.sql).

FAIL BEFORE: an MTT created without a banChat, an MTT row inserted without
ban_chat (the engine's recurring creator), an MTT schedule saved without
banChat, and every registering MTT-family event keep chat on. PASS AFTER: all
of those ban chat; Spins and Sit N Gos keep chat; an explicit false is honoured;
running, late-registration, completed and retired-club events are untouched;
no other column moves. A drifted creator, a row the ownership trigger would
move and a rolled-back run each install nothing, and a re-run changes nothing.
"""
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIGS = ROOT / "supabase/migrations"
MIG = MIGS / "20261012040851_tournament_chat_is_off_by_default.sql"
FIXTURE = ROOT / "tests/fixtures/tournament-chat-default-db/fixture.sql"
PG = Path(os.environ.get("PG_BIN") or next((p for p in ("/usr/lib/postgresql/17/bin", "/opt/homebrew/opt/postgresql@17/bin")
                                            if (Path(p) / "initdb").exists()), "/usr/lib/postgresql/17/bin"))
SIG = "public.fn_create_tournament_governed_legacy(uuid,jsonb)"
LIVE_DEF_MD5 = "bf284ab7932447a7d2e49a1fa7deb9d8"
LIVE_SRC_MD5 = "9ff1b6c1c1396145d62face4867fbf0f"
ENV = {"PATH": f"{PG}:/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}

MIGRATION = MIG.read_text()
POST = re.search(r"^-- @live-proof: \(SELECT md5\(pg_get_functiondef\('" + re.escape(SIG) + r"'::regprocedure\)\) = '([0-9a-f]{32})'\)$",
                 MIGRATION, re.M).group(1)
PROOFS = [m.group(1).strip() for m in re.finditer(r"^-- @live-proof: (.+)$", MIGRATION, re.M)]
FIXTURE_SQL, GUARDS_SQL = FIXTURE.read_text().split("\n-- @guards:", 1)
GUARDS_SQL = "-- @guards:" + GUARDS_SQL


def md5(s):
    return hashlib.md5(s.encode()).hexdigest()


def rebuild_creator():
    """Production's governed creator, from the four migrations that wrote it."""
    a = (MIGS / "20260903172703_an_event_may_restart_every_week.sql").read_text()
    i = a.index("CREATE OR REPLACE FUNCTION public.fn_create_tournament_governed_legacy(")
    j = a.index("$function$", i) + len("$function$")
    head, src = a[i:j], a[j:a.index("$function$", j)]
    assert md5(src) == "855086582b43d915ed6bc4c124a34696", "20260903172703 body"
    b = (MIGS / "20260911112409_persist_eligible_free_buy_creation_options.sql").read_text()
    overlays = re.findall(r"overlay\((\w+) PLACING \$(\w+)\$(.*?)\$\2\$ FROM (\d+) FOR 0\)", b, re.S)
    assert len(overlays) == 3, "20260911112409 overlays"
    for _var, _tag, fragment, pos in overlays:  # PostgreSQL positions are 1-based
        src = src[: int(pos) - 1] + fragment + src[int(pos) - 1:]
    assert md5(src) == "ef2671b3cb67a8c710a7fbe3f0431ef6", "20260911112409 postimage"
    c = (MIGS / "20260912044409_remaining_tournament_variant_allowlist.sql").read_text()
    anchor, guard = re.search(r"replace\(v_source, \$anchor\$(.*?)\$anchor\$, \$guard\$(.*?)\$guard\$\)", c, re.S).groups()
    assert src.count(anchor) == 1
    src = src.replace(anchor, guard)
    assert md5(src) == "d00caa094f988ca352b6f7038f660c19", "20260912044409 postimage"
    d = (MIGS / "20260917065000_mtt_dual_creation_preparation.sql").read_text()
    targets = json.loads(d[d.index("$targets$[") + len("$targets$"):d.index("]$targets$") + 1])
    item = next(t for t in targets if t["signature"] == SIG)
    for edit in item["edits"]:
        assert src.count(edit["old"]) == 1, edit["old"][:60]
        src = src.replace(edit["old"], edit["new"])
    assert md5(src) == item["post_source_md5"] == LIVE_SRC_MD5, "20260917065000 postimage"
    return head + src + "$function$;\n" + (
        f"REVOKE ALL ON FUNCTION {SIG} FROM PUBLIC, anon, authenticated;\n"
        f"GRANT EXECUTE ON FUNCTION {SIG} TO service_role;\n")


CREATOR = rebuild_creator()

with socket.socket() as probe_socket:
    PORT = None
    for candidate in range(55800, 55850):
        try:
            probe_socket.bind(("127.0.0.1", candidate))
            PORT = candidate
            break
        except OSError:
            continue
assert PORT, "no free port in 55800-55849"
cluster = Path(tempfile.mkdtemp(prefix="chat-default-db-", dir=os.environ.get("TMPDIR")))
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


C1, C2, CR, U1, PLAYER, HOST = u(1), u(2), u(3), u(9), u(50), u(60)
T = {k: u(100 + i) for i, k in enumerate(
    ["reg_mtt_players", "reg_bounty", "ann_satellite", "reg_spin", "reg_sng", "running_mtt",
     "completed_mtt", "late_reg_mtt", "retired_mtt", "reg_mtt_already"])}
S = {k: u(200 + i) for i, k in enumerate(
    ["mtt", "pko", "spin", "sng", "hu_linked", "mtt_false", "mtt_null", "retired_mtt", "heads_up"])}

SEED = f"""
INSERT INTO public.unions VALUES ('{U1}');
INSERT INTO public.clubs(id, lifecycle_status, asset) VALUES
  ('{C1}', 'active', 'chips'), ('{C2}', 'active', 'diamonds'), ('{CR}', 'retired', 'chips');
INSERT INTO public.tournaments(id, club_id, name, variant, tournament_type, status, ban_chat, buy_in_amount, blind_structure) VALUES
  ('{T['reg_mtt_players']}', '{C1}', 'Sunday Major', 'freezeout', 'MTT', 'REGISTERING', false, 100, '[]'),
  ('{T['reg_bounty']}', '{C1}', 'Bounty Builder', 'bounty', 'MTT', 'REGISTERING', false, 50, '[]'),
  ('{T['ann_satellite']}', '{C2}', 'Seat Satellite', 'satellite', 'SATELLITE', 'ANNOUNCED', false, 10, '[]'),
  ('{T['reg_spin']}', '{C1}', 'Spin', 'spin', 'SPIN', 'REGISTERING', false, 5, '[]'),
  ('{T['reg_sng']}', '{C1}', 'Sit N Go', 'sng', 'SNG', 'REGISTERING', false, 5, '[]'),
  ('{T['running_mtt']}', '{C1}', 'Running', 'freezeout', 'MTT', 'RUNNING', false, 20, '[]'),
  ('{T['completed_mtt']}', '{C1}', 'Done', 'freezeout', 'MTT', 'COMPLETED', false, 20, '[]'),
  ('{T['late_reg_mtt']}', '{C1}', 'Late', 'freezeout', 'MTT', 'LATE_REG', false, 20, '[]'),
  ('{T['retired_mtt']}', '{CR}', 'Retired', 'freezeout', 'MTT', 'REGISTERING', false, 20, '[]'),
  ('{T['reg_mtt_already']}', '{C1}', 'Quiet', 'freezeout', 'MTT', 'REGISTERING', true, 20, '[]');
INSERT INTO public.tournament_players VALUES
  ('{T['reg_mtt_players']}', '{PLAYER}'), ('{T['ann_satellite']}', '{PLAYER}'),
  ('{T['running_mtt']}', '{PLAYER}'), ('{T['reg_spin']}', '{PLAYER}');
INSERT INTO public.tournament_schedules(id, club_id, name, config) VALUES
  ('{S['mtt']}', '{C1}', 'Daily', '{{"type":"mtt","name":"Daily","buyIn":10}}'),
  ('{S['pko']}', '{C2}', 'PKO', '{{"type":"progressive_bounty"}}'),
  ('{S['spin']}', '{C1}', 'Spin', '{{"type":"spin"}}'),
  ('{S['sng']}', '{C1}', 'SNG', '{{"type":" SNG "}}'),
  ('{S['hu_linked']}', '{C1}', 'HU Sat', '{{"type":"hu_sng","satelliteTarget":{{"tournamentId":"{T['reg_mtt_players']}"}}}}'),
  ('{S['mtt_false']}', '{C1}', 'Chatty', '{{"type":"mtt","banChat":false}}'),
  ('{S['mtt_null']}', '{C1}', 'Null', '{{"banChat":null}}'),
  ('{S['retired_mtt']}', '{CR}', 'Retired', '{{"type":"mtt"}}'),
  ('{S['heads_up']}', '{C1}', 'HU', '{{"type":"heads_up"}}');
"""

AS_HOST = f"SELECT set_config('request.jwt.claims', '{{\"sub\":\"{HOST}\",\"role\":\"authenticated\"}}', true);"
BLINDS = '[{"level":1,"smallBlind":10,"bigBlind":20,"ante":0,"duration":10}]'
PAYOUTS = '[{"position":1,"percentage":100}]'


def create(cfg):
    """fn_create_tournament's governed creator, as a host; the row's ban_chat, rolled back."""
    body = dict(cfg, blindStructure=json.loads(BLINDS), payoutStructure=json.loads(PAYOUTS), maxPlayers=6, buyIn=10)
    sql = (f"BEGIN;\n\\o /dev/null\n{AS_HOST}\n\\o\n"
           f"SELECT public.fn_create_tournament_governed_legacy('{C1}', $cfg${json.dumps(body)}$cfg$::jsonb)::text AS r \\gset\n"
           "SELECT COALESCE((SELECT left(t.ban_chat::text, 1) FROM public.tournaments t "
           "WHERE t.id = (:'r'::jsonb->>'tournament_id')::uuid), :'r');\nROLLBACK;")
    return sql


def insert(tt, chat=None):
    """The engine's recurring creator: an INSERT that may or may not name ban_chat."""
    cols, vals = "club_id, name, tournament_type, status", f"'{C1}', 'Recurring', '{tt}', 'ANNOUNCED'"
    if chat is not None:
        cols, vals = cols + ", ban_chat", vals + f", {str(chat).lower()}"
    return f"BEGIN;\nINSERT INTO public.tournaments({cols}) VALUES ({vals}) RETURNING ban_chat;\nROLLBACK;"


def save_schedule(cfg, update_of=None):
    if update_of:
        stmt = f"UPDATE public.tournament_schedules SET config = $c${json.dumps(cfg)}$c$::jsonb WHERE id = '{update_of}' RETURNING config->'banChat';"
    else:
        stmt = f"INSERT INTO public.tournament_schedules(club_id, name, config) VALUES ('{C1}', 'New', $c${json.dumps(cfg)}$c$::jsonb) RETURNING config->'banChat';"
    return f"BEGIN;\n{stmt}\nROLLBACK;"


def chat(db, key):
    return q(db, f"SELECT ban_chat FROM public.tournaments WHERE id = '{T[key]}'")


def sched(db, key):
    return q(db, f"SELECT COALESCE(config->'banChat', '\"absent\"'::jsonb)::text FROM public.tournament_schedules WHERE id = '{S[key]}'")


def last(out):
    return out.splitlines()[-1] if out else ""


# Every behaviour the owner asked for, as (name, sql, wanted answer).
CASES = [
    ("an MTT created without banChat bans chat", lambda: create({"type": "mtt"}), "t"),
    ("a bounty event created without banChat bans chat", lambda: create({"type": "bounty", "bountyAmount": 2}), "t"),
    ("a satellite created without banChat bans chat", lambda: create({"type": "satellite"}), "t"),
    ("an event created with no type at all bans chat", lambda: create({}), "t"),
    ("a Spin created without banChat keeps chat", lambda: create({"type": "spin"}), "f"),
    ("a Sit N Go created without banChat keeps chat", lambda: create({"type": "sng"}), "f"),
    ("an MTT created with banChat false keeps chat (the host's choice)", lambda: create({"type": "mtt", "banChat": False}), "f"),
    ("a Sit N Go created with banChat true bans chat", lambda: create({"type": "sng", "banChat": True}), "t"),
    ("an MTT inserted without ban_chat (the recurring creator) bans chat", lambda: insert("MTT"), "t"),
    ("a SATELLITE inserted without ban_chat bans chat", lambda: insert("SATELLITE"), "t"),
    ("a SPIN inserted without ban_chat keeps chat", lambda: insert("SPIN"), "f"),
    ("an SNG inserted without ban_chat keeps chat", lambda: insert("SNG"), "f"),
    ("an MTT inserted with ban_chat false keeps it", lambda: insert("MTT", False), "f"),
    ("an MTT schedule saved without banChat gets banChat true", lambda: save_schedule({"type": "mtt"}), "true"),
    ("a mystery bounty schedule saved without banChat gets banChat true", lambda: save_schedule({"type": "mystery_bounty"}), "true"),
    ("a Spin schedule saved without banChat is left alone", lambda: save_schedule({"type": "spin"}), ""),
    ("a heads-up Sit N Go schedule saved without banChat is left alone", lambda: save_schedule({"type": "hu_sng"}), ""),
    ("a Sit N Go label linked to a satellite target is an MTT satellite and gets banChat true",
     lambda: save_schedule({"type": "sng", "satelliteTargetId": T["reg_mtt_players"]}), "true"),
    ("an MTT schedule saved with banChat false keeps it", lambda: save_schedule({"type": "mtt", "banChat": False}), "false"),
    ("an MTT schedule edited to drop banChat gets it back", lambda: save_schedule({"type": "mtt"}, update_of=S["mtt_false"]), "true"),
]
STATE = [
    ("a registering MTT with registrants is switched", lambda db: chat(db, "reg_mtt_players"), "t"),
    ("a registering bounty event is switched", lambda db: chat(db, "reg_bounty"), "t"),
    ("an announced Diamond SATELLITE is switched", lambda db: chat(db, "ann_satellite"), "t"),
    ("an already silent MTT stays silent", lambda db: chat(db, "reg_mtt_already"), "t"),
    ("a registering Spin keeps chat", lambda db: chat(db, "reg_spin"), "f"),
    ("a registering Sit N Go keeps chat", lambda db: chat(db, "reg_sng"), "f"),
    ("a running MTT is untouched", lambda db: chat(db, "running_mtt"), "f"),
    ("a late-registration MTT (already dealing) is untouched", lambda db: chat(db, "late_reg_mtt"), "f"),
    ("a completed MTT is untouched", lambda db: chat(db, "completed_mtt"), "f"),
    ("a retired club's event is untouched", lambda db: chat(db, "retired_mtt"), "f"),
    ("the MTT schedule bans chat", lambda db: sched(db, "mtt"), "true"),
    ("the PKO schedule bans chat", lambda db: sched(db, "pko"), "true"),
    ("the target-linked heads-up schedule bans chat", lambda db: sched(db, "hu_linked"), "true"),
    ("the schedule with banChat null bans chat", lambda db: sched(db, "mtt_null"), "true"),
    ("the Spin schedule is untouched", lambda db: sched(db, "spin"), '"absent"'),
    ("the Sit N Go schedule is untouched", lambda db: sched(db, "sng"), '"absent"'),
    ("the heads-up schedule is untouched", lambda db: sched(db, "heads_up"), '"absent"'),
    ("the schedule a host set to chat keeps banChat false", lambda db: sched(db, "mtt_false"), "false"),
    ("the retired club's schedule is untouched", lambda db: sched(db, "retired_mtt"), '"absent"'),
]
FAIL_BEFORE = {
    "an MTT created without banChat bans chat", "a bounty event created without banChat bans chat",
    "a satellite created without banChat bans chat", "an event created with no type at all bans chat",
    "an MTT inserted without ban_chat (the recurring creator) bans chat",
    "a SATELLITE inserted without ban_chat bans chat",
    "an MTT schedule saved without banChat gets banChat true",
    "a mystery bounty schedule saved without banChat gets banChat true",
    "a Sit N Go label linked to a satellite target is an MTT satellite and gets banChat true",
    "an MTT schedule edited to drop banChat gets it back",
    "a registering MTT with registrants is switched", "a registering bounty event is switched",
    "an announced Diamond SATELLITE is switched", "the MTT schedule bans chat", "the PKO schedule bans chat",
    "the target-linked heads-up schedule bans chat", "the schedule with banChat null bans chat",
}


def observe(db):
    seen = {}
    for name, sql, want in CASES:
        seen[name] = last(q(db, sql())) == want
    for name, read, want in STATE:
        seen[name] = read(db) == want
    return seen


def digest(db):
    """Every row, less the one flag this migration may set."""
    return q(db, """SELECT md5(concat_ws('|',
      (SELECT string_agg((to_jsonb(t) - 'ban_chat')::text, ',' ORDER BY t.id) FROM public.tournaments t),
      (SELECT string_agg((to_jsonb(s) - 'config')::text || (s.config - 'banChat')::text, ',' ORDER BY s.id) FROM public.tournament_schedules s),
      (SELECT string_agg(p::text, ',' ORDER BY p::text) FROM public.tournament_players p)))""")


def catalog(db):
    return q(db, f"""SELECT md5(concat_ws('|',
      (SELECT string_agg(p.oid::regprocedure::text || md5(pg_get_functiondef(p.oid)) || coalesce(p.proacl::text, ''), ',' ORDER BY p.oid::regprocedure::text)
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace),
      (SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE NOT tgisinternal),
      (SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
        WHERE a.attrelid = 'public.tournaments'::regclass AND a.attname = 'ban_chat'),
      (SELECT string_agg(trigger_name, ',' ORDER BY trigger_name) FROM public.ca_declared_money_triggers),
      (SELECT string_agg(ban_chat::text, ',' ORDER BY id) FROM public.tournaments),
      (SELECT string_agg(config::text, ',' ORDER BY id) FROM public.tournament_schedules)))""")


def posture(db):
    return q(db, f"""SELECT json_build_array(pg_get_userbyid(proowner), prosecdef, provolatile, proconfig, proacl::text[],
      pg_get_function_result(oid)) FROM pg_proc WHERE oid = '{SIG}'::regprocedure""")


def proofs(db):
    out = []
    for p in PROOFS:
        r = subprocess.run(psql(db), input=f"SELECT ({p})::text;", capture_output=True, text=True, env=ENV, timeout=60)
        out.append(r.stdout.strip() if r.returncode == 0 else "error")
    return out


def install(db):
    q("postgres", f"CREATE DATABASE {db} OWNER postgres", user="fixture_bootstrap")
    q(db, "ALTER SCHEMA public OWNER TO postgres", user="fixture_bootstrap")
    q(db, FIXTURE_SQL)
    q(db, CREATOR)
    q(db, SEED)
    q(db, GUARDS_SQL)


try:
    run([PG / "initdb", "-D", data, "-U", "fixture_bootstrap", "--auth-local=trust", "--auth-host=trust", "--no-locale", "-E", "UTF8"])
    with (data / "postgresql.conf").open("a") as f:
        f.write(f"\nlisten_addresses='127.0.0.1'\nport={PORT}\nunix_socket_directories=''\nfsync=off\nautovacuum=off\ntimezone='UTC'\n")
    run([PG / "pg_ctl", "-D", data, "-l", cluster / "server.log", "-w", "start"])
    started = True
    print(f"PostgreSQL: {q('postgres', 'SHOW server_version', user='fixture_bootstrap')} on port {PORT}", flush=True)
    q("postgres", "CREATE ROLE postgres LOGIN NOSUPERUSER CREATEDB CREATEROLE; CREATE ROLE anon; CREATE ROLE authenticated; "
                  "CREATE ROLE service_role; GRANT anon, authenticated, service_role TO postgres WITH SET TRUE;",
      user="fixture_bootstrap")

    install("live")
    require(q("live", f"SELECT md5(prosrc) FROM pg_proc WHERE oid = '{SIG}'::regprocedure") == LIVE_SRC_MD5
            and q("live", f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure))") == LIVE_DEF_MD5,
            f"production's governed creator rebuilt from main's migrations byte for byte (definition md5 {LIVE_DEF_MD5})")
    early = proofs("live")
    require(len(PROOFS) == 4 and all(p != "true" for p in early), f"no @live-proof is true before the install ({early})")
    refused = subprocess.run(psql("live"), input=f"UPDATE public.tournaments SET ban_chat = true WHERE id = '{T['reg_mtt_players']}';",
                             capture_output=True, text=True, env=ENV, timeout=60)
    require(refused.returncode != 0 and "cannot be modified after a player has registered" in refused.stderr,
            "the lifecycle guard refuses a registered event's chat change to anyone but the service role")

    before = observe("live")
    failing = {k for k, ok in before.items() if not ok}
    require(failing == FAIL_BEFORE, f"production's behaviour fails exactly the {len(FAIL_BEFORE)} chat-off cases "
            f"(unexpected: {sorted(failing ^ FAIL_BEFORE)})")
    before_posture, before_rows = posture("live"), digest("live")

    # A drifted creator refuses the whole file.
    install("drift")
    q("drift", CREATOR.replace("'success', true, 'tournament_id'", "'success',  true, 'tournament_id'"))
    drift_catalog = catalog("drift")
    run(psql("drift"), MIGRATION, expect_fail="TOURNAMENT_CHAT_DEFAULT_PREIMAGE_CHANGED")
    require(catalog("drift") == drift_catalog, "a drifted creator refuses the file and installs nothing")

    # A row the ownership trigger would move refuses the whole file.
    install("side")
    q("side", f"INSERT INTO public.union_clubs VALUES ('{U1}', '{C1}')")
    side_catalog = catalog("side")
    run(psql("side"), MIGRATION, expect_fail="TOURNAMENT_CHAT_DEFAULT_SIDE_EFFECT")
    require(catalog("side") == side_catalog, "an UPDATE that would move any column but ban_chat refuses the file and installs nothing")

    live_catalog = catalog("live")
    run(psql("live"), MIGRATION.replace("\nCOMMIT;\n", "\nROLLBACK;\n"))
    require(catalog("live") == live_catalog, "a rolled-back run changes nothing")
    run(psql("live"), "SET ROLE authenticated;\n" + MIGRATION, expect_fail="ERROR")
    require(catalog("live") == live_catalog, "a browser role cannot install it")

    out = run(psql("live"), MIGRATION)
    require("3 not-yet-started tournament(s) switched to chat off" in out.stderr,
            "the install switches exactly the three registering or announced MTT-family events")
    require(q("live", f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure))") == POST,
            f"the installed creator is the reviewed text (md5 {POST})")
    require(posture("live") == before_posture, "the creator's owner, SECURITY DEFINER, search_path, result and grants are unchanged")
    require(q("live", "SELECT count(*) FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum "
                      "WHERE a.attrelid = 'public.tournaments'::regclass AND a.attname = 'ban_chat'") == "0"
            and q("live", "SELECT attnotnull FROM pg_attribute WHERE attrelid = 'public.tournaments'::regclass AND attname = 'ban_chat'") == "t",
            "tournaments.ban_chat keeps NOT NULL and has no column default")
    require(q("live", "SELECT count(*) FROM public.ca_declared_money_triggers WHERE table_name = 'tournaments' "
                      "AND trigger_name = 'a00_tournaments_chat_default'") == "1",
            "the new tournaments trigger declares itself in ca_declared_money_triggers")
    require(q("live", "SELECT has_function_privilege('anon', 'public.fn_ca_schedule_config_keeps_chat(jsonb)', 'EXECUTE')") == "f",
            "the schedule classifier is not executable by anon")
    require(digest("live") == before_rows, "no column but ban_chat and config.banChat moved, and no row was added or removed")

    after = observe("live")
    require(all(after.values()), f"all {len(after)} chat cases pass after the install "
            f"(failing: {sorted(k for k, ok in after.items() if not ok)})")
    require(proofs("live") == ["true"] * len(PROOFS), "every @live-proof is true after the install")

    settled = catalog("live")
    out = run(psql("live"), MIGRATION)
    require("already carries the chat default" in out.stderr and catalog("live") == settled and digest("live") == before_rows,
            "a re-run installs nothing twice and changes no row")
    require(all(observe("live").values()), "every case still passes after the re-run")
    print(f"PASS: tournament chat is off by default ({len(FAIL_BEFORE)} of {len(before)} cases fail before, "
          f"{len(after)} of {len(after)} pass after)", flush=True)
finally:
    if started:
        run([PG / "pg_ctl", "-D", data, "-m", "fast", "-w", "stop"])
    shutil.rmtree(cluster, ignore_errors=True)
