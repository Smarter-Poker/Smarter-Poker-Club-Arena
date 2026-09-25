-- 20260924134722_a_lease_generation_keeps_the_hand_it_reserved_is_withdrawn
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-24 13:47:22 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- THE GUARD THAT WOULD HAVE REFUSED THE FIX
--
-- 20260924130508 (file 20260924130148) armed a deferred refusal on
-- public.engine_tournament_leases: a lease row could not stop naming a lease
-- generation that still held a reserved smarter_private.f06_hand_permits row.
-- This withdraws it whole, three quarters of an hour later, because its
-- central premise is false and the cost of the mistake is real.
--
-- WHAT IT CLAIMED. That public.claim_tournament_lease_v2 overwrites
-- lease_generation in place, and that the outgoing generation's uuid was
-- therefore recorded in only two places, the lease row and the permit, so
-- after the takeover it survived only on a permit nothing could reach. On that
-- reading, public.fn_f06_abort_abandoned_generation could never be called for
-- it, because that door takes the generation as an argument.
--
-- WHY THAT IS WRONG. The permit row names its own generation, and that is
-- exactly where the adopting manager reads it.
-- server/src/tournament/abandonedGenerationDoor.ts, merged as #5163 on
-- 2026-09-24, takes the generation from the table's own admission answer:
--
--   const p = permit as Record<string, unknown>;
--   ...
--   const generation = p.generation.toLowerCase();
--   return generation === leaseGeneration.toLowerCase() ? null : generation;
--
-- f06_hand_permits.generation, surfaced as the hand_permit_unresolved reason
-- the table already gives. The lease row was never the only record of it, and
-- this agent read that column repeatedly while measuring the incident, which
-- should have been the tell.
--
-- WHY THE GUARD WAS WORSE THAN NOTHING. The adopting manager closes the dead
-- generation AFTER it holds the lease, and in a separate RPC:
-- abandonedPermitGeneration returns a generation only when it differs from the
-- manager's own leaseGeneration, and closeAbandonedGeneration is its own
-- supabase.rpc call in its own transaction. The sequence is therefore
--
--   1. adopt: UPDATE engine_tournament_leases, generation A replaced by B
--   2. close: fn_f06_abort_abandoned_generation(event, A, ...)
--
-- and the withdrawn guard judged step 1 at COMMIT, where A still held the
-- reserved permit and no lease row named A. It refused step 1, so step 2 could
-- never run. It would have blocked the recovery path #5163 exists to provide,
-- on every crash-and-adopt cycle, once the engine can take a release. Measured
-- 2026-09-24 13:40 UTC, before this withdrawal: 13 tournaments whose next
-- adoption it already refused.
--
-- WHAT THE INCIDENT ACTUALLY WAS. 423 tournaments RUNNING and silent with
-- 3,138 open seats over 863 players, because a generation that died mid-hand
-- left its permit 'reserved' and smarter_private.f06_one_hand admits one
-- reserved permit per table. That reading stands. What was missing was never a
-- refusal; it was a caller for the door, and #5163 is that caller. The right
-- shape here was the writer change, and another agent had already built it.
--
-- WHAT THIS LEAVES. The 423 are untouched, as they were before and after the
-- guard: a constraint trigger judges only rows a transaction writes, and this
-- withdrawal writes none either. fn_f06_abort_abandoned_generation is still
-- defined and is asserted below, because it is the path that must work.
--
-- @live-proof: (SELECT count(*) FROM pg_trigger WHERE tgname IN ('a_lease_generation_keeps_the_hand_it_reserved', 'a_released_lease_generation_keeps_the_hand_it_reserved') AND NOT tgisinternal) = 0
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '9s';
SET LOCAL statement_timeout = '120s';
-- The engine heartbeats this table constantly, so an AccessExclusiveLock races
-- live RowShareLock holders. A short deadlock timeout fails this transaction
-- fast and lets it be retried, rather than stalling engine traffic behind it.
SET LOCAL deadlock_timeout = '300ms';

DO $withdraw$
DECLARE
  v_n bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'a_lease_generation_keeps_the_hand_it_reserved'
                    AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'refused: the guard this withdraws is not installed; nothing to withdraw';
  END IF;

  SELECT count(*) INTO v_n FROM public.tournaments
   WHERE status = 'RUNNING' AND started_at < now() - interval '24 hours';
  IF v_n = 0 THEN
    RAISE EXCEPTION 'refused: the frozen tournaments this was measured against are gone; re-measure before changing anything';
  END IF;
  RAISE NOTICE 'withdrawing the guard; % frozen tournaments left exactly as they are', v_n;
END;
$withdraw$;

DROP TRIGGER IF EXISTS a_lease_generation_keeps_the_hand_it_reserved ON public.engine_tournament_leases;
DROP TRIGGER IF EXISTS a_released_lease_generation_keeps_the_hand_it_reserved ON public.engine_tournament_leases;
DROP FUNCTION IF EXISTS public.fn_lease_generation_keeps_its_reserved_hand();
DROP INDEX IF EXISTS smarter_private.f06_reserved_permit_by_generation;

DO $verify$
DECLARE
  v_frozen bigint;
  v_res    bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgname IN ('a_lease_generation_keeps_the_hand_it_reserved',
                               'a_released_lease_generation_keeps_the_hand_it_reserved')
                AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'failed: a trigger from the withdrawn guard is still installed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public'
                AND p.proname = 'fn_lease_generation_keeps_its_reserved_hand') THEN
    RAISE EXCEPTION 'failed: the withdrawn guard function is still defined';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes
              WHERE schemaname = 'smarter_private'
                AND indexname = 'f06_reserved_permit_by_generation') THEN
    RAISE EXCEPTION 'failed: the withdrawn guard index is still present';
  END IF;

  -- The adoption path this stops obstructing must still be there.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public'
                    AND p.proname = 'fn_f06_abort_abandoned_generation') THEN
    RAISE EXCEPTION 'failed: fn_f06_abort_abandoned_generation is missing; the recovery path is not there';
  END IF;

  SELECT count(*) INTO v_frozen FROM public.tournaments
   WHERE status = 'RUNNING' AND started_at < now() - interval '24 hours';
  SELECT count(*) INTO v_res FROM smarter_private.f06_hand_permits WHERE state = 'reserved';
  IF v_frozen = 0 OR v_res = 0 THEN
    RAISE EXCEPTION 'failed: this withdrawal must change no data, but the measured state is gone';
  END IF;

  RAISE NOTICE 'PASS: guard withdrawn; % frozen tournaments and % reserved permits untouched', v_frozen, v_res;
END;
$verify$;

COMMIT;
