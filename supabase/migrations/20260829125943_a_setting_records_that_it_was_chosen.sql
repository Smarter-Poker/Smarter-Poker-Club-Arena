-- ═══════════════════════════════════════════════════════════════════════════════
--  A SETTING RECORDS THAT IT WAS CHOSEN
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Dan, binding: "NEVER REGRESS OR AUTO CHANGE BACK UNLESS THE USER CHANGES THEM
-- MANUALLY."
--
-- THE BUG THIS CLOSES
--
-- Every column on this table is NOT NULL with a default, so a stored value that
-- equals the default is indistinguishable from a value nobody ever set.
-- `useTableSettings.hydrateFromServer` had to guess, and guessed like this:
--
--     const serverChose = serverValue !== DEFAULT_SETTINGS[key];
--
-- That is correct exactly half the time. Worked example, entirely from shipped
-- behaviour:
--
--   1. On their laptop a player turns the ticker OFF. Row: show_ticker = false.
--   2. On their phone they turn it back ON. `true` is also the column default.
--   3. They open the laptop. The row says `true`, which the laptop reads as
--      "the account never had an opinion", so it pushes its own stale `false`
--      back UP and turns the ticker off again — on both devices.
--
-- Nobody touched a control. It applies to every setting whose ON state happens
-- to be the default: sound, bet-size presets, auto-post-blinds, confirm all-in,
-- auto-muck, four-colour deck. `auto_muck_explicit` exists because somebody hit
-- this already and solved it for exactly one column.
--
-- THE FIX
--
-- Record the fact of the choice rather than inferring it from the value.
-- `settings_touched` names every column this account has deliberately written.
-- Hydration then reads: touched -> the row wins; untouched -> the browser's
-- value may be carried up. A value that equals the default is now a first-class
-- answer, which it never was before.
--
-- BACKFILL: divergence from the default, which is precisely what the old code
-- inferred. So no existing user's behaviour changes on the day this lands; they
-- simply stop being wrong from the next write onward.

BEGIN;

ALTER TABLE public.user_table_settings
  ADD COLUMN IF NOT EXISTS settings_touched text[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN public.user_table_settings.settings_touched IS
  'Columns this account has deliberately written. Hydration lets the row win '
  'for these and only these; anything absent is treated as "never chosen", so a '
  'value equal to the column default is still a real answer. Maintained by '
  'fn_mark_table_setting_touched. Never write it directly from a client.';

-- ── Backfill ────────────────────────────────────────────────────────────────
-- Evaluate each column's own default and compare, rather than hardcoding a list
-- that would drift the first time a column is added.
DO $backfill$
DECLARE
  r            record;
  v_default    text;
  v_updated    bigint;
  v_total      bigint := 0;
BEGIN
  FOR r IN
    SELECT a.attname::text AS col, pg_get_expr(d.adbin, d.adrelid) AS default_expr
      FROM pg_attribute a
      JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = 'public.user_table_settings'::regclass
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND a.attname NOT IN ('user_id', 'created_at', 'updated_at', 'settings_touched')
  LOOP
    EXECUTE format('SELECT (%s)::text', r.default_expr) INTO v_default;

    EXECUTE format(
      'UPDATE public.user_table_settings t
          SET settings_touched = array_append(t.settings_touched, %L)
        WHERE (to_jsonb(t) ->> %L) IS DISTINCT FROM %L
          AND NOT (%L = ANY (t.settings_touched))',
      r.col, r.col, v_default, r.col
    );
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    v_total := v_total + v_updated;
  END LOOP;

  RAISE NOTICE 'settings_touched backfill marked % (row, column) pairs', v_total;
END
$backfill$;

-- ── The only sanctioned writer ──────────────────────────────────────────────
-- SECURITY INVOKER and auth.uid(): this cannot touch anybody else's row, and it
-- is still subject to the table's RLS. The column names are whitelisted against
-- the table's own catalog, so a client cannot accumulate junk in the array by
-- passing arbitrary strings.
CREATE OR REPLACE FUNCTION public.fn_mark_table_setting_touched(p_columns text[])
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  v_uid   uuid := auth.uid();
  v_valid text[];
BEGIN
  IF v_uid IS NULL OR p_columns IS NULL OR array_length(p_columns, 1) IS NULL THEN
    RETURN;
  END IF;

  SELECT array_agg(DISTINCT c)
    INTO v_valid
    FROM unnest(p_columns) AS c
   WHERE c IN (
     SELECT a.attname::text
       FROM pg_attribute a
      WHERE a.attrelid = 'public.user_table_settings'::regclass
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND a.attname NOT IN ('user_id', 'created_at', 'updated_at', 'settings_touched')
   );

  IF v_valid IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.user_table_settings t
     SET settings_touched = (
           SELECT array_agg(DISTINCT e)
             FROM unnest(t.settings_touched || v_valid) AS e
         )
   WHERE t.user_id = v_uid;
END
$fn$;

COMMENT ON FUNCTION public.fn_mark_table_setting_touched(text[]) IS
  'Record that the signed-in user deliberately set these settings columns. '
  'Idempotent, whitelisted against the table catalog, and scoped to auth.uid(). '
  'Called after a successful per-key upsert from useTableSettings / '
  'useUserTableSettings.';

GRANT EXECUTE ON FUNCTION public.fn_mark_table_setting_touched(text[]) TO authenticated;

-- ── Self-assertions: this migration fails rather than lying ─────────────────
DO $assert$
DECLARE
  v_missing int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'user_table_settings'
       AND column_name = 'settings_touched'
       AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'settings_touched was not created NOT NULL';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_mark_table_setting_touched'
  ) THEN
    RAISE EXCEPTION 'fn_mark_table_setting_touched was not created';
  END IF;

  -- Nothing may have landed in the array that is not a real column.
  SELECT count(*) INTO v_missing
    FROM public.user_table_settings t,
         LATERAL unnest(t.settings_touched) AS c
   WHERE c NOT IN (
     SELECT a.attname::text
       FROM pg_attribute a
      WHERE a.attrelid = 'public.user_table_settings'::regclass
        AND a.attnum > 0 AND NOT a.attisdropped
   );
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'backfill wrote % entries that are not columns of the table', v_missing;
  END IF;
END
$assert$;

COMMIT;
