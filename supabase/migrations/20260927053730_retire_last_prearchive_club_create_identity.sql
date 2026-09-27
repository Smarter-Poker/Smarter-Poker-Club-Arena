-- RETIRE THE LAST EXACT PRE-ARCHIVE CLUB-CREATE CERTIFICATION SHADOW.
--
-- This Auth-less August 31 certification identity survives only as one exact
-- public.users row. A complete read-only production scan found no authority,
-- custody, gameplay, audit, archive, asset, UUID, or email-bearing surface.
-- Refuse a freeze, any source drift, any changed delete graph, or any newly
-- appeared matching surface before deleting exactly that one pinned row.
-- @live-proof: (SELECT NOT public.fn_platform_frozen() AND NOT EXISTS (SELECT 1 FROM public.users WHERE id='f488216c-2323-4f5e-857c-597339b00f75'::uuid))

BEGIN;

SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '15min';

DO $retire$
DECLARE
  v_id constant uuid := 'f488216c-2323-4f5e-857c-597339b00f75'::uuid;
  v_email constant text := 'club-create-cert-1788193929851-i6onsb@smarter-poker.invalid';
  v_surface record;
  v_found boolean;
  v_deleted integer := 0;
BEGIN
  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'LAST_PREARCHIVE_CLUB_CREATE_IDENTITY_REFUSES_PLATFORM_FREEZE'
      USING ERRCODE = '55000';
  END IF;

  PERFORM 1
    FROM public.users u
   WHERE u.id = v_id
     AND u.email = v_email
     AND u.username = 'club-create-cer'
     AND u.avatar_url IS NULL
     AND u.created_at = '2026-08-31T16:32:10.388656Z'::timestamptz
     AND u.updated_at = '2026-08-31T16:32:10.388656Z'::timestamptz
     AND length(to_jsonb(u)::text) = 269
     AND md5(to_jsonb(u)::text) = '8a140d14f3ae7b98d0da7d890717c84e'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LAST_PREARCHIVE_CLUB_CREATE_IDENTITY_CHANGED'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
       SELECT 1 FROM pg_catalog.pg_trigger t
        WHERE t.tgrelid = 'public.users'::regclass AND NOT t.tgisinternal
     ) OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint fk
        WHERE fk.contype = 'f' AND fk.confrelid = 'public.users'::regclass
     ) THEN
    RAISE EXCEPTION 'LAST_PREARCHIVE_CLUB_CREATE_IDENTITY_DELETE_GRAPH_CHANGED'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (SELECT 1 FROM auth.users WHERE id = v_id)
     OR EXISTS (SELECT 1 FROM auth.sessions WHERE user_id::text = v_id::text)
     OR EXISTS (SELECT 1 FROM auth.refresh_tokens WHERE user_id::text = v_id::text)
     OR EXISTS (SELECT 1 FROM public.profiles WHERE id = v_id)
     OR EXISTS (SELECT 1 FROM public.signup_errors WHERE user_id = v_id)
     OR EXISTS (SELECT 1 FROM public.ca_test_account_audit_archive WHERE actor_id = v_id)
     OR EXISTS (SELECT 1 FROM public.ca_test_account_ledger_actor_archive WHERE actor_id = v_id)
     OR EXISTS (SELECT 1 FROM storage.objects o
                 WHERE o.bucket_id = 'club-assets'
                   AND o.name LIKE 'club-logos/' || v_id::text || '%') THEN
    RAISE EXCEPTION 'LAST_PREARCHIVE_CLUB_CREATE_IDENTITY_PROTECTED_SURFACE_CHANGED'
      USING ERRCODE = '55000';
  END IF;

  -- Scan every current public UUID identity-bearing column, including columns
  -- with direct foreign keys. Exclude only the exact public.users source row.
  FOR v_surface IN
    SELECT n.nspname AS schema_name, c.relname AS table_name, a.attname AS column_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_attribute a
        ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND a.atttypid = 'uuid'::regtype
       AND NOT (
         n.nspname = 'public' AND c.relname = 'users' AND a.attname = 'id'
       )
       AND (
         a.attname = 'user_id'
         OR a.attname LIKE '%\_user\_id' ESCAPE '\'
         OR a.attname LIKE '%\_by' ESCAPE '\'
         OR a.attname IN (
           'player_id', 'player_a', 'player_b', 'actor', 'actor_id', 'owner_id',
           'recipient_id', 'sender_id', 'from_user_id', 'to_user_id', 'performed_by',
           'referrer_id', 'referee_id', 'challenger_id', 'challengee_id',
           'winner_id', 'loser_id', 'author_id', 'viewer_id', 'requester_id',
           'approver_id', 'caller_id', 'callee_id', 'caller_uid', 'jwt_sub'
         )
       )
     ORDER BY c.relname, a.attname
  LOOP
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE %I = $1)',
      v_surface.schema_name, v_surface.table_name, v_surface.column_name
    ) INTO v_found USING v_id;
    IF v_found THEN
      RAISE EXCEPTION 'LAST_PREARCHIVE_CLUB_CREATE_IDENTITY_UUID_SURFACE: %.%.%',
        v_surface.schema_name, v_surface.table_name, v_surface.column_name
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  -- Auth and Storage use independent ownership and do not consistently expose
  -- foreign keys to public.users. Scan every UUID column in those schemas.
  FOR v_surface IN
    SELECT n.nspname AS schema_name, c.relname AS table_name, a.attname AS column_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_attribute a
        ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname IN ('auth', 'storage')
       AND c.relkind IN ('r', 'p')
       AND a.atttypid = 'uuid'::regtype
     ORDER BY n.nspname, c.relname, a.attname
  LOOP
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE %I = $1)',
      v_surface.schema_name, v_surface.table_name, v_surface.column_name
    ) INTO v_found USING v_id;
    IF v_found THEN
      RAISE EXCEPTION 'LAST_PREARCHIVE_CLUB_CREATE_IDENTITY_UUID_SURFACE: %.%.%',
        v_surface.schema_name, v_surface.table_name, v_surface.column_name
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  -- Catch identity copies that retained only the reserved address.
  FOR v_surface IN
    SELECT n.nspname AS schema_name, c.relname AS table_name, a.attname AS column_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_attribute a
        ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname IN ('auth', 'public')
       AND c.relkind IN ('r', 'p')
       AND a.atttypid IN ('text'::regtype, 'character varying'::regtype)
       AND a.attname LIKE '%email%'
     ORDER BY n.nspname, c.relname, a.attname
  LOOP
    IF v_surface.schema_name = 'public' AND v_surface.table_name = 'users' THEN
      EXECUTE format(
        'SELECT EXISTS (SELECT 1 FROM public.users WHERE %I = $1 AND id <> $2)',
        v_surface.column_name
      ) INTO v_found USING v_email, v_id;
    ELSE
      EXECUTE format(
        'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE %I = $1)',
        v_surface.schema_name, v_surface.table_name, v_surface.column_name
      ) INTO v_found USING v_email;
    END IF;
    IF v_found THEN
      RAISE EXCEPTION 'LAST_PREARCHIVE_CLUB_CREATE_IDENTITY_EMAIL_SURFACE: %.%.%',
        v_surface.schema_name, v_surface.table_name, v_surface.column_name
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  DELETE FROM public.users u
   WHERE u.id = v_id
     AND u.email = v_email
     AND u.username = 'club-create-cer'
     AND u.avatar_url IS NULL
     AND u.created_at = '2026-08-31T16:32:10.388656Z'::timestamptz
     AND u.updated_at = '2026-08-31T16:32:10.388656Z'::timestamptz
     AND length(to_jsonb(u)::text) = 269
     AND md5(to_jsonb(u)::text) = '8a140d14f3ae7b98d0da7d890717c84e';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  IF v_deleted <> 1 OR EXISTS (SELECT 1 FROM public.users WHERE id = v_id) THEN
    RAISE EXCEPTION 'LAST_PREARCHIVE_CLUB_CREATE_IDENTITY_DELETE_COUNT: %', v_deleted
      USING ERRCODE = '55000';
  END IF;
END
$retire$;

COMMIT;
