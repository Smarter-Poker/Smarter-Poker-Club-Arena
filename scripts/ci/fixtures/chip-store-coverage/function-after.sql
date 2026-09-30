CREATE OR REPLACE FUNCTION public.fn_ca_chip_store_coverage_gaps()
 RETURNS TABLE(store text, gap text, detail text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_allowed text[];
BEGIN
  /* The enumerated stores, read from the journal's own constraint, so the
     coverage list is checked against the real domain and not a copy of it. */
  SELECT array_agg(DISTINCT m[1]) INTO v_allowed
    FROM pg_constraint c,
         LATERAL regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''::text', 'g') m
   WHERE c.conrelid = 'public.chip_ledger'::regclass
     AND c.conname IN ('chip_ledger_from_type_check','chip_ledger_to_type_check');

  RETURN QUERY
  SELECT a.s, 'undeclared'::text,
         ('the chip journal accepts ' || a.s || ' but ca_chip_store_coverage does not say whether the supply basis counts it')::text
    FROM unnest(v_allowed) a(s)
   WHERE NOT EXISTS (SELECT 1 FROM public.ca_chip_store_coverage g WHERE g.store = a.s);

  RETURN QUERY
  WITH recent_store_pairs AS MATERIALIZED (
    SELECT l.from_type, l.to_type, sum(l.amount) AS amount
      FROM public.chip_ledger l
     WHERE l.created_at > now() - interval '24 hours'
       -- Keep the original NULL-sensitive exclusion exactly.
       AND NOT (l.category = 'correction'
                AND l.metadata ->> 'posted_via' = 'fn_ca_post_correction')
     GROUP BY l.from_type, l.to_type
  )
  SELECT g.store, 'uncounted store moved'::text,
         ('the supply basis does not count ' || g.store || ' and it moved '
          || round(x.net, 2)::text || ' in the last 24h, so that movement reads as drift')::text
    FROM public.ca_chip_store_coverage g
    JOIN LATERAL (
      SELECT COALESCE(sum(l.amount) FILTER (WHERE l.to_type = g.store), 0)
           - COALESCE(sum(l.amount) FILTER (WHERE l.from_type = g.store), 0) AS net
        FROM recent_store_pairs l
    ) x ON true
   WHERE g.treatment = 'uncounted' AND x.net <> 0;
END;
$function$
