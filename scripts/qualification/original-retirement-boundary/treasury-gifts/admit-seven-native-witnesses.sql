-- Native qualification fixture ONLY. Never a production migration.
DO $native$BEGIN IF (inet_server_addr() IS DISTINCT FROM '127.0.0.1'::inet AND NOT(inet_server_addr()IS NULL AND current_database()='original_source_refs' AND current_setting('port')='55931')) OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999 THEN RAISE EXCEPTION 'original_treasury_fixture_requires_isolated_loopback_PG17';END IF;END$native$;
SET timezone='UTC';CREATE SCHEMA IF NOT EXISTS smarter_private;
SELECT smarter_private.admit_original_treasury_gift('1b4eab8b-d46d-4f54-a825-340d50d9e6e2'::uuid);
SELECT smarter_private.admit_original_treasury_gift('95445619-c021-4dd8-97b5-a593ce910145'::uuid);
SELECT smarter_private.admit_original_treasury_gift('ab65ad78-6e50-4718-ba7e-86256d426a43'::uuid);
SELECT smarter_private.admit_original_treasury_gift('b439b3d5-2d1f-4859-aa48-34bea8a8101c'::uuid);
SELECT smarter_private.admit_original_treasury_return('68e2c834-49cb-4917-aa9d-95355b0cebfc'::uuid);
SELECT smarter_private.admit_original_treasury_return('821d7f4b-0bd9-431d-bca2-6308627d7faf'::uuid);
SELECT smarter_private.admit_original_treasury_return('dc82ad6b-1357-489b-9d11-b426eb50d053'::uuid);
