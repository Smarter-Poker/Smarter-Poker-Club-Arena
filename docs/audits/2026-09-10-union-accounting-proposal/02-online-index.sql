-- Run as one standalone statement after stage 1, outside any transaction.
-- Do not hide a previous INVALID index with IF NOT EXISTS. Inspect first.
CREATE UNIQUE INDEX CONCURRENTLY uq_agent_commissions_contributor
ON public.agent_commissions(user_id,source_id,source_type,contributing_user_id)
NULLS NOT DISTINCT WHERE source_id IS NOT NULL;
