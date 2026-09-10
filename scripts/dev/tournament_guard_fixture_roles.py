"""Align only the captured guard metadata in the private PG17 rehearsal.

The runner creates a local cluster as registration_test. Its postgres role
inherits that fixture owner's table/sequence rights; SUPERUSER is not inherited.
This models the captured function owner and ACL, not production HTTP/RLS.
"""
import json
import re

def align(q, signature, *, service, search_path, runtime_timeout=None):
    assert re.fullmatch(r"[a-z_][a-z_0-9]*\([a-z_0-9, ]*\)", signature), signature
    for role in ["postgres", "anon", "authenticated", "service_role"]:
        q("DO $fixture$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='%s') THEN CREATE ROLE %s NOLOGIN NOSUPERUSER INHERIT; END IF; END; $fixture$;" % (role,role))
    q("GRANT registration_test TO postgres;")
    target="public."+signature
    q("ALTER FUNCTION "+target+" OWNER TO postgres;")
    q("REVOKE ALL ON FUNCTION "+target+" FROM PUBLIC,anon,authenticated,service_role;")
    if service:
        q("GRANT EXECUTE ON FUNCTION "+target+" TO service_role;")
    assert search_path in ["public", "public, pg_temp", "public, extensions, pg_temp"]
    q("ALTER FUNCTION "+target+" SET search_path TO "+search_path+";")
    if runtime_timeout is not None:
        assert runtime_timeout=="120s"
        q("ALTER FUNCTION "+target+" SET statement_timeout TO '120s';")
    metadata=json.loads(q("SELECT jsonb_build_object('owner',pg_get_userbyid(proowner),'definer',prosecdef,'config',proconfig,'anon',has_function_privilege('anon',oid,'EXECUTE'),'authenticated',has_function_privilege('authenticated',oid,'EXECUTE'),'service',has_function_privilege('service_role',oid,'EXECUTE')) FROM pg_proc WHERE oid='"+target+"'::regprocedure;"))
    expected_config=["search_path="+search_path]
    if runtime_timeout is not None:
        expected_config.append("statement_timeout="+runtime_timeout)
    assert metadata==dict(owner="postgres",definer=True,config=expected_config,anon=False,authenticated=False,service=service),metadata
