#!/usr/bin/env python3
"""Current existing-ticket redemption in the coordinator's owned local PG17.

No production connection, cluster creation, broad migration, issuer or auth stub.
Only pinned tracked definitions, the exact absent direct-ticket schema delta,
and explicitly gated source transformations are composed. The opening issued-ticket liability is synthetic historical input;
source satellite terminal execution and late chairs are not certified here.
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess

PSQL = "/opt/homebrew/opt/postgresql@17/bin/psql"
SOCKET = "/tmp/codex-chip-drift-cutover-e2iav203/socket"
CMD = [PSQL, "-X", "-qAt", "-h", SOCKET, "-p", "55473", "-U", "postgres",
       "-d", "full_stage1", "-v", "ON_ERROR_STOP=1"]
PROBE = "scripts/ci/probes/existing-ticket-current-redemption-native.sql"
STAGE_B_RESOLVER = "scripts/ci/stage_b_migration_source.py"
SOURCES = {
    "m4": ("supabase/migrations/20260909165629_satellite_settlement_has_one_atomic_authority.sql", "ce14eccd72c0589fd4feae70fe1395a11347d1c0812de15090a7b48337d08882"),
    "funded": ("supabase/migrations/20260910171924_satellite_seats_count_once_and_keep_the_funded_prize.sql", "9a00bc662f729d5a6db25c4f10a5ceeb45509b230e35f48252620fe9dcef3fc3"),
    "resolver": ("supabase/migrations/20260910020626_the_host_club_is_in_its_own_union.sql", "4e078b55a44bbc3e516d4a0da73ce39453b4dc6950225d98e02d2a8d6c0412e9"),
    "lane": ("supabase/migrations/20260910035435_the_settlement_lane_is_per_tournament_not_platform_wide.sql", "d07cbe35f62ef4a18e29779c812526c27420da4a82c891c0bf2f136b9e6a31fe"),
    "m6": ("supabase/migrations/20260909014433_spin_reserve_settlement_commits_its_journal_or_nothing.sql", "3a2af49bcaf13fdca72a4b89e2d6b38ee9c125f4d8b09aa8626c36e593aebc1f"),
    "rolling": ("supabase/migrations/20260910173147_the_settlement_lane_is_per_tournament_for_rolling_authorities.sql", "bc620a6b093ab9769615427168763bc35aaed44e60ee190202470dfcef0f744b"),
    "cap": ("supabase/migrations/20260906233722_a_cap_counts_entries_not_the_seats_filled_right_now.sql", "0e66deca80157a34105d1f1cae569b52f07cbe2e74c07caf46fa11a53ba3ecac"),
}
# Outside named definitions, only the pinned M4 direct-ticket schema delta and
# the already bounded resolver transformation are executed inside outer rollback.
FUNCTIONS = (
    ("lane", "fn_ca_lock_settlement_lane_global", "", "343015440ea5c84ee4ca7ae583c73d30", "service_role"),
    ("rolling", "fn_ca_lock_settlement_lane_for_tournament", "uuid,uuid", "3acb4c1d763181905cf5b64287f8f28f", "service_role"),
    ("rolling", "fn_tournament_live_seat_acquisition_requires_authority", "", "5a60bdd761aaaaad4b3bf982a3c50f6e", ""),
    ("rolling", "fn_satellite_target_player_provenance_is_immutable", "", "266a6b06f5cc44bc953ca4c31933d7db", ""),
    ("m4", "fn_ca_satellite_entry_ticket_is_guarded", "", "721225f2dc9bf83dfbc361e204e14830", ""),
    ("m4", "fn_ca_refund_entitlement_commit_valid", "", "b3a3353b87e0e0afbfaeef29a42fb154", ""),
    ("m4", "fn_ca_lock_tournament_contract_from_entitlement", "", "c6fef0645b730d53e5c4135f13d8e052", ""),
    ("m4", "fn_satellite_target_contract_is_immutable", "", "e4e44174e6df39605122a6a6098b77cc", ""),
    ("funded", "fn_ca_tournament_escrow", "uuid", "56663389f8348d2ab35a54460c0b7632", "service_role"),
    ("funded", "fn_ca_escrow_on_rake_record", "", "3e628d6a57a93eeb61d494ee33f989a3", "service_role"),
    ("cap", "fn_tournament_entry_cap_reached", "uuid", "b3fe14943dd45edcca84f9396034b28c", "service_role"),
)
TABLES = (
    "auth.users", "auth.sessions", "public.users", "public.profiles", "public.clubs",
    "public.unions", "public.union_clubs", "public.club_members", "public.tournaments",
    "public.tournament_players", "public.tournament_escrow", "public.chip_ledger",
    "public.chip_ledger_idem", "public.chip_transactions", "public.wallet_transactions",
    "public.wallet_credit_idempotency", "public.wallets", "public.club_wallets", "public.union_wallets",
    "public.rake_records", "public.rake_attributions", "public.agent_commissions",
    "public.tournament_tickets", "public.tournament_refund_entitlements",
    "public.tournament_refund_tranches", "public.tournament_refund_authorizations",
    "public.tournament_ticket_admission_authorizations", "public.tournament_unregistration_receipts",
    "public.tournament_cancellation_receipts", "public.tournament_satellite_settlements",
    "public.tournament_satellite_awards", "public.tournament_satellite_remainders",
    "public.tournament_payouts", "public.tournament_obligations", "public.tables", "public.table_seats",
    "public.tournament_tables", "public.tournament_capacity_table_receipts",
    "public.tournament_manager_wakes", "public.tournament_seat_exit_authorizations",
    "public.tournament_seat_move_receipts", "public.entry_purchase_idempotency_receipts",
    "public.engine_tournament_leases", "public.ca_settle_sources", "public.financial_alerts",
    "public.ca_ledger_write_failures", "public.ca_drift_incidents", "public.ca_financial_epochs",
    "public.player_stats", "public.vip_points_carry",
)
CATALOGS = ("pg_proc", "pg_trigger", "pg_class", "pg_attribute", "pg_attrdef",
            "pg_constraint", "pg_index", "pg_policy")


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def quote(text):
    return "'" + text.replace("'", "''") + "'"


def stage_b_source(root):
    spec = importlib.util.spec_from_file_location(
        "existing_ticket_stage_b_source", root / STAGE_B_RESOLVER
    )
    resolver = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(resolver)
    return resolver.resolve(root)


def definition(source, name):
    found = list(re.finditer(r"CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\." +
        re.escape(name) + r"\s*\(.*?\bAS\s+(\$[A-Za-z_0-9]*\$)(.*?)\1\s*;", source, re.S | re.I))
    if len(found) != 1:
        raise ValueError("expected one exact source definition: " + name)
    return found[0][0]


def body_hash(sql):
    tag = re.search(r"\bAS\s+(\$[A-Za-z_0-9]*\$)", sql, re.I)
    return hashlib.md5(sql[tag.end():sql.index(tag[1], tag.end())].encode()).hexdigest()


def lane_transform(sql, lane, name):
    pattern = re.findall(r"v_excl CONSTANT text :=\s*'((?:''|[^'])*)';", lane)
    replacement = re.findall(r"'" + re.escape(name) + r"',\s*'([^']+)'", lane)
    if len(pattern) != 1 or len(replacement) != 1:
        raise ValueError("exact tracked lane plan missing: " + name)
    answer, count = re.subn(pattern[0].replace("''", "'"), replacement[0], sql)
    if count != 1:
        raise ValueError("expected one lane replacement: " + name)
    return answer


def install(sql, name, args, expected, roles=""):
    if body_hash(sql) != expected:
        raise ValueError("reviewed resulting body changed: " + name)
    signature = "public." + name + "(" + args + ")"
    result = sql + "\nALTER FUNCTION " + signature + " OWNER TO postgres;\n"
    result += "REVOKE ALL ON FUNCTION " + signature + " FROM PUBLIC,anon,authenticated,service_role;\n"
    if roles:
        result += "GRANT EXECUTE ON FUNCTION " + signature + " TO " + roles + ";\n"
    result += ("DO $function_body$ BEGIN IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=" +
        quote(signature) + "::regprocedure) IS DISTINCT FROM " + quote(expected) +
        " THEN RAISE EXCEPTION 'installed ticket composition body differs: %'," +
        quote(signature) + "; END IF; END; $function_body$;\n")
    return result


def schema_foundation(m4):
    """Restore only the absent M4 direct-ticket columns and their exact checks.

    The retained three tables are the earlier no-direct-ticket shape and empty.
    Every new expression is selected verbatim from the already SHA-pinned M4;
    no issuer, cutover inventory, historical repair, or other M4 DDL is replayed.
    """
    def select(start, end):
        if m4.count(start) != 1:
            raise ValueError("M4 schema start is ambiguous: " + start)
        first = m4.index(start)
        last = m4.index(end, first)
        return m4[first:last]

    settlement_column = "entry_ticket_count     integer NOT NULL CHECK (entry_ticket_count >= 0)"
    settlement_check = "CHECK (ticket_award_count = seat_count + cash_ticket_count + entry_ticket_count)"
    award_column = "ticket_id         uuid REFERENCES public.tournament_tickets(id)\n                           ON DELETE RESTRICT"
    award_kind = "CHECK (delivery_kind IN ('seat','cash','ticket'))"
    for fragment in (settlement_column, settlement_check, award_column, award_kind):
        if m4.count(fragment) != 1:
            raise ValueError("M4 direct-ticket schema fragment differs")
    award_check = select("  CHECK ((\n    (delivery_kind = 'seat'", "\n);").strip()
    ticket_check = select("  ADD CONSTRAINT tournament_tickets_satellite_entry_contract_check", ";")
    ticket_fk = select("ALTER TABLE public.tournament_tickets\n  ADD CONSTRAINT tournament_tickets_direct_satellite_award_fkey", ";") + ";\n"
    ticket_index = select("CREATE UNIQUE INDEX tournament_ticket_one_direct_satellite_award", ";") + ";\n"
    result = """DO $direct_ticket_schema_preimage$
BEGIN
 IF EXISTS(SELECT 1 FROM public.tournament_satellite_settlements)
    OR EXISTS(SELECT 1 FROM public.tournament_satellite_awards)
    OR EXISTS(SELECT 1 FROM public.tournament_tickets)
    OR EXISTS(SELECT 1 FROM pg_attribute WHERE NOT attisdropped AND (
      (attrelid='public.tournament_satellite_settlements'::regclass AND attname='entry_ticket_count')
      OR (attrelid='public.tournament_satellite_awards'::regclass AND attname='ticket_id')
      OR (attrelid='public.tournament_tickets'::regclass AND attname='source_satellite_award_place')))
 THEN RAISE EXCEPTION 'owned direct-ticket schema must be the exact empty older foundation'; END IF;
 IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid='public.tournament_satellite_settlements'::regclass
         AND conname='tournament_satellite_settlements_check2')
       IS DISTINCT FROM 'CHECK ((ticket_award_count = (seat_count + cash_ticket_count)))'
    OR (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid='public.tournament_satellite_awards'::regclass
         AND conname='tournament_satellite_awards_delivery_kind_check')
       IS DISTINCT FROM 'CHECK ((delivery_kind = ANY (ARRAY[''seat''::text, ''cash''::text])))'
    OR (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid='public.tournament_satellite_awards'::regclass
         AND conname='tournament_satellite_awards_check')
       IS DISTINCT FROM 'CHECK (((((delivery_kind = ''seat''::text) AND (registration_id IS NOT NULL) AND (obligation_id IS NULL) AND (obligation_kind IS NULL) AND (payout_source = ''satellite_seat''::text)) OR ((delivery_kind = ''cash''::text) AND (registration_id IS NULL) AND (obligation_id IS NOT NULL) AND (obligation_kind = ANY (ARRAY[''seat''::text, ''place''::text])) AND (payout_source <> ''satellite_seat''::text))) IS TRUE))'
    OR (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid='public.tournament_tickets'::regclass
         AND conname='tournament_tickets_satellite_entry_contract_check')
       IS DISTINCT FROM 'CHECK (((((redemption_mode = ''wallet_chips''::text) AND (source_tournament_id IS NULL) AND (source_satellite_id IS NULL) AND (source_refund_entitlement_id IS NULL) AND (entry_prize IS NULL) AND (entry_bounty IS NULL) AND (entry_fee IS NULL)) OR ((redemption_mode = ''tournament_entry_only''::text) AND (issued_by = ''2d1cd6c3-5700-4af9-a271-d4863fdab20d''::uuid) AND (source_tournament_id IS NOT NULL) AND (source_satellite_id IS NOT NULL) AND (source_refund_entitlement_id IS NOT NULL) AND (entry_prize IS NOT NULL) AND (entry_prize >= (0)::numeric) AND (entry_prize = round(entry_prize, 2)) AND (entry_bounty IS NOT NULL) AND (entry_bounty >= (0)::numeric) AND (entry_bounty = round(entry_bounty, 2)) AND (entry_fee IS NOT NULL) AND (entry_fee >= (0)::numeric) AND (entry_fee = round(entry_fee, 2)) AND (value = round(((entry_prize + entry_bounty) + entry_fee), 2)))) IS TRUE))'
 THEN RAISE EXCEPTION 'retained direct-ticket constraint preimage differs'; END IF;
END;
$direct_ticket_schema_preimage$;
"""
    result += "ALTER TABLE public.tournament_satellite_settlements ADD COLUMN " + settlement_column + ";\n"
    result += "ALTER TABLE public.tournament_satellite_settlements DROP CONSTRAINT tournament_satellite_settlements_check2, ADD CONSTRAINT tournament_satellite_settlements_check2 " + settlement_check + ";\n"
    result += "ALTER TABLE public.tournament_satellite_awards ADD COLUMN " + award_column + ", ADD UNIQUE(ticket_id);\n"
    result += "ALTER TABLE public.tournament_satellite_awards DROP CONSTRAINT tournament_satellite_awards_delivery_kind_check, ADD CONSTRAINT tournament_satellite_awards_delivery_kind_check " + award_kind + ", DROP CONSTRAINT tournament_satellite_awards_check, ADD CONSTRAINT tournament_satellite_awards_check " + award_check + ";\n"
    if m4.count("ADD COLUMN source_satellite_award_place integer") != 1:
        raise ValueError("M4 source award column differs")
    result += "ALTER TABLE public.tournament_tickets ADD COLUMN source_satellite_award_place integer, DROP CONSTRAINT tournament_tickets_satellite_entry_contract_check,\n" + ticket_check + ";\n"
    result += ticket_fk + ticket_index
    result += """DO $direct_ticket_schema_postimage$
BEGIN
 IF (SELECT count(*) FROM pg_attribute a WHERE a.attnum>0 AND NOT a.attisdropped AND (
      (a.attrelid='public.tournament_satellite_settlements'::regclass AND a.attname='entry_ticket_count'
       AND a.atttypid='integer'::regtype AND a.attnotnull)
      OR (a.attrelid='public.tournament_satellite_awards'::regclass AND a.attname='ticket_id'
       AND a.atttypid='uuid'::regtype AND NOT a.attnotnull)
      OR (a.attrelid='public.tournament_tickets'::regclass AND a.attname='source_satellite_award_place'
       AND a.atttypid='integer'::regtype AND NOT a.attnotnull)))<>3
    OR EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid IN (
      'public.tournament_satellite_settlements'::regclass,'public.tournament_satellite_awards'::regclass,
      'public.tournament_tickets'::regclass) AND NOT convalidated)
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tournament_tickets'::regclass
      AND conname='tournament_tickets_direct_satellite_award_fkey' AND condeferrable AND condeferred
      AND confrelid='public.tournament_satellite_awards'::regclass AND confdeltype='r')
 THEN RAISE EXCEPTION 'exact direct-ticket schema postimage is incomplete'; END IF;
END;
$direct_ticket_schema_postimage$;
"""
    return result


def compose(root):
    texts = {}
    for key, (path, expected) in SOURCES.items():
        text = (root / path).read_text()
        if digest(text) != expected:
            raise ValueError("reviewed tracked source changed: " + path)
        texts[key] = text
    stage_b_path = stage_b_source(root)
    texts["stage_b"] = stage_b_path.read_text()
    sql = """BEGIN;
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='5s';
DO $owned_baseline$
BEGIN
 IF current_database()<>'full_stage1' OR current_user<>'postgres'
    OR inet_server_addr() IS NOT NULL
    OR (SELECT count(*) FROM auth.users)<>15
    OR (SELECT count(*) FROM public.tournaments)<>12
    OR (SELECT count(*) FROM public.tournament_seat_move_receipts)<>3
    OR EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid())
 THEN RAISE EXCEPTION 'requires exclusively owned 15-user/12-event/3-move baseline'; END IF;
 -- Preserve the retained actual session verifier. Never replace it with a stub.
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_caller_session_is_live()')
      AND replace(lower(prosrc),'"','') LIKE '%auth.sessions%')
 THEN RAISE EXCEPTION 'retained auth guard does not prove a real auth.sessions lookup'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_escrow_apply(uuid,text,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric)'))
       IS DISTINCT FROM 'e084726dde176e51a8b1b0d64b0c2f0b'
 THEN RAISE EXCEPTION 'retained exact escrow foundation differs'; END IF;
END;
$owned_baseline$;
"""
    sql += schema_foundation(texts["m4"])
    for key, name, signature, expected, roles in FUNCTIONS:
        sql += install(definition(texts[key], name), name, signature, expected, roles)
    name = "fn_ca_lock_tournament_seat_acquisition"
    item = lane_transform(definition(texts["m6"], name), texts["lane"], name)
    sql += install(item, name, "uuid,uuid,uuid", "b7d371b05e543f1fa9ac3131288bca13")
    # Stage B is now the sole executable source for the final ticket core. It
    # already contains the reviewed tournament-local lane, so no legacy
    # post-source transformation is replayed here.
    sql += install(
        definition(texts["stage_b"], "fn_ca_register_for_tournament_with_ticket_for"),
        "fn_ca_register_for_tournament_with_ticket_for", "uuid,uuid,uuid",
        "73c4229d74a0ebdd79ec48a17e43883b",
    )
    # Only the function declaration is renamed, so its body remains exact M4.
    alias = definition(texts["m4"], "fn_register_for_tournament_with_ticket")
    old = "public.fn_register_for_tournament_with_ticket("
    if alias.count(old) != 1:
        raise ValueError("private ticket alias declaration is ambiguous")
    alias = alias.replace(old, "public.fn_register_for_tournament_with_ticket_before_terminal_gate(", 1)
    sql += install(alias, "fn_register_for_tournament_with_ticket_before_terminal_gate", "uuid,uuid", "bd9bdc21fe6dbdd039a9e4f784ac4f75")
    sql += install(definition(texts["stage_b"], "fn_register_for_tournament_with_ticket"),
        "fn_register_for_tournament_with_ticket", "uuid,uuid", "f7f87de4557415c2a691282202a522b2", "authenticated,service_role")
    # Same narrow source selection used by current entry acceptance. Exclude
    # the historical production player's postcondition, retain substitution
    # cardinality, and verify the exact resulting resolver for this fixture.
    resolver = texts["resolver"]
    if resolver.count("DO $mig$") != 1 or resolver.count("  v_check :=") != 1:
        raise ValueError("tracked resolver boundary differs")
    resolver = resolver[resolver.index("DO $mig$"):resolver.index("  v_check :=")]
    sql += resolver + "\nEND; $mig$;\n"
    sql += """DO $ticket_dependencies$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_tournament_club_for_user(uuid,uuid,uuid)'::regprocedure)
      IS DISTINCT FROM 'f80eff4c311820670f1b71d15c29452d'
 THEN RAISE EXCEPTION 'current resolver body differs'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_sync_tournament_current_players()'::regprocedure)
      IS DISTINCT FROM 'ecb120c2c6a4ecee6c2e04d4c9b5ebc7'
 THEN RAISE EXCEPTION 'current roster count trigger body differs'; END IF;
 IF EXISTS(SELECT 1 FROM (VALUES
   ('public.tournament_tickets','tournament_satellite_entry_ticket_is_guarded','public.fn_ca_satellite_entry_ticket_is_guarded()'),
   ('public.tournament_refund_entitlements','tournament_refund_entitlement_commit_valid','public.fn_ca_refund_entitlement_commit_valid()'),
   ('public.tournament_players','satellite_target_player_provenance_is_immutable','public.fn_satellite_target_player_provenance_is_immutable()'),
   ('public.tournament_players','trg_sync_tournament_current_players','public.fn_sync_tournament_current_players()')
 ) required(relation,name,signature) WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t
   WHERE t.tgrelid=to_regclass(required.relation) AND t.tgname=required.name
     AND t.tgfoid=to_regprocedure(required.signature) AND t.tgenabled='O' AND NOT t.tgisinternal))
 THEN RAISE EXCEPTION 'retained ticket/entitlement/provenance/count trigger graph is incomplete'; END IF;
END;
$ticket_dependencies$;
"""
    probe = (root / PROBE).read_text()
    if probe.count("BEGIN;") != 1 or probe.count("ROLLBACK;") != 1:
        raise ValueError("probe outer transaction boundary changed")
    probe = probe.replace("BEGIN;", "", 1).replace("ROLLBACK;", "", 1)
    sql += probe + "\nROLLBACK;\n"
    return sql


def read(query):
    answer = subprocess.run(CMD, input=query, text=True, capture_output=True, timeout=45)
    if answer.returncode:
        raise RuntimeError(answer.stderr)
    return answer.stdout.strip()


def baseline():
    return read("SELECT current_database()||'|'||current_user||'|'||(inet_server_addr() IS NULL)::text"
        "||'|'||(SELECT count(*) FROM auth.users)||'|'||(SELECT count(*) FROM public.tournaments)"
        "||'|'||(SELECT count(*) FROM public.tournament_seat_move_receipts)"
        "||'|'||(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid());")


def snapshot():
    # Capture absent relations explicitly. No schema is silently invented.
    result = {}
    for name in TABLES:
        if read("SELECT to_regclass(" + quote(name) + ") IS NOT NULL;") != "t":
            result[name] = None
        else:
            result[name] = json.loads(read("SELECT json_build_object('count',count(*),'md5',"
                "md5(COALESCE(string_agg(row_to_json(t)::text,E'\\n' ORDER BY row_to_json(t)::text),''))) FROM " + name + " t;"))
    for name in CATALOGS:
        result["pg_catalog." + name] = read("SELECT md5(COALESCE(string_agg(row_to_json(t)::text,E'\\n' "
            "ORDER BY row_to_json(t)::text),'')) FROM pg_catalog." + name + " t;")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--evidence", type=Path)
    parser.add_argument("--compose-only", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()
    sql = compose(root)
    if args.compose_only:
        print(sql)
        return
    if args.evidence is None:
        parser.error("--evidence is required for execution")
    before_baseline = baseline()
    if before_baseline != "full_stage1|postgres|true|15|12|3|0":
        raise RuntimeError("owned baseline differs: " + before_baseline)
    before = snapshot()
    result = None
    execution_error = None
    try:
        result = subprocess.run(CMD, input=sql, text=True, capture_output=True, timeout=90)
    except subprocess.TimeoutExpired as error:
        execution_error = "local ticket rehearsal timed out and its connection was terminated"
    after = snapshot()
    after_baseline = baseline()
    output = result.stdout if result is not None else ""
    errors = result.stderr if result is not None else execution_error
    markers = re.findall(r"AUDIT_TEST_PASS: ([^\n]+)", errors or "")
    restored = before == after and after_baseline == before_baseline
    passed = (result is not None and result.returncode == 0 and restored and len(markers) == 6
        and output.splitlines().count("EXISTING_TICKET_CURRENT_REDEMPTION_NATIVE_PASS") == 1)
    report = {
        "programme": "109-item comprehensive Club Arena accounting audit",
        "control": "CA-03-10", "recorded_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "status": "passed" if passed else "failed", "production_mutations": False,
        "new_ticket_issuer_executed": False, "source_terminal_completed": False,
        "initial_liability": "Synthetic historical issued direct-entry ticket, 200 chips, matching immutable issue provenance",
        "scope": "Actual authenticated prestart ticket admission, ownership, target, capacity, atomic failure and replay",
        "limits": ["No source satellite terminal execution", "No late table creation or active-hand race",
                   "Local session/role proof, not production HTTP transport", "No new ticket issuance or historical production repair"],
        "baseline_before": before_baseline, "baseline_after": after_baseline,
        "exit_code": result.returncode if result is not None else None,
        "exact_rollback": restored, "passed_checks": markers,
        "source_sha256": {
            **{path: sha for path, sha in SOURCES.values()},
            STAGE_B_RESOLVER: digest((root / STAGE_B_RESOLVER).read_text()),
            str(stage_b_source(root).relative_to(root)): digest(stage_b_source(root).read_text()),
        },
        "probe_sha256": digest((root / PROBE).read_text()), "composed_sha256": digest(sql),
        "before": before, "after": after, "output": output, "error": errors,
    }
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    args.evidence.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({k: report[k] for k in ["status", "exit_code", "exact_rollback", "passed_checks"]}), flush=True)
    if not passed:
        print("\n".join((errors or "").splitlines()[-20:]), flush=True)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
