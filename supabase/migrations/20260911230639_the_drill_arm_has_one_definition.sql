-- ═══════════════════════════════════════════════════════════════════════════
--  THE DRILL ARM HAS ONE DEFINITION
--  BBJ programme, post-audit phase 2 of 5 (2026-09-11)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Adding `p_kind` to `fn_bbj_arm_drill` created an OVERLOAD rather than
-- replacing the function: CREATE OR REPLACE matches on the argument list, so
-- `(uuid, text)` and `(uuid, text, text)` both existed - and an existing
-- caller passing `(table, note)` resolved to the EXACT two-argument match,
-- which is the OLD body, with no kind and none of the mini's guards.
--
-- Two definitions of one rule, with the older one winning for every caller
-- that had not been updated. That is precisely the drift this sweep has spent
-- the evening closing, introduced by the fix for it, and caught by reading
-- `pg_proc` after applying rather than by assuming the replace had replaced.
--
-- The three-argument form defaults `p_kind` to 'main', so it is callable as
-- `(table, note)` and is a strict superset. The two-argument one goes, and
-- this migration refuses to finish unless exactly one definition survives and
-- it is still callable the old way.

BEGIN;

DROP FUNCTION IF EXISTS public.fn_bbj_arm_drill(uuid, text);

DO $$
DECLARE v_sigs text;
BEGIN
  SELECT string_agg(pg_get_function_identity_arguments(p.oid), ' | ')
    INTO v_sigs
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_bbj_arm_drill';

  IF v_sigs IS DISTINCT FROM 'p_table_id uuid, p_note text, p_kind text' THEN
    RAISE EXCEPTION
      'fn_bbj_arm_drill must have exactly one definition, the three-argument one; found: %',
      COALESCE(v_sigs, '<none>');
  END IF;

  /* It must still be callable the old way, or retiring the overload would
     break every existing caller rather than unify them. */
  IF public.fn_bbj_arm_drill('00000000-0000-0000-0000-000000000000'::uuid, 'signature probe') IS NULL THEN
    RAISE EXCEPTION 'the surviving definition is not callable as (table, note)';
  END IF;
END $$;

COMMIT;
