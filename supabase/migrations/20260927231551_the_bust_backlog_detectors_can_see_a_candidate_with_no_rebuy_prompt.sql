-- THE DETECTOR WAS BLIND TO EXACTLY THIS BACKLOG (2026-09-27).
--
-- `fn_ca_knockout_door_stalled` counts a waiting candidate only when
-- `rebuy_prompt_until < now()`. 696 of the 697 candidates stranded by tonight's
-- incident carry `rebuy_prompt_until IS NULL` -- the manager died before it
-- ever wrote a prompt -- and NULL is never `< now()`, so `past_prompt` read 1
-- and the detector stayed silent for 37 hours while three events sat dead.
-- A NULL prompt is not an open rebuy decision: `fn_ca_release_broke_seats`
-- already reads it as "nobody was offered anything"
-- (`rebuy_prompt_until IS NULL OR rebuy_prompt_until <= now()`), and the
-- knockout door itself only defers while a prompt is NOT NULL and in future.
CREATE OR REPLACE FUNCTION public.fn_ca_knockout_door_stalled(p_stall_minutes integer DEFAULT 15)
-- The signature, its DEFAULT and the OUT names the money board reads are
-- unchanged; only what counts as "waiting with no open rebuy decision" widens.
RETURNS TABLE (
  last_resolved_at              timestamptz,
  stalled_minutes               numeric,
  pending_candidates            bigint,
  pending_past_prompt           bigint,
  oldest_expired_prompt_minutes numeric,
  detail                        text
)
LANGUAGE sql
STABLE
AS $fn$
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
$fn$;

-- A GLOBAL DOOR THAT KEEPS RESOLVING HIDES A SINGLE EVENT THAT CANNOT.
--
-- The global detector above only fires when the door resolves NOTHING
-- anywhere. Through this whole incident it kept resolving -- the last one
-- 5.7 seconds before the outage was diagnosed -- because hundreds of healthy
-- spins were draining normally. The events that were dead had their own
-- backlog and no alarm. This names them, per event, which is the shape the
-- F06 stall actually takes.
CREATE OR REPLACE FUNCTION public.fn_ca_bust_backlog_stalled(p_minutes integer DEFAULT 20)
RETURNS TABLE (
  tournament_id    uuid,
  tournament_name  text,
  variant          text,
  backlog          bigint,
  oldest_mins      numeric,
  last_hand_at     timestamptz,
  minutes_no_hand  numeric,
  message          text
)
LANGUAGE sql
STABLE
AS $fn$
  WITH latest AS (
    SELECT DISTINCT ON (c.tournament_id, c.eliminated_user_id)
           c.tournament_id, c.eliminated_user_id, c.state, c.resolved_at, c.created_at
      FROM public.tournament_knockout_candidates c
      JOIN public.tournaments t ON t.id = c.tournament_id AND t.status = 'RUNNING'
     ORDER BY c.tournament_id, c.eliminated_user_id, c.hand_number DESC, c.id DESC
  ), b AS (
    SELECT l.tournament_id, count(*) AS backlog, min(l.created_at) AS oldest
      FROM latest l
     WHERE l.state = 'pending' AND l.resolved_at IS NULL
       AND l.created_at < now() - make_interval(mins => GREATEST(p_minutes, 1))
     GROUP BY l.tournament_id
  )
  SELECT b.tournament_id, t.name, t.variant, b.backlog,
         round((extract(epoch FROM (now() - b.oldest)) / 60.0)::numeric, 1),
         h.last_hand_at,
         round((extract(epoch FROM (now() - h.last_hand_at)) / 60.0)::numeric, 1),
         b.backlog || ' busted player(s) in "' || t.name || '" have been waiting to be '
           || 'recorded for more than ' || round((extract(epoch FROM (now() - b.oldest)) / 60.0)::numeric, 1)
           || ' minute(s). Until each is recorded out, its chair still reads '
           || 'playing at zero chips, so smarter_private.f06_movement_prior '
           || 'refuses the table''s movement proof (F06_MOVEMENT_ELIMINATION_UNPROVEN) '
           || 'and no table of this event can break.'
    FROM b
    JOIN public.tournaments t ON t.id = b.tournament_id
    LEFT JOIN LATERAL (
      SELECT max(hh.created_at) AS last_hand_at
        FROM public.hand_history hh
        JOIN public.tables tb ON tb.id = hh.table_id
       WHERE tb.tournament_id = b.tournament_id) h ON true
   ORDER BY b.backlog DESC
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_bust_backlog_stalled(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_ca_bust_backlog_stalled(integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_bust_backlog_stalled(integer) TO service_role;
