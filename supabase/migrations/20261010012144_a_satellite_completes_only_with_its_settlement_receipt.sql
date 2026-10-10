-- a_satellite_completes_only_with_its_settlement_receipt
--
-- Dan, 2026-10-09 18:30 CT: tournaments must never be able to finish unpaid,
-- "or even be an option to happen". Approved for production by Dan
-- 2026-10-09 ("Yes, apply all 3").
--
-- MTTs, Spins and Sit & Gos already cannot. The deferred constraint trigger
-- non_satellite_completed_requires_terminal_receipt refuses COMPLETED unless
-- the atomic terminal receipt exists and fn_ca_tournament_terminal_receipt
-- validates its payout evidence and the exact zero close of its escrow
-- (Diamond events included, from their own Diamond escrow).
--
-- Satellites had no such lock. Their guard, aaa_guard_atomic_satellite_completion
-- (migration 20260908125910), was installed DISABLED pending a "Stage B" that
-- never ran, and it checks tournament_satellite_settlement_batches, which the
-- live engine does not write: of the 221 satellites completed in the 3 days to
-- 2026-10-09, all 221 fail fn_check_atomic_satellite_finish with
-- satellite_batch_not_settled. It must stay disabled.
--
-- The live engine settles a satellite through its immutable receipt,
-- tournament_satellite_settlements, written in the same transaction that marks
-- it COMPLETED and closing its source escrow. Measured read-only 2026-10-09:
-- every one of the 2,548 satellites completed since 2026-09-10 03:00 UTC has
-- that receipt, with source_escrow_closed_at set and settled_at equal to
-- ended_at. No satellite has ever been inserted already COMPLETED.
--
-- What changes: a deferred constraint trigger, the satellite twin of the
-- non-satellite one, refuses to let any satellite become COMPLETED unless its
-- settlement receipt exists with its escrow closed. It is checked at COMMIT,
-- so a receipt written later in the same transaction counts. A path that tries
-- to finish a satellite without settling it now fails and rolls back, leaving
-- the event COMPLETING, where ca-tournament-finished-not-completed-5m sees it,
-- instead of COMPLETED with nobody paid. Between the two triggers every
-- tournament that becomes COMPLETED is covered.
-- No money moves. No existing row changes.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- The lock must not refuse anything the live engine does today.
DO $pre$
DECLARE
  v_missing integer;
BEGIN
  SELECT count(*) INTO v_missing
    FROM public.tournaments t
   WHERE t.status = 'COMPLETED'
     AND t.ended_at > timestamptz '2026-09-10 03:00:00+00'
     AND (lower(COALESCE(t.variant, '')) = 'satellite'
          OR upper(COALESCE(t.tournament_type, '')) = 'SATELLITE'
          OR t.satellite_target_id IS NOT NULL
          OR t.satellite_target IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM public.tournament_satellite_settlements s
                      WHERE s.tournament_id = t.id
                        AND s.source_escrow_closed_at IS NOT NULL);
  IF v_missing <> 0 THEN
    RAISE EXCEPTION 'A_LIVE_SATELLITE_PATH_COMPLETES_WITHOUT_A_RECEIPT: %', v_missing;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgname = 'satellite_completed_requires_settlement_receipt'
                AND tgrelid = 'public.tournaments'::regclass) THEN
    RAISE EXCEPTION 'SATELLITE_LOCK_ALREADY_PRESENT';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.fn_satellite_completed_requires_settlement_receipt()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status text;
BEGIN
  IF upper(COALESCE(NEW.status::text, '')) <> 'COMPLETED' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND upper(COALESCE(OLD.status::text, '')) = 'COMPLETED' THEN
    RETURN NULL;
  END IF;
  -- Non-satellites are held by non_satellite_completed_requires_terminal_receipt,
  -- whose exclusion is exactly this predicate.
  IF NOT (lower(COALESCE(NEW.variant::text, '')) = 'satellite'
          OR upper(COALESCE(NEW.tournament_type::text, '')) = 'SATELLITE'
          OR NEW.satellite_target_id IS NOT NULL
          OR NEW.satellite_target IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  -- Judged at COMMIT against the row as it now stands.
  SELECT t.status INTO v_status FROM public.tournaments t WHERE t.id = NEW.id;
  IF upper(COALESCE(v_status, '')) <> 'COMPLETED' THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tournament_satellite_settlements s
                  WHERE s.tournament_id = NEW.id
                    AND s.source_escrow_closed_at IS NOT NULL) THEN
    RAISE EXCEPTION
      'satellite tournament % cannot become COMPLETED without its settlement receipt and closed escrow',
      NEW.id USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_satellite_completed_requires_settlement_receipt()
  FROM PUBLIC, anon, authenticated, service_role;

-- No DROP TRIGGER IF EXISTS: it would take an ACCESS EXCLUSIVE lock on the
-- live tournaments table. The pre-check above proves the name is free.
CREATE CONSTRAINT TRIGGER satellite_completed_requires_settlement_receipt
  AFTER INSERT OR UPDATE OF status ON public.tournaments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_satellite_completed_requires_settlement_receipt();

COMMENT ON TRIGGER satellite_completed_requires_settlement_receipt ON public.tournaments IS
  'A satellite becomes COMPLETED only with its tournament_satellite_settlements receipt and closed source escrow, checked at COMMIT. Satellite twin of non_satellite_completed_requires_terminal_receipt. Migration a_satellite_completes_only_with_its_settlement_receipt, 2026-10-09.';

COMMENT ON TRIGGER aaa_guard_atomic_satellite_completion ON public.tournaments IS
  'SUPERSEDED 2026-10-09 by satellite_completed_requires_settlement_receipt. Keep DISABLED: it checks tournament_satellite_settlement_batches, which the live engine does not write, so enabling it would refuse every satellite completion.';

DO $prove$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'satellite_completed_requires_settlement_receipt'
                    AND tgrelid = 'public.tournaments'::regclass
                    AND tgenabled = 'O' AND tgdeferrable AND tginitdeferred) THEN
    RAISE EXCEPTION 'SATELLITE_LOCK_NOT_INSTALLED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'non_satellite_completed_requires_terminal_receipt'
                    AND tgrelid = 'public.tournaments'::regclass
                    AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'NON_SATELLITE_LOCK_MISSING';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgname = 'aaa_guard_atomic_satellite_completion'
                AND tgrelid = 'public.tournaments'::regclass
                AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'OBSOLETE_SATELLITE_GUARD_IS_ENABLED';
  END IF;
END
$prove$;

COMMIT;