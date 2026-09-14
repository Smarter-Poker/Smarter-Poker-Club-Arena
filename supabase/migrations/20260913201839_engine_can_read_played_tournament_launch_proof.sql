-- Reserved using scripts/reserve-migration-version.sh.
-- The engine needs the same read-only historical launch proof that the
-- completion transaction already rechecks. Browser execution stays denied.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc
      WHERE oid='public.fn_prove_played_launch_recovery(uuid,timestamptz)'::regprocedure)
     IS DISTINCT FROM '27037b1d61898aef22fd476a44667cc9' THEN
    RAISE EXCEPTION 'Played MTT proof grant refuses unreviewed source';
  END IF;
END;
$guard$;
GRANT EXECUTE ON FUNCTION public.fn_prove_played_launch_recovery(uuid,timestamptz) TO service_role;
COMMIT;
