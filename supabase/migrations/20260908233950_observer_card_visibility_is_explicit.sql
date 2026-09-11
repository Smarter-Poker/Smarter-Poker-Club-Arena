-- observer_card_visibility_is_explicit
BEGIN;

DO $observer_policy_precondition$
BEGIN
  IF to_regclass('public.tables') IS NULL THEN
    RAISE EXCEPTION 'OBSERVER_CARD_VISIBILITY_TABLES_MISSING';
  END IF;

  IF NOT (
    SELECT c.relrowsecurity
      FROM pg_class c
     WHERE c.oid = 'public.tables'::regclass
  ) THEN
    RAISE EXCEPTION 'OBSERVER_CARD_VISIBILITY_TABLES_RLS_DISABLED';
  END IF;
END;
$observer_policy_precondition$;

ALTER TABLE public.tables
  ADD COLUMN IF NOT EXISTS observer_show_cards boolean NOT NULL DEFAULT false;

UPDATE public.tables
   SET observer_show_cards = false
 WHERE observer_show_cards IS NULL;

ALTER TABLE public.tables
  ALTER COLUMN observer_show_cards SET DEFAULT false,
  ALTER COLUMN observer_show_cards SET NOT NULL;

COMMENT ON COLUMN public.tables.observer_show_cards IS
  'When true, non-seated observers may see tabled cards at showdown or during an all-in runout. False is the privacy default.';

DO $observer_policy_postimage$
DECLARE
  v_type oid;
  v_not_null boolean;
  v_default text;
BEGIN
  SELECT a.atttypid, a.attnotnull, pg_get_expr(d.adbin, d.adrelid)
    INTO v_type, v_not_null, v_default
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d
      ON d.adrelid = a.attrelid
     AND d.adnum = a.attnum
   WHERE a.attrelid = 'public.tables'::regclass
     AND a.attname = 'observer_show_cards'
     AND NOT a.attisdropped;

  IF v_type IS DISTINCT FROM 'boolean'::regtype
     OR v_not_null IS DISTINCT FROM true
     OR v_default IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION
      'OBSERVER_CARD_VISIBILITY_POSTIMAGE_MISMATCH type=% not_null=% default=%',
      v_type::regtype,
      v_not_null,
      v_default;
  END IF;

  IF NOT (
    SELECT c.relrowsecurity
      FROM pg_class c
     WHERE c.oid = 'public.tables'::regclass
  ) THEN
    RAISE EXCEPTION 'OBSERVER_CARD_VISIBILITY_TABLES_RLS_DISABLED_POSTIMAGE';
  END IF;
END;
$observer_policy_postimage$;

COMMIT;