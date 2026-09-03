-- ═══════════════════════════════════════════════════════════════════════════════
--  THE FREE BUY LOG RECORDS THE WHOLE BACKFILL (2026-09-02)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Follow-up to 20260902183602_freerolls_are_free_buy, found by reading the log
-- it wrote. That migration's backfill UPDATE set is_rebuy, add_on_available,
-- rebuy_cost and addon_cost to their compliant values DIRECTLY, so by the time
-- fn_freerolls_are_free_buy saw NEW those four columns were already right and
-- it logged only what IT still had to fill (chips and windows). Result: 28 rows
-- were rewritten, 9 log rows were written. The other 19 - the ones whose only
-- defect was the free add-on (addon_cost 0.00 -> 1.00) - left no trace in
-- ca_freeroll_free_buy_log.
--
-- They did leave a trace: fn_capture_managed_game_contract recorded every one
-- as a 'system_revision' in managed_game_contract_versions, all 28 stamped
-- with the backfill transaction's single published_at. This migration derives
-- the column-by-column diff from those revisions (version N-1 -> N) and
-- reconciles the log: the 9 existing BACKFILL rows are extended with the
-- columns the UPDATE itself changed, and the 19 missing rows are inserted.
--
-- DML only. No DDL, so no PostgREST schema reload.
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

WITH backfill AS (
  SELECT v.game_id, v.version, v.contract AS new_c, v.published_at
    FROM public.managed_game_contract_versions v
    JOIN public.tournaments t ON t.id = v.game_id
   WHERE v.game_kind = 'tournament'
     AND v.change_reason = 'system_revision'
     AND v.published_at = (
           -- The backfill transaction: the single instant at which the first
           -- BACKFILL log rows were written.
           SELECT min(created_at) FROM public.ca_freeroll_free_buy_log WHERE op = 'BACKFILL'
         )
     AND public.fn_is_free_buy_event(t.buy_in_amount, t.buy_in_fee, t.tournament_type, t.variant)
), diffs AS (
  SELECT b.game_id,
         (SELECT jsonb_object_agg(k, jsonb_build_object('from', p.contract -> k, 'to', b.new_c -> k))
            FROM unnest(ARRAY['is_rebuy','add_on_available','rebuy_cost','addon_cost',
                              'rebuy_chips','addon_chips','rebuy_levels','addon_levels',
                              'max_rebuys','buy_in_fee']) k
           WHERE (p.contract -> k) IS DISTINCT FROM (b.new_c -> k)) AS changed
    FROM backfill b
    JOIN public.managed_game_contract_versions p
      ON p.game_kind = 'tournament' AND p.game_id = b.game_id AND p.version = b.version - 1
), extended AS (
  UPDATE public.ca_freeroll_free_buy_log l
     SET changed = d.changed || l.changed
    FROM diffs d
   WHERE l.tournament_id = d.game_id
     AND l.op = 'BACKFILL'
     AND d.changed IS NOT NULL
  RETURNING l.tournament_id
)
INSERT INTO public.ca_freeroll_free_buy_log (tournament_id, tournament_name, op, status, changed, created_at)
SELECT d.game_id, t.name, 'BACKFILL', t.status, d.changed,
       (SELECT min(created_at) FROM public.ca_freeroll_free_buy_log WHERE op = 'BACKFILL')
  FROM diffs d
  JOIN public.tournaments t ON t.id = d.game_id
 WHERE d.changed IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM extended e WHERE e.tournament_id = d.game_id)
   AND NOT EXISTS (
         SELECT 1 FROM public.ca_freeroll_free_buy_log l
          WHERE l.tournament_id = d.game_id AND l.op = 'BACKFILL'
       );

-- Post-apply assertion: every not-started freeroll the backfill rewrote has a
-- BACKFILL row, and every BACKFILL row names the add-on price it corrected.
DO $$
DECLARE
  v_missing integer;
BEGIN
  SELECT count(*) INTO v_missing
    FROM public.managed_game_contract_versions v
    JOIN public.tournaments t ON t.id = v.game_id
   WHERE v.game_kind = 'tournament'
     AND v.change_reason = 'system_revision'
     AND v.published_at = (SELECT min(created_at) FROM public.ca_freeroll_free_buy_log WHERE op = 'BACKFILL')
     AND public.fn_is_free_buy_event(t.buy_in_amount, t.buy_in_fee, t.tournament_type, t.variant)
     AND NOT EXISTS (
           SELECT 1 FROM public.ca_freeroll_free_buy_log l
            WHERE l.tournament_id = v.game_id AND l.op = 'BACKFILL'
              AND l.changed ? 'addon_cost'
         );
  IF v_missing <> 0 THEN
    RAISE EXCEPTION 'free_buy_log: % backfilled freeroll(s) still have no BACKFILL log row naming addon_cost', v_missing;
  END IF;
END $$;

COMMIT;
