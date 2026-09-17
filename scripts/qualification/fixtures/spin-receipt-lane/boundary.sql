-- Disposable native qualification only. No production-capable fallback.
DO $private_boundary$
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres'
    OR (SELECT rolsuper FROM pg_roles WHERE rolname=current_user)
    OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
    OR current_database()<>'qual_spin_expiry_'||replace(current_setting('qualification.execution_uuid')::uuid::text,'-','')
    OR inet_server_addr() IS NOT NULL OR current_setting('port')<>'5432'
    OR current_setting('session_replication_role')<>'origin' THEN
  RAISE EXCEPTION 'receipt lane requires exact private nonsuperuser PG17 allocation'; END IF;
END $private_boundary$;
