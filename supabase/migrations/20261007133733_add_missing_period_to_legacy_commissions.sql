-- Add missing period_start and period_end to legacy commission payments
-- They were paid out in the week of Sep 28 but were missing the period boundaries required by the accounting statements.
BEGIN;
SET LOCAL app.ledger_maintenance = 'migration: legacy_commissions_missing_period';

WITH target AS (
  SELECT id, metadata->>'cutoff' AS cutoff
  FROM public.chip_ledger
  WHERE club_id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'
    AND status='posted'
    AND category IN ('rakeback','commission')
    AND created_at>='2026-09-28 07:00:00+00'
    AND created_at<'2026-10-06 07:00:00+00'
    AND (metadata->>'period_start' IS NULL OR metadata->>'period_end' IS NULL)
)
UPDATE public.chip_ledger l
SET metadata = metadata
  || jsonb_build_object('period_start', (t.cutoff::timestamptz - interval '7 days')::text)
  || jsonb_build_object('period_end', t.cutoff)
FROM target t
WHERE l.id = t.id;

COMMIT;
