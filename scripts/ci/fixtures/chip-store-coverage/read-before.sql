  RETURN QUERY
  SELECT g.store, 'uncounted store moved'::text,
         ('the supply basis does not count ' || g.store || ' and it moved '
          || round(x.net, 2)::text || ' in the last 24h, so that movement reads as drift')::text
    FROM public.ca_chip_store_coverage g
    JOIN LATERAL (
      SELECT COALESCE(sum(l.amount) FILTER (WHERE l.to_type = g.store), 0)
           - COALESCE(sum(l.amount) FILTER (WHERE l.from_type = g.store), 0) AS net
        FROM public.chip_ledger l
       WHERE l.created_at > now() - interval '24 hours'
         -- the supply basis excludes exactly these legs (fn_ca_supply_snapshot)
         AND NOT (l.category = 'correction'
                  AND l.metadata ->> 'posted_via' = 'fn_ca_post_correction')
    ) x ON true
   WHERE g.treatment = 'uncounted' AND x.net <> 0;