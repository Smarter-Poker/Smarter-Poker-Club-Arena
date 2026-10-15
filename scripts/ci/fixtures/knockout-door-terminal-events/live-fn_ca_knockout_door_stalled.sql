CREATE OR REPLACE FUNCTION public.fn_ca_knockout_door_stalled(p_stall_minutes integer DEFAULT 15)
 RETURNS TABLE(last_resolved_at timestamp with time zone, stalled_minutes numeric, pending_candidates bigint, pending_past_prompt bigint, oldest_expired_prompt_minutes numeric, detail text)
 LANGUAGE sql
 STABLE
AS $function$
  WITH k AS (
    SELECT max(resolved_at) AS last_resolved_at,
           count(*) FILTER (WHERE resolved_at IS NULL) AS pending,
           count(*) FILTER (WHERE resolved_at IS NULL
                              AND (rebuy_prompt_until IS NULL
                                   OR rebuy_prompt_until < now())) AS past_prompt,
           min(COALESCE(rebuy_prompt_until, created_at))
             FILTER (WHERE resolved_at IS NULL
                       AND (rebuy_prompt_until IS NULL
                            OR rebuy_prompt_until < now())) AS oldest_prompt
      FROM public.tournament_knockout_candidates
  )
  SELECT k.last_resolved_at,
         round((extract(epoch FROM (now() - k.last_resolved_at)) / 60.0)::numeric, 1),
         k.pending, k.past_prompt,
         round((extract(epoch FROM (now() - k.oldest_prompt)) / 60.0)::numeric, 1),
         'the knockout door has not resolved a single candidate for '
           || round((extract(epoch FROM (now() - k.last_resolved_at)) / 60.0)::numeric, 1)
           || ' minute(s) while ' || k.past_prompt
           || ' candidate(s) are waiting with no open rebuy decision, '
           || 'the oldest for '
           || round((extract(epoch FROM (now() - k.oldest_prompt)) / 60.0)::numeric, 1)
           || ' minute(s). Healthy is a gap of 2.04s (p50) and 19.19s (p99): '
           || 'this is not a quiet door, it is a stopped one, and every player '
           || 'behind it is neither eliminated nor allowed to rebuy'
    FROM k
   WHERE k.past_prompt > 0
     AND (k.last_resolved_at IS NULL
          OR k.last_resolved_at < now() - make_interval(mins => GREATEST(p_stall_minutes, 1)))
$function$
