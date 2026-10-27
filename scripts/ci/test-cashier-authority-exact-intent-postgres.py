#!/usr/bin/env python3
"""Qualify Cashier active authority and globally exact retry keys in disposable Postgres."""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import sys
from concurrent.futures import ThreadPoolExecutor

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "supabase/migrations/20261004124327_cashier_authority_and_retry_keys_are_exact.sql"

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=True)


def find_pg_bin():
    if os.environ.get("PG_BIN"):
        return Path(os.environ["PG_BIN"])
    for candidate in sorted(Path("/usr/lib/postgresql").glob("*/bin"), reverse=True):
        if (candidate / "postgres").exists():
            return candidate
    return Path("/opt/homebrew/opt/postgresql@17/bin")


pg = find_pg_bin()
env = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
env["LC_ALL"] = "C"
# PostgreSQL's Unix socket path is capped at roughly 100 bytes on macOS. Keep
# this task-owned disposable cluster at a short path on the mandated SSD.
scratch_root = "/Volumes/SmarterWork/agent-work" if sys.platform == "darwin" else tempfile.gettempdir()
if sys.platform == "darwin" and not Path(scratch_root).is_dir():
    raise RuntimeError("External SSD is required for Cashier qualification")
cluster = Path(tempfile.mkdtemp(prefix="cashier-pg-", dir=scratch_root))
socket = cluster / "socket"
socket.mkdir(mode=0o700)
port = "55749"
psql = [
    str(pg / "psql"), "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose",
    "-h", str(socket), "-p", port, "-U", "postgres", "-d", "postgres",
]
results = {"scope": "cashier active authority and globally exact retry keys", "cases": [], "passed": False}

CLUB = "00000000-0000-0000-0000-0000000000c1"
OWNER = "00000000-0000-0000-0000-000000000001"
AGENT_A = "00000000-0000-0000-0000-00000000000a"
AGENT_B = "00000000-0000-0000-0000-00000000000b"
AGENT_C = "00000000-0000-0000-0000-00000000000c"
PLAYER = "00000000-0000-0000-0000-00000000000d"

FIXTURE = f"""
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role' $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;

CREATE TABLE public.ca_money_rpc_registry(
  proname text PRIMARY KEY, status text NOT NULL DEFAULT 'approved'
    CHECK(status IN ('approved','legacy','retired','system','closed')), notes text);
CREATE TABLE public.ca_declared_money_triggers(
  table_name text NOT NULL, trigger_name text NOT NULL, note text,
  PRIMARY KEY(table_name,trigger_name));
CREATE TABLE public.cashier_core_calls(actor uuid, action text, operation_id uuid);
CREATE TABLE public.clubs(
  id uuid PRIMARY KEY, owner_id uuid, name text, chip_treasury numeric DEFAULT 1000,
  promo_balance numeric DEFAULT 1000);
CREATE TABLE public.club_members(
  club_id uuid, user_id uuid, role text, status text, agent_id uuid,
  chip_balance numeric DEFAULT 100, joined_at timestamptz DEFAULT now(),
  PRIMARY KEY(club_id,user_id));
CREATE TABLE public.agents(
  id uuid DEFAULT gen_random_uuid(), club_id uuid, user_id uuid, status text,
  agent_wallet_balance numeric DEFAULT 100, promo_wallet_balance numeric DEFAULT 100,
  credit_used numeric DEFAULT 0, PRIMARY KEY(club_id,user_id));
CREATE TABLE public.profiles(
  id uuid PRIMARY KEY, alias text, username text, display_name text, first_name text,
  last_name text, full_name text, player_number text, avatar_url text, arena_avatar_url text);
CREATE TABLE public.chip_transactions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz DEFAULT now(),
  club_id uuid, transaction_type text, amount numeric, from_user_id uuid,
  to_user_id uuid, notes text, metadata jsonb DEFAULT '{{}}'::jsonb);
CREATE TABLE public.chip_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL,
  requester_id uuid NOT NULL,
  approver_id uuid,
  amount numeric(18,2) NOT NULL CHECK(amount > 0),
  note text,
  status text NOT NULL DEFAULT 'pending',
  responded_by uuid,
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  op_id uuid);
CREATE UNIQUE INDEX chip_requests_requester_op_uidx
  ON public.chip_requests(club_id, requester_id, op_id) WHERE op_id IS NOT NULL;

INSERT INTO public.clubs(id,owner_id,name) VALUES ('{CLUB}','{OWNER}','Security Club');
INSERT INTO public.profiles(id,alias,username) VALUES
 ('{OWNER}','Owner','owner'),('{AGENT_A}','Agent A','agent_a'),
 ('{AGENT_B}','Agent B','agent_b'),('{AGENT_C}','Agent C','agent_c'),
 ('{PLAYER}','Player','player');
INSERT INTO public.club_members(club_id,user_id,role,status,agent_id) VALUES
 ('{CLUB}','{OWNER}','owner','active',NULL),
 ('{CLUB}','{AGENT_A}','agent','active','{OWNER}'),
 ('{CLUB}','{AGENT_B}','agent','active','{AGENT_A}'),
 ('{CLUB}','{AGENT_C}','agent','active','{AGENT_B}'),
 ('{CLUB}','{PLAYER}','player','active','{AGENT_A}');
INSERT INTO public.agents(club_id,user_id,status) VALUES
 ('{CLUB}','{AGENT_A}','active'),('{CLUB}','{AGENT_B}','active'),('{CLUB}','{AGENT_C}','active');

CREATE FUNCTION public.fn_arena_name(text,text,text,text,text,text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT coalesce($1,$2,$3,$4,$5,$6,'Player') $$;
CREATE FUNCTION public.fn_club_bank_role(uuid,uuid DEFAULT NULL) RETURNS text LANGUAGE sql STABLE
SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM clubs WHERE id=$1 AND owner_id=coalesce($2,auth.uid()))
 THEN 'owner' ELSE (SELECT role FROM club_members WHERE club_id=$1 AND user_id=coalesce($2,auth.uid()) LIMIT 1) END $$;
CREATE FUNCTION public.fn_club_is_in_downline(uuid,uuid,uuid) RETURNS boolean LANGUAGE sql STABLE
SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$ SELECT false $$;
CREATE FUNCTION public.fn_club_cashier_scope(uuid,uuid DEFAULT NULL) RETURNS text LANGUAGE sql STABLE
SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
 SELECT CASE public.fn_club_bank_role($1,coalesce($2,auth.uid()))
 WHEN 'owner' THEN 'all' WHEN 'co_owner' THEN 'all' WHEN 'admin' THEN 'all'
 WHEN 'super_agent' THEN 'downline' WHEN 'agent' THEN 'downline'
 WHEN 'sub_agent' THEN 'downline' ELSE 'none' END $$;
CREATE FUNCTION public.fn_club_cashier_members(uuid)
RETURNS TABLE(user_id uuid,role text,role_rank integer,depth integer,chip_balance numeric,
 name text,username text,player_number text,avatar_url text)
LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT NULL::uuid,NULL::text,0,0,0::numeric,NULL::text,NULL::text,NULL::text,NULL::text WHERE false $$;
CREATE FUNCTION public.fn_cashier_statement_downline(uuid,uuid) RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT ARRAY[$2] $$;
CREATE FUNCTION public.fn_cashier_statement_scope(uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT '{{}}'::jsonb $$;
CREATE FUNCTION public.fn_club_trade_ledger(uuid,integer DEFAULT 50,integer DEFAULT 0)
RETURNS TABLE(id uuid,created_at timestamptz,transaction_type text,amount numeric,
 from_user_id uuid,to_user_id uuid,notes text,metadata jsonb,from_name text,to_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
SET lock_timeout TO '5s' AS $$ SELECT NULL::uuid,NULL::timestamptz,NULL::text,0::numeric,NULL::uuid,NULL::uuid,NULL::text,NULL::jsonb,NULL::text,NULL::text WHERE false $$;
REVOKE ALL ON FUNCTION public.fn_club_trade_ledger(uuid,integer,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_club_trade_ledger(uuid,integer,integer) TO authenticated,service_role;
CREATE TABLE public.cashier_trade_ledger_preimage(function_oid oid NOT NULL);
INSERT INTO public.cashier_trade_ledger_preimage
VALUES ('public.fn_club_trade_ledger(uuid,integer,integer)'::regprocedure::oid);
CREATE VIEW public.cashier_trade_ledger_dependency AS
SELECT id,metadata FROM public.fn_club_trade_ledger('00000000-0000-0000-0000-0000000000c1',1,0);

CREATE FUNCTION public.fn_club_bank_send(uuid,uuid,numeric,text DEFAULT 'agent_wallet',text DEFAULT NULL,uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE tx uuid:=gen_random_uuid(); BEGIN
 INSERT INTO cashier_core_calls VALUES(auth.uid(),'club_bank_send',$6);
 PERFORM pg_sleep(0.3);
 PERFORM set_config('app.ledger_correlation',$6::text,true);
 UPDATE clubs SET chip_treasury=chip_treasury-$3 WHERE id=$1;
 UPDATE agents SET agent_wallet_balance=agent_wallet_balance+$3
  WHERE club_id=$1 AND user_id=$2;
 INSERT INTO chip_transactions(id,club_id,transaction_type,amount,from_user_id,to_user_id,notes,metadata)
 VALUES(tx,$1,'club_bank_send',$3,auth.uid(),$2,$5,jsonb_build_object('op_id',$6::text));
 RETURN jsonb_build_object('success',true,'transaction_id',tx,'amount',$3); END $$;
CREATE FUNCTION public.fn_club_bank_claim_back(uuid,uuid,numeric,text DEFAULT 'agent_wallet',text DEFAULT NULL,uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN INSERT INTO cashier_core_calls VALUES(auth.uid(),'claim',$6); RETURN jsonb_build_object('success',true); END $$;
CREATE FUNCTION public.fn_club_bank_reverse(uuid,text DEFAULT NULL,uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN INSERT INTO cashier_core_calls VALUES(auth.uid(),'reverse',$3); RETURN jsonb_build_object('success',true); END $$;
CREATE FUNCTION public.fn_admin_remove_player_chips(uuid,uuid,numeric,text DEFAULT NULL,uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN INSERT INTO cashier_core_calls VALUES(auth.uid(),'remove',$5); RETURN jsonb_build_object('success',true); END $$;
CREATE FUNCTION public.fn_promo_wallet_send(uuid,uuid,numeric,text DEFAULT 'player_wallet',text DEFAULT NULL,uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN INSERT INTO cashier_core_calls VALUES(auth.uid(),'promo',$6); RETURN jsonb_build_object('success',true); END $$;
CREATE FUNCTION public.fn_club_promo_wallet_send(uuid,uuid,numeric,text DEFAULT 'player_wallet',text DEFAULT NULL,uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN INSERT INTO cashier_core_calls VALUES(auth.uid(),'club_promo',$6); RETURN jsonb_build_object('success',true); END $$;
CREATE FUNCTION public.fn_agent_wallet_send(uuid,uuid,numeric,text DEFAULT 'player_wallet',text DEFAULT NULL,uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE tx uuid:=gen_random_uuid(); BEGIN
 INSERT INTO cashier_core_calls VALUES(auth.uid(),'agent_wallet_send',$6);
 -- This is the retained production ordering that exposed the inversion: the
 -- club row is locked before the ledger correlation reaches money triggers.
 PERFORM 1 FROM clubs WHERE id=$1 FOR UPDATE;
 PERFORM pg_sleep(0.3);
 PERFORM set_config('app.ledger_correlation',$6::text,true);
 UPDATE agents SET agent_wallet_balance=agent_wallet_balance-$3
  WHERE club_id=$1 AND user_id=auth.uid();
 UPDATE agents SET agent_wallet_balance=agent_wallet_balance+$3
  WHERE club_id=$1 AND user_id=$2;
 INSERT INTO chip_transactions(club_id,transaction_type,amount,from_user_id,to_user_id,metadata)
 VALUES($1,'agent_wallet_send',$3,auth.uid(),$2,jsonb_build_object('op_id',$6::text,'destination',lower(coalesce($4,'player_wallet'))));
 RETURN jsonb_build_object('success',true,'transaction_id',tx,'amount',$3);
END $$;
CREATE FUNCTION public.fn_agent_wallet_claim_back(uuid,uuid,numeric DEFAULT NULL,text DEFAULT NULL,uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
BEGIN
 INSERT INTO cashier_core_calls VALUES(auth.uid(),'agent_wallet_claim_back',$5);
 PERFORM 1 FROM clubs WHERE id=$1 FOR UPDATE;
 PERFORM set_config('app.ledger_correlation',$5::text,true);
 INSERT INTO chip_transactions(club_id,transaction_type,amount,from_user_id,to_user_id,notes,metadata)
 VALUES($1,'agent_wallet_claim_back',coalesce($3,1),$2,auth.uid(),$4,
   jsonb_build_object('op_id',$5::text,'original_transaction_id',$2::text));
 RETURN jsonb_build_object('success',true,'transaction_id',gen_random_uuid(),'amount',coalesce($3,1));
END $$;
CREATE FUNCTION public.fn_request_chips(uuid,numeric,text DEFAULT NULL,uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE
  v_me uuid:=auth.uid(); v_agent uuid; v_open integer;
  v_prior public.chip_requests%rowtype; v_note text:=NULLIF(BTRIM(COALESCE($3,'')),'');
  v_id uuid;
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('success',false,'error','Not Authenticated'); END IF;
  IF $4 IS NULL THEN RETURN jsonb_build_object('success',false,'error','A Retry Key Is Required'); END IF;
  IF $1 IS NULL OR $2 IS NULL OR $2<=0 OR $2>1e9 OR $2<>round($2,2) THEN
    RETURN jsonb_build_object('success',false,'error','Enter A Valid Request Amount');
  END IF;
  IF v_note IS NOT NULL AND length(v_note)>500 THEN
    RETURN jsonb_build_object('success',false,'error','Request Note Is Too Long');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('chip-request:'||$1::text||':'||v_me::text,0));
  SELECT * INTO v_prior FROM public.chip_requests
   WHERE club_id=$1 AND requester_id=v_me AND op_id=$4;
  IF FOUND THEN
    IF v_prior.amount IS DISTINCT FROM $2 OR v_prior.note IS DISTINCT FROM v_note THEN
      RETURN jsonb_build_object('success',false,'error','That Retry Key Belongs To A Different Request');
    END IF;
    RETURN jsonb_build_object('success',true,'request_id',v_prior.id,'replayed',true);
  END IF;
  SELECT cm.agent_id INTO v_agent FROM public.club_members cm
   WHERE cm.club_id=$1 AND cm.user_id=v_me
     AND COALESCE(cm.status,'active') IN ('active','approved') FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success',false,'error','You Are Not An Active Member Of This Club');
  END IF;
  IF v_agent IS NULL THEN SELECT owner_id INTO v_agent FROM public.clubs WHERE id=$1; END IF;
  SELECT count(*) INTO v_open FROM public.chip_requests
   WHERE club_id=$1 AND requester_id=v_me AND status='pending';
  IF v_open>=3 THEN
    RETURN jsonb_build_object('success',false,'error','You Already Have 3 Open Requests');
  END IF;
  PERFORM pg_sleep(0.3);
  INSERT INTO public.chip_requests(club_id,requester_id,approver_id,amount,note,op_id)
  VALUES($1,v_me,v_agent,$2,v_note,$4) RETURNING id INTO v_id;
  RETURN jsonb_build_object('success',true,'request_id',v_id,'replayed',false);
END $$;

-- This simulates an operation committed before global exact-intent ownership
-- existed. Neither the request wrapper nor a money wrapper may adopt its UUID.
INSERT INTO public.chip_requests(club_id,requester_id,approver_id,amount,note,op_id)
VALUES('{CLUB}','{AGENT_C}','{AGENT_B}',4,'Historical Request',
  '10000000-0000-0000-0000-000000000011');

GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO authenticated,service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated,service_role;
"""


def command(argv, sql=None, timeout=90):
    return subprocess.run([str(x) for x in argv], input=sql, text=True, capture_output=True, env=env, timeout=timeout)


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def record(name, result, expected=None):
    (out / f"{name}.log").write_text(result.stdout + result.stderr)
    passed = result.returncode == 0 and (expected is None or result.stdout.rstrip("\n") == expected)
    results["cases"].append({"name": name, "passed": passed})
    require(passed, f"{name}: {result.stdout[-600:]}{result.stderr[-1200:]}")
    return result.stdout.rstrip("\n")


def run(name, sql, expected=None, timeout=90):
    return record(name, command(psql, sql, timeout), expected)


def as_role(user_id, sql, role="authenticated"):
    claims = json.dumps({"sub": user_id, "role": role})
    return (
        f"SELECT set_config('request.jwt.claims', '{claims}', false) \\g /dev/null\n"
        f"SET ROLE {role};\n{sql}\nRESET ROLE;\n"
    )


def refused(name, sql, sqlstate="42501"):
    result = command(psql, sql)
    (out / f"{name}.log").write_text(result.stdout + result.stderr)
    passed = result.returncode != 0 and sqlstate in result.stderr
    results["cases"].append({"name": name, "passed": passed, "sqlstate": sqlstate})
    require(passed, f"{name}: expected {sqlstate}: {result.stdout[-400:]}{result.stderr[-1000:]}")


try:
    version = command([pg / "postgres", "--version"]).stdout
    require(re.search(r"PostgreSQL\) 1[6-9]\.", version), "PostgreSQL 16+ required: " + version)
    init = command([pg / "initdb", "-D", cluster / "data", "-U", "postgres", "--auth-local=trust", "--auth-host=reject", "--no-locale", "--encoding=UTF8"])
    require(init.returncode == 0, init.stderr)
    with (cluster / "data/postgresql.conf").open("a") as config:
        config.write(f"\nlisten_addresses=''\nunix_socket_directories='{socket}'\nunix_socket_permissions=0700\nport={port}\nshared_buffers='16MB'\nmax_connections=20\n")
    start = command([pg / "pg_ctl", "-D", cluster / "data", "-l", cluster / "server.log", "-w", "start"])
    require(start.returncode == 0, start.stderr)
    run("fixture", FIXTURE)
    run("shipped-migration", MIGRATION.read_text())
    run("phase2-recovery-migration", (ROOT / "supabase/migrations/20261011143741_cashier_original_operator_can_read_committed_recovery_receip.sql").read_text())
    run("classic-ledger-oid-preserved", "SELECT function_oid='public.fn_club_trade_ledger(uuid,integer,integer)'::regprocedure::oid FROM cashier_trade_ledger_preimage;", "t")
    run("classic-ledger-dependent-view-preserved", "SELECT to_regclass('public.cashier_trade_ledger_dependency') IS NOT NULL;", "t")
    run("classic-ledger-result-shape-preserved", "SELECT pg_get_function_result('public.fn_club_trade_ledger(uuid,integer,integer)'::regprocedure);", "TABLE(id uuid, created_at timestamp with time zone, transaction_type text, amount numeric, from_user_id uuid, to_user_id uuid, notes text, metadata jsonb, from_name text, to_name text)")
    run("classic-ledger-function-posture-preserved", "SELECT p.prosecdef||'|'||(p.provolatile='s')||'|'||r.rolname||'|'||array_to_string(p.proconfig,'|') FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='public.fn_club_trade_ledger(uuid,integer,integer)'::regprocedure;", "true|true|postgres|search_path=public, pg_temp|lock_timeout=5s")
    run("classic-ledger-acl-preserved", "SELECT has_function_privilege('anon','public.fn_club_trade_ledger(uuid,integer,integer)','EXECUTE')||'|'||has_function_privilege('authenticated','public.fn_club_trade_ledger(uuid,integer,integer)','EXECUTE')||'|'||has_function_privilege('service_role','public.fn_club_trade_ledger(uuid,integer,integer)','EXECUTE');", "false|true|true")
    run("classic-ledger-pagination-fixture", f"INSERT INTO chip_transactions(id,created_at,club_id,transaction_type,amount,from_user_id,to_user_id,notes,metadata) SELECT ('20000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid,'2026-01-01T00:00:00Z','{CLUB}','pagination_contract',g,'{OWNER}','{PLAYER}','Pagination Contract',jsonb_build_object('sequence',g) FROM generate_series(1,252) g;")
    run("classic-ledger-251-row-sentinel-cap", as_role(OWNER, f"SELECT count(*) FROM public.fn_club_trade_ledger('{CLUB}',999,0) WHERE notes='Pagination Contract';"), "251")
    run("classic-ledger-tie-order-is-deterministic", as_role(OWNER, f"SELECT string_agg(id::text,',' ORDER BY row_number) FROM (SELECT id,row_number() OVER () AS row_number FROM public.fn_club_trade_ledger('{CLUB}',999,0) WHERE notes='Pagination Contract' LIMIT 2) ordered;"), "20000000-0000-0000-0000-000000000252,20000000-0000-0000-0000-000000000251")
    run("classic-ledger-pages-do-not-overlap", as_role(OWNER, f"WITH first_page AS (SELECT id FROM public.fn_club_trade_ledger('{CLUB}',250,0)), second_page AS (SELECT id FROM public.fn_club_trade_ledger('{CLUB}',250,250)) SELECT count(*) FROM first_page JOIN second_page USING(id);"), "0")

    # Reproduce the global legacy-key scan before adding the exact maintained
    # index. Keep unrelated clubs/types and duplicate historical keys visible.
    lookup_key = "10000000-0000-0000-0000-0000000000f0"
    run("global-op-pressure-fixture", f"""
      INSERT INTO chip_transactions(club_id,transaction_type,metadata)
      SELECT md5(i::text)::uuid,'unrelated',CASE WHEN i%1000=0
       THEN jsonb_build_object('op_id',md5(i::text)) ELSE '{{}}'::jsonb END
      FROM generate_series(1,100000)i;
      INSERT INTO chip_transactions(club_id,transaction_type,metadata)
      VALUES (gen_random_uuid(),'legacy_unknown',jsonb_build_object('op_id','{lookup_key}')),
       (gen_random_uuid(),'another_legacy_type',jsonb_build_object('op_id','{lookup_key}'));
      ANALYZE chip_transactions;
    """)
    lookup = "SELECT 1 FROM chip_transactions WHERE metadata->>'op_id'=$1"
    def lookup_plan(label, key):
        raw = run(label, "SET plan_cache_mode='force_generic_plan'; PREPARE lookup(text) AS "
                  + lookup + "; EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) EXECUTE lookup('" + key + "');")
        return json.loads(raw)[0]
    def lookup_nodes(node):
        yield node
        for child in node.get('Plans', []):
            yield from lookup_nodes(child)
    baseline = lookup_plan("global-op-before-plan", lookup_key)
    require(any(n.get('Node Type')=='Seq Scan' for n in lookup_nodes(baseline['Plan'])),
            'baseline must reproduce the unindexed global legacy lookup')
    op_index_sql = (ROOT / "supabase/migrations/20261026224428_cashier_global_retry_lookup_index.sql").read_text()
    run("global-op-index-install", op_index_sql)
    run("global-op-index-analyze", "ANALYZE chip_transactions;")
    for label,key,rows in [('present',lookup_key,2),('absent','not-a-recorded-key',0)]:
        plan = lookup_plan('global-op-after-'+label, key)
        nodes = list(lookup_nodes(plan['Plan']))
        require(not any(n.get('Node Type')=='Seq Scan' for n in nodes)
                and any(n.get('Index Name')=='chip_transactions_global_op_lookup_idx' for n in nodes)
                and plan['Plan']['Actual Rows']==rows,
                'generic global lookup must use index without dropping foreign/duplicate evidence')
        (out/('global-op-'+label+'.json')).write_text(json.dumps(plan,indent=2))
    run("global-op-legacy-foreign-duplicate-refused", as_role(OWNER,
        f"SELECT public.fn_agent_wallet_send('{CLUB}','{PLAYER}',25,'player_wallet','Legacy Key','{lookup_key}')->>'error';"), "That Legacy Retry Key Cannot Be Verified; Reconcile It Before Retrying")
    run("global-op-wrong-index-fixture", "DROP INDEX chip_transactions_global_op_lookup_idx; CREATE INDEX chip_transactions_global_op_lookup_idx ON chip_transactions(created_at);")
    refused("global-op-wrong-shape-refused", op_index_sql, "P0001")
    run("global-op-remove-wrong-index", "DROP INDEX chip_transactions_global_op_lookup_idx;")
    run("global-op-restore-qualified-index", op_index_sql)

    op1 = "10000000-0000-0000-0000-000000000001"
    call = f"SELECT public.fn_club_bank_send('{CLUB}','{PLAYER}',10,'player_wallet','Exact Send','{op1}')->>'success';"
    run("active-agent-send", as_role(AGENT_A, call), "true")
    run("classic-ledger-preserves-metadata", as_role(AGENT_A, f"SELECT count(*) FROM public.fn_club_trade_ledger('{CLUB}',251,0) WHERE metadata->>'op_id'='{op1}';"), "1")
    replay = f"SELECT (public.fn_club_bank_send('{CLUB}','{PLAYER}',10,'player_wallet','Exact Send','{op1}')->>'replayed')::boolean; SELECT count(*) FROM cashier_core_calls WHERE operation_id='{op1}';"
    run("identical-replay-once", as_role(AGENT_A, replay), "t\n1")

    for label, statement in {
        "target": f"SELECT public.fn_club_bank_send('{CLUB}','{AGENT_C}',10,'player_wallet','Exact Send','{op1}')->>'success';",
        "amount": f"SELECT public.fn_club_bank_send('{CLUB}','{PLAYER}',11,'player_wallet','Exact Send','{op1}')->>'success';",
        "destination": f"SELECT public.fn_club_bank_send('{CLUB}','{PLAYER}',10,'agent_wallet','Exact Send','{op1}')->>'success';",
        "reason": f"SELECT public.fn_club_bank_send('{CLUB}','{PLAYER}',10,'player_wallet','Changed','{op1}')->>'success';",
        "action": f"SELECT public.fn_promo_wallet_send('{CLUB}','{PLAYER}',10,'player_wallet','Exact Send','{op1}')->>'success';",
    }.items():
        run(f"changed-{label}-refused", as_role(AGENT_A, statement), "false")
    run("changed-intents-never-reach-core", f"SELECT count(*) FROM cashier_core_calls WHERE operation_id='{op1}';", "1")
    run("null-key-refused", as_role(AGENT_A, f"SELECT public.fn_club_bank_send('{CLUB}','{PLAYER}',10)->>'success';"), "false")

    request_key = "10000000-0000-0000-0000-000000000012"
    request_call = f"SELECT public.fn_request_chips('{CLUB}',5,'Table Buy In','{request_key}')"
    run("chip-request-first", as_role(PLAYER, request_call + "->>'success';"), "true")
    run("chip-request-identical-replay", as_role(PLAYER, request_call + "->>'replayed';"), "true")
    run("chip-request-amount-drift-refused", as_role(PLAYER, f"SELECT public.fn_request_chips('{CLUB}',6,'Table Buy In','{request_key}')->>'success';"), "false")
    run("chip-request-note-drift-refused", as_role(PLAYER, f"SELECT public.fn_request_chips('{CLUB}',5,'Changed','{request_key}')->>'success';"), "false")
    run("chip-request-row-once", f"SELECT count(*) FROM chip_requests WHERE op_id='{request_key}';", "1")

    request_first = "10000000-0000-0000-0000-000000000013"
    run("request-first-owns-global-key", as_role(PLAYER, f"SELECT public.fn_request_chips('{CLUB}',7,'Request First','{request_first}')->>'success';"), "true")
    run("request-first-refuses-money", as_role(AGENT_A, f"SELECT public.fn_club_bank_send('{CLUB}','{PLAYER}',7,'player_wallet','Request First','{request_first}')->>'success';"), "false")
    run("request-first-one-effect", f"SELECT (SELECT count(*) FROM chip_requests WHERE op_id='{request_first}')+(SELECT count(*) FROM chip_transactions WHERE metadata->>'op_id'='{request_first}');", "1")

    money_first = "10000000-0000-0000-0000-000000000014"
    run("money-first-owns-global-key", as_role(AGENT_A, f"SELECT public.fn_club_bank_send('{CLUB}','{PLAYER}',8,'player_wallet','Money First','{money_first}')->>'success';"), "true")
    run("money-first-refuses-request", as_role(PLAYER, f"SELECT public.fn_request_chips('{CLUB}',8,'Money First','{money_first}')->>'success';"), "false")
    run("money-first-one-effect", f"SELECT (SELECT count(*) FROM chip_requests WHERE op_id='{money_first}')+(SELECT count(*) FROM chip_transactions WHERE metadata->>'op_id'='{money_first}');", "1")

    historical_request = "10000000-0000-0000-0000-000000000011"
    run("historical-request-key-refuses-replay", as_role(AGENT_C, f"SELECT public.fn_request_chips('{CLUB}',4,'Historical Request','{historical_request}')->>'success';"), "false")
    run("historical-request-key-refuses-money", as_role(AGENT_A, f"SELECT public.fn_club_bank_send('{CLUB}','{PLAYER}',4,'player_wallet','Historical Request','{historical_request}')->>'success';"), "false")
    run("historical-request-remains-one-effect", f"SELECT (SELECT count(*) FROM chip_requests WHERE op_id='{historical_request}')+(SELECT count(*) FROM chip_transactions WHERE metadata->>'op_id'='{historical_request}');", "1")

    run("suspend-agent", f"UPDATE agents SET status='suspended' WHERE club_id='{CLUB}' AND user_id='{AGENT_A}';")
    refused("suspended-agent-write-refused", as_role(AGENT_A, f"SELECT public.fn_club_bank_send('{CLUB}','{PLAYER}',10,'player_wallet','No','10000000-0000-0000-0000-000000000002');"))
    run("suspended-agent-statement-refused", as_role(AGENT_A, f"SELECT public.fn_cashier_statement_scope('{CLUB}')->>'authorized';"), "false")
    run("suspended-agent-classic-empty", as_role(AGENT_A, f"SELECT count(*) FROM public.fn_club_trade_ledger('{CLUB}',50,0);"), "0")
    run("suspended-operator-original-receipt-readable", as_role(AGENT_A,
        f"SELECT jsonb_array_length(public.fn_cashier_recovery_receipts('{CLUB}',ARRAY['{op1}'::uuid])->'operations');"), "1")
    run("other-operator-receipt-hidden", as_role(AGENT_B,
        f"SELECT jsonb_array_length(public.fn_cashier_recovery_receipts('{CLUB}',ARRAY['{op1}'::uuid])->'operations');"), "0")
    run("wrong-club-receipt-hidden", as_role(AGENT_A,
        f"SELECT jsonb_array_length(public.fn_cashier_recovery_receipts('00000000-0000-0000-0000-0000000000c2',ARRAY['{op1}'::uuid])->'operations');"), "0")
    run("suspended-original-replay-is-no-new-effect", as_role(AGENT_A, replay), "t\n1")
    run("remove-operator-membership", f"UPDATE club_members SET status='left' WHERE club_id='{CLUB}' AND user_id='{AGENT_A}';")
    # The retained money core in this small fixture is a call witness, not the
    # real bank role validator. Assert the actual role contract it consumes.
    run("removed-operator-bank-role-refused", as_role(AGENT_A,
        f"SELECT public.fn_club_bank_role('{CLUB}') IS NULL;"), "t")
    run("removed-operator-own-receipt-readable", as_role(AGENT_A,
        f"SELECT jsonb_array_length(public.fn_cashier_recovery_receipts('{CLUB}',ARRAY['{op1}'::uuid])->'operations');"), "1")
    run("restore-operator-membership", f"UPDATE club_members SET status='active' WHERE club_id='{CLUB}' AND user_id='{AGENT_A}';")
    run("anonymous-recovery-door-refused", "SELECT has_function_privilege('anon','public.fn_cashier_recovery_receipts(uuid,uuid[],text[])','EXECUTE');", "f")
    refused("anonymous-cannot-execute-recovery", "SET ROLE anon; SELECT public.fn_cashier_recovery_receipts(NULL);", "42501")
    refused("null-recovery-club-refused", as_role(AGENT_A, "SELECT public.fn_cashier_recovery_receipts(NULL);"), "22023")
    refused("unbounded-recovery-refused", as_role(AGENT_A,
        f"SELECT public.fn_cashier_recovery_receipts('{CLUB}',ARRAY(SELECT gen_random_uuid() FROM generate_series(1,26)));"), "22023")
    run("missing-receipt-remains-unknown", as_role(AGENT_A,
        f"SELECT public.fn_cashier_recovery_receipts('{CLUB}',ARRAY[gen_random_uuid()])::text;"), '{"tickets": [], "operations": []}')
    ticket_key = "ticket:original-issuer"
    run("ticket-receipt-fixture", f"INSERT INTO chip_transactions(club_id,transaction_type,amount,from_user_id,to_user_id,metadata) VALUES ('{CLUB}','tournament_ticket_issue',2,'{AGENT_A}','{PLAYER}',jsonb_build_object('ticket_id',gen_random_uuid(),'idempotency_key','{ticket_key}'));")
    run("issuer-ticket-receipt-readable", as_role(AGENT_A,
        f"SELECT jsonb_array_length(public.fn_cashier_recovery_receipts('{CLUB}','{{}}'::uuid[],ARRAY['{ticket_key}'])->'tickets');"), "1")
    run("other-issuer-ticket-receipt-hidden", as_role(AGENT_B,
        f"SELECT jsonb_array_length(public.fn_cashier_recovery_receipts('{CLUB}','{{}}'::uuid[],ARRAY['{ticket_key}'])->'tickets');"), "0")
    run("recovery-cannot-change-core-call-count", f"SELECT count(*) FROM cashier_core_calls WHERE operation_id='{op1}';", "1")
    # Exercise the retained production bank body, rather than the accounting
    # fixture's core-call witness, for removed-owner write refusal. Roll back
    # this temporary body and membership change in the same private connection.
    bank_source = (ROOT / "supabase/migrations/20260903170529_the_hierarchy_sends_are_one_journal_row_each.sql").read_text()
    bank_start = bank_source.index("CREATE OR REPLACE FUNCTION public.fn_club_bank_send(")
    bank_open = bank_source.index("AS $function$", bank_start) + len("AS $function$")
    bank_end = bank_source.index(";", bank_source.index("$function$", bank_open)) + 1
    bank_body = bank_source[bank_start:bank_end].replace("public.fn_club_bank_send(", "public.fn_club_bank_send_core_20261004(", 1)
    run("production-bank-body-refuses-removed-operator", "BEGIN;" + bank_body +
        f"UPDATE public.club_members SET role='co_owner' WHERE club_id='{CLUB}' AND user_id='{AGENT_A}';" +
        as_role(AGENT_A, f"SELECT public.fn_club_bank_role('{CLUB}');") +
        f"DELETE FROM public.club_members WHERE club_id='{CLUB}' AND user_id='{AGENT_A}';" +
        as_role(AGENT_A, f"SELECT public.fn_club_bank_send('{CLUB}','{PLAYER}',1,'player_wallet','Withdrawn authority',gen_random_uuid())->>'success';") +
        "ROLLBACK;", "co_owner\nfalse")
    run("restore-agent", f"UPDATE agents SET status='active' WHERE club_id='{CLUB}' AND user_id='{AGENT_A}';")

    run("suspend-intermediate", f"UPDATE agents SET status='suspended' WHERE club_id='{CLUB}' AND user_id='{AGENT_B}';")
    run("inactive-edge-breaks-downline", f"SELECT public.fn_club_is_in_downline('{CLUB}','{AGENT_A}','{AGENT_C}');", "f")
    run("restore-intermediate", f"UPDATE agents SET status='active' WHERE club_id='{CLUB}' AND user_id='{AGENT_B}';")
    run("active-edge-restores-downline", f"SELECT public.fn_club_is_in_downline('{CLUB}','{AGENT_A}','{AGENT_C}');", "t")

    service_update = as_role(OWNER, f"UPDATE clubs SET chip_treasury=chip_treasury+1 WHERE id='{CLUB}';", "service_role")
    run("service-jwt-with-sub-bypasses-human-guard", service_update)
    run("service-without-claims-bypasses-human-guard", "SELECT set_config('request.jwt.claims','',false); SET ROLE service_role; UPDATE clubs SET chip_treasury=chip_treasury+1 WHERE id='" + CLUB + "'; RESET ROLE;")

    refused("authenticated-cannot-call-private-core", as_role(AGENT_A, f"SELECT public.fn_club_bank_send_core_20261004('{CLUB}','{PLAYER}',1,'player_wallet',NULL,gen_random_uuid());"))
    refused("authenticated-cannot-call-agent-wallet-core", as_role(AGENT_A, f"SELECT public.fn_agent_wallet_send_core_20261004('{CLUB}','{AGENT_B}',1,'agent_wallet',NULL,gen_random_uuid());"))
    refused("authenticated-cannot-call-request-core", as_role(PLAYER, f"SELECT public.fn_request_chips_core_20261004('{CLUB}',1,NULL,gen_random_uuid());"))
    refused("authenticated-cannot-read-intents", as_role(AGENT_A, "SELECT * FROM public.cashier_rpc_operation_intents;"))
    run("member-money-triggers-declared", "SELECT count(*) FROM ca_declared_money_triggers WHERE table_name='club_members' AND trigger_name IN ('cashier_member_balance_actor_guard','cashier_member_operation_mutex');", "2")

    cross = "10000000-0000-0000-0000-000000000003"
    run("first-actor-owns-global-key", as_role(AGENT_A, f"SELECT public.fn_club_bank_send('{CLUB}','{PLAYER}',2,'player_wallet','Cross','{cross}')->>'success';"), "true")
    run("second-actor-cannot-reuse-global-key", as_role(AGENT_B, f"SELECT public.fn_club_bank_send('{CLUB}','{PLAYER}',2,'player_wallet','Cross','{cross}')->>'success';"), "false")
    run("cross-actor-core-once", f"SELECT count(*) FROM cashier_core_calls WHERE operation_id='{cross}';", "1")

    # A wrapped key cannot move money through a retained legacy Cashier door.
    before = run("cross-door-before", f"SELECT chip_treasury FROM clubs WHERE id='{CLUB}';")
    run("wrapped-key-refuses-legacy-door", as_role(AGENT_A, f"SELECT public.fn_agent_wallet_send('{CLUB}','{AGENT_B}',2,'agent_wallet','Cross Door','{cross}')->>'success';"), "false")
    run("cross-door-no-second-movement", f"SELECT chip_treasury FROM clubs WHERE id='{CLUB}';", before)

    # A real retained agent-wallet door owns the same global key and exact
    # payload contract, including identical replay and drift refusal.
    legacy_first = "10000000-0000-0000-0000-000000000005"
    run("legacy-key-first", as_role(AGENT_A, f"SELECT public.fn_agent_wallet_send('{CLUB}','{AGENT_B}',2,'agent_wallet','Legacy First','{legacy_first}')->>'success';"), "true")
    run("legacy-key-identical-replay", as_role(AGENT_A, f"SELECT (public.fn_agent_wallet_send('{CLUB}','{AGENT_B}',2,'agent_wallet','Legacy First','{legacy_first}')->>'replayed')::boolean;"), "t")
    run("legacy-key-payload-drift-refused", as_role(AGENT_A, f"SELECT public.fn_agent_wallet_send('{CLUB}','{AGENT_B}',3,'agent_wallet','Legacy First','{legacy_first}')->>'success';"), "false")
    run("legacy-key-target-drift-refused", as_role(AGENT_A, f"SELECT public.fn_agent_wallet_send('{CLUB}','{AGENT_C}',2,'agent_wallet','Legacy First','{legacy_first}')->>'success';"), "false")
    run("legacy-key-destination-drift-refused", as_role(AGENT_A, f"SELECT public.fn_agent_wallet_send('{CLUB}','{AGENT_B}',2,'player_wallet','Legacy First','{legacy_first}')->>'success';"), "false")
    run("legacy-key-reason-drift-refused", as_role(AGENT_A, f"SELECT public.fn_agent_wallet_send('{CLUB}','{AGENT_B}',2,'agent_wallet','Changed','{legacy_first}')->>'success';"), "false")
    run("legacy-key-action-drift-refused", as_role(AGENT_A, f"SELECT public.fn_agent_wallet_claim_back('{CLUB}',gen_random_uuid(),1,'Claim','{legacy_first}')->>'success';"), "false")
    run("legacy-key-core-and-movement-once", f"SELECT count(*)||'/'||(SELECT count(*) FROM chip_transactions WHERE metadata->>'op_id'='{legacy_first}') FROM cashier_core_calls WHERE operation_id='{legacy_first}';", "1/1")
    run("legacy-key-refuses-wrapped-door", as_role(AGENT_A, f"SELECT public.fn_club_bank_send('{CLUB}','{AGENT_B}',2,'agent_wallet','Legacy First','{legacy_first}')->>'success';"), "false")
    run("legacy-first-never-reaches-other-cores", f"SELECT count(*) FROM cashier_core_calls WHERE operation_id='{legacy_first}' AND action<>'agent_wallet_send';", "0")

    race = "10000000-0000-0000-0000-000000000004"
    sql_a = as_role(AGENT_A, f"SELECT public.fn_club_bank_send('{CLUB}','{PLAYER}',3,'player_wallet','Race','{race}')->>'success';")
    sql_b = as_role(AGENT_B, f"SELECT public.fn_club_bank_send('{CLUB}','{PLAYER}',3,'player_wallet','Race','{race}')->>'success';")
    with ThreadPoolExecutor(max_workers=2) as pool:
        concurrent = list(pool.map(lambda sql: command(psql, sql), [sql_a, sql_b]))
    values = sorted(result.stdout.strip() for result in concurrent)
    race_ok = all(result.returncode == 0 for result in concurrent) and values == ["false", "true"]
    results["cases"].append({"name": "cross-actor-race-one-winner", "passed": race_ok})
    require(race_ok, "race results: " + repr([(r.returncode, r.stdout, r.stderr) for r in concurrent]))
    run("race-core-and-movement-once", f"SELECT count(*)||'/'||(SELECT count(*) FROM chip_transactions WHERE metadata->>'op_id'='{race}') FROM cashier_core_calls WHERE operation_id='{race}';", "1/1")

    mixed_race = "10000000-0000-0000-0000-000000000010"
    wrapped_sql = as_role(AGENT_A, f"SELECT public.fn_club_bank_send('{CLUB}','{AGENT_B}',3,'agent_wallet','Mixed Race','{mixed_race}')->>'success';")
    legacy_sql = as_role(AGENT_A, f"SELECT public.fn_agent_wallet_send('{CLUB}','{AGENT_B}',3,'agent_wallet','Mixed Race','{mixed_race}')->>'success';")
    with ThreadPoolExecutor(max_workers=2) as pool:
        mixed = list(pool.map(lambda sql: command(psql, sql, 20), [wrapped_sql, legacy_sql]))
    mixed_values = sorted(result.stdout.strip() for result in mixed)
    mixed_ok = all(result.returncode == 0 for result in mixed) and mixed_values == ["false", "true"]
    results["cases"].append({"name": "wrapped-legacy-race-one-winner", "passed": mixed_ok})
    require(mixed_ok, "mixed race: " + repr([(r.returncode, r.stdout, r.stderr) for r in mixed]))
    run("wrapped-legacy-race-one-movement", f"SELECT count(*) FROM chip_transactions WHERE metadata->>'op_id'='{mixed_race}';", "1")

    request_money_race = "10000000-0000-0000-0000-000000000015"
    request_sql = as_role(PLAYER, f"SELECT public.fn_request_chips('{CLUB}',9,'Request Money Race','{request_money_race}')->>'success';")
    money_sql = as_role(AGENT_A, f"SELECT public.fn_club_bank_send('{CLUB}','{PLAYER}',9,'player_wallet','Request Money Race','{request_money_race}')->>'success';")
    with ThreadPoolExecutor(max_workers=2) as pool:
        request_money = list(pool.map(lambda sql: command(psql, sql, 20), [request_sql, money_sql]))
    request_money_values = sorted(result.stdout.strip() for result in request_money)
    request_money_ok = (
        all(result.returncode == 0 for result in request_money)
        and request_money_values == ["false", "true"]
    )
    results["cases"].append({"name": "request-money-race-one-winner", "passed": request_money_ok})
    require(request_money_ok, "request/money race: " + repr([(r.returncode, r.stdout, r.stderr) for r in request_money]))
    run("request-money-race-one-effect", f"SELECT (SELECT count(*) FROM chip_requests WHERE op_id='{request_money_race}')+(SELECT count(*) FROM chip_transactions WHERE metadata->>'op_id'='{request_money_race}');", "1")

    # Different actors sending to each other used to form actor-row -> club ->
    # recipient-row cycles. Both operations must finish without a deadlock.
    send_ab = as_role(AGENT_A, f"SELECT public.fn_club_bank_send('{CLUB}','{AGENT_B}',1,'agent_wallet','A to B','10000000-0000-0000-0000-000000000006')->>'success';")
    send_ba = as_role(AGENT_B, f"SELECT public.fn_club_bank_send('{CLUB}','{AGENT_A}',1,'agent_wallet','B to A','10000000-0000-0000-0000-000000000007')->>'success';")
    with ThreadPoolExecutor(max_workers=2) as pool:
        crossed = list(pool.map(lambda sql: command(psql, sql, 20), [send_ab, send_ba]))
    crossed_ok = all(result.returncode == 0 and result.stdout.strip() == "true" for result in crossed)
    results["cases"].append({"name": "cross-agent-sends-no-deadlock", "passed": crossed_ok})
    require(crossed_ok, "cross-agent sends: " + repr([(r.returncode, r.stdout, r.stderr) for r in crossed]))

    # Suspension waits for an admitted operation's authority mutex, then the
    # next request observes the new status and is refused.
    status_op = "10000000-0000-0000-0000-000000000008"
    active_send = as_role(AGENT_A, f"SELECT public.fn_club_bank_send('{CLUB}','{PLAYER}',1,'player_wallet','Status Race','{status_op}')->>'success';")
    with ThreadPoolExecutor(max_workers=2) as pool:
        send_future = pool.submit(command, psql, active_send, 20)
        import time
        time.sleep(0.08)
        suspend_future = pool.submit(command, psql, f"UPDATE agents SET status='suspended' WHERE club_id='{CLUB}' AND user_id='{AGENT_A}';", 20)
        status_results = [send_future.result(), suspend_future.result()]
    send_result, suspend_result = status_results
    send_serialized = (
        (send_result.returncode == 0 and send_result.stdout.strip() == "true")
        or (send_result.returncode != 0 and "42501" in send_result.stderr)
    )
    status_ok = send_serialized and suspend_result.returncode == 0
    results["cases"].append({"name": "suspension-serializes-after-admitted-send", "passed": status_ok})
    require(status_ok, "status race: " + repr([(r.returncode, r.stdout, r.stderr) for r in status_results]))
    run("status-race-ends-suspended", f"SELECT status FROM agents WHERE club_id='{CLUB}' AND user_id='{AGENT_A}';", "suspended")
    refused("post-suspension-send-refused", as_role(AGENT_A, f"SELECT public.fn_club_bank_send('{CLUB}','{PLAYER}',1,'player_wallet','After Suspend','10000000-0000-0000-0000-000000000009');"))
    run("restore-agent-after-status-race", f"UPDATE agents SET status='active' WHERE club_id='{CLUB}' AND user_id='{AGENT_A}';")

    # Phase 5 qualifies the shipped bounded batch executor against the same
    # native authority/exact-intent owner. The fixture's retained send core
    # witnesses real agent-wallet debits/credits; it is not a production probe.
    batch_source = (ROOT / "supabase/migrations/20260831235991_cashier_roster_ledger_batch_performance.sql").read_text()
    batch_start = batch_source.index("create or replace function public.fn_cashier_batch_transfer(")
    batch_end = batch_source.index("$function$;", batch_start) + len("$function$;")
    run("batch-shipped-executor", batch_source[batch_start:batch_end] +
        "REVOKE ALL ON FUNCTION public.fn_cashier_batch_transfer(uuid,text,jsonb,uuid) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION public.fn_cashier_batch_transfer(uuid,text,jsonb,uuid) TO authenticated,service_role;")
    batch_id = "30000000-0000-4000-8000-000000000001"
    batch_op_a = "30000000-0000-4000-8000-000000000002"
    batch_op_b = "30000000-0000-4000-8000-000000000003"
    batch_items = json.dumps([
        {"user_id": AGENT_B, "amount": 0.1, "destination": "agent_wallet", "reason": "Cashier Send Out", "op_id": batch_op_a},
        {"user_id": AGENT_C, "amount": 0.2, "destination": "agent_wallet", "reason": "Cashier Send Out", "op_id": batch_op_b},
    ])
    batch_call = f"public.fn_cashier_batch_transfer('{CLUB}','send','{batch_items}'::jsonb,'{batch_id}')"
    run("batch-first-individual-values", as_role(AGENT_A,
        f"SELECT string_agg(item->>'amount',',' ORDER BY item->>'user_id') FROM jsonb_array_elements({batch_call}->'results') item;"), "0.1,0.2")
    run("batch-identical-replay-no-new-core", as_role(AGENT_A,
        f"SELECT bool_and((item->>'replayed')::boolean) FROM jsonb_array_elements({batch_call}->'results') item;"), "t")
    run("batch-exact-two-receipts-one-cent-sum", f"SELECT count(*)||'|'||sum(amount) FROM chip_transactions WHERE metadata->>'op_id' IN ('{batch_op_a}','{batch_op_b}');", "2|0.3")
    changed_items = json.loads(batch_items)
    changed_items[0]["amount"] = 0.11
    changed_items[1]["op_id"] = "30000000-0000-4000-8000-000000000004"
    partial_call = f"public.fn_cashier_batch_transfer('{CLUB}','send','{json.dumps(changed_items)}'::jsonb,'{batch_id}')"
    run("batch-partial-exact-intent-refusal-is-per-recipient", as_role(AGENT_A,
        f"SELECT string_agg(item->>'success',',' ORDER BY item->>'user_id') FROM jsonb_array_elements({partial_call}->'results') item;"), "false,true")
    run("batch-partial-keeps-first-original-amount", f"SELECT count(*)||'|'||sum(amount) FROM chip_transactions WHERE metadata->>'op_id'='{batch_op_a}';", "1|0.1")
    invalid_items = json.loads(batch_items)
    invalid_items[1]["amount"] = 0.005
    run("batch-invalid-later-amount-refuses-entire-envelope", as_role(AGENT_A,
        f"SELECT public.fn_cashier_batch_transfer('{CLUB}','send','{json.dumps(invalid_items)}'::jsonb,'{batch_id}')->>'success';"), "false")
    run("batch-invalid-envelope-does-not-reach-first-core", f"SELECT count(*) FROM cashier_core_calls WHERE operation_id='{batch_op_a}';", "1")
    refused("batch-anonymous-door-refused", "SET ROLE anon; SELECT public.fn_cashier_batch_transfer(NULL,'send','[]',NULL);", "42501")

    # Phase 3 uses the actual active-authority producer above, with isolated
    # baseline/ledger fixtures. No production accounts or financial writes.
    report_club = "00000000-0000-0000-0000-0000000000c3"
    run("conservation-fixture", f"""
      ALTER TABLE profiles ADD COLUMN status text;
      ALTER TABLE clubs ADD COLUMN asset text DEFAULT 'chips';
      ALTER TABLE club_members ADD COLUMN held_chips numeric DEFAULT 0;
      CREATE TABLE ca_treasury_baseline(club_id uuid PRIMARY KEY,opening_balance numeric,taken_at timestamptz);
      CREATE TABLE ca_chip_baseline(club_id uuid,user_id uuid,opening_balance numeric,taken_at timestamptz,PRIMARY KEY(club_id,user_id));
      CREATE TABLE chip_ledger(id uuid DEFAULT gen_random_uuid(),club_id uuid,from_type text,from_entity_id uuid,to_type text,to_entity_id uuid,amount numeric,created_at timestamptz,status text NOT NULL CHECK(status IN ('posted','correction','reversal')));
      CREATE TABLE tables(id uuid PRIMARY KEY,club_id uuid,tournament_id uuid);
      CREATE TABLE table_seats(table_id uuid,stack numeric,left_at timestamptz);
      INSERT INTO clubs(id,owner_id,name,chip_treasury) VALUES ('{report_club}','{OWNER}','Report Club',485);
      INSERT INTO club_members(club_id,user_id,role,status,chip_balance) VALUES
        ('{report_club}','{OWNER}','owner','active',0),
        ('{report_club}','{PLAYER}','player','active',90),
        ('{report_club}','{AGENT_B}','player','active',210);
      INSERT INTO ca_treasury_baseline VALUES ('{report_club}',500,'2026-01-02');
      INSERT INTO ca_chip_baseline VALUES ('{report_club}','{OWNER}',0,'2026-01-02'),
        ('{report_club}','{PLAYER}',100,'2026-01-02'),('{report_club}','{AGENT_B}',200,'2026-01-01');
      INSERT INTO chip_ledger(club_id,from_type,from_entity_id,to_type,to_entity_id,amount,created_at,status) VALUES
        ('{report_club}','club_treasury','{report_club}','agent_wallet','{OWNER}',20,'2026-01-03','posted'),
        ('{report_club}','agent_wallet','{OWNER}','club_treasury','{report_club}',5,'2026-01-03','posted'),
        ('{report_club}','player_wallet','{PLAYER}','player_wallet','{AGENT_B}',10,'2026-01-03','posted'),
        ('{report_club}','club_treasury','{report_club}','player_wallet','{PLAYER}',400,'2026-01-01','posted'),
        ('{CLUB}','club_treasury','{report_club}','player_wallet','{PLAYER}',99,'2026-01-03','posted'),
        ('{report_club}','club_treasury','{report_club}','player_wallet','{PLAYER}',3,'2026-01-03','correction'),
        ('{report_club}','player_wallet','{PLAYER}','club_treasury','{report_club}',3,'2026-01-03','reversal'),
        ('{report_club}','player_wallet','{PLAYER}','player_wallet','{AGENT_B}',2,'2026-01-03','correction'),
        ('{report_club}','player_wallet','{AGENT_B}','player_wallet','{PLAYER}',2,'2026-01-03','reversal');
      INSERT INTO agents(club_id,user_id,status,agent_wallet_balance,promo_wallet_balance) VALUES ('{report_club}','{OWNER}','active',15,7);
      INSERT INTO tables VALUES ('{report_club}','{report_club}',NULL),('{CLUB}','{report_club}','{CLUB}');
      INSERT INTO table_seats VALUES ('{report_club}',25,NULL),('{CLUB}',999,NULL),('{report_club}',999,now());
    """)
    refused("conservation-ledger-pending-status-not-a-booked-leg",f"INSERT INTO chip_ledger(status) VALUES ('pending');","23514")
    refused("conservation-ledger-null-status-refused","INSERT INTO chip_ledger(status) VALUES (NULL);","23502")
    run("conservation-shipped-migration", (ROOT / "supabase/migrations/20261011162855_cashier_club_baseline_conservation_report.sql").read_text())
    run("pressure-original-function", (ROOT / "supabase/migrations/20261011162855_cashier_club_baseline_conservation_report.sql").read_text().replace("fn_cashier_conservation_report", "fn_cashier_conservation_report_original"))
    replacement_sql = (ROOT / "supabase/migrations/20261012113652_cashier_conservation_aggregates_wallet_legs_before_materiali.sql").read_text()
    run("conservation-pressure-changed-preimage", "ALTER FUNCTION public.fn_cashier_conservation_report(uuid) SET statement_timeout='7s';")
    refused("conservation-pressure-changed-preimage-refused", replacement_sql, "55000")
    run("conservation-pressure-refusal-preserves-preimage", "SELECT proconfig @> ARRAY['statement_timeout=7s'] FROM pg_proc WHERE oid='public.fn_cashier_conservation_report(uuid)'::regprocedure;", "t")
    run("conservation-pressure-restore-qualified-preimage", "ALTER FUNCTION public.fn_cashier_conservation_report(uuid) RESET statement_timeout;")
    run("conservation-pressure-installed-once", replacement_sql)
    refused("conservation-pressure-replay-refused", replacement_sql, "55000")
    run("conservation-pressure-replay-preserves-postimage", "SELECT md5(pg_get_functiondef('public.fn_cashier_conservation_report(uuid)'::regprocedure));", "68e55e37885c51afd37d532753cb5ba1")
    report_call = f"public.fn_cashier_conservation_report('{report_club}')"
    def witness(name, expression, expected):
        value=run(name, as_role(OWNER,f"SELECT {expression} FROM (SELECT {report_call} AS r) x;"),expected)
        run(name+"-exact-pre-post", as_role(OWNER,f"SELECT ({report_call}-'as_of')=(public.fn_cashier_conservation_report_original('{report_club}')-'as_of');"),"t")
        return value
    witness("conservation-bank-exact", "r->'bank'->>'status'||'|'||(r->'bank'->>'actual')||'|'||(r->'bank'->>'expected')", "verified|485|485")
    witness("conservation-individual-cutovers-and-peer-sides", "r->'players'->>'status'||'|'||(r->'players'->>'checked')||'|'||(r->'players'->>'absolute_drift')", "verified|3|0")
    witness("conservation-inventory-no-tournament-or-exited-stacks", "r->'inventory'->>'cash_stacks'||'|'||(r->'inventory'->>'agent_wallets')||'|'||(r->'inventory'->>'promo_wallets')", "25|15|7")
    run("conservation-correction-only-fixture",f"INSERT INTO chip_ledger(club_id,from_type,from_entity_id,to_type,to_entity_id,amount,created_at,status) VALUES ('{report_club}','club_treasury','{report_club}','player_wallet','{PLAYER}',4,'2026-01-04','correction'); UPDATE clubs SET chip_treasury=481 WHERE id='{report_club}'; UPDATE club_members SET chip_balance=94 WHERE club_id='{report_club}' AND user_id='{PLAYER}';")
    witness("conservation-booked-correction-counts-bank-and-player", "r->'bank'->>'status'||'|'||(r->'bank'->>'expected')||'|'||(r->'players'->>'status')", "verified|481|verified")
    run("conservation-reversal-only-fixture",f"INSERT INTO chip_ledger(club_id,from_type,from_entity_id,to_type,to_entity_id,amount,created_at,status) VALUES ('{report_club}','player_wallet','{PLAYER}','club_treasury','{report_club}',4,'2026-01-05','reversal'); UPDATE clubs SET chip_treasury=485 WHERE id='{report_club}'; UPDATE club_members SET chip_balance=90 WHERE club_id='{report_club}' AND user_id='{PLAYER}';")
    witness("conservation-booked-reversal-counts-bank-and-player", "r->'bank'->>'status'||'|'||(r->'bank'->>'expected')||'|'||(r->'players'->>'status')", "verified|485|verified")

    run("conservation-offset-fixture", f"UPDATE club_members SET chip_balance=chip_balance+CASE WHEN user_id='{PLAYER}' THEN 0.01 ELSE -0.01 END WHERE club_id='{report_club}' AND user_id IN ('{PLAYER}','{AGENT_B}');")
    witness("conservation-opposite-cent-drifts-do-not-cancel", "r->'players'->>'status'||'|'||(r->'players'->>'mismatches')||'|'||(r->'players'->>'net_drift')||'|'||(r->'players'->>'absolute_drift')", "attention|2|0.00|0.02")
    run("conservation-restore-exact-wallets", f"UPDATE club_members SET chip_balance=CASE WHEN user_id='{PLAYER}' THEN 90 ELSE 210 END WHERE club_id='{report_club}' AND user_id IN ('{PLAYER}','{AGENT_B}'); INSERT INTO club_members(club_id,user_id,role,status,chip_balance) VALUES ('{report_club}','{AGENT_C}','player','active',0);")
    witness("conservation-zero-without-baseline-is-unknown", "r->'players'->>'status'||'|'||(r->'players'->>'missing')", "incomplete|1")
    run("conservation-orphan-baseline-fixture", f"INSERT INTO ca_chip_baseline VALUES ('{report_club}',gen_random_uuid(),0,'2026-01-02');")
    witness("conservation-orphan-position-is-unknown", "r->'players'->>'missing'", "2")
    run("conservation-bank-baseline-removal", f"DELETE FROM ca_treasury_baseline WHERE club_id='{report_club}';")
    witness("conservation-missing-bank-is-not-zero", "r->'bank'->>'status'||'|'||coalesce(r->'bank'->>'expected','NULL')", "incomplete|NULL")
    run("conservation-bank-future-baseline", f"INSERT INTO ca_treasury_baseline VALUES ('{report_club}',485,now()+interval '1 day');")
    witness("conservation-future-baseline-refused-as-coverage", "r->'bank'->>'status'", "incomplete")
    for bank_role in ("admin", "co_owner"):
        run("conservation-active-"+bank_role+"-fixture",f"UPDATE club_members SET role='{bank_role}' WHERE club_id='{report_club}' AND user_id='{PLAYER}';")
        run("conservation-active-"+bank_role+"-accepted",as_role(PLAYER,f"SELECT {report_call}->>'scope';"),"bank_and_player_baselines")
    run("conservation-restore-player-role",f"UPDATE club_members SET role='player' WHERE club_id='{report_club}' AND user_id='{PLAYER}';")
    refused("conservation-player-refused",as_role(PLAYER,f"SELECT {report_call};"))
    refused("conservation-unaffiliated-refused",as_role(AGENT_A,f"SELECT {report_call};"))
    refused("conservation-null-club-refused",as_role(OWNER,"SELECT public.fn_cashier_conservation_report(NULL);"),"22023")
    refused("conservation-no-session-refused","SET ROLE authenticated; SELECT public.fn_cashier_conservation_report(NULL);")
    run("conservation-owner-withdrawal", f"UPDATE club_members SET status='suspended' WHERE club_id='{report_club}' AND user_id='{OWNER}';")
    refused("conservation-owner-id-cannot-bypass-suspension",as_role(OWNER,f"SELECT {report_call};"))
    run("conservation-deleted-operator", f"UPDATE club_members SET status='active' WHERE club_id='{report_club}' AND user_id='{OWNER}'; UPDATE profiles SET status='deleted' WHERE id='{OWNER}';")
    refused("conservation-deleted-operator-refused",as_role(OWNER,f"SELECT {report_call};"))
    run("conservation-restore-owner",f"UPDATE profiles SET status=NULL WHERE id='{OWNER}';")
    run("conservation-posture", "SELECT p.prosecdef||'|'||(p.provolatile='s')||'|'||r.rolname||'|'||array_to_string(p.proconfig,'|') FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='public.fn_cashier_conservation_report(uuid)'::regprocedure;", "true|true|postgres|search_path=public, pg_temp")
    run("conservation-anonymous-acl-refused", "SELECT has_function_privilege('anon','public.fn_cashier_conservation_report(uuid)','EXECUTE');", "f")
    run("conservation-diamond-fixture",f"UPDATE clubs SET asset='diamonds' WHERE id='{report_club}';")
    refused("conservation-diamond-units-not-mixed",as_role(OWNER,f"SELECT {report_call};"),"22023")
    run("conservation-restore-chip-asset",f"UPDATE clubs SET asset='chips' WHERE id='{report_club}';")
    run("conservation-read-only-transaction", "BEGIN READ ONLY;"+as_role(OWNER,f"SELECT {report_call}->>'scope';")+"COMMIT;", "bank_and_player_baselines")
    run("conservation-read-only-repeat",as_role(OWNER,f"SELECT {report_call}={report_call};"),"t")

    run("pressure-large-independent-fixture", f"""
      INSERT INTO club_members(club_id,user_id,role,status,chip_balance)
       SELECT '{report_club}',md5('pressure-user-'||i)::uuid,'player','active',0 FROM generate_series(1,590)i;
      INSERT INTO ca_chip_baseline(club_id,user_id,opening_balance,taken_at)
       SELECT '{report_club}',md5('pressure-user-'||i)::uuid,0,'2026-01-01' FROM generate_series(1,590)i;
      INSERT INTO chip_ledger(club_id,from_type,from_entity_id,to_type,to_entity_id,amount,created_at,status)
       SELECT '{report_club}','player_wallet',md5('pressure-user-'||(i%590+1))::uuid,
        'player_wallet',md5('pressure-user-'||(i%590+1))::uuid,(i%700+1)::numeric/100,
        '2026-01-03'::timestamptz+((i%7000)||' seconds')::interval,
        (ARRAY['posted','correction','reversal'])[i%3+1] FROM generate_series(1,400000)i;
      -- Match the installed idx_chip_ledger_player_wallet_legs exactly.
      CREATE INDEX pressure_cover ON chip_ledger(created_at)
       INCLUDE(club_id,to_type,from_type,to_entity_id,from_entity_id,amount)
       WHERE club_id IS NOT NULL AND (to_type='player_wallet' OR from_type='player_wallet');
      -- Include production's non-covering entity indexes so a regression may
      -- not silently choose hundreds of repeated heap probes per position.
      CREATE INDEX pressure_to_entity ON chip_ledger(club_id,to_entity_id,created_at);
      CREATE INDEX pressure_from_entity ON chip_ledger(club_id,from_entity_id,created_at);
      ANALYZE chip_ledger; ANALYZE ca_chip_baseline; ANALYZE club_members;
    """,timeout=180)
    run("pressure-cover-visible", "VACUUM (FREEZE, ANALYZE) chip_ledger;",timeout=180)
    witness("pressure-independent-cancelled-both-legs", "(r->'players'->>'checked')::int=593 AND (r->'players'->>'missing')::int=2 AND (r->'players'->>'actual')::numeric=300 AND (r->'players'->>'expected')::numeric=300 AND (r->'players'->>'absolute_drift')::numeric=0", "t")
    pressure={}
    original_source = (ROOT / "supabase/migrations/20261011162855_cashier_club_baseline_conservation_report.sql").read_text()
    installed_source = run("pressure-qualified-function-definition", "SELECT pg_get_functiondef('public.fn_cashier_conservation_report(uuid)'::regprocedure);")
    for label,source in [('before',original_source),('after',installed_source)]:
        query=source[source.index('  WITH bank AS MATERIALIZED ('):source.index('  IF v_report IS NULL THEN')]
        query=query.replace(' INTO v_report','').replace('p_club_id',f"'{report_club}'::uuid").strip()
        raw=run('pressure-plan-'+label,"SET work_mem='4MB'; EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) "+query,timeout=180)
        plan=json.loads(raw)[0]
        pressure[label]={'execution_ms':plan['Execution Time'],'temp_written':plan['Plan'].get('Temp Written Blocks',0),'temp_read':plan['Plan'].get('Temp Read Blocks',0)}
        (out/('pressure-'+label+'.json')).write_text(json.dumps(plan,indent=2))
    def plan_nodes(node):
        yield node
        for child in node.get('Plans', []):
            yield from plan_nodes(child)
    moves_node = next(node for node in plan_nodes(plan['Plan']) if node.get('Subplan Name') == 'CTE moves')
    journal_scans = [node for node in plan_nodes(moves_node) if node.get('Relation Name') == 'chip_ledger']
    require(len(journal_scans) == 1 and journal_scans[0].get('Node Type') == 'Index Only Scan'
            and journal_scans[0].get('Index Name') == 'pressure_cover'
            and journal_scans[0].get('Actual Loops') == 1
            and journal_scans[0].get('Heap Fetches') == 0,
            'wallet legs must use one covering pass, not per-position heap probes')
    results['cases'].append({'name':'pressure-wallet-legs-one-covering-pass','passed':True})
    (out/'pressure-journal-scan.json').write_text(json.dumps(journal_scans,indent=2))
    run('pressure-current-report-readonly',"BEGIN READ ONLY;"+as_role(OWNER,f"SELECT ({report_call}->'players'->>'absolute_drift')::numeric=0;")+"COMMIT;",'t',timeout=180)
    require(pressure['before']['temp_written']>0,'original materialization did not reproduce spills')
    require(pressure['after']['temp_written']==0,'candidate still spills raw ledger rows')
    results['cases'].append({'name':'pressure-baseline-spills-candidate-does-not','passed':True})
    Path(out/'pressure-summary.json').write_text(json.dumps(pressure,indent=2))

    # A global created_at cover still scans every club before filtering. Keep
    # the original spill/pass witness above, then qualify the club-key cover
    # against unrelated booked legs using the same users and time range.
    unrelated_rows = 800000
    report_snapshot = run("pressure-club-cover-before-snapshot", as_role(OWNER,
        f"SELECT ({report_call}-'as_of')::text;"), timeout=180)
    run("pressure-unrelated-club-fixture", f"""
      INSERT INTO chip_ledger(club_id,from_type,from_entity_id,to_type,to_entity_id,amount,created_at,status)
       SELECT '{CLUB}','player_wallet',md5('pressure-user-'||(i%590+1))::uuid,
        'agent_wallet','{OWNER}',1,'2026-01-03'::timestamptz+((i%7000)||' seconds')::interval,
        (ARRAY['posted','correction','reversal'])[i%3+1]
       FROM generate_series(1,{unrelated_rows})i;
    """, timeout=180)
    run("pressure-unrelated-cover-visible", "VACUUM (FREEZE, ANALYZE) chip_ledger;", timeout=180)
    qualified_query = installed_source[installed_source.index('  WITH bank AS MATERIALIZED ('):installed_source.index('  IF v_report IS NULL THEN')]
    qualified_query = qualified_query.replace(' INTO v_report','').replace('p_club_id',f"'{report_club}'::uuid").strip()
    global_plan = json.loads(run("pressure-global-cover-unrelated-plan",
        "SET work_mem='4MB'; EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + qualified_query, timeout=180))[0]
    global_moves = next(node for node in plan_nodes(global_plan['Plan']) if node.get('Subplan Name') == 'CTE moves')
    global_scan = next(node for node in plan_nodes(global_moves) if node.get('Relation Name') == 'chip_ledger')
    require((global_scan.get('Index Name') == 'pressure_cover'
             and global_scan.get('Rows Removed by Filter',0) >= unrelated_rows)
            or (global_scan.get('Node Type') in ('Index Scan','Bitmap Heap Scan')
                and global_scan.get('Actual Rows') == 400008
                and (global_scan.get('Node Type') == 'Index Scan'
                     or global_scan.get('Exact Heap Blocks',0) > 0)),
            'unscoped cover must reproduce foreign scans or own heap reads')
    results['cases'].append({'name':'pressure-existing-index-reads-foreign-or-heap-legs','passed':True})
    (out/'pressure-global-unrelated.json').write_text(json.dumps(global_plan,indent=2))
    # The maintained concurrent preamble is issued as its own statement by
    # this disposable native psql runner, never inside the fixture transaction.
    index_sql = (ROOT / "supabase/migrations/20261012144405_cashier_conservation_reads_only_the_requested_club_journal.sql").read_text()
    run("pressure-club-cover-shipped-migration", index_sql, timeout=180)
    run("pressure-club-cover-function-byte-identical", "SELECT md5(pg_get_functiondef('public.fn_cashier_conservation_report(uuid)'::regprocedure));", "68e55e37885c51afd37d532753cb5ba1")
    club_plan = json.loads(run("pressure-club-cover-bounded-plan",
        "SET work_mem='4MB'; EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + qualified_query, timeout=180))[0]
    club_moves = next(node for node in plan_nodes(club_plan['Plan']) if node.get('Subplan Name') == 'CTE moves')
    club_scans = [node for node in plan_nodes(club_moves) if node.get('Relation Name') == 'chip_ledger']
    require(len(club_scans) == 1 and club_scans[0].get('Node Type') == 'Index Only Scan'
            and club_scans[0].get('Index Name') == 'idx_chip_ledger_club_player_legs_cover'
            and club_scans[0].get('Actual Loops') == 1
            and club_scans[0].get('Actual Rows') == 400008
            and club_scans[0].get('Heap Fetches') == 0
            and club_scans[0].get('Rows Removed by Filter',0) == 0
            and 'club_id =' in club_scans[0].get('Index Cond','')
            and 'created_at >=' in club_scans[0].get('Index Cond',''),
            'club cover must bound one index-only pass by club and baseline')
    results['cases'].append({'name':'pressure-club-cover-excludes-unrelated-legs','passed':True})
    run("pressure-club-cover-exact-report-preserved", as_role(OWNER,
        f"SELECT ({report_call}-'as_of')::text;"), report_snapshot, timeout=180)
    (out/'pressure-club-bounded.json').write_text(json.dumps(club_plan,indent=2))
    run("pressure-club-cover-wrong-definition-fixture", "DROP INDEX public.idx_chip_ledger_club_player_legs_cover; CREATE INDEX idx_chip_ledger_club_player_legs_cover ON public.chip_ledger(created_at);")
    refused("pressure-club-cover-wrong-definition-refused", index_sql, "55000")
    run("pressure-club-cover-refusal-preserves-function", "SELECT md5(pg_get_functiondef('public.fn_cashier_conservation_report(uuid)'::regprocedure));", "68e55e37885c51afd37d532753cb5ba1")
    run("pressure-club-cover-remove-isolated-wrong-index", "DROP INDEX public.idx_chip_ledger_club_player_legs_cover;")
    run("pressure-club-cover-restore-qualified-migration", index_sql, timeout=180)

    hashes = run("source-binding-hashes", "SELECT p.oid::regprocedure::text||'|'||md5(p.prosrc)||'|'||md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('fn_cashier_conservation_report','fn_cashier_recovery_receipts','fn_cashier_member_is_active','fn_club_active_cashier_edges','fn_club_bank_role','fn_club_is_in_downline','fn_cashier_assert_active_actor','fn_cashier_agent_status_mutex','fn_cashier_balance_actor_guard','fn_cashier_operation_mutex_guard','fn_cashier_operation_intent_guard','fn_cashier_exact_intent_begin','fn_cashier_exact_intent_finish','fn_club_bank_send','fn_club_bank_claim_back','fn_club_bank_reverse','fn_admin_remove_player_chips','fn_promo_wallet_send','fn_club_promo_wallet_send','fn_agent_wallet_send','fn_agent_wallet_claim_back','fn_request_chips','fn_club_bank_send_core_20261004','fn_club_bank_claim_core_20261004','fn_club_bank_reverse_core_20261004','fn_admin_remove_chips_core_20261004','fn_promo_wallet_send_core_20261004','fn_club_promo_send_core_20261004','fn_agent_wallet_send_core_20261004','fn_agent_wallet_claim_back_core_20261004','fn_request_chips_core_20261004','fn_club_cashier_members','fn_cashier_statement_downline','fn_cashier_statement_scope','fn_club_trade_ledger') ORDER BY p.oid::regprocedure::text;")
    (out / "source-binding-hashes.txt").write_text(hashes + "\n")
    results["passed"] = all(case["passed"] for case in results["cases"])
finally:
    command([pg / "pg_ctl", "-D", cluster / "data", "-m", "immediate", "stop"], timeout=20)
    (out / "result.json").write_text(json.dumps(results, indent=2) + "\n")
    shutil.rmtree(cluster, ignore_errors=True)

if not results["passed"]:
    raise SystemExit(1)

# Keep the current report-plan regression in the required Cashier native lane.
subprocess.run([
    sys.executable, str(ROOT / "scripts/ci/test-cashier-conservation-cutoff-statistics-postgres.py"),
    "--output", str(out / "conservation-cutoffs"),
], env={**os.environ, "PG_BIN": str(pg)}, check=True)
