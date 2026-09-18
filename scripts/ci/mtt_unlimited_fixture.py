"""Compose the retained real PRE-R46 PostgreSQL catalog; never connect or run it.

The caller owns its private PostgreSQL 17 cluster, applies the candidate migration
separately, runs all three native probes and six isolation cases, and disposes it.
No legacy ticket composer, payment stand-in, or production row dump is used.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re


DATA = Path("scripts/ci/fixtures/mtt-unlimited")
SCHEMA_PARTS = (
    "accounting-schema.sql",
    "accounting-access.sql",
    "accounting-policies.sql",
    "accounting-seed-registry.sql",
)
SUPPLEMENTS = (
    "function-capture-20260916.json",
    "function-dependencies-20260916.json",
)
SATELLITE_SUCCESSOR = "scripts/ci/fixtures/mtt-format-preparation/current-satellite-successor-20260917.json"
SATELLITE_SIGNATURE = "public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)"


def _literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def _json_sql(value: object) -> str:
    return _literal(json.dumps(value, separators=(",", ":"))) + "::jsonb"


def _inputs(root: Path) -> tuple[dict, dict[str, str], dict[str, str]]:
    """Read content-bound fixture assets. No import-time work or execution."""
    root = root.resolve()
    binding_path = root / DATA / "source-binding.json"
    binding = json.loads(binding_path.read_text())
    texts: dict[str, str] = {}
    hashes = {str(DATA / "source-binding.json"): hashlib.sha256(binding_path.read_bytes()).hexdigest()}
    for name, expected in binding["files"].items():
        if Path(name).name != name:
            raise ValueError("fixture input must be a basename: " + name)
        data = (root / DATA / name).read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if digest != expected["sha256"]:
            raise ValueError("MTT captured source binding changed: " + name)
        texts[name] = data.decode("utf-8")
        hashes[str(DATA / name)] = digest
    loader = root / "scripts/ci/mtt_unlimited_fixture.py"
    hashes[str(loader.relative_to(root))] = hashlib.sha256(loader.read_bytes()).hexdigest()
    return binding, texts, hashes


def preconditions_sql(root: Path | None = None) -> str:
    """These are safety/shape checks, not resource admission or a test result."""
    return """DO $r46_empty_local$
BEGIN
 IF current_user <> 'postgres' OR inet_server_addr() IS NOT NULL
    OR current_database() !~ '^r46_mtt_'
    OR current_setting('server_version_num')::integer / 10000 <> 17 THEN
  RAISE EXCEPTION 'R46 fixture requires its private local PostgreSQL 17 database';
 END IF;
 IF to_regnamespace('auth') IS NOT NULL OR to_regclass('public.tournaments') IS NOT NULL
    OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m')) THEN
  RAISE EXCEPTION 'R46 fixture refuses a database with existing application schema';
 END IF;
END $r46_empty_local$;
"""


def _supplement_sql(rows: list[dict]) -> str:
    result = []
    seen = set()
    for row in rows:
        signature = "public." + row["signature"]
        if signature in seen:
            raise ValueError("duplicate captured function: " + signature)
        seen.add(signature)
        definition = row["definition"]
        tag = re.search(r"\bAS\s+(\$[A-Za-z_0-9]*\$)", definition, re.I)
        if tag is None:
            raise ValueError("captured function body delimiter missing: " + signature)
        body = definition[tag.end():definition.index(tag[1], tag.end())]
        if hashlib.md5(body.encode()).hexdigest() != row["source_md5"]:
            raise ValueError("captured function body changed: " + signature)
        if hashlib.md5(definition.encode()).hexdigest() != row["definition_md5"]:
            raise ValueError("captured function definition changed: " + signature)
        # These supplement only missing catalog functions. Never overwrite a
        # divergent authority or silently adopt an unexpected newer baseline.
        result.append("DO $absent$ BEGIN IF to_regprocedure(" + _literal(signature)
                      + ") IS NOT NULL THEN RAISE EXCEPTION 'R46 supplement already exists: %',"
                      + _literal(signature) + "; END IF; END $absent$;")
        result.append(definition.rstrip().rstrip(";") + ";")
        result.append("ALTER FUNCTION " + signature + " OWNER TO " + _identifier(row["owner"]) + ";")
        roles = {"PUBLIC", "anon", "authenticated", "service_role", row["owner"]}
        roles.update(grant["role"] for grant in row["grants"])
        result.append("REVOKE ALL ON FUNCTION " + signature + " FROM "
                      + ",".join("PUBLIC" if role == "PUBLIC" else _identifier(role)
                                 for role in sorted(roles)) + ";")
        for grant in row["grants"]:
            if grant["privilege"] != "EXECUTE":
                raise ValueError("unexpected function privilege: " + signature)
            result.append("GRANT EXECUTE ON FUNCTION " + signature + " TO "
                          + ("PUBLIC" if grant["role"] == "PUBLIC" else _identifier(grant["role"]))
                          + (" WITH GRANT OPTION" if grant["grantable"] else "") + ";")
    return "\n".join(result) + "\n"


def _waitlist_sql(row: dict) -> str:
    """The single actual missing relation, including its original access rules."""
    if (row["schema_name"], row["name"], row["relkind"]) != ("public", "tournament_waitlists", "r"):
        raise ValueError("unexpected R46 table supplement")
    if row["triggers"]:
        raise ValueError("waitlist capture gained triggers requiring explicit dependency review")
    table = "public.tournament_waitlists"
    result = ["DO $absent$ BEGIN IF to_regclass('" + table + "') IS NOT NULL THEN "
              "RAISE EXCEPTION 'R46 waitlist table already exists'; END IF; END $absent$;"]
    columns = []
    for column in row["columns"]:
        if column["identity"] or column["generated"] or column["acl"] is not None:
            raise ValueError("waitlist column contract changed")
        columns.append(_identifier(column["name"]) + " " + column["type"]
                       + (" DEFAULT " + column["default"] if column["default"] is not None else "")
                       + (" NOT NULL" if column["notnull"] else ""))
    result.append("CREATE TABLE " + table + " (" + ",".join(columns) + ");")
    for constraint in row["constraints"]:
        result.append("ALTER TABLE " + table + " ADD CONSTRAINT "
                      + _identifier(constraint["name"]) + " " + constraint["definition"] + ";")
    for index in row["indexes"]:
        if not index["valid"] or not index["ready"]:
            raise ValueError("captured waitlist index is not usable")
        if not index["constraint_backed"]:
            result.append(index["definition"] + ";")
    result.append("ALTER TABLE " + table + " OWNER TO " + _identifier(row["owner"]) + ";")
    result.append("REVOKE ALL ON TABLE " + table + " FROM PUBLIC,anon,authenticated,service_role,postgres;")
    allowed = {"SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"}
    for grant in row["grants"]:
        if grant["privilege"] not in allowed:
            raise ValueError("unexpected table privilege")
        result.append("GRANT " + grant["privilege"] + " ON TABLE " + table + " TO "
                      + ("PUBLIC" if grant["role"] == "PUBLIC" else _identifier(grant["role"]))
                      + (" WITH GRANT OPTION" if grant["grantable"] else "") + ";")
    commands = {"*": "ALL", "r": "SELECT", "a": "INSERT", "w": "UPDATE", "d": "DELETE"}
    for policy in row["policies"]:
        result.append("CREATE POLICY " + _identifier(policy["name"]) + " ON " + table
                      + (" AS PERMISSIVE" if policy["permissive"] else " AS RESTRICTIVE")
                      + " FOR " + commands[policy["cmd"]] + " TO "
                      + ",".join("PUBLIC" if role == "PUBLIC" else _identifier(role)
                                 for role in policy["roles"])
                      + (" USING (" + policy["qual"] + ")" if policy["qual"] is not None else "")
                      + (" WITH CHECK (" + policy["with_check"] + ")" if policy["with_check"] is not None else "") + ";")
    if row["relrowsecurity"]:
        result.append("ALTER TABLE " + table + " ENABLE ROW LEVEL SECURITY;")
    if row["relforcerowsecurity"]:
        result.append("ALTER TABLE " + table + " FORCE ROW LEVEL SECURITY;")
    return "\n".join(result) + "\n"


def _contract_sql(texts: dict[str, str]) -> str:
    contract = json.loads(texts["accounting-catalog-contract.json"])
    for row in contract["functions"]:
        # The retained accounting capture uses pg_get_function_identity_arguments,
        # including parameter names. Those are not regprocedure type signatures.
        row["identity_kind"] = "named_arguments"
    for name in SUPPLEMENTS:
        for row in json.loads(texts[name])["rows"]:
            contract["functions"].append({
                "identity": "public." + row["signature"],
                "identity_kind": "regprocedure",
                "source_md5": row["source_md5"], "owner": row["owner"],
                "definition_md5": row["definition_md5"],
                "grants": row["grants"], "effective_execute": row["effective_execute"],
            })
    waitlist = json.loads(texts["table-capture-20260916.json"])["rows"]
    if len(waitlist) != 1:
        raise ValueError("one captured waitlist relation is required")
    waitlist = waitlist[0]
    contract["table_access"].append({"identity": "public.tournament_waitlists",
                                     "owner": waitlist["owner"], "grants": waitlist["grants"]})
    contract["constraints"].extend({"table": "public.tournament_waitlists",
                                     "name": c["name"], "definition": c["definition"]}
                                    for c in waitlist["constraints"])
    preimages = json.loads(texts["r46-preimages.json"])
    contract["waitlist"] = waitlist
    return """DO $r46_actual_catalog$
DECLARE catalog jsonb := """ + _json_sql(contract) + ";\n preimages jsonb := " + _json_sql(preimages) + """;
 item jsonb; expected jsonb; actual jsonb; fn oid; rel oid; kind text;
BEGIN
 FOR item IN SELECT value FROM jsonb_array_elements(catalog->'functions') LOOP
  IF item->>'identity_kind' = 'named_arguments' THEN
   SELECT p.oid INTO STRICT fn FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid))
      = item->>'identity';
  ELSIF item->>'identity_kind' = 'regprocedure' THEN
   fn := to_regprocedure(item->>'identity');
  ELSE
   RAISE EXCEPTION 'R46 unknown function identity format: %',item->>'identity';
  END IF;
  IF fn IS NULL OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=fn) IS DISTINCT FROM item->>'source_md5'
     OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=fn) IS DISTINCT FROM item->>'owner' THEN
   RAISE EXCEPTION 'R46 function authority mismatch: %', item->>'identity';
  END IF;
  IF item ? 'definition_md5' AND md5(pg_get_functiondef(fn)) IS DISTINCT FROM item->>'definition_md5' THEN
   RAISE EXCEPTION 'R46 function definition/configuration mismatch: %',item->>'identity';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('role',x->>'role','privilege',x->>'privilege',
    'grantable',(x->>'grantable')::boolean) ORDER BY x->>'role',x->>'privilege'), '[]'::jsonb)
   INTO expected FROM jsonb_array_elements(item->'grants') x;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC'
     ELSE pg_get_userbyid(a.grantee) END,'privilege',a.privilege_type,'grantable',a.is_grantable)
     ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
       a.privilege_type), '[]'::jsonb)
   INTO actual FROM pg_proc p CROSS JOIN LATERAL
     aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=fn;
  IF actual IS DISTINCT FROM expected THEN
   RAISE EXCEPTION 'R46 function ACL mismatch: %',item->>'identity';
  END IF;
  IF item ? 'effective_execute' AND jsonb_build_object(
      'anon',has_function_privilege('anon',fn,'EXECUTE'),
      'authenticated',has_function_privilege('authenticated',fn,'EXECUTE'),
      'service_role',has_function_privilege('service_role',fn,'EXECUTE'))
      IS DISTINCT FROM item->'effective_execute' THEN
   RAISE EXCEPTION 'R46 function effective role mismatch: %',item->>'identity';
  END IF;
 END LOOP;
 FOR kind IN SELECT unnest(ARRAY['table_access','schema_access']) LOOP
  FOR item IN SELECT value FROM jsonb_array_elements(catalog->kind) LOOP
   IF kind='table_access' THEN
    rel:=to_regclass(item->>'identity');
    IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=rel) IS DISTINCT FROM item->>'owner' THEN
     RAISE EXCEPTION 'R46 table owner mismatch: %',item->>'identity';
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC'
      ELSE pg_get_userbyid(a.grantee) END,'privilege',a.privilege_type,'grantable',a.is_grantable)
      ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
      a.privilege_type), '[]'::jsonb) INTO actual FROM pg_class c CROSS JOIN LATERAL
      aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=rel;
   ELSE
    rel:=to_regnamespace(item->>'identity');
    IF (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE oid=rel) IS DISTINCT FROM item->>'owner' THEN
     RAISE EXCEPTION 'R46 schema owner mismatch: %',item->>'identity';
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC'
      ELSE pg_get_userbyid(a.grantee) END,'privilege',a.privilege_type,'grantable',a.is_grantable)
      ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
      a.privilege_type), '[]'::jsonb) INTO actual FROM pg_namespace n CROSS JOIN LATERAL
      aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.oid=rel;
   END IF;
   SELECT COALESCE(jsonb_agg(jsonb_build_object('role',x->>'role','privilege',x->>'privilege',
      'grantable',(x->>'grantable')::boolean) ORDER BY x->>'role',x->>'privilege'), '[]'::jsonb)
    INTO expected FROM jsonb_array_elements(item->'grants') x;
   IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'R46 relation/schema ACL mismatch: %',item->>'identity';
   END IF;
  END LOOP;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(catalog->'triggers') LOOP
  rel := to_regclass(item->>'table_name');
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=rel AND tgname=item->>'tgname'
      AND pg_get_triggerdef(oid,true)=item->>'definition' AND tgenabled::text=item->>'tgenabled') THEN
   RAISE EXCEPTION 'R46 actual trigger mismatch: %.%',item->>'table_name',item->>'tgname';
  END IF;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(catalog->'constraints') LOOP
  -- The retained auth/public captures used both PostgreSQL deparse modes.
  -- Require an exact rendering of this same named constraint, not text rewrites.
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass(item->>'table')
      AND conname=item->>'name'
      AND item->>'definition' IN (pg_get_constraintdef(oid,false),pg_get_constraintdef(oid,true))) THEN
   RAISE EXCEPTION 'R46 actual constraint mismatch: %.%',item->>'table',item->>'name';
  END IF;
 END LOOP;
 rel := 'public.tournament_waitlists'::regclass;
 IF (SELECT relrowsecurity FROM pg_class WHERE oid=rel) IS DISTINCT FROM
     (catalog->'waitlist'->>'relrowsecurity')::boolean
    OR (SELECT relforcerowsecurity FROM pg_class WHERE oid=rel) IS DISTINCT FROM
     (catalog->'waitlist'->>'relforcerowsecurity')::boolean
    OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=rel AND NOT tgisinternal) THEN
  RAISE EXCEPTION 'R46 waitlist RLS or original trigger shape changed';
 END IF;
 SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
   'notnull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,
   'default',pg_get_expr(d.adbin,d.adrelid),'acl',a.attacl::text) ORDER BY a.attnum)
  INTO actual FROM pg_attribute a LEFT JOIN pg_attrdef d
    ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE a.attrelid=rel AND a.attnum>0 AND NOT a.attisdropped;
 IF actual IS DISTINCT FROM catalog->'waitlist'->'columns' THEN
  RAISE EXCEPTION 'R46 waitlist column shape changed';
 END IF;
 SELECT jsonb_agg(jsonb_build_object('name',p.polname,'cmd',p.polcmd,'permissive',p.polpermissive,
   'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END ORDER BY r)
     FROM unnest(p.polroles) r),'qual',pg_get_expr(p.polqual,p.polrelid),
   'with_check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname)
  INTO actual FROM pg_policy p WHERE p.polrelid=rel;
 IF actual IS DISTINCT FROM catalog->'waitlist'->'policies' THEN
  RAISE EXCEPTION 'R46 waitlist policy shape changed';
 END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(catalog->'waitlist'->'indexes') LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      WHERE i.indrelid=rel AND c.relname=item->>'name'
        AND pg_get_indexdef(i.indexrelid)=item->>'definition'
        AND i.indisvalid AND i.indisready) THEN
   RAISE EXCEPTION 'R46 waitlist index changed: %',item->>'name';
  END IF;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(preimages->'functions') LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.'||(item->>'signature')))
      IS DISTINCT FROM item->>'source_md5' THEN
   RAISE EXCEPTION 'R46 migration preimage mismatch: %',item->>'signature';
  END IF;
 END LOOP;
 IF (SELECT count(*) FROM jsonb_array_elements(preimages->'functions')) <> 39 THEN
  RAISE EXCEPTION 'R46 requires all 39 pinned function preimages';
 END IF;
 IF EXISTS(SELECT 1 FROM public.tournaments) OR EXISTS(SELECT 1 FROM public.tournament_players)
    OR EXISTS(SELECT 1 FROM public.tables) OR EXISTS(SELECT 1 FROM public.engine_maintenance_break) THEN
  RAISE EXCEPTION 'R46 template must contain no game or maintenance state';
 END IF;
 RAISE NOTICE 'R46 FIXTURE: captured function ACLs, triggers, constraints and 39 preimages verified';
END $r46_actual_catalog$;
"""


def _chip_store_registry_sql(capture: dict) -> str:
    rows = capture["rows"]
    if (capture["table"] != "public.ca_chip_store_coverage"
            or len(rows) != 2
            or [row["store"] for row in rows] != ["escrow", "prize_liability"]):
        raise ValueError("R46 requires the exact captured ticket store declarations")
    return """DO $r46_chip_stores$
DECLARE expected jsonb := """ + _json_sql(rows) + """; actual jsonb;
BEGIN
 IF EXISTS(SELECT 1 FROM public.ca_chip_store_coverage
   WHERE store IN ('escrow','prize_liability')) THEN
  RAISE EXCEPTION 'R46 chip store supplement refuses existing declarations';
 END IF;
 INSERT INTO public.ca_chip_store_coverage
 SELECT * FROM jsonb_populate_recordset(NULL::public.ca_chip_store_coverage,expected);
 SELECT jsonb_agg(to_jsonb(c) ORDER BY store) INTO actual
  FROM public.ca_chip_store_coverage c WHERE store IN ('escrow','prize_liability');
 IF actual IS DISTINCT FROM expected THEN
  RAISE EXCEPTION 'R46 captured chip store declarations changed';
 END IF;
END $r46_chip_stores$;
"""


def postconditions_sql(root: Path) -> str:
    """Assert the composed PRE-R46 catalog, before the caller applies R46.

This intentionally fails after the migration changes its 39 function preimages.
The candidate probes and caller's before/after snapshots own post-migration proof.
"""
    _, texts, _ = _inputs(root)
    return _contract_sql(texts)


def compose(root: Path) -> dict:
    binding, texts, hashes = _inputs(root)
    supplements = [row for name in SUPPLEMENTS for row in json.loads(texts[name])["rows"]]
    sql = "\\set ON_ERROR_STOP on\nBEGIN;\nSET LOCAL timezone='UTC';\n" + preconditions_sql(root)
    sql += "\n".join(texts[name] for name in SCHEMA_PARTS)
    sql += "\n" + _supplement_sql(supplements)
    tables = json.loads(texts["table-capture-20260916.json"])["rows"]
    if len(tables) != 1:
        raise ValueError("one captured waitlist relation is required")
    sql += _waitlist_sql(tables[0])
    sql += _contract_sql(texts)
    sql += _chip_store_registry_sql(json.loads(texts["registry-capture-20260917.json"]))
    # Inputs only: the authority identifies the arena from these public flags.
    # No wallets, balances, games, funded tickets or prior production rows copied.
    sql += """
SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) VALUES('46460000-0000-4000-8000-000000000001');
INSERT INTO public.users(id,username)
 VALUES('46460000-0000-4000-8000-000000000001','r46_template_diamond_owner');
INSERT INTO public.clubs(id,club_id,name,asset,is_platform,owner_id,union_id,
 chip_treasury,chip_pool,promo_balance,insurance_balance)
 VALUES('46460000-0000-4000-8000-000000000002',994600,'R46 synthetic Diamond arena',
 'diamonds',true,'46460000-0000-4000-8000-000000000001',NULL,0,0,0,0);
SET LOCAL session_replication_role=origin;
COMMIT;
"""
    return {
        "sql": sql, "source_sha256": hashes,
        "limits": binding["limits"] + [
            "This is PRE-R46 schema composition only; the caller must apply the exact candidate migration separately.",
            "The private fixture PostgreSQL owner is a local superuser; it does not reproduce managed-provider administrator topology.",
            "The nine native cases qualify their exercised branches, not every business path of the 39 rewritten functions.",
            "The Diamond arena identity is synthetic zero-balance input; no production row identity or funding is asserted.",
        ],
    }


def preparation_supplement_sql(root: Path, fixtures: list[dict]) -> str:
    """Load only bound captured authorities/registry configuration, never games.

    Existing definitions must match exactly when permitted. The one captured
    installed successor requires its exact historical predecessor before any
    replacement, then the exact current definition/owner/ACL afterward.
    """
    sql = """BEGIN;
DO $private$ BEGIN
 IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL
    OR current_database() !~ '^r46_mtt_' THEN
  RAISE EXCEPTION 'preparation supplement requires owned socket-only fixture';
 END IF;
END $private$;
-- The captured community-search authority calls the real pg_trgm functions.
-- Match the already qualified projection caller's extension dependency; this
-- runs only after the private, newly composed database guard above.
CREATE EXTENSION pg_trgm WITH SCHEMA extensions;
"""
    seen = set()
    for fixture in fixtures:
        path = (root / fixture["path"]).resolve()
        if (not path.is_relative_to(root.resolve())
                or hashlib.sha256(path.read_bytes()).hexdigest() != fixture["sha256"]):
            raise ValueError("preparation capture changed: " + fixture["path"])
        capture = json.loads(path.read_text())
        if fixture["kind"] == "tables":
            if (fixture["path"] != "scripts/ci/fixtures/mtt-format-preparation/projection-tables-20260917.json"
                    or fixture["presence"] != "absent"
                    or fixture["schema"]["path"] != "scripts/ci/fixtures/mtt-format-preparation/projection-tables-20260917.sql"):
                raise ValueError("only exact absent projection tables are supported")
            schema_path = (root / fixture["schema"]["path"]).resolve()
            if (not schema_path.is_relative_to(root.resolve())
                    or hashlib.sha256(schema_path.read_bytes()).hexdigest() != fixture["schema"]["sha256"]):
                raise ValueError("captured projection schema source changed")
            schema = schema_path.read_text()
            embedded = re.findall(r"expected jsonb:=\$rows\$(.*?)\$rows\$::jsonb", schema, re.S)
            if len(embedded) != 1 or json.loads(embedded[0]) != capture["rows"]:
                raise ValueError("projection schema must read back its exact captured table catalog")
            if {row["name"] for row in capture["rows"]} != {
                    "player_search_preferences", "managed_game_schedules", "managed_game_command_receipts"}:
                raise ValueError("unexpected projection dependency table set")
            # The captured schema owns its transaction, local-only guard and
            # exact full catalog readback. Function dependencies precede it.
            sql += "COMMIT;\n" + schema + "\nBEGIN;\n"
            continue
        if fixture["kind"] == "registry":
            rows = capture["rows"]
            if len(rows) != 1 or rows[0].get("row", {}).get("store") != "club_treasury":
                raise ValueError("only the exact captured club_treasury declaration is supported")
            expected = _json_sql(rows[0]["row"])
            sql += """DO $registry$ BEGIN
 IF EXISTS(SELECT 1 FROM public.ca_chip_store_coverage WHERE store='club_treasury') THEN
  RAISE EXCEPTION 'preparation registry unexpectedly exists';
 END IF;
 INSERT INTO public.ca_chip_store_coverage
 SELECT r.* FROM jsonb_populate_record(NULL::public.ca_chip_store_coverage,""" + expected + """)r;
 IF (SELECT to_jsonb(r) FROM public.ca_chip_store_coverage r WHERE store='club_treasury')
    IS DISTINCT FROM """ + expected + """ THEN
  RAISE EXCEPTION 'captured preparation registry identity mismatch';
 END IF;
END $registry$;
"""
            continue
        successor = fixture["kind"] == "function-successor"
        if successor and (fixture["path"] != SATELLITE_SUCCESSOR
                or fixture["presence"] != "exact-predecessor"
                or len(capture["rows"]) != 1
                or "public." + capture["rows"][0]["signature"] != SATELLITE_SIGNATURE):
            raise ValueError("only the exact installed satellite successor is supported")
        if fixture["kind"] != "functions" and not successor:
            raise ValueError("unsupported preparation supplement")
        for row in capture["rows"]:
            signature = "public." + row["signature"]
            if signature in seen:
                raise ValueError("duplicate preparation function capture: " + signature)
            seen.add(signature)
            definition = row["definition"]
            tag = re.search(r"\bAS\s+(\$[A-Za-z_0-9]*\$)", definition, re.I)
            if tag is None:
                raise ValueError("capture body delimiter missing")
            body = definition[tag.end():definition.index(tag[1], tag.end())]
            if (hashlib.md5(body.encode()).hexdigest() != row["source_md5"]
                    or hashlib.md5(definition.encode()).hexdigest() != row["definition_md5"]):
                raise ValueError("captured preparation definition changed")
            grants = row["grants"]
            if any(g["privilege_type"] != "EXECUTE" for g in grants):
                raise ValueError("unexpected preparation function privilege")
            commands = [definition.rstrip().rstrip(";") + ";",
                        "ALTER FUNCTION " + signature + " OWNER TO " + _identifier(row["owner"]) + ";"]
            roles = {"PUBLIC", "anon", "authenticated", "service_role", row["owner"],
                     *(g["grantee"] for g in grants)}
            commands.append("REVOKE ALL ON FUNCTION " + signature + " FROM " + ",".join(
                "PUBLIC" if who == "PUBLIC" else _identifier(who) for who in sorted(roles)) + ";")
            for grant in grants:
                commands.append("GRANT EXECUTE ON FUNCTION " + signature + " TO "
                    + ("PUBLIC" if grant["grantee"] == "PUBLIC" else _identifier(grant["grantee"]))
                    + (" WITH GRANT OPTION" if grant["is_grantable"] else "") + ";")
            sql += "DO $capture$ DECLARE actual jsonb; BEGIN\n"
            presence = fixture["presence"]
            if successor:
                predecessor = row["predecessor"]
                sql += "IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(" + _literal(signature) + ")"
                sql += " AND md5(prosrc)=" + _literal(predecessor["source_md5"])
                sql += " AND md5(pg_get_functiondef(oid))=" + _literal(predecessor["definition_md5"])
                sql += " AND pg_get_userbyid(proowner)=" + _literal(predecessor["owner"])
                sql += ") THEN RAISE EXCEPTION 'captured preparation predecessor identity mismatch: %'," + _literal(signature) + ";END IF;\n"
                expected_predecessor_acl = sorted(predecessor["grants"], key=lambda g: (g["grantee"], g["privilege_type"]))
                sql += """SELECT coalesce(jsonb_agg(jsonb_build_object(
 'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
 'grantor',pg_get_userbyid(a.grantor),'is_grantable',a.is_grantable,'privilege_type',a.privilege_type)
 ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type),'[]'::jsonb)
 INTO actual FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a
 WHERE p.oid=to_regprocedure(""" + _literal(signature) + ");\nIF actual IS DISTINCT FROM " + _json_sql(expected_predecessor_acl)
                sql += " THEN RAISE EXCEPTION 'captured preparation predecessor ACL mismatch: %'," + _literal(signature) + ";END IF;\n"
                sql += "\n".join("EXECUTE " + _literal(command) + ";" for command in commands) + "\n"
                presence = "exact"
            if "expected_presence" in row:
                if row["expected_presence"] not in ("present", "absent"):
                    raise ValueError("invalid captured function presence")
                presence = "exact" if row["expected_presence"] == "present" else "absent"
            if presence == "absent":
                sql += "IF to_regprocedure(" + _literal(signature) + ") IS NOT NULL THEN RAISE EXCEPTION 'captured preparation authority unexpectedly exists';END IF;\n"
            elif presence == "exact":
                sql += "IF to_regprocedure(" + _literal(signature) + ") IS NULL THEN RAISE EXCEPTION 'captured preparation authority missing';END IF;\n"
            elif presence != "exact-or-absent":
                raise ValueError("unsupported capture presence policy")
            sql += "IF to_regprocedure(" + _literal(signature) + ") IS NULL THEN\n"
            sql += "\n".join("EXECUTE " + _literal(command) + ";" for command in commands)
            sql += "\nEND IF;\nIF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE oid=to_regprocedure(" + _literal(signature) + ")"
            sql += " AND md5(prosrc)=" + _literal(row["source_md5"]) + " AND md5(pg_get_functiondef(oid))=" + _literal(row["definition_md5"])
            sql += " AND pg_get_userbyid(proowner)=" + _literal(row["owner"]) + ") THEN RAISE EXCEPTION 'captured preparation authority identity mismatch: %'," + _literal(signature) + ";END IF;\n"
            expected = sorted(grants, key=lambda g: (g["grantee"], g["privilege_type"]))
            sql += """SELECT coalesce(jsonb_agg(jsonb_build_object(
 'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
 'grantor',pg_get_userbyid(a.grantor),'is_grantable',a.is_grantable,'privilege_type',a.privilege_type)
 ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type),'[]'::jsonb)
 INTO actual FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a
 WHERE p.oid=to_regprocedure(""" + _literal(signature) + ");\nIF actual IS DISTINCT FROM " + _json_sql(expected) + " THEN RAISE EXCEPTION 'captured preparation ACL mismatch: %'," + _literal(signature) + ";END IF;END $capture$;\n"
    return sql + "COMMIT;\n"
