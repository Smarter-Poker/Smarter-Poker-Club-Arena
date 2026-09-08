-- Reserved with scripts/new-migration.mjs. Prevent a locked owned pack
-- from being skipped in favour of an unnecessary diamond debit.
-- Tested with the exported live functions on an isolated PostgreSQL 17 cluster.
BEGIN;

DO $migration$
DECLARE
  definition text := pg_get_functiondef('public.fn_use_throwable_v2(text,uuid)'::regprocedure);
BEGIN
  -- Refuse to overwrite any concurrent function change that was not reviewed.
  IF md5(definition) <> '8ea1cb739945e2933c3dc19ea8cbe005' THEN
    RAISE EXCEPTION 'fn_use_throwable_v2 changed since review; revalidate before applying';
  END IF;
  EXECUTE replace(definition, 'FOR UPDATE SKIP LOCKED', 'FOR UPDATE');
END
$migration$;

COMMIT;
