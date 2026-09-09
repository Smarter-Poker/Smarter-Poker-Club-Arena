-- 20260909005925_a_busted_player_without_a_seat_can_still_be_eliminated.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  THE ELIMINATION SWEEP COULD NOT REACH THE TABLE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Measured on production 2026-09-09, 00:45 UTC. 285 of 390 RUNNING tournaments
-- had not dealt a hand in over twenty minutes and ZERO had completed in twelve
-- minutes, on a platform that normally finishes hundreds an hour. 1,378
-- knockout candidates sat `pending`, 907 of them older than two hours, while
-- 1,252 `tournament_players` rows read `status='playing'` with zero chips and
-- no seat. The engine's own detector said it out loud 433 times in fifteen
-- minutes: "<name> has held seat N at 0 chips for 120s in tournament <id> and
-- is still 'playing' - the elimination sweep is not reaching this table."
--
-- No human was in any of them - every seat was a horse - and no money moved
-- wrongly: `fn_unaccounted_seat_exits()` returned zero rows for all time and no
-- wallet went negative. What was lost was the ability of a tournament to END.
--
-- TWO OF THE FOUR CAUSES ARE IN THIS FUNCTION. (The other two are in the engine
-- and ship beside this migration: the rebuy-decision RPC was handed the whole
-- busted list instead of the batch, and one refused player aborted the pass for
-- everyone behind him on every five-second sweep, for ever.)
--
--   1. `multiple_pending_knockout_generations` refused permanently whenever a
--      player held more than one pending candidate. The unique constraint is
--      (tournament_id, eliminated_user_id, seat_joined_at), so two pending rows
--      are two seat GENERATIONS - a rebuy - and the older one is settled by
--      definition. Refusing left the player unkillable. 143 rows, 13 events.
--
--   2. `knockout_generation_is_not_current` compared the candidate's
--      `seat_joined_at` against `max(table_seats.joined_at)` for the player. A
--      busted player's chair is released immediately (Dan 2026-08-30) and reused
--      in place by the next occupant, so that max is NULL - and
--      `x IS DISTINCT FROM NULL` is TRUE. Every player whose chair was already
--      gone was refused for ever. The guard is right when a current seat exists;
--      it has nothing to compare against when one does not.
--
-- Everything else in this function is byte-identical to
-- 20260908042100_an_accepted_hand_is_one_commit_and_stats_leave_the_hot_path.sql.
--
-- GRANTS ARE UNCHANGED AND RESTATED: the live ACL is postgres + service_role
-- only, no browser role, and CREATE OR REPLACE preserves it. The REVOKE below
-- is belt and braces against a future default-privileges change; it must never
-- gain `authenticated` or `anon` (club-arena CLAUDE.md, definer authorization).
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_eliminate_tournament_player_atomic(
  p_tournament_id uuid,
  p_user_id uuid,
  p_position integer,
  p_prize numeric,
  p_bubble_refund numeric DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_player public.tournament_players%ROWTYPE;
  v_candidate public.tournament_knockout_candidates%ROWTYPE;
  v_pending_count integer;
  v_latest_joined_at timestamptz;
  v_legacy_hand_number bigint;
  v_result jsonb;
BEGIN
  -- Match the canonical tournament -> player -> candidate/seat lock order.
  PERFORM 1 FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  SELECT * INTO v_player
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','player_not_found');
  END IF;

  PERFORM 1
    FROM public.tournament_knockout_candidates c
   WHERE c.tournament_id=p_tournament_id
     AND c.eliminated_user_id=p_user_id
     AND c.state='pending'
   ORDER BY c.hand_number
   FOR UPDATE;
  SELECT count(*) INTO v_pending_count
    FROM public.tournament_knockout_candidates c
   WHERE c.tournament_id=p_tournament_id
     AND c.eliminated_user_id=p_user_id
     AND c.state='pending';
  -- MORE THAN ONE PENDING GENERATION IS A REBUY, NOT AN AMBIGUITY (2026-09-09).
  -- The unique constraint is (tournament_id, eliminated_user_id, seat_joined_at),
  -- so two pending rows for one player are two DIFFERENT seat generations: the
  -- player busted, bought back in, took a new chair and busted again. The older
  -- generation is therefore settled by definition - it is what 'rebought' means -
  -- and only the newest can be the operative knockout. Refusing instead left the
  -- player 'playing' at zero chips for ever, invisible to the seating self-heal
  -- (which skips zero-chip entrants on purpose) and blocking the field count from
  -- ever reaching one. Measured 2026-09-09: 143 rows across 13 live tournaments.
  IF v_pending_count>1 THEN
    UPDATE public.tournament_knockout_candidates c
       SET state='rebought',resolved_at=coalesce(c.resolved_at,clock_timestamp())
     WHERE c.tournament_id=p_tournament_id
       AND c.eliminated_user_id=p_user_id
       AND c.state='pending'
       AND c.seat_joined_at IS DISTINCT FROM (
         SELECT max(c2.seat_joined_at)
           FROM public.tournament_knockout_candidates c2
          WHERE c2.tournament_id=p_tournament_id
            AND c2.eliminated_user_id=p_user_id
            AND c2.state='pending');
  END IF;

  SELECT * INTO v_candidate
    FROM public.tournament_knockout_candidates c
   WHERE c.tournament_id=p_tournament_id
     AND c.eliminated_user_id=p_user_id
     AND c.state IN ('pending','eliminated')
   ORDER BY (c.state='pending') DESC,c.hand_number DESC
   LIMIT 1
   FOR UPDATE;

  SELECT max(s.joined_at) INTO v_latest_joined_at
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id=s.table_id
   WHERE tb.tournament_id=p_tournament_id AND s.user_id=p_user_id;

  IF v_candidate.id IS NOT NULL THEN
    -- A PLAYER WITH NO SEAT AT ALL IS NOT ON A STALE GENERATION (2026-09-09).
    -- This check exists so an OLD candidate cannot eliminate a player who has
    -- since re-entered and taken a new chair. That hazard needs a current seat
    -- to exist. When the player holds no seat row in this tournament,
    -- v_latest_joined_at is NULL, `seat_joined_at IS DISTINCT FROM NULL` is TRUE,
    -- and the elimination was refused for ever - even though "the chair is gone"
    -- is the ordinary end state of a bust: the seat is released immediately
    -- (Dan 2026-08-30) and is reused in place by the next occupant.
    -- Compare generations only when there IS a generation to compare against.
    IF v_latest_joined_at IS NOT NULL
       AND v_candidate.seat_joined_at IS DISTINCT FROM v_latest_joined_at THEN
      RETURN jsonb_build_object('ok',false,'reason','knockout_generation_is_not_current');
    END IF;
    IF v_candidate.state='pending'
       AND v_candidate.rebuy_prompt_until IS NOT NULL
       AND v_candidate.rebuy_prompt_until>clock_timestamp() THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','rebuy_decision_open',
        'rebuy_prompt_until',v_candidate.rebuy_prompt_until);
    END IF;
  ELSIF v_player.status='playing' THEN
    -- Old pods wrote a successful stack receipt but no atomic receipt. Permit
    -- only that precisely identifiable rolling-upgrade case. A new atomic hand
    -- with no candidate is never silently downgraded to legacy authority.
    SELECT (k.result->>'hand_number')::bigint
      INTO v_legacy_hand_number
      FROM public.settlement_idempotency_keys k
     WHERE k.table_id=v_player.table_id
       AND k.status='succeeded'
       AND k.completed_at>=v_latest_joined_at
       AND coalesce(k.result->>'hand_number','') ~ '^[0-9]+$'
       AND k.result->>'table_id'=v_player.table_id::text
       AND k.result->'written' ? p_user_id::text
       AND coalesce(k.result->'written'->>p_user_id::text,'') ~ '^-?[0-9]+([.][0-9]+)?$'
       AND (k.result->'written'->>p_user_id::text)::numeric<=0
     ORDER BY k.completed_at DESC
     LIMIT 1;
    IF v_legacy_hand_number IS NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','knockout_evidence_not_found');
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.hand_atomic_commits c
       WHERE c.table_id=v_player.table_id AND c.hand_number=v_legacy_hand_number
    ) THEN
      RETURN jsonb_build_object('ok',false,'reason','atomic_knockout_candidate_missing');
    END IF;
  END IF;

  v_result := public.fn_eliminate_player_legacy_candidate_20260907(
    p_tournament_id,p_user_id,p_position,p_prize,p_bubble_refund);
  IF coalesce((v_result->>'ok')::boolean,false) AND v_candidate.id IS NOT NULL THEN
    UPDATE public.tournament_knockout_candidates c
       SET state='eliminated',resolved_at=coalesce(c.resolved_at,clock_timestamp())
     WHERE c.id=v_candidate.id AND c.state IN ('pending','eliminated');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'knockout generation changed while elimination committed'
        USING ERRCODE='serialization_failure';
    END IF;
  END IF;
  RETURN v_result;
END;
$function$;

-- NOBODY IN A BROWSER CALLS THIS. It is the engine's elimination writer: it
-- assigns a finishing place and pays a prize, and the actor is the engine, never
-- a player. PUBLIC is named alongside the two browser roles on purpose -
-- revoking a role while PUBLIC still holds the grant reads as a fix and does
-- nothing (club-arena CLAUDE.md, definer authorization).
REVOKE ALL ON FUNCTION public.fn_eliminate_tournament_player_atomic(
  uuid, uuid, integer, numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_eliminate_tournament_player_atomic(
  uuid, uuid, integer, numeric, numeric) TO service_role;

COMMIT;
