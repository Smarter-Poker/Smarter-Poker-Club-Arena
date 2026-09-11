-- Restate the already verified server-only Round3 ACL for the branch permission gate.
-- Requires the exact adopted legacy repair; changes no function body or financial data.
-- Before and after guards reject absent, default-open, browser-exposed or drifted authority.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '10s';

DO $guard$
DECLARE
  v_function record;
  v_acl text[];
BEGIN
  SELECT p.* INTO v_function
  FROM pg_proc AS p
  WHERE p.oid = to_regprocedure('public.fn_settle_round3_agents_to_players(uuid,timestamptz,timestamptz)');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Round3 ACL restatement refuses an absent adopted function';
  END IF;
  SELECT array_agg(
    (CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END)
    || '|' || pg_get_userbyid(a.grantor)::text
    || '|' || a.privilege_type || '|' || a.is_grantable::text
    ORDER BY
      (CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END) COLLATE "C",
      pg_get_userbyid(a.grantor)::text COLLATE "C",
      a.privilege_type COLLATE "C", a.is_grantable)
  INTO v_acl
  FROM aclexplode(COALESCE(v_function.proacl, acldefault('f', v_function.proowner))) AS a;
  IF md5(v_function.prosrc) IS DISTINCT FROM '18c6571f37401e14116e59310235b7b2'
     OR pg_get_userbyid(v_function.proowner)::text IS DISTINCT FROM 'postgres'
     OR v_function.prosecdef IS DISTINCT FROM true
     OR v_function.proconfig IS DISTINCT FROM ARRAY['search_path=public']::text[]
     OR v_function.proargnames IS DISTINCT FROM ARRAY['p_union_id','p_period_start','p_period_end']::text[]
     OR v_function.pronargdefaults IS DISTINCT FROM 0::smallint
     OR v_acl IS DISTINCT FROM ARRAY[
       'postgres|postgres|EXECUTE|false',
       'service_role|postgres|EXECUTE|false'
     ]::text[] THEN
    RAISE EXCEPTION 'Round3 ACL restatement refuses adopted body, owner, security, signature, configuration or ACL drift';
  END IF;
END
$guard$;

REVOKE ALL ON FUNCTION public.fn_settle_round3_agents_to_players(uuid,timestamptz,timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_round3_agents_to_players(uuid,timestamptz,timestamptz)
  TO service_role;

DO $guard$
DECLARE
  v_function record;
  v_acl text[];
BEGIN
  SELECT p.* INTO v_function
  FROM pg_proc AS p
  WHERE p.oid = to_regprocedure('public.fn_settle_round3_agents_to_players(uuid,timestamptz,timestamptz)');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Round3 ACL restatement refuses an absent adopted function';
  END IF;
  SELECT array_agg(
    (CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END)
    || '|' || pg_get_userbyid(a.grantor)::text
    || '|' || a.privilege_type || '|' || a.is_grantable::text
    ORDER BY
      (CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END) COLLATE "C",
      pg_get_userbyid(a.grantor)::text COLLATE "C",
      a.privilege_type COLLATE "C", a.is_grantable)
  INTO v_acl
  FROM aclexplode(COALESCE(v_function.proacl, acldefault('f', v_function.proowner))) AS a;
  IF md5(v_function.prosrc) IS DISTINCT FROM '18c6571f37401e14116e59310235b7b2'
     OR pg_get_userbyid(v_function.proowner)::text IS DISTINCT FROM 'postgres'
     OR v_function.prosecdef IS DISTINCT FROM true
     OR v_function.proconfig IS DISTINCT FROM ARRAY['search_path=public']::text[]
     OR v_function.proargnames IS DISTINCT FROM ARRAY['p_union_id','p_period_start','p_period_end']::text[]
     OR v_function.pronargdefaults IS DISTINCT FROM 0::smallint
     OR v_acl IS DISTINCT FROM ARRAY[
       'postgres|postgres|EXECUTE|false',
       'service_role|postgres|EXECUTE|false'
     ]::text[] THEN
    RAISE EXCEPTION 'Round3 ACL restatement refuses adopted body, owner, security, signature, configuration or ACL drift';
  END IF;
END
$guard$;

COMMIT;
