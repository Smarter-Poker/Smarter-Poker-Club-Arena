-- THE BBJ SNAPSHOT ALERTS STOP STACKING UP.
--
-- 173 FeeReconciler.bbj_unlinkable and 79 bbj_drift alerts are open. They are
-- not 252 problems. Each is a DAILY SNAPSHOT of the same rolling 1-day window
-- ("[A5] 31.51 chips of BBJ contribution over the last 1d sit on 81
-- rake_records row(s) with NO hand_id..."), re-raised every run. Only the most
-- recent of each source describes the present; the rest are history that reads
-- as backlog, and 252 stale rows in a queue an operator scans by eye is how a
-- real alert gets missed.
--
-- THE MONEY IS NOT LOST, AND THAT MATTERS FOR THE SEVERITY. Over the last two
-- days rake_records booked 15,677.96 of BBJ contribution and the pool received
-- 15,700.56. Contributions ARE reaching the jackpot. What the null hand_id
-- costs is the ability to reconcile a specific contribution against a specific
-- hand — an audit-linkage defect, not a chip leak.
--
-- WHAT CANNOT BE REPAIRED, AND WHY. 4,063 rake_records rows carry a BBJ
-- contribution with no hand_id, worth 1,919.94 chips, oldest 2026-04-16.
-- Relinking is impossible: ZERO have a matching hand_history row on
-- (table_id, global_hand_id). For anything older than a week that is expected
-- and sanctioned — CLAUDE.md 10.5 records Dan's ruling that horse-only hands
-- are pruned after 7 days, and 99.95% of hands are horse-only. There is no hand
-- left to link to and there should not be.
--
-- The live residual is small and shrinking: 5 rows / 1.98 chips today, 3 / 1.38
-- yesterday, 1 / 0.50 on 08-25, all from atomic_distribute_rake, none with a
-- hand_history row despite being far too recent to have been pruned. THAT is
-- the real defect — logHandHistory returning a null id, exactly as the alert
-- says — and it lives in the engine, not in SQL. Left for that lane with the
-- numbers above rather than papered over here.
--
-- ROLLBACK
--   UPDATE financial_alerts SET resolved=false, resolved_at=NULL
--    WHERE id IN (SELECT alert_id FROM bbj_snapshot_alert_collapse_log);

CREATE TABLE IF NOT EXISTS public.bbj_snapshot_alert_collapse_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id     uuid NOT NULL UNIQUE,
  source       text NOT NULL,
  created_at   timestamptz NOT NULL,
  collapsed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.bbj_snapshot_alert_collapse_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bbj_snapshot_alert_collapse_log FROM PUBLIC;
GRANT SELECT ON public.bbj_snapshot_alert_collapse_log TO service_role;

WITH ranked AS (
  SELECT id, source, created_at,
         row_number() OVER (PARTITION BY source ORDER BY created_at DESC) AS rn
    FROM public.financial_alerts
   WHERE source IN ('FeeReconciler.bbj_unlinkable', 'FeeReconciler.bbj_drift')
     AND resolved IS NOT TRUE
),
superseded AS (SELECT id, source, created_at FROM ranked WHERE rn > 1)
INSERT INTO public.bbj_snapshot_alert_collapse_log (alert_id, source, created_at)
SELECT id, source, created_at FROM superseded
ON CONFLICT (alert_id) DO NOTHING;

UPDATE public.financial_alerts a
   SET resolved = true, resolved_at = now()
  FROM public.bbj_snapshot_alert_collapse_log l
 WHERE l.alert_id = a.id AND a.resolved IS NOT TRUE;

DO $post$
DECLARE v_left int; v_collapsed int;
BEGIN
  SELECT count(*) INTO v_left FROM public.financial_alerts
   WHERE source IN ('FeeReconciler.bbj_unlinkable','FeeReconciler.bbj_drift')
     AND resolved IS NOT TRUE;
  SELECT count(*) INTO v_collapsed FROM public.bbj_snapshot_alert_collapse_log;

  -- Exactly one live snapshot per source must survive. Zero would mean the
  -- current state is no longer reported at all, which is worse than the noise.
  IF v_left <> 2 THEN
    RAISE EXCEPTION 'expected 1 live snapshot per source (2 total), found %', v_left;
  END IF;
  IF v_collapsed = 0 THEN
    RAISE EXCEPTION 'nothing was collapsed; the dedupe did not run';
  END IF;
END
$post$;
