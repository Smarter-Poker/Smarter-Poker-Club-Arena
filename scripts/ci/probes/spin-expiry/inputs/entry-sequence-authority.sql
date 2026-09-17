-- SOURCE ONLY / UNRUN. Isolated FIFO5 provider authority restoration.
-- Not a production migration or a business operation. Restore only the two
-- sequences omitted from retained schema/access authority, plus the captured
-- elimination sequence needed by the same cancellation. No sequence value,
-- increment, bound, cache, table default, function or trigger is changed.
-- Source: entry-sequences-capture-v2.json, observed 2026-09-16 12:29:05 UTC,
-- SHA256 5a1be88b490f940de698074281af5af6e1691befedb02d899e09c36a3ae1aec7.
-- Apply once after the authentic provider/schema/access restore and before the
-- funded fixture. Unexpected ownership, grants or dependencies refuse replay.
-- Third authority: refund-sequence-capture-v5.json, observed
-- 2026-09-16 13:54:59.798451 UTC, SHA256
-- 9d28e41f36c296b7661dd6b6a0c1f3397c0a2aead5ed22dafc0b5ffb6ec1d672.
-- Supersedes only the provider file; original two restorations are preserved.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL statement_timeout = '15s';

DO $entry_sequence_preimage$
DECLARE
  item record;
  seq_oid oid;
  execution_uuid text := current_setting('qualification.execution_uuid');
BEGIN
  IF current_user <> 'fixture_bootstrap' OR session_user <> 'fixture_bootstrap'
     OR execution_uuid !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR current_database() <> 'qual_spin_expiry_' || replace(execution_uuid, '-', '')
     OR current_database() !~ '^qual_spin_expiry_[0-9a-f]{32}$'
     OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
     OR inet_server_addr() IS NOT NULL
     OR current_setting('session_replication_role') <> 'origin'
     OR (SELECT rolsuper FROM pg_roles WHERE rolname = 'postgres') IS DISTINCT FROM false
  THEN
    RAISE EXCEPTION 'entry sequence authority requires exact isolated bootstrap boundary';
  END IF;

  FOR item IN SELECT * FROM (VALUES
    ('public', 'managed_game_contract_versions_id_seq'),
    ('smarter_private', 'f06_lifecycle_seq'),
    ('public', 'tournament_player_elimination_sequence')
  ) expected(schema_name, name)
  LOOP
    SELECT c.oid INTO STRICT seq_oid
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_sequence s ON s.seqrelid = c.oid
    WHERE n.nspname = item.schema_name AND c.relname = item.name
      AND c.relkind = 'S' AND c.relpersistence = 'p'
      AND pg_get_userbyid(c.relowner) = 'fixture_bootstrap' AND c.relacl IS NULL
      AND format_type(s.seqtypid, NULL) = 'bigint'
      AND s.seqstart::text = '1' AND s.seqincrement::text = '1'
      AND s.seqmin::text = '1' AND s.seqmax::text = '9223372036854775807'
      AND s.seqcache::text = '1' AND s.seqcycle = false;
    IF EXISTS (
      SELECT 1 FROM pg_depend d
      WHERE d.classid = 'pg_class'::regclass AND d.objid = seq_oid
        AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
    ) THEN
      RAISE EXCEPTION 'unexpected entry sequence ownership dependency: %.%', item.schema_name, item.name;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public' AND c.relname = 'managed_game_contract_versions'
      AND c.relkind = 'r' AND pg_get_userbyid(c.relowner) = 'postgres'
      AND a.attname = 'id' AND a.attnum > 0 AND NOT a.attisdropped
      AND a.atttypid = 'bigint'::regtype AND a.attidentity = ''
  ) THEN
    RAISE EXCEPTION 'entry sequence owned-by target differs';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public' AND c.relname = 'tournament_players'
      AND c.relkind = 'r' AND pg_get_userbyid(c.relowner) = 'postgres'
      AND a.attname = 'elimination_sequence' AND a.attnum > 0 AND NOT a.attisdropped
      AND a.atttypid = 'bigint'::regtype AND a.attidentity = ''
  ) THEN
    RAISE EXCEPTION 'elimination sequence owned-by target differs';
  END IF;
END $entry_sequence_preimage$;

ALTER SEQUENCE public.managed_game_contract_versions_id_seq OWNER TO postgres;
ALTER SEQUENCE smarter_private.f06_lifecycle_seq OWNER TO postgres;
ALTER SEQUENCE public.tournament_player_elimination_sequence OWNER TO postgres;
ALTER SEQUENCE public.managed_game_contract_versions_id_seq
  OWNED BY public.managed_game_contract_versions.id;
ALTER SEQUENCE public.tournament_player_elimination_sequence
  OWNED BY public.tournament_players.elimination_sequence;

-- Use the captured grantor, with no grant option and no extra principals.
SET LOCAL ROLE postgres;
GRANT SELECT, UPDATE, USAGE ON SEQUENCE public.managed_game_contract_versions_id_seq
  TO postgres, service_role;
GRANT SELECT, UPDATE, USAGE ON SEQUENCE smarter_private.f06_lifecycle_seq TO postgres;
GRANT SELECT, UPDATE, USAGE ON SEQUENCE public.tournament_player_elimination_sequence TO postgres;
RESET ROLE;

DO $entry_sequence_postimage$
DECLARE
  expected jsonb;
  actual jsonb;
BEGIN
  FOR expected IN SELECT value FROM jsonb_array_elements($authority$[
    {"schema_name":"public","name":"managed_game_contract_versions_id_seq","owner":"postgres","acl":"{postgres=rwU/postgres,service_role=rwU/postgres}","relpersistence":"p","type":"bigint","start":"1","increment":"1","minimum":"1","maximum":"9223372036854775807","cache":"1","cycle":false,"grants":[{"grantee":"postgres","grantor":"postgres","grantable":false,"privilege":"SELECT"},{"grantee":"postgres","grantor":"postgres","grantable":false,"privilege":"UPDATE"},{"grantee":"postgres","grantor":"postgres","grantable":false,"privilege":"USAGE"},{"grantee":"service_role","grantor":"postgres","grantable":false,"privilege":"SELECT"},{"grantee":"service_role","grantor":"postgres","grantable":false,"privilege":"UPDATE"},{"grantee":"service_role","grantor":"postgres","grantable":false,"privilege":"USAGE"}],"ownership":[{"schema_name":"public","table":"managed_game_contract_versions","column":"id","deptype":"a"}]},
    {"schema_name":"smarter_private","name":"f06_lifecycle_seq","owner":"postgres","acl":"{postgres=rwU/postgres}","relpersistence":"p","type":"bigint","start":"1","increment":"1","minimum":"1","maximum":"9223372036854775807","cache":"1","cycle":false,"grants":[{"grantee":"postgres","grantor":"postgres","grantable":false,"privilege":"SELECT"},{"grantee":"postgres","grantor":"postgres","grantable":false,"privilege":"UPDATE"},{"grantee":"postgres","grantor":"postgres","grantable":false,"privilege":"USAGE"}],"ownership":null},
    {"schema_name":"public","name":"tournament_player_elimination_sequence","owner":"postgres","acl":"{postgres=rwU/postgres}","relpersistence":"p","type":"bigint","start":"1","increment":"1","minimum":"1","maximum":"9223372036854775807","cache":"1","cycle":false,"grants":[{"grantee":"postgres","grantor":"postgres","grantable":false,"privilege":"SELECT"},{"grantee":"postgres","grantor":"postgres","grantable":false,"privilege":"UPDATE"},{"grantee":"postgres","grantor":"postgres","grantable":false,"privilege":"USAGE"}],"ownership":[{"table":"tournament_players","column":"elimination_sequence","deptype":"a","schema_name":"public"}]}
  ]$authority$::jsonb)
  LOOP
    SELECT jsonb_build_object(
      'schema_name', n.nspname, 'name', c.relname,
      'owner', pg_get_userbyid(c.relowner), 'acl', c.relacl::text,
      'relpersistence', c.relpersistence, 'type', format_type(s.seqtypid, NULL),
      'start', s.seqstart::text, 'increment', s.seqincrement::text,
      'minimum', s.seqmin::text, 'maximum', s.seqmax::text,
      'cache', s.seqcache::text, 'cycle', s.seqcycle,
      'grants', (
        SELECT jsonb_agg(jsonb_build_object(
          'grantor', pg_get_userbyid(a.grantor),
          'grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
          'privilege', a.privilege_type, 'grantable', a.is_grantable
        ) ORDER BY pg_get_userbyid(a.grantee), a.privilege_type)
        FROM aclexplode(c.relacl) a
      ),
      'ownership', (
        SELECT jsonb_agg(jsonb_build_object(
          'schema_name', tn.nspname, 'table', t.relname,
          'column', a.attname, 'deptype', d.deptype
        ) ORDER BY d.refobjid, d.refobjsubid)
        FROM pg_depend d JOIN pg_class t ON t.oid = d.refobjid
        JOIN pg_namespace tn ON tn.oid = t.relnamespace
        JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
          AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
      )
    ) INTO STRICT actual
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_sequence s ON s.seqrelid = c.oid
    WHERE n.nspname = expected->>'schema_name' AND c.relname = expected->>'name'
      AND c.relkind = 'S';
    IF actual IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'entry sequence authority postimage differs: %.%',
        expected->>'schema_name', expected->>'name';
    END IF;
  END LOOP;
END $entry_sequence_postimage$;
COMMIT;
