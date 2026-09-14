-- Reserved by scripts/reserve-migration-version.sh at 2026-09-14 00:01:59 UTC.
-- Production's played MTT proof failed 25006 before reaching its body: a POST
-- to a STABLE RPC runs READ ONLY in PostgREST, but the request guard classified
-- every POST as mutable and attempted SELECT FOR KEY SHARE. Respect the actual
-- transaction access mode. Read-only requests still verify the exact live
-- generation; all read-write mutation requests retain the takeover-blocking
-- lock. PostgreSQL itself prohibits mutations in a read-only transaction.
-- No proof, payout, lease window, grant or transaction isolation change.
-- https://docs.postgrest.org/en/stable/references/transactions.html
BEGIN;
SET LOCAL lock_timeout='5s';
DO $patch$
DECLARE
  v_oid regprocedure := 'smarter_private.fn_smarter_data_api_pre_request()'::regprocedure;
  v_source text;
BEGIN
  SELECT prosrc INTO v_source FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)='ec1aaf15293f431798d48a0ad91c5e3d' THEN RETURN; END IF;
  IF md5(v_source) IS DISTINCT FROM 'ab227471f29f2944ebd64909622b6af7' THEN
    RAISE EXCEPTION 'Read-only RPC authority repair refuses unreviewed request guard';
  END IF;
  EXECUTE replace(pg_get_functiondef(v_oid),$needle$IF v_method IN ('GET', 'HEAD', 'OPTIONS') THEN$needle$,
    $replacement$IF v_method IN ('GET', 'HEAD', 'OPTIONS')
     OR current_setting('transaction_read_only') = 'on' THEN$replacement$);
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=v_oid) IS DISTINCT FROM 'ec1aaf15293f431798d48a0ad91c5e3d' THEN
    RAISE EXCEPTION 'Read-only RPC authority repair failed source verification';
  END IF;
END;
$patch$;
COMMIT;
