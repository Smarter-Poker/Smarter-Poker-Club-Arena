-- @live-proof: (SELECT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname='ca_record_gateway' AND NOT r.rolsuper AND NOT r.rolinherit AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication AND NOT r.rolbypassrls AND r.rolconnlimit=4 AND shobj_description(r.oid,'pg_authid') LIKE 'ca-private-record-%'))
-- The independent listener needs its own identity, not a copy of the engine's
-- credential. Create it disabled and without application grants. LOGIN/password
-- belongs to one explicit protected provider operation using a new canonical
-- secret, after effective PUBLIC/membership/ownership permissions qualify.
-- No password, player record, financial row, PUBLIC grant or other role changes.
-- Reserved by scripts/reserve-migration-version.sh, October 28, 2026.
BEGIN;
SET LOCAL lock_timeout='500ms';
SET LOCAL statement_timeout='5s';
DO $role$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ca_record_gateway') THEN
  RAISE EXCEPTION 'PRIVATE_RECORD_ROLE_ALREADY_EXISTS: recover its original owner, never adopt or rotate it';
 END IF;
 CREATE ROLE ca_record_gateway NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4;
 EXECUTE format('GRANT CONNECT ON DATABASE %I TO ca_record_gateway',current_database());
 COMMENT ON ROLE ca_record_gateway IS 'ca-private-record-listener:v1:disabled:20261028154533';
END $role$;
COMMIT;
