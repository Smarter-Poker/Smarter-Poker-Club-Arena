-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821140155 "rake_cut_out_of_every_buyin_and_rebuy"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 60495feb040cbf6c01819abfe5388188 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
--  ONE RAKE MODEL (Dan, 2026-08-21)
-- ═══════════════════════════════════════════════════════════════════════════
--  "Ensure that all buy-ins pay the registration fee and 10% rake is taken
--   OUT for all buy-ins and rebuys."
--
--  Entries already worked this way: the advertised buy-in is the total, and
--  10% is cut out of it. Rebuys and re-entries did NOT - they added the fee
--  ON TOP, so a 20 rebuy silently charged 22 while a 20 entry charged 20. Two
--  prices for the same rule.
--
--  TWO CHANGES
--   1. fn_create_tournament        - a positive buy-in always pays at least
--                                    1 chip of fee. round(4 * 0.1) is 0, so
--                                    small buy-ins were entering rake-free.
--   2. process_tournament_rebuy    - the advertised rebuy price becomes the
--                                    TOTAL; the fee is cut out of it; the
--                                    remainder feeds the prize pool.
--
--  Spins keep their zero fee. That is Dan's own prior ruling with a stated
--  reason: the edge is engineered into the multiplier distribution, so a fee
--  here would roughly double the true house edge. Flagged, not overridden.
--
--  Both functions are patched IN PLACE from pg_get_functiondef so the rest of
--  their bodies - the atomicity guards, the seat assertions, the idempotency
--  keys - are carried across verbatim and cannot be lost to a retype.
--
--  TIER 3. ROLLBACK at the bottom.

DO $mig$
DECLARE
  v_def       text;
  v_new       text;
  v_old_line  text;
  v_new_line  text;
BEGIN
  -- ── 1. Every positive buy-in pays a fee ──────────────────────────────────
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_create_tournament';
  IF v_def IS NULL THEN RAISE EXCEPTION 'fn_create_tournament not found'; END IF;

  v_old_line := 'v_fee    := LEAST(v_total, GREATEST(0, round(v_total * 0.1)));';
  v_new_line := 'v_fee    := LEAST(v_total, GREATEST(CASE WHEN v_total > 0 THEN 1 ELSE 0 END, round(v_total * 0.1)));';
  IF position(v_old_line in v_def) = 0 THEN
    RAISE EXCEPTION 'fn_create_tournament: fee line not found, refusing to guess';
  END IF;
  v_new := replace(v_def, v_old_line, v_new_line);
  EXECUTE v_new;

  -- ── 2. Rebuys and re-entries: cut the rake OUT, not on top ───────────────
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'process_tournament_rebuy';
  IF v_def IS NULL THEN RAISE EXCEPTION 'process_tournament_rebuy not found'; END IF;

  v_old_line := 'v_base := round(v_base::numeric,2); v_fee := round(v_base*v_ratio,2); v_total := v_base+v_fee;';
  v_new_line := 'v_total := round(v_base::numeric); v_fee := CASE WHEN v_ratio > 0 AND v_total > 0 THEN LEAST(v_total, GREATEST(1, round(v_total * v_ratio))) ELSE 0 END; v_base := v_total - v_fee;';
  IF position(v_old_line in v_def) = 0 THEN
    RAISE EXCEPTION 'process_tournament_rebuy: pricing line not found, refusing to guess';
  END IF;
  v_new := replace(v_def, v_old_line, v_new_line);

  -- The price guard has to learn the new shape, or every cached client 500s.
  v_old_line := 'v_legacy_total := v_base + round(v_base * v_legacy_ratio, 2);
    IF NOT (p_rebuy_type = ''addon'' AND abs(p_cost - v_legacy_total) <= 0.01) THEN';
  v_new_line := 'v_legacy_total := v_total + round(v_total * v_legacy_ratio, 2);
    IF abs(p_cost - v_legacy_total) > 0.01 THEN';
  IF position(v_old_line in v_new) = 0 THEN
    RAISE EXCEPTION 'process_tournament_rebuy: price guard not found, refusing to guess';
  END IF;
  v_new := replace(v_new, v_old_line, v_new_line);

  EXECUTE v_new;
END
$mig$;

-- ── Post-apply assertions ──────────────────────────────────────────────────
DO $post$
DECLARE d text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_create_tournament';
  IF position('CASE WHEN v_total > 0 THEN 1 ELSE 0 END' in d) = 0 THEN
    RAISE EXCEPTION 'fn_create_tournament did not take the minimum-fee change';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO d FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='process_tournament_rebuy';
  IF position('v_base := v_total - v_fee;' in d) = 0 THEN
    RAISE EXCEPTION 'process_tournament_rebuy did not take the cut-out change';
  END IF;
  IF position('v_legacy_total := v_total + round(v_total * v_legacy_ratio, 2);' in d) = 0 THEN
    RAISE EXCEPTION 'process_tournament_rebuy price guard was not updated';
  END IF;
  -- The seat-atomicity guard and the exact-grant assertion must survive.
  IF position('refusing to charge for chips that would be overwritten' in d) = 0
     OR position('Chip grant did not land' in d) = 0 THEN
    RAISE EXCEPTION 'process_tournament_rebuy lost a safety guard in the patch';
  END IF;
END
$post$;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════════
-- Re-run the same DO block with v_old_line and v_new_line swapped:
--   fn_create_tournament:      GREATEST(CASE WHEN v_total > 0 THEN 1 ELSE 0 END,  ->  GREATEST(0,
--   process_tournament_rebuy:  v_total := round(v_base::numeric); ... v_base := v_total - v_fee;
--                              ->  v_base := round(v_base::numeric,2); v_fee := round(v_base*v_ratio,2); v_total := v_base+v_fee;
--                              and restore the addon-only legacy price guard.
