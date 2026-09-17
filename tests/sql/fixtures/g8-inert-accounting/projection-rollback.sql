ROLLBACK TO SAVEPOINT ip_private_install;
DO $rollback$
BEGIN
 IF EXISTS(SELECT FROM pg_namespace WHERE nspname='smarter_private')
    OR EXISTS(SELECT FROM pg_roles WHERE rolname IN ('postgres','authenticator'))
    OR (SELECT roles FROM ip_fixture_preimage) IS DISTINCT FROM
       (SELECT jsonb_agg(to_jsonb(r) ORDER BY oid) FROM pg_roles r)
    OR (SELECT memberships FROM ip_fixture_preimage) IS DISTINCT FROM
       (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY roleid,member,grantor),'[]'::jsonb) FROM pg_auth_members m)
    OR (SELECT defaults FROM ip_fixture_preimage) IS DISTINCT FROM
       (SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY oid),'[]'::jsonb) FROM pg_default_acl d) THEN
  RAISE EXCEPTION 'IP_FIXTURE_ROLLBACK_READBACK';
 END IF;
END $rollback$;
ROLLBACK;
