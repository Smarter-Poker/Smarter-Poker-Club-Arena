-- Only after a terminal interrupted original build of the exact reviewed
-- definition, with no active builder and unchanged source/owner/DDL admission.
-- Inspect durable state before this one maintained recovery. No blind retries.
REINDEX INDEX CONCURRENTLY public.idx_chip_ledger_reviewed_overlay_returns;
