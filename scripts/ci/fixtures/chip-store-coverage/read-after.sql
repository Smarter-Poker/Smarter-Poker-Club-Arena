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