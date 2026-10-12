#!/usr/bin/env python3
"""Qualify 20261012030847_the_statement_counts_each_move_once_and_names_its_wallet
on a private PostgreSQL 17 cluster (127.0.0.1, a free port or $CS_DB_PORT,
trust auth, a temporary data directory under $TMPDIR). Nothing here reaches
production.

1. Production's live statement row body (sliced from 20261011225840, #6688,
   the file that installed it over #6615) is reproduced byte for byte: its
   md5 must equal the preimage the migration pins (b1f42803..., read back
   from production on 2026-10-12). The fixture carries production's fn_arena_name and statement
   indexes, #6615's direction cover included (db-production-shape.sql).
2. FAIL BEFORE: tests/fixtures/cashier-statements/db-one-move-once.sql fails
   on the live body; the maintained oracle regression.sql passes on it.
3. The migration refuses a drifted body, an invalid index and a replay, and a
   rolled-back run leaves every function as it was.
4. PASS AFTER: db-one-move-once.sql passes; regression.sql fails only the seven
   assertions that pin the defects this migration fixes; every other
   statement function is byte-identical; owner, ACL, definer and search_path
   are unchanged; the totals equal their own unlimited page for every viewer,
   scope and filter (the default all-scope totals take #6615's directional
   fast path, read as #6688's concurrent slices, every filtered one the per-branch path; both are checked, the
   NaN and omission boundaries of #6615 included); no entry appears or
   disappears on the maintained
   fixture, and a direction changes only on the receipts the fix names.
5. PLAN: on a wide synthetic club the all-scope totals stay index-only scans
   (receipts, the viewer's own receipts, #6615's ledger direction cover), the
   mirrored legs come from the new partial index, and nothing reads either
   table by a sequential scan.
"""
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIX = ROOT / "tests/fixtures/cashier-statements"
MIG = ROOT / "supabase/migrations/20261012030847_the_statement_counts_each_move_once_and_names_its_wallet.sql"
# The file that installed production's live body: #6688's concurrent slices
# of #6615's directional totals.
LIVE_SOURCE = ROOT / "supabase/migrations/20261011225840_cashier_totals_read_the_range_as_concurrent_slices.sql"
BASE = ROOT / "supabase/migrations/20260923131325_cashier_statements_read_every_wallet_in_one_keyset.sql"
# CI installs PostgreSQL 17 at the Debian path; a Mac has it under Homebrew.
PG = Path(os.environ.get("PG_BIN") or next((p for p in ("/usr/lib/postgresql/17/bin", "/opt/homebrew/opt/postgresql@17/bin")
                                            if (Path(p) / "initdb").exists()), "/usr/lib/postgresql/17/bin"))
SIG = "public.fn_cashier_statement_rows(uuid,uuid,text,timestamptz,timestamptz,jsonb,timestamptz,text,uuid,integer)"
INDEX = "idx_chip_ledger_statement_mirror_legs"
ENV = {"PATH": f"{PG}:/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}

cluster = Path(tempfile.mkdtemp(prefix="cs-db-", dir=os.environ.get("TMPDIR")))
data = cluster / "data"
if os.environ.get("CS_DB_PORT"):
    PORT = int(os.environ["CS_DB_PORT"])
else:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        PORT = s.getsockname()[1]
started = False


def psql(db, user="postgres", stop=True):
    return [str(PG / "psql"), "-X", "-qAt", "-v", f"ON_ERROR_STOP={1 if stop else 0}",
            "-h", "127.0.0.1", "-p", str(PORT), "-U", user, "-d", db]


def run(argv, text=None, expect_fail=None, timeout=600):
    p = subprocess.run(argv, input=text, capture_output=True, text=True, env=ENV, timeout=timeout)
    if expect_fail is not None:
        if p.returncode == 0 or expect_fail not in p.stderr:
            raise AssertionError(f"expected failure containing {expect_fail!r}\n{p.stdout}\n{p.stderr[-3000:]}")
        return p
    if p.returncode:
        log = (cluster / "server.log").read_text()[-3000:] if (cluster / "server.log").exists() else ""
        raise RuntimeError(p.stdout[-3000:] + p.stderr[-3000:] + log)
    return p


def q(db, sql, user="postgres", expect_fail=None):
    return run(psql(db, user), sql, expect_fail).stdout.strip()


def require(cond, label):
    if not cond:
        raise AssertionError("FAIL: " + label)
    print("PASS: " + label, flush=True)


def slice_function(text, name):
    start = text.index(f"CREATE OR REPLACE FUNCTION public.{name}(")
    return text[start:text.index("$function$;", start) + len("$function$;")]


MIGRATION = MIG.read_text()
PRE = re.search(r"IS DISTINCT FROM '([0-9a-f]{32})' THEN\n    RAISE EXCEPTION 'fn_cashier_statement_rows is not the live text", MIGRATION).group(1)
POST = re.search(r"-- @live-proof: \(SELECT md5\(pg_get_functiondef\('" + re.escape(SIG) + r"'::regprocedure\)\) = '([0-9a-f]{32})'\)", MIGRATION).group(1)
LIVE_BODY = slice_function(LIVE_SOURCE.read_text(), "fn_cashier_statement_rows")


def catalog(db):
    return json.loads(q(db, """SELECT jsonb_object_agg(oid::regprocedure::text, jsonb_build_object(
      'owner', pg_get_userbyid(proowner), 'acl', proacl, 'config', proconfig, 'definer', prosecdef,
      'volatility', provolatile, 'definition', pg_get_functiondef(oid)))
      FROM pg_proc WHERE pronamespace = 'public'::regnamespace
       AND (proname LIKE 'fn\\_cashier\\_statement\\_%' OR proname IN ('fn_arena_name', 'fn_club_bank_role', 'fn_club_is_in_downline'))"""))


def rows_md5(db):
    return q(db, f"SELECT md5(pg_get_functiondef('{SIG}'::regprocedure))")


def build(db):
    q("postgres", f"DROP DATABASE IF EXISTS {db}", user="fixture_bootstrap")
    q("postgres", f"CREATE DATABASE {db} OWNER postgres", user="fixture_bootstrap")
    q(db, "ALTER SCHEMA public OWNER TO postgres", user="fixture_bootstrap")
    q(db, "\n".join(l for l in (FIX / "bootstrap.sql").read_text().splitlines() if not l.startswith("CREATE ROLE ")))
    q(db, (FIX / "baseline.sql").read_text())
    q(db, BASE.read_text())
    q(db, (FIX / "db-production-shape.sql").read_text())
    q(db, LIVE_BODY)


def regression_db(db, expect_pass):
    p = subprocess.run(psql(db), input="BEGIN;\n" + (FIX / "db-one-move-once.sql").read_text() + "\nROLLBACK;\n",
                       capture_output=True, text=True, env=ENV, timeout=300)
    passes = re.findall(r"PASS: (.*)", p.stderr)
    fails = re.findall(r"FAIL: (.*)", p.stderr)
    if expect_pass:
        total = len(re.findall(r"^SELECT assert_true\(", (FIX / "db-one-move-once.sql").read_text(), re.M))
        require(p.returncode == 0 and not fails and len(passes) == total,
                f"db-one-move-once.sql: all {total} assertions pass ({len(passes)} passed)")
    else:
        require(p.returncode != 0 and len(fails) == 1,
                f"db-one-move-once.sql fails on production's live body (first failure: {fails[0] if fails else p.stderr[-300:]})")


def regression_failures(db):
    # Every assertion of db-one-move-once.sql, autocommit and ON_ERROR_STOP=0,
    # on a throwaway database: the whole list of failures, not the first one.
    p = subprocess.run(psql(db, stop=False), input=(FIX / "db-one-move-once.sql").read_text(),
                       capture_output=True, text=True, env=ENV, timeout=300)
    return re.findall(r"ERROR:  FAIL: (.*)", p.stderr), re.findall(r"PASS: (.*)", p.stderr)


def maintained_oracle(db, expected_failures):
    # Autocommit with ON_ERROR_STOP=0, on a throwaway database: every
    # assertion runs, so the failures are the whole list, not the first one.
    p = subprocess.run(psql(db, "fixture_bootstrap", stop=False), input=(FIX / "regression.sql").read_text(),
                       capture_output=True, text=True, env=ENV, timeout=600)
    fails = re.findall(r"ERROR:  FAIL: (.*)", p.stderr)
    errors = [l for l in p.stderr.splitlines() if "ERROR:" in l and "FAIL:" not in l]
    passes = re.findall(r"PASS: (.*)", p.stderr)
    require(not errors, "regression.sql raises nothing but its own assertions" + ("" if not errors else f": {errors[:3]}"))
    require(sorted(fails) == sorted(expected_failures),
            f"regression.sql fails exactly {len(expected_failures)} assertion(s) ({len(passes)} pass): {fails}")
    return len(passes)


VIEWERS = [(1, "all"), (2, "all"), (4, "all"), (10, "downline"), (11, "downline"), (12, "downline"),
           (20, "self"), (21, "self"), (22, "self"), (25, "self")]
FILTERS = ['{}', '{"wallet":"player"}', '{"wallet":"table"}', '{"wallet":"cashout"}', '{"wallet":"agent"}',
           '{"wallet":"bank"}', '{"wallet":"promo"}', '{"wallet":"union"}', '{"wallet":"ticket"}',
           '{"wallet":"other"}', '{"direction":"in"}', '{"direction":"out"}', '{"direction":"managed"}',
           '{"state":"posted"}', '{"state":"pending"}', '{"state":"reversed"}', '{"state":"clawed_back"}',
           '{"operation":"refund"}', '{"operation":"club_bank_send"}', '{"counterparty":"Player Twenty"}',
           '{"counterparty":"00000000-0000-0000-0000-000000000020"}', '{"counterparty":"%_"}',
           '{"reference":"op-r1"}', '{"reference":"cl-2001"}']


def call(club, viewer, scope, filters, limit):
    lim = "NULL" if limit is None else str(limit)
    return (f"SELECT * FROM public.fn_cashier_statement_rows(u({club}), u({viewer}), '{scope}', "
            f"'2026-09-01Z', '2026-09-30Z', '{filters}'::jsonb, NULL, NULL, NULL, {lim})")


def totals(db, club, viewer, scope, filters):
    return q(db, "SELECT coalesce(jsonb_agg(jsonb_build_array(entry_direction, entry_amount, entry->'count') "
                 "ORDER BY entry_direction), '[]') FROM (" + call(club, viewer, scope, filters, 0) + ") t")


def page_totals(db, club, viewer, scope, filters):
    return q(db, "SELECT coalesce(jsonb_agg(jsonb_build_array(d, a, c) ORDER BY d), '[]') FROM ("
                 "SELECT entry_direction d, sum(entry_amount) a, to_jsonb(count(*)) c FROM ("
                 + call(club, viewer, scope, filters, None) + ") p GROUP BY entry_direction) t")


def entries(db, club, viewer, scope, filters="{}"):
    return json.loads(q(db, "SELECT coalesce(jsonb_object_agg((entry->>'source') || ':' || (entry->>'id'), "
                            "jsonb_build_array(entry->>'amount', entry->>'state', entry->>'direction')), '{}') FROM ("
                        + call(club, viewer, scope, filters, None) + ") p"))


try:
    run([PG / "initdb", "-D", data, "-U", "fixture_bootstrap", "--auth-local=trust", "--auth-host=trust",
         "--no-locale", "-E", "UTF8"])
    with (data / "postgresql.conf").open("a") as f:
        f.write(f"\nlisten_addresses='127.0.0.1'\nport={PORT}\nunix_socket_directories=''\n"
                "shared_buffers='64MB'\nmax_connections=20\nautovacuum=off\nfsync=off\n")
    run([PG / "pg_ctl", "-D", data, "-l", cluster / "server.log", "-w", "start"])
    started = True
    q("postgres", "CREATE ROLE postgres LOGIN NOSUPERUSER BYPASSRLS CREATEDB CREATEROLE; "
                  "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; "
                  "GRANT anon, authenticated, service_role TO postgres WITH SET TRUE; "
                  "CREATE ROLE authenticator LOGIN NOINHERIT; "
                  "GRANT anon, authenticated, service_role TO authenticator WITH SET TRUE;", user="fixture_bootstrap")

    # 1. Production's live body, reproduced.
    build("before")
    require(rows_md5("before") == PRE, f"the fixture holds production's live row body byte for byte (md5 {PRE})")
    require(json.loads(q("before", "SELECT json_build_array(rolsuper, rolbypassrls) FROM pg_roles WHERE rolname = 'postgres'")) == [False, True],
            "functions are owned by a NOSUPERUSER BYPASSRLS postgres, as in production")
    original = catalog("before")
    require(original[SIG.replace("public.", "").replace("timestamptz", "timestamp with time zone")]["acl"] == ["postgres=X/postgres"],
            "the row query is owner-only before the migration")

    # 2. Fail before; the maintained oracle passes on the live body.
    regression_db("before", expect_pass=False)
    q("postgres", "CREATE DATABASE count_before TEMPLATE before OWNER postgres", user="fixture_bootstrap")
    failed, passed = regression_failures("count_before")
    require(len(failed) > 0 and "the player's totals count each move once, where its chips moved" in failed
            and "the owner paid and received nothing personally" in failed,
            f"on production's live body {len(failed)} of {len(failed) + len(passed)} db-one-move-once.sql assertions fail, "
            "the default all-scope totals (#6615's fast path, sliced by #6688) among them")
    q("postgres", "CREATE DATABASE oracle_before TEMPLATE before OWNER postgres", user="fixture_bootstrap")
    maintained_oracle("oracle_before", [])
    before = {(v, s, f): entries("before", 100, v, s, f) for v, s in VIEWERS for f in ['{}', '{"wallet":"bank"}', '{"counterparty":"%_"}']}

    # 3. Refusals: a drifted body, an invalid index, a rolled-back run.
    q("postgres", "CREATE DATABASE refusals TEMPLATE before OWNER postgres", user="fixture_bootstrap")
    q("refusals", "UPDATE pg_proc SET prosrc = prosrc || E'\\n-- drift' WHERE proname = 'fn_cashier_statement_rows'", user="fixture_bootstrap")
    run(psql("refusals"), MIGRATION, expect_fail="is not the live text this migration was written against")
    q("refusals", LIVE_BODY)
    q("refusals", f"UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'public.{INDEX}'::regclass", user="fixture_bootstrap")
    run(psql("refusals"), MIGRATION, expect_fail=f"{INDEX} is missing or not valid")
    q("refusals", f"UPDATE pg_index SET indisvalid = true WHERE indexrelid = 'public.{INDEX}'::regclass", user="fixture_bootstrap")
    run(psql("refusals"), MIGRATION.replace("\nCOMMIT;\n", "\nROLLBACK;\n"))
    require(catalog("refusals") == original, "a drifted body or an invalid index is refused, and a rolled-back run changes no function")
    p = subprocess.run(psql("refusals"), input="SET ROLE authenticated;\n" + MIGRATION,
                       capture_output=True, text=True, env=ENV, timeout=300)
    require(p.returncode != 0 and re.search(r"must be owner|permission denied", p.stderr) is not None and catalog("refusals") == original,
            "a browser role cannot install it")

    # 4. Pass after.
    build("after")
    rows_before = q("after", "SELECT md5(string_agg(t::text, '' ORDER BY t::text)) FROM (SELECT row_to_json(x)::text t FROM chip_ledger x UNION ALL SELECT row_to_json(y)::text FROM chip_transactions y) z")
    run(psql("after"), MIGRATION)
    after = catalog("after")
    target = SIG.replace("public.", "").replace("timestamptz", "timestamp with time zone")
    require(rows_md5("after") == POST, f"the installed body is the reviewed text (md5 {POST})")
    require({k: v for k, v in original[target].items() if k != "definition"} == {k: v for k, v in after[target].items() if k != "definition"},
            "owner, ACL ({postgres=X/postgres}), SECURITY DEFINER, search_path and volatility are unchanged")
    require(all(after[k] == v for k, v in original.items() if k != target), "every other statement function is byte-identical")
    require(q("after", f"SELECT indisvalid AND indisready FROM pg_index WHERE indexrelid = 'public.{INDEX}'::regclass") == "t", "the mirror-leg index is built and valid")
    require(q("after", "SELECT md5(string_agg(t::text, '' ORDER BY t::text)) FROM (SELECT row_to_json(x)::text t FROM chip_ledger x UNION ALL SELECT row_to_json(y)::text FROM chip_transactions y) z") == rows_before,
            "no money row is touched")
    run(psql("after"), MIGRATION, expect_fail="is not the live text this migration was written against")
    require(rows_md5("after") == POST, "a replay is refused and changes nothing")
    regression_db("after", expect_pass=True)

    q("postgres", "CREATE DATABASE oracle_after TEMPLATE after OWNER postgres", user="fixture_bootstrap")
    maintained_oracle("oracle_after", [
        "owner direction is viewer-relative",                                   # 1006 Club Bank send, 1007 horse seat: the operator is managed
        "a receipt entry has the exact contract shape",                         # the payer's label is fn_arena_name (user_10), not display_name
        "the counterparty of a received receipt is the payer",                  # the same: user_10, not Display 10
        "a total above 1e13 prints in full (never #)",                          # Club D's owner did not pay the Club Bank send: managed
        "horse funding reads as treasury funding with its marked note and keys withheld",  # it reads as club_bank_send
        "the printed kind is the one that filters",                             # treasury_funding no longer exists to filter
        "exactly 20,000 entries export",                                        # club C's 20,000 mints move none of the owner's chips: managed, not out
    ])

    for (v, s, f), was in before.items():
        now = entries("after", 100, v, s, f)
        require(set(now) == set(was), f"no entry appears or disappears on the maintained fixture: {v}/{s}/{f}")
        moved = sorted(k for k in now if now[k][2] != was[k][2])
        allowed = {"receipt:" + q("after", f"SELECT u({n})") for n in (1005, 1006, 1007)}
        require(set(moved) <= allowed, f"a direction changes only on the approval, the Club Bank send and the horse seat: {v}/{s} {moved}")
        require(all(now[k][:2] == was[k][:2] for k in now), f"amounts and states are unchanged: {v}/{s}/{f}")

    for v, s in VIEWERS:
        for f in FILTERS:
            require(totals("after", 100, v, s, f) == page_totals("after", 100, v, s, f), f"totals are their own page: {v}/{s}/{f}")

    # #6615's boundaries on the rebased body: NaN amounts, an omitted leg that
    # is NaN, a mirrored refund, and the totals still equal to their own page
    # on the default fast path and on every filtered path.
    q("postgres", "CREATE DATABASE boundaries TEMPLATE after OWNER postgres", user="fixture_bootstrap")
    q("boundaries", (FIX / "movement-totals-boundaries.sql").read_text())
    q("boundaries", """
      INSERT INTO chip_transactions(id,club_id,from_user_id,to_user_id,amount,transaction_type,created_at)
      VALUES(u(991001),u(100),u(20),u(1),'NaN','transfer','2026-09-07Z'),
            (u(991002),u(100),u(1),u(25),3.25,'transfer','2026-09-07Z');
      INSERT INTO chip_ledger(id,club_id,from_type,from_entity_id,to_type,to_entity_id,amount,category,idempotency_key,created_at)
      VALUES(u(991003),u(100),'club_wallet',u(1),'player_wallet',u(20),'NaN','refund','nan-mirror','2026-09-07Z');
      INSERT INTO chip_transactions(id,club_id,from_user_id,to_user_id,amount,transaction_type,metadata,created_at)
      VALUES(u(991004),u(100),u(1),u(20),2.5,'topup','{"idempotency_key":"nan-mirror"}','2026-09-07Z');""")
    for v, s in VIEWERS:
        for f in FILTERS:
            require(totals("boundaries", 100, v, s, f) == page_totals("boundaries", 100, v, s, f),
                    f"#6615 boundaries: totals are their own page: {v}/{s}/{f}")

    # 5. Plan: a wide club, the all-scope totals.
    # Twelve clubs over a year, so September of club u(100) is ~1% of each
    # table, as the busiest club's week is of production's: one in five ledger
    # legs a promo, one in two a prize, the rest buy-ins; one receipt in fifty
    # the owner's; a sweep receipt mirroring every promo leg of club u(100).
    q("after", """
      INSERT INTO public.chip_ledger(club_id, from_type, from_entity_id, to_type, to_entity_id, amount, category, created_at, status)
      SELECT u(100 + n % 12), CASE WHEN n % 5 = 0 THEN 'bbj_pool' ELSE 'prize_liability' END, u(600 + n % 7),
             CASE WHEN n % 5 = 0 THEN 'promo_wallet' ELSE 'player_wallet' END,
             CASE WHEN n % 5 = 0 THEN u(100 + n % 12) ELSE u(20 + n % 3) END,
             1 + (n % 1000) / 100.0, CASE WHEN n % 5 = 0 THEN 'promo' WHEN n % 2 = 0 THEN 'tournament_prize' ELSE 'buyin' END,
             '2026-01-01Z'::timestamptz + n * interval '52 second', 'posted'
        FROM generate_series(1, 600000) n;
      INSERT INTO public.chip_transactions(club_id, from_user_id, to_user_id, amount, transaction_type, created_at)
      SELECT u(100 + n % 12), CASE WHEN n % 50 = 0 THEN u(1) ELSE u(20 + n % 3) END, NULL, 1 + (n % 1000) / 100.0, 'tournament_buyin',
             '2026-01-01Z'::timestamptz + n * interval '79 second'
        FROM generate_series(1, 400000) n;
      INSERT INTO public.chip_transactions(club_id, from_user_id, to_user_id, amount, transaction_type, created_at)
      SELECT u(100 + n % 12), NULL, NULL, 1 + (n % 1000) / 100.0, 'bbj_promo_sweep', '2026-01-01Z'::timestamptz + n * interval '52 second'
        FROM generate_series(5, 600000, 60) n;
      VACUUM (ANALYZE) public.chip_ledger;
      VACUUM (ANALYZE) public.chip_transactions;""", user="fixture_bootstrap")
    require(totals("after", 100, 1, "all", "{}") == page_totals("after", 100, 1, "all", "{}"), "wide club: the owner's totals are the owner's page")
    p = run(psql("after", "fixture_bootstrap"), f"""
      LOAD 'auto_explain';
      SET auto_explain.log_min_duration = 0;
      SET auto_explain.log_nested_statements = on;
      SET auto_explain.log_format = 'json';
      SET auto_explain.log_level = 'notice';
      SET max_parallel_workers_per_gather = 0;
      SET ROLE authenticated;
      SELECT public.as_user(1);
      SELECT public.fn_cashier_statement_totals(public.u(100), '2026-09-01Z', '2026-09-30Z', '{{}}');""")
    plans = p.stderr
    scans = re.findall(r'"Node Type": "(Seq Scan|Index Scan|Index Only Scan|Bitmap Heap Scan)"[\s\S]*?"Relation Name": "([a-z_]+)"', plans)
    require(not [s for s in scans if s[0] == "Seq Scan" and s[1] in ("chip_ledger", "chip_transactions")],
            "the all-scope totals read neither table by a sequential scan")
    for idx in ("idx_chip_tx_club_time_totals", "chip_transactions_club_from_created_idx",
                "chip_transactions_club_to_created_idx",
                "(idx_chip_ledger_cashier_direction_totals|idx_chip_ledger_cashier_totals_cover)"):
        require(re.search(r'"Node Type": "Index Only Scan",[^{{]*?"Index Name": "' + idx + '"', plans) is not None,
                f"the all-scope totals read {idx} index-only")
    require(re.search(r'"Index Name": "' + INDEX + '"', plans) is not None, f"the mirrored legs come from {INDEX}")
    # The page keeps its shape: every branch a Limit over an index scan, the
    # mirror probe an index lookup at the leg's own instant, no Seq Scan.
    p = run(psql("after", "fixture_bootstrap"), """
      LOAD 'auto_explain';
      SET auto_explain.log_min_duration = 0;
      SET auto_explain.log_nested_statements = on;
      SET auto_explain.log_format = 'json';
      SET auto_explain.log_level = 'notice';
      SET ROLE authenticated;
      SELECT public.as_user(1);
      SELECT public.fn_cashier_statement_page(public.u(100), '2026-09-01Z', '2026-09-30Z', '{}', NULL, 50);
      SELECT public.as_user(20);
      SELECT public.fn_cashier_statement_page(public.u(100), '2026-09-01Z', '2026-09-30Z', '{}', NULL, 50);""")
    page_scans = re.findall(r'"Node Type": "(Seq Scan|Index Scan|Index Only Scan|Bitmap Heap Scan)"[\s\S]*?"Relation Name": "([a-z_]+)"', p.stderr)
    require(page_scans and not [s for s in page_scans if s[0] == "Seq Scan" and s[1] in ("chip_ledger", "chip_transactions")],
            "the owner's and the player's pages read neither table by a sequential scan")
    require(re.search(r'"Alias": "mirror"', p.stderr) is not None and '"Node Type": "Limit"' in p.stderr,
            "each page branch is limited and the mirror probe is planned as an index lookup")
    print("PASS: the statement counts each move once and names its wallet", flush=True)
finally:
    if started:
        run([PG / "pg_ctl", "-D", data, "-m", "fast", "-w", "stop"])
    shutil.rmtree(cluster, ignore_errors=True)
