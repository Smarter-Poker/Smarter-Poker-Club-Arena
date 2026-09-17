-- Fixture-only, read-only snapshot. pg_roles masks passwords; never inspect
-- pg_authid or credentials. Database pg_dump does not capture global roles.
\set ON_ERROR_STOP on
SELECT jsonb_build_object(
 'roles',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.oid) FROM pg_roles r),
 'memberships',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.roleid,m.member,m.grantor) FROM pg_auth_members m)
)::text;
