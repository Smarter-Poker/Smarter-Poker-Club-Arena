-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260506011322 "normalize_memory_charts_to_object_format"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 6f23ad1a90aaef26fd79f2156896e439 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

BEGIN;

-- Helper: convert string value ("shove", "fold", "shoveNN") to {push, fold} object
CREATE OR REPLACE FUNCTION fn_normalize_chart_value(v TEXT) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  pct numeric;
BEGIN
  IF v IS NULL THEN RETURN NULL; END IF;
  IF v = 'shove' OR v = 'push' THEN RETURN '{"push": 1, "fold": 0}'::jsonb; END IF;
  IF v = 'fold' THEN RETURN '{"push": 0, "fold": 1}'::jsonb; END IF;
  IF v ~ '^shove(\d+)$' THEN
    pct := (regexp_match(v, '^shove(\d+)$'))[1]::numeric / 100.0;
    RETURN jsonb_build_object('push', pct, 'fold', 1 - pct);
  END IF;
  -- Already object or unknown — return as-is JSON if parseable
  BEGIN
    RETURN v::jsonb;
  EXCEPTION WHEN others THEN
    RETURN '{"push": 0, "fold": 1}'::jsonb;
  END;
END;
$$;

-- Normalize string-format shells to object-format
UPDATE memory_charts_gold
SET hand_matrix = (
  SELECT jsonb_object_agg(k, fn_normalize_chart_value(v))
  FROM jsonb_each_text(hand_matrix) AS x(k, v)
)
WHERE EXISTS (
  SELECT 1 FROM jsonb_each_text(hand_matrix) AS y(k2, v2)
  WHERE v2 NOT LIKE '{%}' LIMIT 1
);

COMMIT;
