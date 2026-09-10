CREATE OR REPLACE FUNCTION public.fn_allocate_rake_credits(p_amount numeric, p_contributions jsonb, p_method text DEFAULT 'WEIGHTED_CONTRIBUTED'::text)
 RETURNS TABLE(user_id uuid, credit numeric, weight numeric)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH c AS (
    SELECT (k.key)::uuid AS uid,
           round((k.value)::numeric * 100)::bigint AS cc
      FROM jsonb_each(COALESCE(p_contributions, '{}'::jsonb)) k
     WHERE jsonb_typeof(k.value) = 'number'
       AND (k.value)::numeric > 0
       AND k.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ),
  t AS (
    SELECT COALESCE(SUM(cc), 0)::bigint AS total,
           round(GREATEST(COALESCE(p_amount, 0), 0) * 100)::bigint AS amt,
           COUNT(*)::bigint AS n
      FROM c
  ),
  weighted AS (
    SELECT c.uid, c.cc,
           (t.amt * c.cc) / t.total AS fl,
           (t.amt * c.cc) % t.total AS rem,
           t.amt, t.total
      FROM c CROSS JOIN t
     WHERE t.total > 0
  ),
  weighted_ranked AS (
    SELECT w.*,
           row_number() OVER (ORDER BY w.rem DESC, w.uid ASC) AS rn,
           SUM(w.fl) OVER () AS fl_sum
      FROM weighted w
  ),
  equal_ranked AS (
    SELECT c.uid, c.cc, t.amt, t.total, t.n,
           row_number() OVER (ORDER BY c.uid ASC) AS rn
      FROM c CROSS JOIN t
     WHERE t.n > 0
  )
  SELECT uid,
         ((fl + CASE WHEN rn <= (amt - fl_sum) THEN 1 ELSE 0 END)::numeric / 100),
         round(cc::numeric / total, 8)
    FROM weighted_ranked
   WHERE COALESCE(p_method, 'WEIGHTED_CONTRIBUTED') = 'WEIGHTED_CONTRIBUTED'
  UNION ALL
  SELECT uid,
         (((amt / n) + CASE WHEN rn <= (amt % n) THEN 1 ELSE 0 END)::numeric / 100),
         round(cc::numeric / total, 8)
    FROM equal_ranked
   WHERE COALESCE(p_method, 'WEIGHTED_CONTRIBUTED') = 'DEALT_EQUAL';
$function$;
