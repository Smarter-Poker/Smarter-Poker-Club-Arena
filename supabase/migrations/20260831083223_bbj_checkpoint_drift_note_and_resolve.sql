-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831083223; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- The one alert left over from the sweep: fn_bbj_contributions_total_verify
-- reported drift -0.50, and two reads two seconds apart now both report 0.00
-- on 772,072 rows.
--
-- The cause is not a race and not a leak, and it is worth writing down rather
-- than silencing: fn_bbj_repair_unbanked BACKDATES the contributions it heals
-- (created_at = the original hand's timestamp). The checkpoint folds forward
-- from its own as_of, so a row healed into a window the checkpoint has
-- already passed is invisible to the fold but present in the recompute — the
-- verify sees the difference exactly once, re-checkpoints to truth in the
-- same call, and the next run reads zero.
--
-- The check is therefore RIGHT and is left exactly as it is. It caught real
-- drift on 2026-08-21 (-8.46) and would catch it again. This resolves the one
-- stale row, gated on the drift actually being zero, and records the
-- interaction so the next reader does not mistake a heal for a leak.
UPDATE public.financial_alerts
   SET resolved = true, resolved_at = now(),
       context = COALESCE(context, '{}'::jsonb) || jsonb_build_object(
         'resolution', 'drift verified 0.00 twice, two seconds apart, over 772,072 rows on 2026-08-31. Expected shape: fn_bbj_repair_unbanked backdates healed contributions to their hand time, so a heal behind the checkpoint as_of shows as one-shot drift and re-checkpoints itself. Check left unchanged.')
 WHERE source = 'fn_bbj_contributions_total_verify'
   AND resolved IS NOT TRUE
   AND (SELECT (fn_bbj_contributions_total_verify()->>'drift')::numeric) = 0;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.financial_alerts
              WHERE source='fn_bbj_contributions_total_verify' AND resolved IS NOT TRUE) THEN
    RAISE EXCEPTION 'checkpoint alert still open — drift is not actually zero';
  END IF;
END $$;

