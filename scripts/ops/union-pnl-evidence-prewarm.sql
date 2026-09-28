-- Read-only pre-warm for one union's P&L evidence (run just before its weekly
-- close, outside any transaction). Each statement is a plain SELECT capped at
-- 45 s; a cancelled one only means less was warmed. It moves nothing.
--   psql "$DB" -v union=fade0000-0000-0000-0000-000000000001 \
--     -v start='2026-09-21 07:00+00' -v end='2026-09-28 07:00+00' -f scripts/ops/union-pnl-evidence-prewarm.sql
SET statement_timeout = '45s';
SET default_transaction_read_only = on;
-- the week's hands (the one outcome pass)
SELECT count(*), sum(length(o.evidence::text)) FROM public.union_pnl_cash_outcomes o
 WHERE o.game_scope->>'game_union_id'=:'union' AND o.recognized_at>=:'start' AND o.recognized_at<:'end';
-- tournament credits and their frames (returns, award owners)
SELECT count(*) FROM public.tournament_accounting_credit_receipts c
 JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
 WHERE c.tournament_snapshot->>'union_id'=:'union' AND b.observed_at<:'end';
-- the week's original flows
SELECT count(*), sum(length(q.ledger_snapshot::text)) FROM public.union_pnl_original_flows q
 WHERE q.game_scope->>'game_union_id'=:'union' AND q.recognized_at>=:'start' AND q.recognized_at<:'end';
