#!/usr/bin/env python3
"""Compose the exact D9 and current Phase 3 authorities without connecting to a database.

The prepared SQL is one transaction and deliberately refuses source drift.
It must be qualified with the current engine, seat consumer and manager request
contracts before the parent release owner uses it. No production action occurs here.
"""
from pathlib import Path
import argparse
import hashlib
import json
import re
import subprocess

D9_REF = "7682f9340375909e6af81d4fb4f4665071e95784"
BASE_REF = "11a37306788567e9b60d6ac1ab32455b865de5c1"
COMPONENT_PATHS = (
    "scripts/deploy/phase-three-current-satellite-terminal.sql",
    "scripts/deploy/phase-three-satellite-manager-target-scope.sql",
    "scripts/deploy/phase-three-strict-tournament-cutover.sql",
)
OUTPUT_PATH = "scripts/deploy/phase-three-activate-current-and-legacy-terminal-authorities.sql"


def source(root, ref, path):
    return subprocess.check_output(["git", "show", ref+":"+path], cwd=root, text=True)


def h(text):
    return hashlib.md5(text.encode()).hexdigest()


def function_body(text, name):
    """Read one reviewed definition, including D9's dynamic SQL definitions."""
    matches = re.findall(
        r"CREATE(?: OR REPLACE)? FUNCTION public\." + re.escape(name)
        + r"\(.*?AS\s+(\$\w*\$)(.*?)\1", text, re.S,
    )
    if len(matches) != 1:
        raise ValueError(f"expected one definition for {name}; found {len(matches)}")
    return matches[0][1]


def tagged_body(text, tag):
    matches = re.findall(re.escape(tag) + r"(.*?)" + re.escape(tag), text, re.S)
    if len(matches) != 1:
        raise ValueError(f"expected one body tagged {tag}; found {len(matches)}")
    return matches[0]


def function_language(text, name):
    headers = re.findall(
        r"CREATE(?: OR REPLACE)? FUNCTION public\." + re.escape(name)
        + r"\(.*?AS\s+\$\w*\$", text, re.S,
    )
    if len(headers) != 1:
        raise ValueError(f"expected one language header for {name}")
    language = re.search(r"\bLANGUAGE\s+(sql|plpgsql)\b", headers[0], re.I)
    if language is None:
        raise ValueError(f"unrecognized function language for {name}")
    return language[1].lower()


def once(text, before, after):
    count = text.count(before)
    if count != 1:
        raise ValueError(f"expected one source marker; found {count}: {before[:90]!r}")
    return text.replace(before, after, 1)


def sql_literal(text):
    return "'" + text.replace("'", "''") + "'"


def sql_array(values, kind="text"):
    if values is None:
        return "NULL::" + kind + "[]"
    return "ARRAY[" + ",".join(sql_literal(value) for value in values) + "]::" + kind + "[]"


PRIVATE_ACL = ("postgres=X/postgres",)
SERVICE_ACL = PRIVATE_ACL + ("service_role=X/postgres",)
PUBLIC_PATH = ("search_path=public, pg_temp",)
WITNESS_PATH = ("search_path=pg_catalog, public, pg_temp", "TimeZone=UTC")
CASH_PATH = ("search_path=public", "statement_timeout=30s")


def function_pin(identity, body, config=PUBLIC_PATH, acl=PRIVATE_ACL,
                 definer=True, language="plpgsql", volatility="v"):
    return (identity, body, config, acl, definer, language, volatility)


def function_gate(tag, rows):
    """Authenticate bodies and the metadata that gives those bodies authority."""
    values = []
    for identity, body, config, acl, definer, language, volatility in rows:
        values.append("  (" + ",".join((
            sql_literal(identity), sql_literal(body), sql_array(config),
            sql_array(acl, "aclitem"), str(definer).lower(),
            sql_literal(language), sql_literal(volatility),
        )) + ")")
    value_sql = ",\n".join(values)
    return f"""DO ${tag}$
DECLARE r record; p pg_proc%ROWTYPE;
BEGIN
 FOR r IN SELECT * FROM (VALUES
{value_sql}
 ) expected(identity,body_md5,config,acl,definer,language,volatility) LOOP
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(r.identity);
  IF NOT FOUND OR md5(p.prosrc) IS DISTINCT FROM r.body_md5
   OR p.proowner IS DISTINCT FROM 'postgres'::regrole
   OR p.prosecdef IS DISTINCT FROM r.definer
   OR p.proconfig IS DISTINCT FROM r.config OR p.proacl IS DISTINCT FROM r.acl
   OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname=r.language)
   OR p.provolatile::text IS DISTINCT FROM r.volatility THEN
   RAISE EXCEPTION '{tag} source or metadata differs: %',r.identity;
  END IF;
 END LOOP;
END ${tag}$;
"""


def d9_function_pins(accepted, cash, satellite):
    """All 17 D9 authorities, resolved from the exact reviewed commit sources."""
    specs = (
        ("fn_ca_accepted_tournament_settlement_fact(jsonb)", accepted, WITNESS_PATH, PRIVATE_ACL, True, "plpgsql", "i"),
        ("fn_ca_legacy_tournament_finish_witness(uuid)", accepted, WITNESS_PATH, PRIVATE_ACL, True, "plpgsql", "s"),
        ("fn_ca_legacy_finish_source_rows(uuid)", cash, WITNESS_PATH, PRIVATE_ACL, True, "sql", "s"),
        ("fn_ca_guard_legacy_finish_evidence()", satellite, WITNESS_PATH, PRIVATE_ACL, True, "plpgsql", "v"),
        ("fn_ca_legacy_finish_sealed_witness(uuid)", satellite, WITNESS_PATH, PRIVATE_ACL, True, "plpgsql", "s"),
        ("fn_ca_legacy_finish_standings_are_exact(uuid)", cash, WITNESS_PATH, PRIVATE_ACL, True, "plpgsql", "s"),
        ("fn_ca_legacy_finish_must_close()", satellite, WITNESS_PATH, PRIVATE_ACL, True, "plpgsql", "v"),
        ("fn_ca_complete_legacy_tournament(uuid,text)", satellite, WITNESS_PATH + ("statement_timeout=45s",), PRIVATE_ACL, True, "plpgsql", "v"),
        ("fn_settle_tournament_places(uuid,uuid)", cash, CASH_PATH, SERVICE_ACL, True, "plpgsql", "v"),
        ("fn_refuse_new_entries_while_frozen()", cash, PUBLIC_PATH, None, False, "plpgsql", "v"),
        ("fn_ca_verify_terminal_place_batch(uuid,boolean)", cash, PUBLIC_PATH, PRIVATE_ACL, True, "plpgsql", "v"),
        ("fn_ca_legacy_satellite_contract_proof(uuid)", satellite, WITNESS_PATH, PRIVATE_ACL, True, "plpgsql", "s"),
        ("fn_ca_legacy_satellite_receipt_check(uuid,uuid,boolean)", satellite, CASH_PATH, PRIVATE_ACL, True, "plpgsql", "v"),
        ("trg_capture_satellite_economics_on_start()", satellite, PUBLIC_PATH, PRIVATE_ACL, True, "plpgsql", "v"),
        ("trg_guard_atomic_satellite_completion()", satellite, PUBLIC_PATH, PRIVATE_ACL, True, "plpgsql", "v"),
        ("fn_guard_tournament_completed_certificate()", satellite, PUBLIC_PATH, PRIVATE_ACL, True, "plpgsql", "v"),
        ("fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)", satellite, CASH_PATH, PRIVATE_ACL, True, "plpgsql", "v"),
    )
    return [function_pin("public." + identity, h(function_body(text, identity.split("(")[0])),
                         config, acl, definer, language, volatility)
            for identity, text, config, acl, definer, language, volatility in specs]


# Exact trigger definitions were read without writes from d9_combined_full_stage
# on 2026-09-11. Their event masks, predicates, function bindings and deferred
# state are part of the D12/legacy seal contract, not mere trigger existence.
TRIGGER_PINS = (
    ("tournaments", "aa_guard_tournament_completing_claim", "fn_guard_tournament_completing_claim()", 19, False, False, False,
     "CREATE TRIGGER aa_guard_tournament_completing_claim BEFORE UPDATE OF status ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_tournament_completing_claim()"),
    ("tournaments", "aaa_guard_atomic_satellite_completion", "trg_guard_atomic_satellite_completion()", 19, False, False, False,
     "CREATE TRIGGER aaa_guard_atomic_satellite_completion BEFORE UPDATE OF status ON public.tournaments FOR EACH ROW EXECUTE FUNCTION trg_guard_atomic_satellite_completion()"),
    ("tournaments", "zzzz_freeze_finalized_tournament_prize_pool", "trg_freeze_finalized_tournament_prize_pool()", 19, False, False, False,
     "CREATE TRIGGER zzzz_freeze_finalized_tournament_prize_pool BEFORE UPDATE OF prize_pool, guaranteed_prize, prize_pool_finalized, payout_structure, spin_multiplier ON public.tournaments FOR EACH ROW EXECUTE FUNCTION trg_freeze_finalized_tournament_prize_pool()"),
    ("tournaments", "zzzz_tournament_pool_finalization_window_guard", "trg_tournament_pool_finalization_window_guard()", 19, False, False, False,
     "CREATE TRIGGER zzzz_tournament_pool_finalization_window_guard BEFORE UPDATE OF prize_pool_finalized ON public.tournaments FOR EACH ROW EXECUTE FUNCTION trg_tournament_pool_finalization_window_guard()"),
    ("tournaments", "zzzz_tournaments_atomic_place_completion_guard", "trg_tournament_atomic_place_completion_guard()", 19, False, False, True,
     "CREATE TRIGGER zzzz_tournaments_atomic_place_completion_guard BEFORE UPDATE ON public.tournaments FOR EACH ROW WHEN (((new.status = 'COMPLETED'::text) AND (old.status IS DISTINCT FROM 'COMPLETED'::text))) EXECUTE FUNCTION trg_tournament_atomic_place_completion_guard()"),
    ("tournaments", "zzzzz_tournaments_atomic_final_table_deal_completion_guard", "trg_atomic_final_table_deal_completion_guard()", 19, False, False, True,
     "CREATE TRIGGER zzzzz_tournaments_atomic_final_table_deal_completion_guard BEFORE UPDATE OF status ON public.tournaments FOR EACH ROW WHEN (((new.status = 'COMPLETED'::text) AND (old.status IS DISTINCT FROM 'COMPLETED'::text))) EXECUTE FUNCTION trg_atomic_final_table_deal_completion_guard()"),
    ("tournaments", "zzzzzz_tournaments_financial_certificate", "fn_guard_tournament_completed_certificate()", 19, False, False, True,
     "CREATE TRIGGER zzzzzz_tournaments_financial_certificate BEFORE UPDATE OF status ON public.tournaments FOR EACH ROW WHEN (((new.status = 'COMPLETED'::text) AND (old.status IS DISTINCT FROM 'COMPLETED'::text))) EXECUTE FUNCTION fn_guard_tournament_completed_certificate()"),
    ("tournament_legacy_finish_evidence", "legacy_finish_evidence_is_append_only", "fn_ca_guard_legacy_finish_evidence()", 31, False, False, False,
     "CREATE TRIGGER legacy_finish_evidence_is_append_only BEFORE INSERT OR DELETE OR UPDATE ON public.tournament_legacy_finish_evidence FOR EACH ROW EXECUTE FUNCTION fn_ca_guard_legacy_finish_evidence()"),
    ("tournament_legacy_finish_evidence", "legacy_finish_evidence_cannot_truncate", "fn_ca_guard_legacy_finish_evidence()", 34, False, False, False,
     "CREATE TRIGGER legacy_finish_evidence_cannot_truncate BEFORE TRUNCATE ON public.tournament_legacy_finish_evidence FOR EACH STATEMENT EXECUTE FUNCTION fn_ca_guard_legacy_finish_evidence()"),
    ("tournament_legacy_finish_evidence", "legacy_finish_requires_same_transaction_completion", "fn_ca_legacy_finish_must_close()", 5, True, True, False,
     "CREATE CONSTRAINT TRIGGER legacy_finish_requires_same_transaction_completion AFTER INSERT ON public.tournament_legacy_finish_evidence DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_ca_legacy_finish_must_close()"),
    ("table_seats", "zy_tournament_live_seat_exit_requires_authority", "fn_tournament_live_seat_exit_requires_authority()", 27, False, False, False,
     "CREATE TRIGGER zy_tournament_live_seat_exit_requires_authority BEFORE DELETE OR UPDATE OF table_id, user_id, seat_number, left_at, status ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_tournament_live_seat_exit_requires_authority()"),
)


def trigger_gate(tag):
    rows = []
    for relation, name, identity, kind, deferred, initially_deferred, has_when, definition in TRIGGER_PINS:
        rows.append("  (" + ",".join((
            sql_literal("public." + relation), sql_literal(name),
            sql_literal("public." + identity), str(kind), str(deferred).lower(),
            str(initially_deferred).lower(), str(has_when).lower(), sql_literal(definition),
        )) + ")")
    row_sql = ",\n".join(rows)
    return f"""DO ${tag}$
BEGIN
 IF EXISTS(SELECT 1 FROM (VALUES
{row_sql}
 ) expected(relation,name,identity,kind,deferred,initially_deferred,has_when,definition)
 WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t
  WHERE t.tgrelid=to_regclass(expected.relation) AND t.tgname=expected.name
   AND t.tgfoid=to_regprocedure(expected.identity) AND t.tgenabled='O'
   AND NOT t.tgisinternal AND t.tgtype=expected.kind AND t.tgnargs=0
   AND t.tgdeferrable=expected.deferred AND t.tginitdeferred=expected.initially_deferred
   AND (t.tgqual IS NOT NULL)=expected.has_when
   AND pg_get_triggerdef(t.oid)=expected.definition)) THEN
  RAISE EXCEPTION '{tag} requires exact enabled tournament, legacy seal and seat triggers';
 END IF;
END ${tag}$;
"""


def preserved_function_pins():
    return [
        function_pin("public.fn_tournament_live_seat_exit_requires_authority()",
                     "74c1a1a6b2c9ccbf8fe04f875bfba2e2"),
        function_pin("public.fn_complete_tournament_terminal(uuid,uuid,text)",
                     "541b6e9d029b8eec7f55aa4ad6965a63",
                     PUBLIC_PATH + ("statement_timeout=45s",), SERVICE_ACL),
        function_pin("public.fn_settle_satellite_tournament(uuid,uuid)",
                     "486d0e6729de8d518d7faf0c253b65d3",
                     PUBLIC_PATH + ("statement_timeout=30s",), SERVICE_ACL),
        function_pin("public.fn_ca_satellite_settlement_receipt(uuid,uuid)",
                     "381b3e0691a2b9303693653f5110d568", CASH_PATH),
    ]


def final_function_pins(d9_pins, base, manager, strict, replacements):
    """Use final emitted bodies, so later helper edits cannot leave stale pins.

    The original legacy core and intermediate current core are authenticated
    by their own transformation blocks. Only the final manager core belongs
    in this final catalog gate; a function cannot retain all three versions.
    """
    rows = [(identity, replacements.get(identity, body), *metadata)
            for identity, body, *metadata in d9_pins]
    rows.extend(preserved_function_pins())
    for text, identities in (
        (base, (
            "fn_ca_satellite_terminal_scope(uuid)",
            "fn_ca_open_satellite_terminal_scope(uuid)",
            "fn_ca_close_satellite_terminal_scope(uuid,jsonb)",
            "fn_ca_satellite_pending_transition(public.tournaments,public.tournaments)",
            "fn_ca_satellite_terminal_commit_proof()",
            "fn_ca_satellite_terminal_scope_consumed()",
        )),
        (manager, (
            "fn_ca_satellite_manager_target_immutable()",
            "fn_ca_publish_satellite_manager_target(uuid,uuid,jsonb)",
            "fn_ca_satellite_manager_target_write(text,text,jsonb,jsonb)",
        )),
    ):
        for identity in identities:
            rows.append(function_pin("public." + identity,
                        h(function_body(text, identity.split("(")[0])),
                        language=function_language(text, identity.split("(")[0])))
    rows.extend((
        function_pin("public.fn_ca_verify_current_satellite_terminal(uuid,uuid,boolean)",
                     h(function_body(base, "fn_ca_verify_current_satellite_terminal")), CASH_PATH),
        function_pin("public.fn_tournament_finish_readiness(uuid,uuid)",
                     h(tagged_body(base, "$patch_body_readiness$"))),
        function_pin("public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)",
                     h(function_body(strict, "fn_settle_tournament_obligation")),
                     PUBLIC_PATH, SERVICE_ACL),
    ))
    return rows


def empty_capability_gate():
    return """DO $current_legacy_no_capabilities$
BEGIN
 IF EXISTS(SELECT 1 FROM public.tournament_satellite_terminal_authorizations)
  OR EXISTS(SELECT 1 FROM public.tournament_satellite_manager_targets)
  OR EXISTS(SELECT 1 FROM public.tournament_seat_exit_authorizations) THEN
  RAISE EXCEPTION 'current/legacy activation retained a transaction capability';
 END IF;
END $current_legacy_no_capabilities$;
"""


def compose(root):
    root=Path(root).resolve()
    accepted=source(root,D9_REF,"supabase/migrations/20260911163920_accepted_tournament_settlement_facts.sql")
    sat=source(root,D9_REF,"supabase/migrations/20260911172413_complete_legacy_satellites_through_sealed_canonical_settleme.sql")
    cash=source(root,D9_REF,"supabase/migrations/20260911170040_complete_legacy_tournaments_from_sealed_accepted_hands.sql")
    originals=[]
    for path in COMPONENT_PATHS:
        value=(root/path).read_text()
        if value!=source(root,BASE_REF,path):
            raise ValueError("Phase 3 source differs from reviewed input: "+path)
        originals.append(value)
    base,manager,strict=originals
    occupancy_gate = """DO $occupancy_prerequisite$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.table_seats'::regclass
  AND attname='occupancy_id' AND atttypid='uuid'::regtype AND attnotnull AND NOT attisdropped)
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_stamp_seat_occupancy()')
  AND md5(prosrc)='aa11dad7e910735d01c28c8638698a3f')
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.table_seats'::regclass
  AND tgname='zzz_stamp_seat_occupancy' AND tgenabled='O' AND tgtype=23
  AND tgfoid=to_regprocedure('public.fn_stamp_seat_occupancy()')) THEN
  RAISE EXCEPTION 'current/legacy activation requires the canonical seat occupancy schema';
 END IF;
END $occupancy_prerequisite$;
"""
    base = once(base, 'END $preflight$;', 'END $preflight$;\n' + occupancy_gate)
    # 1. Retain D9's sealed standings branch inside the current scoped core.
    # The remainder of the current core, including seat closure, is unchanged.
    core = tagged_body(base, "$patch_body_core$")
    legacy_core = function_body(sat, 'fn_settle_satellite_tournament_pre_money_path_gate')
    a = legacy_core.index('  IF public.fn_ca_legacy_finish_sealed_witness(p_tournament_id) IS NOT NULL THEN')
    b = legacy_core.index('  SELECT count(*), count(DISTINCT tp.position)', a)
    legacy_branch = legacy_core[a:b]
    original_branch = core[core.index('  SELECT count(*), count(tp.elimination_sequence)'):core.index('  SELECT count(*), count(DISTINCT tp.position)')]
    combined_core = once(core, original_branch, legacy_branch)
    base = once(base, core, combined_core)
    base = base.replace("'83bf8b297d07bbae671707f24afec271'", repr(h(legacy_core))).replace("'0e2066fafe3c4e1fceb96db9937b3140'", repr(h(combined_core)))
    # 2. Route sealed receipts to the existing private D9 verifier. Current
    # receipts continue through the exact current inflight/deferred proof.
    verifier = tagged_body(base, "$current_satellite_proof$")
    anchor = "  IF lower(COALESCE(v_source.variant, '')) <> 'satellite'"
    insert = '  IF public.fn_ca_legacy_finish_sealed_witness(p_tournament_id) IS NOT NULL THEN\n    RETURN public.fn_ca_legacy_satellite_receipt_check(\n      p_tournament_id,p_observed_winner_id,NOT p_inflight);\n  END IF;\n'
    open_scope = tagged_body(base, "$open_scope$")
    new_open_scope = once(open_scope,
        "COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.seat_id),'[]'::jsonb)\n FROM public.tournament_seat_exit_authorizations a WHERE a.token=v_token;",
        "COALESCE(jsonb_agg(to_jsonb(a)||jsonb_build_object('seat_identity',jsonb_build_object('table_id',s.table_id,'seat_number',s.seat_number,'joined_at',extract(epoch from s.joined_at),'occupancy_id',s.occupancy_id)) ORDER BY a.seat_id),'[]'::jsonb)\n FROM public.tournament_seat_exit_authorizations a JOIN public.table_seats s ON s.id=a.seat_id WHERE a.token=v_token;")
    base = once(base, open_scope, new_open_scope).replace('519bfbe4b59c3d833ae7d59570b89203', h(new_open_scope))
    strict = strict.replace('519bfbe4b59c3d833ae7d59570b89203', h(new_open_scope))
    new_verifier = once(verifier, anchor, insert + anchor)
    new_verifier = once(new_verifier,
        "AND source_table.tournament_id=p_tournament_id)))",
        "AND source_table.tournament_id=p_tournament_id\n                AND e->'seat_identity' IS NOT DISTINCT FROM jsonb_build_object('table_id',seat.table_id,'seat_number',seat.seat_number,'joined_at',extract(epoch from seat.joined_at),'occupancy_id',seat.occupancy_id))))")
    base = once(base, verifier, new_verifier).replace("'0977ca13c91ea1aef766cf6d81f0c816'", repr(h(new_verifier)))
    old_guard = function_body(sat, 'trg_guard_atomic_satellite_completion')
    base = base.replace("'517504ed4bae5ac000d6c47a6f5cb0d9'", repr(h(old_guard)))
    # 3. Use the canonical completion certificate immediately, then let the
    # sealed transaction's deferred trigger certify the final closed receipt.
    old_cert = function_body(sat, 'fn_guard_tournament_completed_certificate')
    cert = once(old_cert, '  v_legacy jsonb;\n', '')
    a = cert.index('  v_legacy:=public.fn_ca_legacy_finish_sealed_witness(NEW.id);')
    b = cert.index('  v_kind := public.fn_tournament_finish_kind(NEW.id);', a)
    cert = cert[:a] + cert[b:]
    if h(cert) != 'd994347e1b76c936ce13361d73f94fd2':
        raise ValueError("restored canonical certificate body differs")
    base = once(base, "AND md5(prosrc)='d994347e1b76c936ce13361d73f94fd2'", 'AND md5(prosrc)=' + repr(h(old_cert)))
    cert_patch = "\nDO $restore_current_certificate$\nDECLARE f oid:='public.fn_guard_tournament_completed_certificate()'::regprocedure;\n b text; d text; before_meta jsonb; after_meta jsonb;\nBEGIN\n SELECT prosrc,pg_get_functiondef(oid),to_jsonb(p)-'prosrc' INTO b,d,before_meta FROM pg_proc p WHERE oid=f;\n IF md5(b)<>'" + h(old_cert) + "' THEN RAISE EXCEPTION 'D9 certificate preimage differs'; END IF;\n EXECUTE replace(d,b,$combined_certificate$" + cert + "$combined_certificate$);\n SELECT to_jsonb(p)-'prosrc' INTO after_meta FROM pg_proc p WHERE oid=f;\n IF before_meta IS DISTINCT FROM after_meta THEN RAISE EXCEPTION 'certificate metadata changed'; END IF;\nEND $restore_current_certificate$;\n"
    base = once(base, 'END $preflight$;', 'END $preflight$;\n' + cert_patch)
    old_deferred = function_body(sat, 'fn_ca_legacy_finish_must_close')
    deferred = once(old_deferred, "  UPDATE public.tournament_finish_receipts SET certified_at=clock_timestamp(),completed_at=(r->>'settled_at')::timestamptz,", "  IF NEW.created_txid IS DISTINCT FROM txid_current()\n   OR (r->>'settled_at')::timestamptz IS DISTINCT FROM transaction_timestamp()\n  THEN RAISE EXCEPTION 'legacy final certification is outside its sealed transaction'; END IF;\n  UPDATE public.tournament_finish_receipts SET certified_at=COALESCE(certified_at,clock_timestamp()),completed_at=(r->>'settled_at')::timestamptz,")
    deferred = once(deferred, '    AND certified_at IS NULL AND evidence IS NULL;', "    AND ((certified_at IS NULL AND evidence IS NULL) OR (\n      certified_at=transaction_timestamp() AND updated_at=transaction_timestamp()\n      AND completed_at=(r->>'settled_at')::timestamptz\n      AND evidence=r||jsonb_build_object('fully_settled',false,\n        'financially_verified',true,'status','COMPLETING')));")
    deferred_patch = "\nDO $compose_legacy_deferred_certificate$\nDECLARE f oid:='public.fn_ca_legacy_finish_must_close()'::regprocedure;\n b text; d text; before_meta jsonb; after_meta jsonb;\nBEGIN\n SELECT prosrc,pg_get_functiondef(oid),to_jsonb(p)-'prosrc' INTO b,d,before_meta FROM pg_proc p WHERE oid=f;\n IF md5(b)<>'" + h(old_deferred) + "' THEN RAISE EXCEPTION 'D9 deferred certificate preimage differs'; END IF;\n EXECUTE replace(d,b,$combined_deferred_certificate$" + deferred + "$combined_deferred_certificate$);\n SELECT to_jsonb(p)-'prosrc' INTO after_meta FROM pg_proc p WHERE oid=f;\n IF before_meta IS DISTINCT FROM after_meta THEN RAISE EXCEPTION 'deferred certificate metadata changed'; END IF;\nEND $compose_legacy_deferred_certificate$;\n"
    base = once(base, 'END $restore_current_certificate$;', 'END $restore_current_certificate$;\n' + deferred_patch)
    # 4. Publish the exact target capability without changing either payer.
    manager = manager.replace('0e2066fafe3c4e1fceb96db9937b3140', h(combined_core))
    combined_target = once(combined_core, "  UPDATE public.tournaments\n     SET status = 'COMPLETING', updated_at = now()", "  PERFORM public.fn_ca_publish_satellite_manager_target(\n    p_tournament_id,v_target_id,v_plan);\n\n  UPDATE public.tournaments\n     SET status = 'COMPLETING', updated_at = now()")
    manager = manager.replace('c5ba0595fc5363ecc94243b003a3d326', h(combined_target))
    strict = strict.replace('c5ba0595fc5363ecc94243b003a3d326', h(combined_target)).replace('0977ca13c91ea1aef766cf6d81f0c816', h(new_verifier))
    strict = strict.replace('96a61ea5e16560735bcb70b355aa79ab', '541b6e9d029b8eec7f55aa4ad6965a63')
    new_place = function_body(cash, 'fn_ca_verify_terminal_place_batch')
    # D9 already installed the exact verifier. A cutover must never silently
    # overwrite a changed financial proof while authenticating only its writer.
    a = strict.index('CREATE OR REPLACE FUNCTION public.fn_ca_verify_terminal_place_batch(')
    end = ' FROM PUBLIC,anon,authenticated,service_role;'
    b = strict.index(end, a) + len(end)
    verifier_gate = """DO $preserve_d9_place_verifier$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE
  oid='public.fn_ca_verify_terminal_place_batch(uuid,boolean)'::regprocedure
  AND md5(prosrc)='c13263e1ba4d0c5e28380b894cb2e74d'
  AND proowner='postgres'::regrole AND prosecdef
  AND proconfig=ARRAY['search_path=public, pg_temp']::text[]
  AND proacl=ARRAY['postgres=X/postgres']::aclitem[])
 THEN RAISE EXCEPTION 'D9 canonical place verifier source or metadata differs'; END IF;
END $preserve_d9_place_verifier$;"""
    strict = strict[:a] + verifier_gate + strict[b:]
    strict = strict.replace("t.tgenabled <> 'D'", "t.tgenabled = 'O'")

    # 5. Preserve D9's cash writer/verifier and D12's claim wrapper. Phase 3
    # contracts the existing raw leaves; it must not restore older place logic.
    writer = function_body(cash, 'fn_settle_tournament_places')
    a = strict.index(" IF md5(v_source) NOT IN ('d0262f4928b12eea1cc5e9175cbf2737'")
    b = strict.index(" v_oid:=to_regprocedure('public.trg_tournament_atomic_place_completion_guard()');", a)
    strict = strict[:a] + ' IF md5(v_source)<>' + repr(h(writer)) + " THEN\n  RAISE EXCEPTION 'D9 canonical place writer source differs';\n END IF;\n" + strict[b:]
    old_expand = "    IF position('FOR UPDATE' IN v_source) > 0\n       OR v_satellite_guard_enabled\n       OR v_guard_enabled\n       OR v_final_deal_guard_enabled\n       OR v_finish_claim_guard_enabled\n       OR v_finish_certificate_guard_enabled\n       OR v_pool_window_guard_enabled\n       OR v_pool_freeze_guard_enabled THEN"
    new_expand = "    IF position('FOR UPDATE' IN v_source) > 0\n       OR NOT v_satellite_guard_enabled\n       OR NOT v_guard_enabled\n       OR NOT v_final_deal_guard_enabled\n       OR NOT v_finish_claim_guard_enabled\n       OR NOT v_finish_certificate_guard_enabled\n       OR NOT v_pool_window_guard_enabled\n       OR NOT v_pool_freeze_guard_enabled\n       OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE\n          oid='public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)'::regprocedure\n          AND md5(prosrc)='915f3ebd5c4a2efb97ad3a354dfeb365') THEN"
    strict = once(strict, old_expand, new_expand)
    # 6. Authenticate the complete D9 dependency closure and exact trigger
    # consumers before any replacement. These gates are also reused at commit.
    d9_pins = d9_function_pins(accepted, cash, sat)
    preflight = trigger_gate("current_legacy_trigger_preflight")
    preflight += function_gate("current_legacy_source_preflight",
                               d9_pins + preserved_function_pins())
    base = once(base, "DO $preflight$", preflight + "\nDO $preflight$")

    # 7. Check every final emitted authority and all durable trigger consumers.
    # Hash helper bodies from the composed SQL, including future reviewed
    # occupancy changes, instead of keeping another literal hash inventory.
    replacements = {
        "public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)": h(combined_target),
        "public.trg_guard_atomic_satellite_completion()": h(tagged_body(base, "$patch_body_satellite_guard$")),
        "public.fn_guard_tournament_completed_certificate()": h(cert),
        "public.fn_ca_legacy_finish_must_close()": h(deferred),
    }
    final_pins = final_function_pins(d9_pins, base, manager, strict, replacements)
    final_checks = function_gate("current_legacy_source_postflight", final_pins)
    final_checks += trigger_gate("current_legacy_trigger_postflight")
    final_checks += empty_capability_gate()
    strict = once(strict, "\nCOMMIT;", "\n" + final_checks + "\nCOMMIT;")

    pins={'legacyCore':h(legacy_core),'combinedBaseCore':h(combined_core),'combinedManagerCore':h(combined_target),'combinedVerifier':h(new_verifier),'placeVerifier':h(new_place),'restoredCertificate':h(cert),'deferredCertificate':h(deferred)}
    components={'current-legacy-base.sql':base,'current-legacy-manager.sql':manager,'current-legacy-strict.sql':strict}
    first="/* A busy relation aborts the whole cutover"
    last="LOCK TABLE realtime.subscription IN ACCESS EXCLUSIVE MODE NOWAIT;"
    lock_block=strict[strict.index(first):strict.index(last)+len(last)]
    public_locks=list(re.finditer(r"^LOCK TABLE public\.([a-z_]+)\s+IN (SHARE ROW EXCLUSIVE|EXCLUSIVE) MODE NOWAIT;",strict,re.M))
    expected=("tables","tournament_table_origins","tournament_capacity_table_receipts","tournament_manager_wakes","engine_tournament_leases","tournaments","tournament_obligations","tournament_payouts","tournament_final_table_deal_batches","tournament_final_table_deal_receipts")
    if tuple(m[1] for m in public_locks)!=expected:
        raise ValueError("canonical public lock ordering differs")
    bundle="-- Prepared current and sealed legacy terminal composition. NOT APPLIED.\n-- Requires D9, D12 and the exact enabled seat consumer before this one-pass activation.\nBEGIN;\n"+lock_block+"\n"+"\n".join(m[0] for m in public_locks)+"\n"
    for name,value in components.items():
        if len(re.findall(r"^BEGIN;$",value,re.M))!=1 or len(re.findall(r"^COMMIT;$",value,re.M))!=1:
            raise ValueError("component transaction boundary differs: "+name)
        bundle+="\n-- BEGIN "+name+" SHA256 "+hashlib.sha256(value.encode()).hexdigest()+"\n"+re.sub(r"^(BEGIN|COMMIT);$","",value,flags=re.M)+"\n-- END "+name+"\n"
    bundle+="\nCOMMIT;\n"
    return bundle,components,pins


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root",type=Path,default=Path(__file__).resolve().parents[2])
    parser.add_argument("--check",action="store_true",help="verify prepared artifact without writing")
    parser.add_argument("--components",type=Path,help="optional local component/evidence directory")
    args=parser.parse_args()
    bundle,components,pins=compose(args.root)
    target=args.root/OUTPUT_PATH
    if args.check:
        if not target.is_file() or target.read_text()!=bundle:
            raise ValueError("prepared current/legacy artifact differs")
    else:
        target.write_text(bundle)
    if args.components:
        args.components.mkdir(parents=True,exist_ok=True)
        for name,value in components.items():
            (args.components/name).write_text(value)
        (args.components/"composition-pins.json").write_text(json.dumps(pins,indent=2)+"\n")
    print(json.dumps({"artifact":OUTPUT_PATH,"sha256":hashlib.sha256(bundle.encode()).hexdigest(),"pins":pins}))


if __name__=="__main__":
    main()
