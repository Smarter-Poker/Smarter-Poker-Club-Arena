#!/usr/bin/env python3
"""Run a rollback-only Stage-B cash payer composition in an owned local clone.

Only the strict public payer and exact three-leaf contraction block are extracted
from Stage B. This is not a whole Stage-B deployment or terminal closure proof.
"""
from pathlib import Path
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import tempfile

DEFAULT_PSQL = "/opt/homebrew/opt/postgresql@17/bin/psql"
DISPOSABLE_ACKNOWLEDGEMENT = "DISPOSABLE_LOCAL_PG17_CLONE"
SYSTEM_DATABASES = frozenset(("postgres", "template0", "template1"))
LANE_MIGRATION_NAME = "the_settlement_lane_is_per_tournament_not_platform_wide"
BUST_ORDER_MIGRATION_NAME = "a_bust_is_ranked_by_when_it_happened"
BUST_ORDER_MIGRATION_SHA256 = "d2d0acba73031ed8617a243840eecea0e0e227a6dce5a78ce3ce2bfcfb79cf73"
STAGE_B_MIGRATION_NAME = "stage_b_current_postimage_contraction"
CASH_CONTRACTION_MIGRATION_NAME = "final_deal_receipts_survive_real_terminal_settlement"
CASH_CONTRACTION_BLOCK_SHA256 = "990f20650eb18c6bd3d105018fb920ca68faa47fcd9790ec09d71fdd35fb0c20"
STRICT_PAYER_DEFINITION_SHA256 = "f098184a100d5df647dbf9f05e8b81911330efccf7604b099a38086d9747e9aa"
PRIVATE_CORE_IDENTITY = "public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)"
PRIVATE_CORE_SOURCE_MD5 = "ebabbaf0456d80335aaa2e04471d0ab6"
PRIVATE_CORE_DEFINITION_MD5 = "5a3aa8bd1a48d18b793e39c09b645b41"
FINAL_DEAL_IDENTITY = "public.fn_settle_tournament_final_table_deal(uuid)"
FINAL_DEAL_SOURCE_MD5 = "b1941b2e55dade307ecd74068ab3e500"
FINAL_DEAL_DEFINITION_MD5 = "c7bee6802ab30d625c32503a4d6609e1"
COMPOSER_FINAL_DEAL_SOURCE_MD5 = "141c723b5225bcec588b8957cf039184"
NORMAL_CASH_IDENTITY = "public.fn_settle_tournament_places(uuid,uuid)"
NORMAL_CASH_SOURCE_MD5 = "6181734ff98555ecc04648186f6ebf24"
NORMAL_CASH_DEFINITION_MD5 = "c412c8b17186976df139f73a706175f2"
CASH_LEAF_POSTIMAGES = (
    (
        "public.fn_ca_settle_tournament_place_raw(uuid,integer,uuid,numeric)",
        "3585ddbfdb0a197243d5e6eefb6b670f",
        "f676b2cbb361896dfa61f7e5f9413f46",
    ),
    (
        "public.fn_ca_settle_tournament_bubble_raw(uuid,uuid,numeric)",
        "f1fc7a0bf480b1034f0f1d9cba3b4d0b",
        "6bbb0ff983fc61c9f8c18cc2201e0f93",
    ),
    (
        "public.fn_ca_settle_final_table_deal_share_raw(uuid,uuid,numeric)",
        "852e35483b67c1fc59b6347b51c79cb8",
        "3437a8e83051385947c6b48e7c399a90",
    ),
)
GUARDS = (
    "aa_guard_tournament_completing_claim",
    "aaa_guard_atomic_satellite_completion",
    "zzzz_freeze_finalized_tournament_prize_pool",
    "zzzz_tournament_pool_finalization_window_guard",
    "zzzz_tournaments_atomic_place_completion_guard",
    "zzzzz_tournaments_atomic_final_table_deal_completion_guard",
    "zzzzzz_tournaments_financial_certificate",
)
TABLES = (
    "auth.users", "public.users", "public.profiles", "public.clubs",
    "public.club_members", "public.tournaments", "public.tournament_players",
    "public.tournament_escrow", "public.tournament_payouts",
    "public.tournament_obligations", "public.wallet_credit_idempotency",
    "public.wallet_transactions", "public.wallets", "public.chip_ledger",
    "public.ca_settle_sources", "public.tables", "public.table_seats",
    "public.hands", "public.hand_players", "public.tournament_tables",
    "public.tournament_place_settlement_batches",
    "public.tournament_finish_receipts",
    "public.tournament_deal_proposals",
    "public.tournament_deal_reviews",
    "public.tournament_deal_proposal_consents",
    "public.tournament_deal_proposal_executions",
    "public.tournament_deal_review_policy",
    "public.tournament_final_table_deal_batches",
    "public.tournament_final_table_deal_receipts",
)

# Configuration/provenance rows are allowed; every data relation this focused
# rehearsal snapshots must be empty before it can write a synthetic fixture.
DISPOSABLE_DATA_TABLES = tuple(table for table in TABLES if table not in (
    "public.ca_settle_sources", "public.tournament_deal_review_policy",
))


class DatabaseTarget:
    def __init__(self, psql, socket, port, database):
        self.psql = psql
        self.socket = socket
        self.port = port
        self.database = database

    def command(self, *extra):
        return [
            self.psql, "-X", "--host", self.socket, "--port", str(self.port),
            "--username", "postgres", "--dbname", self.database,
            "-v", "ON_ERROR_STOP=1", *extra,
        ]


def psql_environment():
    """Keep credentials, but remove every ambient connection target."""
    environment = os.environ.copy()
    for name in (
        "PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGUSER",
        "PGSERVICE", "PGSERVICEFILE",
    ):
        environment.pop(name, None)
    return environment


def port_number(value):
    port = int(value)
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("port must be between 1 and 65535")
    return port


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--socket", type=Path, required=True,
                        help="existing absolute local Unix socket directory")
    parser.add_argument("--port", type=port_number, required=True)
    parser.add_argument(
        "--database", required=True,
        help="exact name of the disposable zero-data donor/clone",
    )
    parser.add_argument("--psql", default=DEFAULT_PSQL)
    parser.add_argument(
        "--acknowledge", required=True, choices=(DISPOSABLE_ACKNOWLEDGEMENT,),
        help="explicit acknowledgement that the named target is disposable",
    )
    return parser


def parse_args(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.socket.is_absolute() or not args.socket.is_dir():
        parser.error("--socket must name an existing absolute local directory")
    if args.database in SYSTEM_DATABASES:
        parser.error("PostgreSQL system/maintenance databases are never rehearsal targets")
    if not args.database or any(ord(character) < 32 for character in args.database):
        parser.error("--database must be a non-empty explicit database name")
    if os.environ.get("DATABASE_URL"):
        parser.error("DATABASE_URL is not accepted; the local target must be explicit")
    executable = shutil.which(args.psql)
    if executable is None:
        parser.error("--psql must resolve to an executable client")
    return args, DatabaseTarget(executable, str(args.socket), args.port, args.database)


def zero_data_expression():
    relations = ",".join(
        "(" + ",".join(q(part) for part in table.split(".", 1)) + ")"
        for table in DISPOSABLE_DATA_TABLES
    )
    return """SELECT COALESCE(sum(((pg_catalog.xpath(
      '/table/row/row_count/text()', pg_catalog.query_to_xml(
        pg_catalog.format('SELECT count(*) AS row_count FROM %I.%I',
          namespace.nspname, relation.relname), false, false, '')))[1]::text)::bigint),0)
FROM (VALUES """ + relations + """) AS listed(schema_name,relation_name)
JOIN pg_catalog.pg_namespace namespace ON namespace.nspname=listed.schema_name
JOIN pg_catalog.pg_class relation
  ON relation.relnamespace=namespace.oid AND relation.relname=listed.relation_name"""


def assert_safe_target(target):
    fields = ("database", "user", "server_major", "local",
              "other_sessions", "data_rows")
    observed = sql(target, "SELECT current_database()||'|'||current_user||'|'||"
                   "(current_setting('server_version_num')::integer/10000)||'|'||"
                   "(inet_server_addr() IS NULL)::text||'|'||"
                   "(SELECT count(*) FROM pg_stat_activity"
                   " WHERE datname=current_database() AND pid<>pg_backend_pid())||'|'||"
                   "(" + zero_data_expression() + ")").split("|")
    expected = [target.database, "postgres", "17", "true", "0", "0"]
    if observed != expected:
        raise RuntimeError(
            "requires the named, exclusively owned, zero-data local PG17 clone; "
            "observed " + json.dumps(dict(zip(fields, observed)))
        )
    return dict(zip(fields, observed))


def disposable_sql_gate(target):
    return """
DO $disposable_only$
BEGIN
  IF current_database()<>""" + q(target.database) + """ OR current_user<>'postgres'
     OR current_setting('server_version_num')::integer/10000<>17
     OR inet_server_addr() IS NOT NULL
     OR (SELECT count(*) FROM pg_stat_activity
           WHERE datname=current_database() AND pid<>pg_backend_pid())<>0
     OR (""" + zero_data_expression() + """)<>0
     OR to_regprocedure('public.fn_settle_tournament_final_table_deal(uuid)') IS NULL THEN
    RAISE EXCEPTION 'requires the acknowledged zero-data disposable local PG17 clone';
  END IF;
END;
$disposable_only$;
"""


def retarget_disposable_sql_gate(composed, target):
    disposable_blocks = re.findall(
        r"\nDO \$disposable_only\$.*?\$disposable_only\$;\n", composed, re.S
    )
    if len(disposable_blocks) != 1:
        raise ValueError("base rehearsal disposable-target gate changed")
    return composed.replace(
        disposable_blocks[0], "\n" + disposable_sql_gate(target), 1
    )


def retarget_private_core_gate(composed):
    gates = re.findall(
        r"-- CASH_LEAF_SOURCE_SHA256 [^\n]+\n"
        r"DO \$cash_leaf_gate\$.*?\$cash_leaf_gate\$;\n", composed, re.S)
    matches = [gate for gate in gates if PRIVATE_CORE_IDENTITY in gate]
    if len(matches) != 1:
        raise ValueError("base rehearsal private-core gate changed")
    replacement = """-- M5_CURRENT_PRIVATE_CORE
DO $cash_leaf_gate$ BEGIN IF NOT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
  WHERE p.oid=to_regprocedure(""" + q(PRIVATE_CORE_IDENTITY) + ")" + """
    AND md5(p.prosrc)=""" + q(PRIVATE_CORE_SOURCE_MD5) + """
    AND md5(pg_get_functiondef(p.oid))=""" + q(PRIVATE_CORE_DEFINITION_MD5) + """
    AND p.prosecdef AND pg_get_userbyid(p.proowner)='postgres'
    AND l.lanname='plpgsql'
    AND p.proconfig=ARRAY['search_path=public']::text[]
) THEN RAISE EXCEPTION 'current private obligation core differs';
END IF; END; $cash_leaf_gate$;
"""
    return composed.replace(matches[0], replacement, 1)


def retarget_contracted_cash_leaf_gates(composed):
    for identity, source_md5, definition_md5 in (
            CASH_LEAF_POSTIMAGES[0], CASH_LEAF_POSTIMAGES[2]):
        gates = re.findall(
            r"-- CASH_LEAF_SOURCE_SHA256 [^\n]+\n"
            r"DO \$cash_leaf_gate\$.*?\$cash_leaf_gate\$;\n", composed, re.S)
        matches = [gate for gate in gates if identity in gate]
        if len(matches) != 1:
            raise ValueError("base rehearsal cash-leaf gate changed: " + identity)
        replacement = """-- M5_CURRENT_CASH_LEAF
DO $cash_leaf_gate$ BEGIN IF NOT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
  WHERE p.oid=to_regprocedure(""" + q(identity) + ")" + """
    AND md5(p.prosrc)=""" + q(source_md5) + """
    AND md5(pg_get_functiondef(p.oid))=""" + q(definition_md5) + """
    AND p.prosecdef AND pg_get_userbyid(p.proowner)='postgres'
    AND l.lanname='plpgsql'
    AND p.proconfig=ARRAY['search_path=public']::text[]
) THEN RAISE EXCEPTION 'current cash leaf differs: """ + identity + """';
END IF; END; $cash_leaf_gate$;
"""
        composed = composed.replace(matches[0], replacement, 1)
    return composed


def retarget_final_deal_gate(composed):
    gates = re.findall(
        r"DO \$native_gate\$ BEGIN\n.*?END; \$native_gate\$;\n", composed, re.S)
    if len(gates) != 1:
        raise ValueError("base rehearsal native-authority gate changed")
    stale = [line for line in gates[0].splitlines()
             if "native authority source differs: fn_settle_tournament_final_table_deal" in line]
    if len(stale) != 1:
        raise ValueError("base rehearsal final-deal authority gate changed")
    current = (
        "IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang "
        "WHERE p.oid=to_regprocedure(" + q(FINAL_DEAL_IDENTITY) + ") "
        "AND md5(p.prosrc)=" + q(FINAL_DEAL_SOURCE_MD5) + " "
        "AND md5(pg_get_functiondef(p.oid))=" + q(FINAL_DEAL_DEFINITION_MD5) + " "
        "AND p.prosecdef AND pg_get_userbyid(p.proowner)='postgres' "
        "AND l.lanname='plpgsql' "
        "AND p.proconfig=ARRAY['search_path=public','statement_timeout=30s']::text[]) "
        "THEN RAISE EXCEPTION 'native authority source differs: "
        "fn_settle_tournament_final_table_deal'; END IF;"
    )
    return composed.replace(stale[0], current, 1)


def preserve_current_final_deal(composed):
    fixtures = re.findall(
        r"(CREATE OR REPLACE FUNCTION public\.fn_settle_tournament_final_table_deal\("
        r".*?AS (\$[^$]*\$)(.*?)\2;\n"
        r"REVOKE ALL ON FUNCTION public\.fn_settle_tournament_final_table_deal\(uuid\)"
        r".*?\$cash_current\$;\n)", composed, re.S)
    if len(fixtures) != 1 or hashlib.md5(fixtures[0][2].encode()).hexdigest() != \
            COMPOSER_FINAL_DEAL_SOURCE_MD5:
        raise ValueError("base rehearsal final-deal fixture changed")
    preserved = """-- Preserve the exact-tail canonical final-deal authority.
DO $cash_current$ BEGIN IF NOT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
  WHERE p.oid=to_regprocedure(""" + q(FINAL_DEAL_IDENTITY) + ")" + """
    AND md5(p.prosrc)=""" + q(FINAL_DEAL_SOURCE_MD5) + """
    AND md5(pg_get_functiondef(p.oid))=""" + q(FINAL_DEAL_DEFINITION_MD5) + """
    AND p.prosecdef AND pg_get_userbyid(p.proowner)='postgres'
    AND l.lanname='plpgsql'
    AND p.proconfig=ARRAY['search_path=public','statement_timeout=30s']::text[]
) THEN RAISE EXCEPTION 'current final-deal authority was not preserved';
END IF; END; $cash_current$;
"""
    return composed.replace(fixtures[0][0], preserved, 1)


def preserve_current_phase_three_schema(root, composed):
    expansion = (root / "scripts/deploy/phase-three-versioned-final-deal.sql").read_text()
    if expansion.count("BEGIN;") != 1 or expansion.count("COMMIT;") != 1:
        raise ValueError("base rehearsal phase-three transaction changed")
    expansion_body = expansion.split("BEGIN;", 1)[1].replace("COMMIT;", "", 1)
    if composed.count(expansion_body) != 1:
        raise ValueError("base rehearsal phase-three expansion changed")
    return composed.replace(
        expansion_body,
        "\n-- Exact-tail donor already contains the authenticated phase-three schema.\n",
        1,
    )


def once(text, before, after):
    if text.count(before) != 1:
        raise ValueError("expected exactly one marker: " + before[:100])
    return text.replace(before, after, 1)

def exact_migration(root, migration_name):
    migration_directory = root / "supabase/migrations"
    matches = sorted(
        path for path in migration_directory.iterdir()
        if path.is_file() and re.fullmatch(
            rf"[0-9]{{14}}_{re.escape(migration_name)}\.sql(?:\.pending)?",
            path.name,
        )
    )
    if len(matches) != 1:
        raise RuntimeError(
            f"Expected exactly one {migration_name} migration; found {len(matches)}"
        )
    return matches[0]


def canonical_cash_sources(root, stage_b):
    wrappers = re.findall(
        r"(CREATE OR REPLACE FUNCTION public\.fn_settle_tournament_obligation\(.*?"
        r"AS (\$[^$]*\$)(.*?)\2;)", stage_b, re.S)
    if len(wrappers) != 1:
        raise ValueError("exact Stage-B strict public payer definition is missing")
    wrapper, _, body = wrappers[0]
    if hashlib.sha256(wrapper.encode()).hexdigest() != STRICT_PAYER_DEFINITION_SHA256:
        raise ValueError("exact Stage-B strict public payer definition changed")
    for marker in (
        "exact_refund_authority_required", "atomic_batch_required",
        "fn_settle_tournament_obligation_before_atomic_batch_gate(",
    ):
        if body.count(marker) != 1:
            raise ValueError("Stage-B strict public payer marker changed: " + marker)

    core_pin = re.compile(
        r"\(" + re.escape(q(PRIVATE_CORE_IDENTITY)) + r",\s*"
        + re.escape(q(PRIVATE_CORE_DEFINITION_MD5)) + r","
        + re.escape(q(PRIVATE_CORE_SOURCE_MD5)) + r","
    )
    if len(core_pin.findall(stage_b)) != 1:
        raise ValueError("exact M5 private obligation core pin is missing")

    for identity, source_md5, definition_md5 in CASH_LEAF_POSTIMAGES:
        expected = re.compile(
            r"\(" + re.escape(q(identity)) + r",\s*" + re.escape(q(source_md5))
            + r"," + re.escape(q(definition_md5))
            + r",\s*ARRAY\['search_path=public'\]::text\[\],false,'jsonb',0\)"
        )
        if len(expected.findall(stage_b)) != 1:
            raise ValueError("exact M5 cash-leaf postimage is missing: " + identity)

    contraction_path = exact_migration(root, CASH_CONTRACTION_MIGRATION_NAME)
    blocks = re.findall(
        r"DO \$contract_cash_batch_payers\$.*?\$contract_cash_batch_payers\$;",
        contraction_path.read_text(), re.S)
    if len(blocks) != 1 or hashlib.sha256(blocks[0].encode()).hexdigest() != \
            CASH_CONTRACTION_BLOCK_SHA256:
        raise ValueError("exact current cash-leaf contraction block changed")
    for identity, source_md5, _ in CASH_LEAF_POSTIMAGES:
        if blocks[0].count(q(identity)) != 1 or blocks[0].count(q(source_md5)) != 1:
            raise ValueError("cash-leaf contraction identity changed: " + identity)
    return wrapper, blocks[0], contraction_path

def q(text):
    return "'" + text.replace("'", "''") + "'"

def failure_classification(log):
    if "cannot enter COMPLETING without an immutable finish claim" in log:
        return "blocked_final_deal_claim"
    if "COMPLETING claim has no RPC owner" in log:
        return "blocked_final_deal_claim_owner"
    return "failed_rehearsal"

def sql(target, command):
    return subprocess.check_output(
        target.command("-At", "-c", command), text=True,
        env=psql_environment(),
    ).strip()

def snapshot(target):
    result = {}
    for catalog in ("pg_proc", "pg_trigger", "pg_class", "pg_attribute",
                    "pg_attrdef", "pg_constraint", "pg_index", "pg_policy"):
        result[catalog] = sql(target,
            "SELECT md5(COALESCE(string_agg(row_to_json(t)::text,E'\\n'"
            " ORDER BY row_to_json(t)::text),'')) FROM pg_catalog."
            + catalog + " t")
    for table in TABLES:
        if sql(target, "SELECT to_regclass(" + q(table) + ") IS NOT NULL") == "t":
            result[table] = sql(target,
                "SELECT json_build_object('count',count(*),'md5',md5(COALESCE("
                "string_agg(row_to_json(t)::text,E'\\n' ORDER BY row_to_json(t)::text),'')))"
                " FROM " + table + " t")
        else:
            result[table] = None
    return result

def compose(root, fixed_tail, lane_path, target):
    builder_path = root / "scripts/dev/build-versioned-final-deal-probe.py"
    spec = importlib.util.spec_from_file_location("cash_base", builder_path)
    base = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(base)
    stage_b_path = exact_migration(root, STAGE_B_MIGRATION_NAME)
    stage_b = stage_b_path.read_text()
    strict_definition, block, _ = canonical_cash_sources(root, stage_b)
    probe = (root / "scripts/ci/probes/stage-b-cash-payers-native.sql").read_text()
    postimage_start = "  FOREACH v_call IN ARRAY ARRAY["
    postimage_end = (
        "  PERFORM pg_temp.deal_assert(pg_temp.exact_deal_money_state()=v_before,"
    )
    if probe.count(postimage_start) != 1 or probe.count(postimage_end) != 1:
        raise ValueError("cash-payer preimage-only probe changed")
    probe = (probe[:probe.index(postimage_start)]
             + probe[probe.index(postimage_end):])
    probe = once(probe, "  v_call text;\n", "")
    probe = once(
        probe,
        "'unchanged full deal fails atomically under the strict public payer'",
        "'strict public payer refusals preserve exact money state'",
    )
    normalise_acl = "\n".join(
        "REVOKE ALL ON FUNCTION " + identity + " FROM PUBLIC,anon,authenticated,service_role;"
        for identity, _, _ in CASH_LEAF_POSTIMAGES)
    strict = strict_definition + """
REVOKE ALL ON FUNCTION public.fn_settle_tournament_obligation(
  uuid,text,integer,uuid,numeric,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_obligation(
  uuid,text,integer,uuid,numeric,text,text,uuid) TO service_role;
"""
    negatives = []
    # Exercise a late leaf failure so an earlier rewritten leaf also rolls back.
    for role in ("PUBLIC", "anon", "authenticated", "service_role"):
        negatives.append("""
DO $bad_acl$
BEGIN
  BEGIN
    GRANT EXECUTE ON FUNCTION public.fn_ca_settle_final_table_deal_share_raw(uuid,uuid,numeric) TO """ + role + """;
    IF EXISTS (
      SELECT 1 FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(
        COALESCE(p.proacl,acldefault('f',p.proowner))) privilege
      WHERE p.oid='public.fn_ca_settle_final_table_deal_share_raw(uuid,uuid,numeric)'::regprocedure
        AND privilege.privilege_type='EXECUTE' AND privilege.grantee<>p.proowner
    ) THEN
      EXECUTE """ + q(block) + """;
      RAISE EXCEPTION 'unexpectedly accepted a non-owner raw payer';
    ELSE
      PERFORM pg_temp.deal_assert(true,
        'exact-tail auto-revoke prevents the unsafe """ + role + """ ACL');
    END IF;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'Stage-B cash payer is not owner-only:%' THEN RAISE; END IF;
  END;
  PERFORM pg_temp.deal_assert(
    (SELECT md5(prosrc) FROM pg_proc WHERE oid=
      'public.fn_ca_settle_tournament_place_raw(uuid,integer,uuid,numeric)'::regprocedure)
      ='""" + CASH_LEAF_POSTIMAGES[0][1] + """',
    'unexpected """ + role + """ ACL refuses contraction and rolls back earlier leaf');
END;
$bad_acl$;
""")
    for alteration in (
        "ALTER FUNCTION public.fn_ca_settle_final_table_deal_share_raw(uuid,uuid,numeric) SET search_path=public,pg_temp",
        "DO $alter_body$ DECLARE d text; BEGIN SELECT pg_get_functiondef('public.fn_ca_settle_final_table_deal_share_raw(uuid,uuid,numeric)'::regprocedure) INTO d; EXECUTE replace(d,'DECLARE',E'DECLARE\\n-- changed source'); END; $alter_body$",
    ):
        negatives.append("""
DO $bad_source$
BEGIN
  BEGIN
    EXECUTE """ + q(alteration) + """;
    EXECUTE """ + q(block) + """;
    RAISE EXCEPTION 'unexpectedly accepted changed raw payer source';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'Stage-B cash payer source differs:%' THEN RAISE; END IF;
  END;
  PERFORM pg_temp.deal_assert(
    (SELECT md5(prosrc) FROM pg_proc WHERE oid=
      'public.fn_ca_settle_tournament_place_raw(uuid,integer,uuid,numeric)'::regprocedure)
      ='""" + CASH_LEAF_POSTIMAGES[0][1] + """',
    'changed raw payer body or search_path refuses and restores earlier leaf');
END;
$bad_source$;
""")
    probe = once(probe, "-- @CONTRACTION_NEGATIVES@", "\n".join(negatives))
    probe = once(probe, "-- @CONTRACTION_BLOCK@", block)
    guard_sql = "\n".join(
        "ALTER TABLE public.tournaments ENABLE TRIGGER " + name + ";" for name in GUARDS)
    composed = base.compose(
        root, root / "scripts/ci/probes/versioned-final-deal-native.sql", fixed_tail,
        lane_path, stage_b_path)
    composed = preserve_current_phase_three_schema(root, composed)
    composed = retarget_final_deal_gate(composed)
    composed = preserve_current_final_deal(composed)
    composed = retarget_contracted_cash_leaf_gates(composed)
    composed = retarget_private_core_gate(composed)
    composed = retarget_disposable_sql_gate(composed, target)
    composed = once(
        composed,
        "(id,name,tournament_id,status,lifecycle,current_players,game_type,club_id)",
        "(id,name,tournament_id,status,lifecycle,current_players,game_type,club_id,"
        "seat_game_scope,seat_admission_key)",
    )
    composed = once(
        composed,
        "   'tournament','20000000-0000-0000-0000-000000000001');",
        "   'tournament','20000000-0000-0000-0000-000000000001',"
        "'table:87200000-0000-0000-0000-000000000001',"
        "'tournament:87000000-0000-0000-0000-000000000001');",
    )
    composed = once(
        composed,
        "   is_sitting_out,club_id)\nSELECT md5('atomic-deal-seat:'",
        "   is_sitting_out,club_id,active_game_scope,active_parent_key)\n"
        "SELECT md5('atomic-deal-seat:'",
    )
    composed = once(
        composed,
        "       '20000000-0000-0000-0000-000000000001'\n"
        "  FROM generate_series(1,5) g(i);",
        "       '20000000-0000-0000-0000-000000000001',\n"
        "       'table:87200000-0000-0000-0000-000000000001',\n"
        "       'tournament:87000000-0000-0000-0000-000000000001'\n"
        "  FROM generate_series(1,5) g(i);",
    )
    composed = once(
        composed,
        "           'user_id',md5('atomic-deal-user:'||g.i::text)::uuid,\n"
        "           'chips',CASE WHEN g.i<=5 THEN g.i*100 ELSE 0 END,",
        "           'user_id',md5('atomic-deal-user:'||g.i::text)::uuid,\n"
        "           'club_id','20000000-0000-0000-0000-000000000001',\n"
        "           'chips',CASE WHEN g.i<=5 THEN g.i*100 ELSE 0 END,",
    )
    # Seed an actual cash winner plus stone bubble during the original synthetic
    # opening fixture, before session_replication_role is restored to origin.
    composed = once(composed, "current_players,payout_structure,prize_pool_finalized,\n",
                    "current_players,payout_structure,prize_pool_finalized,bubble_protection,\n")
    composed = once(composed, "10,0,now(),9,'RUNNING',10,0,0,0,0,1,",
                    "1,0,now(),9,'RUNNING',10,0,0,0,0,2,")
    composed = once(composed, "'[{\"place\":1,\"percentage\":100}]'::jsonb,false,",
                    "'[{\"place\":1,\"percentage\":100}]'::jsonb,false,true,")
    bubble = """
INSERT INTO public.profiles
SELECT (jsonb_populate_record(NULL::public.profiles,
  to_jsonb(p)||jsonb_build_object('id','10000000-0000-0000-0000-000000000002',
    'username','atomic_cash_bubble'))).*
FROM public.profiles p WHERE p.id='10000000-0000-0000-0000-000000000001';
INSERT INTO public.tournament_players(
  id,tournament_id,user_id,username,chips,status,prize,current_bounty,
  bounty_winnings,mystery_bounty_value,position,elimination_sequence,eliminated_at)
VALUES('31000000-0000-0000-0000-000000000002',
  '30000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002','Probe User Two',0,'eliminated',
  0,0,0,0,2,1,now());
"""
    composed = once(composed, "SET LOCAL session_replication_role=origin;",
                    bubble + "\nSET LOCAL session_replication_role=origin;")
    cash_source_path = exact_migration(root, BUST_ORDER_MIGRATION_NAME)
    cash_source_bytes = cash_source_path.read_bytes()
    if hashlib.sha256(cash_source_bytes).hexdigest() != BUST_ORDER_MIGRATION_SHA256:
        raise ValueError("exact live bust-order source changed")
    cash_source = cash_source_bytes.decode()
    definitions = re.findall(r"(CREATE OR REPLACE FUNCTION public\.fn_settle_tournament_places\(.*?AS (\$[^$]*\$)(.*?)\2;)", cash_source, re.S)
    if len(definitions)!=1:
        raise ValueError("exact current normal cash source is not unique")
    current_definition, _, current_body = definitions[0]
    if hashlib.md5(current_body.encode()).hexdigest()!=NORMAL_CASH_SOURCE_MD5:
        raise ValueError("current normal cash body does not match verified authority")
    normal_cash = """DO $normal_cash_gate$ BEGIN IF NOT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
  WHERE p.oid=to_regprocedure(""" + q(NORMAL_CASH_IDENTITY) + ")" + """
    AND md5(p.prosrc)=""" + q(NORMAL_CASH_SOURCE_MD5) + """
    AND md5(pg_get_functiondef(p.oid))=""" + q(NORMAL_CASH_DEFINITION_MD5) + """
    AND p.prosecdef AND pg_get_userbyid(p.proowner)='postgres'
    AND l.lanname='plpgsql'
    AND p.proconfig=ARRAY['search_path=public','statement_timeout=30s']::text[]
) OR has_function_privilege('anon',""" + q(NORMAL_CASH_IDENTITY) + ", 'EXECUTE')" + """
  OR has_function_privilege('authenticated',""" + q(NORMAL_CASH_IDENTITY) + ", 'EXECUTE')" + """
  OR NOT has_function_privilege('service_role',""" + q(NORMAL_CASH_IDENTITY) + ", 'EXECUTE')" + """
THEN RAISE EXCEPTION 'native normal cash baseline differs'; END IF;
END; $normal_cash_gate$;
"""
    marker = "-- This refusal trigger observes an actual earlier credit, then forces the\n"
    composed = once(composed, marker,
                    normal_cash + strict + normalise_acl + "\n" + guard_sql + "\n" + probe
                    + "\n" + marker)
    return composed

def main():
    args, target = parse_args()
    root = args.root.resolve()
    connection = assert_safe_target(target)
    before = snapshot(target)
    evidence = {
        "recorded_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "production_ddl_applied": False, "whole_stage_b_executed": False,
        "scope": "Strict public payer plus exact owner-only cash leaf contraction; existing native money functions.",
        "synthetic_opening_fixture_only": True,
        "runtime_session_replication_role": "origin",
        "deferred_guards_enabled_during_acceptance": list(GUARDS),
        "connection": connection,
        "safety_acknowledgement": DISPOSABLE_ACKNOWLEDGEMENT,
        "variants": [], "before": before,
    }
    output = Path(tempfile.mkdtemp(prefix="codex-stage-b-cash-payers-"))
    lane_source = exact_migration(root, LANE_MIGRATION_NAME)
    lane_path = output / lane_source.name
    lane_bytes = lane_source.read_bytes()
    if hashlib.sha256(lane_bytes).hexdigest() != "d07cbe35f62ef4a18e29779c812526c27420da4a82c891c0bf2f136b9e6a31fe":
        raise RuntimeError("tracked settlement lane source differs")
    # Preserve the original provenance filename so composed rehearsal SQL is unchanged.
    lane_path.write_bytes(lane_bytes)
    for variant in ("paid", "unpaid", "partial"):
        text = compose(root, variant, lane_path, target)
        path = output / (variant + ".sql")
        path.write_text(text)
        result = subprocess.run(
            target.command("-f", str(path)), text=True, capture_output=True,
            env=psql_environment(),
        )
        log = result.stdout + result.stderr
        (output / (variant + ".log")).write_text(log)
        after = snapshot(target)
        item = {"variant": variant, "exit_code": result.returncode,
                "assertions": len(re.findall(r"NOTICE:\s+PASS ", log)),
                "sql_sha256": hashlib.sha256(text.encode()).hexdigest(),
                "exact_rollback": after == before}
        if result.returncode:
            item["failure_classification"] = failure_classification(log)
        evidence["variants"].append(item)
        evidence["after"] = after
        print(json.dumps(item), flush=True)
        if result.returncode or after != before:
            item["failure_tail"] = re.sub(r"psql:[^:\n]+:\d+:", "psql:", log).splitlines()[-18:]
            print("\n".join(item["failure_tail"]), flush=True)
        if after != before:
            evidence["status"] = "blocked_rollback_mismatch"
            args.evidence.write_text(json.dumps(evidence, indent=2) + "\n")
            raise SystemExit(1)
    classifications = {
        item["failure_classification"] for item in evidence["variants"]
        if item["exit_code"]
    }
    evidence["status"] = (
        "passed" if not classifications
        else next(iter(classifications)) if len(classifications) == 1
        else "failed_mixed_rehearsal"
    )
    evidence["count_note"] = "The same assertions run against three fixed-tail states; totals are not distinct tests."
    evidence["remaining_gate"] = (
        "Current final-deal cash authority changes RUNNING to COMPLETING without the immutable finish claim required by the genuine enabled guard. This proof cannot certify terminal completion."
        if evidence["status"] == "blocked_final_deal_claim"
        else "Current final-deal cash authority lacks the exact transaction-local finish-claim owner required by the genuine enabled guard. This proof cannot certify terminal completion."
        if evidence["status"] == "blocked_final_deal_claim_owner"
        else "Focused cash-payer rehearsal failed before its intended completion; inspect each variant's causal classification and failure tail."
        if evidence["status"] != "passed" else None)
    evidence["source_sha256"] = {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in (
            Path(__file__).resolve(), root / "scripts/ci/probes/stage-b-cash-payers-native.sql",
            root / "scripts/dev/build-versioned-final-deal-probe.py",
            exact_migration(root, STAGE_B_MIGRATION_NAME),
            exact_migration(root, CASH_CONTRACTION_MIGRATION_NAME))}
    args.evidence.write_text(json.dumps(evidence, indent=2) + "\n")
    print("Completed all variants; original catalog/data state restored. Status: " + evidence["status"], flush=True)
    if evidence["status"] != "passed":
        raise SystemExit(1)

if __name__ == "__main__":
    main()
