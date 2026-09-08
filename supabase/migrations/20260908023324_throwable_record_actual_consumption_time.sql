-- Record the actual consumption instant, not the transaction start.
-- Reproduced and verified with the exported business function on local PostgreSQL 17.
BEGIN;

DO $migration$
DECLARE
  definition text := pg_get_functiondef('public.fn_use_throwable_v2(text,uuid)'::regprocedure);
BEGIN
  IF md5(definition) <> '51e421d3c495d0e41adc02d811a8ee86' THEN
    RAISE EXCEPTION 'fn_use_throwable_v2 changed since review; revalidate before applying';
  END IF;
  definition := replace(definition,
    'INSERT INTO public.throw_usage (user_id, throwable_id, paid_diamonds)',
    'INSERT INTO public.throw_usage (user_id, throwable_id, paid_diamonds, created_at)');
  definition := replace(definition,
    'VALUES (v_uid, p_throwable_id, false);',
    'VALUES (v_uid, p_throwable_id, false, clock_timestamp());');
  definition := replace(definition,
    'VALUES (v_uid, p_throwable_id, true);',
    'VALUES (v_uid, p_throwable_id, true, clock_timestamp());');
  EXECUTE definition;
END
$migration$;

COMMIT;
