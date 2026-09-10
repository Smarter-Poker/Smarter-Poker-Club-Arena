-- a_finished_event_holds_no_pending_bust
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- 199 knockout candidates across 120 COMPLETED or CANCELLED events are still
-- marked `pending`. They are the residue of the refusals fixed today: the door
-- would not record a bust whose bounty could not be settled, the event finished
-- another way, and the candidate row was left saying the bust was still waiting
-- to be judged.
--
-- THE MONEY IS SETTLED, and that is checked here rather than assumed. Across
-- all 199, measured before this migration was written:
--
--   * 194 of the players are `eliminated` and HAVE a finishing place;
--   * the other 5 went on to WIN their event - they busted, rebought, and came
--     back, which is exactly what the `rebought` state exists to say;
--   * ZERO are still `playing`;
--   * ZERO have no finishing place;
--   * and ZERO of the 120 events has an unpaid chip of bounty pool -
--     bounty_pool_paid equals bounty_pool in every one of them.
--
-- So nobody is short. Where a head could not be attributed to a knocker,
-- fn_finalize_bounty_pool distributed it as RESIDUAL to the event winner with a
-- completion receipt, which is the designed outcome for an uncollected head.
-- The knockers who earned those heads received their share of the pool through
-- the winner rather than directly. Reversing that now would take chips back
-- from the winners of finished events for a defect of ours, which CLAUDE.md
-- 10.9 forbids, and paying the knockers again would pay the same chips twice.
-- Settled, audited, and left alone.
--
-- What is corrected is only the bookkeeping: a finished event must not hold a
-- bust that reads as still waiting. A stale `pending` row is a false signal for
-- every future reader - the absent-player check, the conservation sweep, the
-- next agent - and it is the kind of noise that teaches people to scroll past
-- a real one.
--
-- Bounded and self-proving: only finished events, only candidates whose player
-- is provably resolved, and the state written is the TRUE one in each case
-- (`eliminated` for a player who has a place, `rebought` for one who won). If
-- any candidate does not fit either shape, nothing is written at all.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $body$
DECLARE
  v_total integer;
  v_placed integer;
  v_won integer;
  v_unsafe integer;
  v_unpaid integer;
  v_elim integer;
  v_reb integer;
  v_left integer;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE p.status = 'eliminated' AND p.position IS NOT NULL),
         count(*) FILTER (WHERE p.status = 'winner'),
         count(*) FILTER (WHERE p.user_id IS NULL OR p.status = 'playing' OR (p.status <> 'winner' AND p.position IS NULL))
    INTO v_total, v_placed, v_won, v_unsafe
    FROM public.tournament_knockout_candidates c
    JOIN public.tournaments t ON t.id = c.tournament_id
    LEFT JOIN public.tournament_players p
      ON p.tournament_id = c.tournament_id AND p.user_id = c.eliminated_user_id
   WHERE c.state = 'pending' AND t.status IN ('COMPLETED', 'CANCELLED');

  IF v_total = 0 THEN
    RAISE EXCEPTION 'no finished event holds a pending bust; this migration had nothing to do';
  END IF;
  IF v_unsafe <> 0 THEN
    RAISE EXCEPTION '% pending candidate(s) in finished events belong to a player who is not resolved; refusing to touch any of them', v_unsafe;
  END IF;
  IF v_placed + v_won <> v_total THEN
    RAISE EXCEPTION 'candidate shapes do not account for every row (% placed + % winner <> % total)', v_placed, v_won, v_total;
  END IF;

  -- every one of these events paid its bounty pool out to the last chip
  SELECT count(*) INTO v_unpaid FROM (
    SELECT DISTINCT t.id
      FROM public.tournament_knockout_candidates c
      JOIN public.tournaments t ON t.id = c.tournament_id
     WHERE c.state = 'pending' AND t.status IN ('COMPLETED', 'CANCELLED')
       AND COALESCE(t.bounty_pool, 0) <> COALESCE(t.bounty_pool_paid, 0)) q;
  IF v_unpaid <> 0 THEN
    RAISE EXCEPTION '% finished event(s) still hold an unpaid bounty pool; the money is NOT settled and nothing here may be tidied away', v_unpaid;
  END IF;

  -- a player who has a finishing place stayed busted
  UPDATE public.tournament_knockout_candidates c
     SET state = 'eliminated', resolved_at = COALESCE(c.resolved_at, now())
    FROM public.tournaments t, public.tournament_players p
   WHERE t.id = c.tournament_id AND t.status IN ('COMPLETED', 'CANCELLED')
     AND p.tournament_id = c.tournament_id AND p.user_id = c.eliminated_user_id
     AND c.state = 'pending'
     AND p.status = 'eliminated' AND p.position IS NOT NULL;
  GET DIAGNOSTICS v_elim = ROW_COUNT;

  -- a player who went on to WIN came back from this bust
  UPDATE public.tournament_knockout_candidates c
     SET state = 'rebought', resolved_at = COALESCE(c.resolved_at, now())
    FROM public.tournaments t, public.tournament_players p
   WHERE t.id = c.tournament_id AND t.status IN ('COMPLETED', 'CANCELLED')
     AND p.tournament_id = c.tournament_id AND p.user_id = c.eliminated_user_id
     AND c.state = 'pending'
     AND p.status = 'winner';
  GET DIAGNOSTICS v_reb = ROW_COUNT;

  IF v_elim + v_reb <> v_total THEN
    RAISE EXCEPTION 'resolved % of % pending candidate(s); discarding rather than leaving the set half corrected', v_elim + v_reb, v_total;
  END IF;

  SELECT count(*) INTO v_left
    FROM public.tournament_knockout_candidates c
    JOIN public.tournaments t ON t.id = c.tournament_id
   WHERE c.state = 'pending' AND t.status IN ('COMPLETED', 'CANCELLED');
  IF v_left <> 0 THEN
    RAISE EXCEPTION '% pending bust(s) remain in finished events', v_left;
  END IF;

  RAISE NOTICE 'resolved % stale pending bust(s): % stayed busted, % came back and won', v_total, v_elim, v_reb;
END
$body$;

COMMIT;
