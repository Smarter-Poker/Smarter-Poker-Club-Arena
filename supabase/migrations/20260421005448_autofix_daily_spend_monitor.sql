-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260421005448 "autofix_daily_spend_monitor"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 7269c1dbd994d36cd81cdc9e871c9aff of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Per-day autofix spend monitor (USD). Uses Haiku 4.5 pricing as the
-- default floor ($1/MTok input, $5/MTok output). If a future run sets a
-- non-default ANTHROPIC_MODEL, the real cost may be higher — this is a
-- conservative lower-bound meant as a circuit-breaker.
CREATE OR REPLACE FUNCTION public.autofix_daily_spend_usd(p_day date DEFAULT (now() AT TIME ZONE 'UTC')::date)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    ROUND(
      SUM(COALESCE(claude_tokens_in, 0))::numeric  / 1000000 * 1.0
      + SUM(COALESCE(claude_tokens_out, 0))::numeric / 1000000 * 5.0
    , 4), 0
  )
  FROM public.autofix_attempts
  WHERE (created_at AT TIME ZONE 'UTC')::date = p_day
    AND claude_tokens_in IS NOT NULL;
$$;

COMMENT ON FUNCTION public.autofix_daily_spend_usd(date) IS
  'Approximate autofix Claude API spend in USD for a given UTC day, assuming Haiku 4.5 pricing ($1/$5 per MTok). Use as a circuit-breaker: if value > $1.60, halt new dispatches to stay under $50/month.';

-- Budget-remaining view for the poller to consult (<$50/mo = <$1.60/day target).
CREATE OR REPLACE FUNCTION public.autofix_budget_exhausted(p_daily_cap_usd numeric DEFAULT 1.60)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT public.autofix_daily_spend_usd() >= p_daily_cap_usd;
$$;

COMMENT ON FUNCTION public.autofix_budget_exhausted(numeric) IS
  'Returns true if today''s autofix spend has hit the daily cap. Default cap $1.60/day ≈ $48/month.';
