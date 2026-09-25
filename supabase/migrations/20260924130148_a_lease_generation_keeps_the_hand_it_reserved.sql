-- 20260924130148_a_lease_generation_keeps_the_hand_it_reserved
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-24 13:01:48 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- THE HAND A DEAD GENERATION TOOK WITH IT
--
-- THE REPORT. 423 tournaments sit RUNNING with started_at more than 24 hours
-- old, holding 3,138 open table_seats across 863 players, and none has dealt a
-- hand in days. Every tournament recovery job on the database is scheduled and
-- succeeding, and all of them run past these 423 without seeing one.
--
-- WHY THEY STOPPED, measured on production 2026-09-24 12:51 to 13:02 UTC.
--
-- A tournament hand is authorised by exactly one smarter_private.f06_hand_
-- permits row in state 'reserved', written under the tournament's lease
-- generation. smarter_private.f06_one_hand is a UNIQUE index on (table_id)
-- WHERE state = 'reserved', so a table admits one reserved permit and no more.
-- That index is the whole mechanism: while a reserved permit sits at a table,
-- no successor can reserve the next hand there, and the table is done for ever.
--
--   reserved permits on the platform                                 527
--   of those, on a tournament that is RUNNING                        527
--   of those, on a tournament that is CANCELLED or COMPLETED           0
--   reserved permits whose generation no lease row names             489
--   of the 423 frozen tournaments, holding one or more               381
--
-- Not one reserved permit anywhere on this database belongs to a tournament
-- that reached a terminal status. A reserved permit is either resolved within
-- the hand that took it, or it strands its tournament in RUNNING for ever.
-- There is no third outcome on record, which is what makes the refusal below
-- safe: it cannot take a path away from anything, because no tournament has
-- ever come back from this state on its own.
--
-- THE TRANSITION THAT LEAVES IT is public.claim_tournament_lease_v2. Its
-- takeover branch fires when a lease has not been heartbeated for 30 seconds:
--
--   OR ( l.heartbeat_at < clock_timestamp() - interval '30 seconds'
--        AND l.lease_generation IS DISTINCT FROM EXCLUDED.lease_generation )
--
-- and the ON CONFLICT DO UPDATE then writes lease_generation = EXCLUDED
-- .lease_generation. The outgoing generation's uuid is overwritten in place.
-- It was recorded in exactly two places, the lease row and the permit, and
-- after that update it survives only on the permit that nothing can now reach.
--
-- The shape of the 489 proves this is the path actually taken, rather than a
-- lease that was deleted:
--
--   orphaned permits whose tournament still HAS a lease row, naming
--     some other generation                                          489
--   orphaned permits whose tournament has no lease row at all           0
--
-- Every one was orphaned by replacement, none by release. public.reap_dead
-- _engine_leases can delete a lease too, and no cron job calls it.
--
-- WHY NO RECOVERY PATH REACHES THEM. Each one is excluded by its own predicate,
-- and no two for the same reason:
--
--   ca-crash-settle-abandoned-minute -> fn_crash_sweep_abandoned reads
--     crash_rounds JOIN diamond_game_configs ON g.game = 'crash'. That is the
--     Crash casino game, not a crashed process. It does not name public
--     .tournaments anywhere. Its 360 clean runs in 6 hours are true and
--     irrelevant.
--   ca-tournament-finished-not-completed-5m ->
--     fn_ca_tournament_finished_but_not_completed keys on WHERE alive <= 1.
--     These have 2 to 306 alive, minimum 2. It also requires last_elimination
--     IS NOT NULL, which excludes 296 of them a second time. It raises a
--     financial_alert and changes no tournament.
--   ca-tournament-conservation-10m -> fn_ca_tournament_conservation_confirm
--     keys on v_hands > v_prev.hands_dealt. It confirms drift only across hands
--     dealt BETWEEN two samples, so a tournament that deals nothing can never
--     be confirmed. It is blind to a frozen event by construction.
--   ca-escrow-ttl-sweep-10m -> fn_ca_escrow_ttl_sweep reads chip_escrow_holds
--     on expires_at. It never joins tournaments, and raises an incident rather
--     than releasing anything.
--   flag-garbage-tournaments -> updates venue_daily_tournaments, a scraped
--     venue listing, on tournament_name text junk. A different table entirely.
--
-- Three of the five are alerters that mend nothing, and the two that are named
-- for tournaments are not about these tournaments. The gap is not in any of
-- them; it is that the orphaning write was never refused.
--
-- THE FIX, AND WHY IT IS THIS SHAPE. Owner policy v2.9 forbids a thirteenth
-- repair job, and one is not wanted here in any case. The correct place is the
-- write that creates the unreachable state, and the correct answer is to
-- refuse it.
--
-- A lease row may not stop naming a generation that still holds a reserved
-- hand. Refused, the update rolls back and the lease row goes on naming the
-- outgoing generation - which is exactly what public.fn_f06_abort_abandoned
-- _generation needs, because that door takes the generation as an argument and
-- there is nowhere else left to read it from. The refusal therefore does not
-- merely detect the defect; it preserves the only state from which the
-- existing writer can still finish. That door already works: it voided 628
-- permits across 314 tournaments between 12:40:40 and 12:46:41 UTC on
-- 2026-09-22 and freed 412 of the 453 tournaments it was run against.
--
-- The 423 are left exactly as measured. A constraint trigger judges only rows
-- a transaction writes, so nothing here touches them, and what happens to them
-- is Dan's to decide.
--
-- WHY IT IS DEFERRED. The check asks whether any lease row still names the
-- outgoing generation. A transaction that resolves the permit and hands the
-- event on does both, in an order this has no business dictating. Read
-- immediately it would judge a half-built transaction. A trigger that is
-- DEFERRABLE INITIALLY DEFERRED asks at COMMIT, and judges the state a
-- transaction leaves behind rather than the order it took to get there.
--
-- WHY A TERMINAL TOURNAMENT IS EXEMPT. A cancelled or completed tournament
-- releases its lease on purpose, and its permits are evidence of a finished
-- game rather than a hand still owed. Without that exemption this would refuse
-- the lease release on every cancellation, and a cancellation is how a refund
-- reaches a player. Nothing on the database relies on it today - zero reserved
-- permits sit on a terminal tournament - and the exemption is there so that
-- stays true when one does.
--
-- WHY TWO TRIGGERS. The discriminator lives in the WHEN clause so that a
-- heartbeat, which updates heartbeat_at on hundreds of rows every few seconds
-- and changes no generation, queues no deferred event at all. UPDATE asks only
-- when the generation actually changes; DELETE asks whenever one is released.
--
-- WHAT IT COSTS. public.release_tournament_leases_v2 releases a batch in one
-- statement, so a shutdown holding one unresolved hand now fails to release
-- that whole batch. Those leases go stale and are re-claimed 30 seconds after
-- the engine returns, which is the same path a kill -9 already takes today.
--
-- @live-proof: (SELECT count(*) FROM pg_trigger WHERE tgname IN ('a_lease_generation_keeps_the_hand_it_reserved', 'a_released_lease_generation_keeps_the_hand_it_reserved') AND NOT tgisinternal) = 2
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $arm$
DECLARE
  v_terminal bigint;
  v_deleted  bigint;
  v_active   bigint;
  v_total    bigint;
BEGIN
  -- (a) THE SAFETY PRECONDITION. A reserved permit has never once belonged to
  --     a tournament that reached a terminal status. If that stops being true
  --     the exemption below is load-bearing in a way this did not measure, and
  --     this reasoning is stale: refuse, re-measure, do not guess.
  SELECT count(*) INTO v_terminal
    FROM smarter_private.f06_hand_permits p
    JOIN public.tournaments t ON t.id = p.tournament_id
   WHERE p.state = 'reserved'
     AND upper(COALESCE(t.status, '')) IN ('CANCELLED', 'CANCELED', 'COMPLETED', 'COMPLETING');
  IF v_terminal <> 0 THEN
    RAISE EXCEPTION 'refused: % reserved permit(s) sit on a terminal tournament; this measured 0 on 2026-09-24 and the terminal exemption was written for that state',
      v_terminal;
  END IF;

  -- (b) THE MECHANISM THIS REFUSES. Every orphaned permit on this database was
  --     orphaned by a generation being REPLACED, never by a lease being
  --     deleted. If deletions start orphaning permits, the release trigger
  --     below is doing more than this migration measured.
  SELECT count(*) INTO v_deleted
    FROM smarter_private.f06_hand_permits p
   WHERE p.state = 'reserved'
     AND NOT EXISTS (SELECT 1 FROM public.engine_tournament_leases l
                      WHERE l.tournament_id = p.tournament_id)
     AND EXISTS (SELECT 1 FROM public.tournaments t
                  WHERE t.id = p.tournament_id
                    AND upper(COALESCE(t.status, '')) NOT IN
                        ('CANCELLED', 'CANCELED', 'COMPLETED', 'COMPLETING'));
  IF v_deleted <> 0 THEN
    RAISE EXCEPTION 'refused: % orphaned permit(s) have no lease row at all; this expected 0, the state measured 2026-09-24',
      v_deleted;
  END IF;

  -- (c) THE BLOCKING MECHANISM. One reserved permit per table is why an
  --     orphan ends the table rather than merely delaying it. If this index
  --     goes, the harm this refuses is a different harm.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname = 'smarter_private' AND indexname = 'f06_one_hand') THEN
    RAISE EXCEPTION 'refused: smarter_private.f06_one_hand is gone; the one-reserved-permit-per-table rule this reasons from no longer holds';
  END IF;

  -- (d) THE PATH BACK THAT THE REFUSAL PRESERVES. Refusing is only the right
  --     answer while a door exists that can void an abandoned generation by
  --     name. Without it the refusal would preserve a state nothing can use.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public'
                    AND p.proname = 'fn_f06_abort_abandoned_generation') THEN
    RAISE EXCEPTION 'refused: public.fn_f06_abort_abandoned_generation is not defined; the refusal would preserve a state no writer can finish';
  END IF;

  -- (e) This adds no job, and the roster is the one the twelfth retirement left.
  SELECT count(*) FILTER (WHERE active), count(*) INTO v_active, v_total FROM cron.job;
  IF v_active IS DISTINCT FROM 121 OR v_total IS DISTINCT FROM 123 THEN
    RAISE EXCEPTION 'refused: cron.job holds % active of % rows; this expected 121 of 123. Re-measure, do not guess.',
      v_active, v_total;
  END IF;

  -- (f) Nothing has armed this already.
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgname IN ('a_lease_generation_keeps_the_hand_it_reserved',
                               'a_released_lease_generation_keeps_the_hand_it_reserved')
                AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'refused: the trigger already exists';
  END IF;

  RAISE NOTICE 'arming: 527 reserved permits and 423 frozen tournaments from 2026-09-24 left untouched';
END;
$arm$;

-- The refusal reads (tournament_id, generation) among reserved permits only.
-- f06_hand_permits carries over a million rows and its three existing indexes
-- are on permit_id and table_id, so without this the check would seq-scan on
-- every handover. Partial on 'reserved', so it holds hundreds of rows, not
-- millions, and it is also the object this migration can be looked up by.
CREATE INDEX IF NOT EXISTS f06_reserved_permit_by_generation
  ON smarter_private.f06_hand_permits (tournament_id, generation)
  WHERE state = 'reserved';

CREATE OR REPLACE FUNCTION public.fn_lease_generation_keeps_its_reserved_hand()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'smarter_private', 'pg_temp'
AS $function$
DECLARE
  v_status   text;
  v_found    boolean := false;
  v_stranded bigint;
BEGIN
  -- A row that named no generation stranded nothing.
  IF OLD.lease_generation IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT upper(COALESCE(t.status, '')), true
    INTO v_status, v_found
    FROM public.tournaments t
   WHERE t.id = OLD.tournament_id;

  -- A tournament removed later in the same transaction owes nothing.
  IF NOT COALESCE(v_found, false) THEN
    RETURN NULL;
  END IF;

  -- A terminal tournament releases its lease on purpose: cancellation refunds
  -- through exactly this path, and completion settles through it.
  IF v_status IN ('CANCELLED', 'CANCELED', 'COMPLETED', 'COMPLETING') THEN
    RETURN NULL;
  END IF;

  -- Asked at COMMIT. If any lease row still names the outgoing generation the
  -- event was handed back to it, or never left it, and nothing is stranded.
  IF EXISTS (SELECT 1 FROM public.engine_tournament_leases l
              WHERE l.tournament_id = OLD.tournament_id
                AND l.lease_generation = OLD.lease_generation) THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO v_stranded
    FROM smarter_private.f06_hand_permits p
   WHERE p.tournament_id = OLD.tournament_id
     AND p.generation = OLD.lease_generation
     AND p.state = 'reserved';

  IF v_stranded > 0 THEN
    RAISE EXCEPTION
      'lease generation % of tournament % still holds % reserved hand permit(s)',
      OLD.lease_generation, OLD.tournament_id, v_stranded
      USING ERRCODE = 'P0405',
            HINT = 'Resolve the outgoing generation''s hand before the event is handed on. fn_f06_abort_abandoned_generation voids an abandoned generation from rows and takes that generation by name, which only this lease row still records.';
  END IF;

  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_lease_generation_keeps_its_reserved_hand() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.fn_lease_generation_keeps_its_reserved_hand() IS
  'Refuses to let a lease row stop naming a generation that still holds a reserved hand permit, because that permit blocks its table for ever and the generation is then unnameable. Deferred to COMMIT so a transaction may resolve and hand on in either order.';

CREATE CONSTRAINT TRIGGER a_lease_generation_keeps_the_hand_it_reserved
  AFTER UPDATE ON public.engine_tournament_leases
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.lease_generation IS DISTINCT FROM NEW.lease_generation)
  EXECUTE FUNCTION public.fn_lease_generation_keeps_its_reserved_hand();

CREATE CONSTRAINT TRIGGER a_released_lease_generation_keeps_the_hand_it_reserved
  AFTER DELETE ON public.engine_tournament_leases
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.lease_generation IS NOT NULL)
  EXECUTE FUNCTION public.fn_lease_generation_keeps_its_reserved_hand();

DO $verify$
DECLARE
  t          pg_trigger%ROWTYPE;
  v_names    text[] := ARRAY['a_lease_generation_keeps_the_hand_it_reserved',
                             'a_released_lease_generation_keeps_the_hand_it_reserved'];
  v_name     text;
  v_reserved bigint;
  v_frozen   bigint;
BEGIN
  FOREACH v_name IN ARRAY v_names LOOP
    SELECT * INTO t FROM pg_trigger WHERE tgname = v_name AND NOT tgisinternal;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'failed: % is not installed', v_name;
    END IF;
    IF t.tgrelid <> 'public.engine_tournament_leases'::regclass THEN
      RAISE EXCEPTION 'failed: % is on %, not engine_tournament_leases', v_name, t.tgrelid::regclass;
    END IF;
    IF t.tgconstraint = 0 THEN
      RAISE EXCEPTION 'failed: % is not a constraint trigger, so it cannot be deferred', v_name;
    END IF;
    IF NOT t.tgdeferrable OR NOT t.tginitdeferred THEN
      RAISE EXCEPTION 'failed: % is not DEFERRABLE INITIALLY DEFERRED; it would judge a half-built transaction', v_name;
    END IF;
    IF t.tgqual IS NULL THEN
      RAISE EXCEPTION 'failed: % has no WHEN clause, so every heartbeat would queue a deferred event', v_name;
    END IF;
    IF t.tgfoid <> 'public.fn_lease_generation_keeps_its_reserved_hand()'::regprocedure THEN
      RAISE EXCEPTION 'failed: % does not call fn_lease_generation_keeps_its_reserved_hand', v_name;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname = 'smarter_private'
                    AND indexname = 'f06_reserved_permit_by_generation') THEN
    RAISE EXCEPTION 'failed: the lookup index this refusal reads is not present';
  END IF;

  -- This migration is a guard, not a repair: it writes no row of its own, so
  -- the measured state is still there for Dan to rule on.
  SELECT count(*) INTO v_reserved
    FROM smarter_private.f06_hand_permits WHERE state = 'reserved';
  IF v_reserved = 0 THEN
    RAISE EXCEPTION 'failed: the reserved permits measured at 527 are gone; this migration must change no data';
  END IF;
  SELECT count(*) INTO v_frozen
    FROM public.tournaments
   WHERE status = 'RUNNING' AND started_at < now() - interval '24 hours';
  IF v_frozen = 0 THEN
    RAISE EXCEPTION 'failed: the 423 frozen tournaments are gone; this migration must change no data';
  END IF;

  RAISE NOTICE 'PASS: deferred refusal armed on engine_tournament_leases; % reserved permits over % frozen tournaments untouched',
    v_reserved, v_frozen;
END;
$verify$;

COMMIT;
