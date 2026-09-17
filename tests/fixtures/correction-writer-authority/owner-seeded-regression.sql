\set ON_ERROR_STOP on
-- SAME connection as legacy seed/full candidate. Input rows are already committed
-- by the isolated predecessor seed. The pinned owner fixture rolls back its own
-- successful and rejected corrections; it neither deletes intent nor swaps writers.
SELECT pg_temp.cw_check(current_user='postgres' AND inet_server_addr() IS NULL
 AND current_setting('session_replication_role')='origin'
 AND (SELECT count(*)=1 FROM correction_fixture_input)
 AND (SELECT count(*)=1 FROM correction_legacy_input),'same-session owner fixture prerequisites');
CREATE TEMP TABLE cw_owner_wrapper_baseline AS SELECT pg_temp.cw_book() AS book,
 (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.rolname) FROM pg_roles r) AS roles,
 (SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.roleid,m.member,m.grantor),'[]'::jsonb) FROM pg_auth_members m) AS memberships;
-- Session claims intentionally survive the included owner's BEGIN. No production credentials.
SELECT set_config('request.jwt.claim.sub',pg_temp.cw_id(1)::text,false);
SELECT set_config('request.jwt.claim.role','service_role',false);
SELECT set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.cw_id(1),'role','service_role')::text,false);
\ir owner-fixture.sql
\ir authority-regression.sql
\ir deferred-overlay-regression.sql
\ir legacy-replay-and-input-assertions.sql
SELECT pg_temp.cw_check(b.book=pg_temp.cw_book()
 AND b.roles=(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.rolname) FROM pg_roles r)
 AND b.memberships=(SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.roleid,m.member,m.grantor),'[]'::jsonb) FROM pg_auth_members m),
 'all included successor probes restore original persistent rows, roles and memberships') FROM cw_owner_wrapper_baseline b;
DROP TABLE cw_owner_wrapper_baseline;
SELECT set_config('request.jwt.claim.sub','',false);
SELECT set_config('request.jwt.claim.role','',false);
SELECT set_config('request.jwt.claims','{}',false);
