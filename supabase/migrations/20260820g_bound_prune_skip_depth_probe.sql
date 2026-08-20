-- Mirror of the live catalog (applied 2026-08-20 via mcp apply_migration).
--
-- The first version of this probe was `count(*)` over every kept row past the
-- retention window. That is a full scan of a 10 GB table — it timed out at 60s
-- the first time it was called. A monitoring function that cannot be run is
-- worse than none, and it was measuring the wrong thing anyway.
--
-- What actually degrades is the DENSITY of permanently-kept rows at the HEAD of
-- idx_hand_history_created, because that is what sp_prune_hand_history filters
-- past on every pass. So measure exactly that, over a bounded window of the
-- head, and return a ratio that means something on its own.

-- The zero-arg version from 20260820f would otherwise make the call ambiguous
-- ("function ... is not unique") once this one has a DEFAULT.
DROP FUNCTION IF EXISTS public.fn_hand_history_prune_skip_depth();

CREATE OR REPLACE FUNCTION public.fn_hand_history_prune_skip_depth(p_sample integer DEFAULT 50000)
 RETURNS TABLE (sampled bigint, skipped bigint, skip_pct numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH head AS (
    SELECT has_human, reported
      FROM public.hand_history
     WHERE created_at < now() - interval '7 days'
     ORDER BY created_at
     LIMIT p_sample
  )
  SELECT count(*)::bigint,
         count(*) FILTER (WHERE has_human IS TRUE OR reported IS TRUE)::bigint,
         round(100.0 * count(*) FILTER (WHERE has_human IS TRUE OR reported IS TRUE)
               / NULLIF(count(*), 0), 3)
    FROM head;
$function$;

COMMENT ON FUNCTION public.fn_hand_history_prune_skip_depth(integer) IS
  'Density of permanently-kept rows (human or reported) at the head of idx_hand_history_created — the rows sp_prune_hand_history must filter past on every pass. Bounded to a sample of the head so it is always cheap. Near 0% is healthy. If it climbs toward 100% the pruner is walking a long dead prefix and the fix is: CREATE INDEX CONCURRENTLY idx_hand_history_unclassified ON hand_history (created_at) WHERE has_human IS NULL. Added 2026-08-20.';
