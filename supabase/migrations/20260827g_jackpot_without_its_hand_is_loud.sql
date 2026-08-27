-- ============================================================================
--  A jackpot payout with no hand stops being invisible
-- ============================================================================
--
--  Two ways a payout ends up with no hand, and neither said anything:
--
--  1. `runStep` continues after a failed step BY DESIGN
--     (ServerTableEngineSettlement.ts:985). If the hand_history insert fails,
--     the payout still lands, `hand_id` stays NULL, and the rundown is dark for
--     that winner forever. Nothing reported it.
--
--  2. Something deletes the hand later. 20260827d stopped the pruner doing it,
--     but a manual delete, a future sweep, or a bug in that exemption would do
--     it again -- and the first anyone would know is a player tapping a winner
--     and getting the summary card instead of the hand.
--
--  WHY A TRIGGER AND NOT A FOREIGN KEY. ON DELETE RESTRICT would make the
--  pruner's batched `DELETE ... WHERE id = ANY(...)` fail outright if a single
--  jackpot hand slipped into a batch, stalling retention on a table already at
--  3.6 GB and growing ~0.5 GB/day. That turns a display problem into an
--  infrastructure one. ON DELETE SET NULL would erase the very evidence this
--  adds. The house has met this before and settled it -- see
--  `ca_seat_stack_exits` and CLAUDE.md 11.5: the trigger NEVER BLOCKS, it makes
--  the failure LOUD.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.bbj_hand_evidence_log (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  kind         text        NOT NULL,
  payout_id    uuid,
  hand_id      uuid,
  table_id     uuid,
  hand_number  bigint,
  db_role      text        NOT NULL DEFAULT current_user,
  application  text        NOT NULL DEFAULT COALESCE(current_setting('application_name', true), ''),
  detail       jsonb       NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE public.bbj_hand_evidence_log IS
  'Every time the hand behind a jackpot payout is deleted, or a payout is written without one. Append-only; never blocks anything.';

CREATE INDEX IF NOT EXISTS idx_bbj_hand_evidence_at ON public.bbj_hand_evidence_log (at DESC);

ALTER TABLE public.bbj_hand_evidence_log ENABLE ROW LEVEL SECURITY;
-- No policy: this is an operator log. service_role bypasses RLS; nobody else
-- has any business reading which hands went missing.

-- 1. Somebody is deleting a hand that a jackpot points at
CREATE OR REPLACE FUNCTION public.fn_log_jackpot_hand_deleted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_payout uuid;
BEGIN
  SELECT p.id INTO v_payout
    FROM public.bbj_payouts p
   WHERE p.table_id = OLD.table_id AND p.hand_number = OLD.hand_number
   LIMIT 1;

  IF v_payout IS NOT NULL THEN
    INSERT INTO public.bbj_hand_evidence_log (kind, payout_id, hand_id, table_id, hand_number, detail)
    VALUES ('hand_deleted', v_payout, OLD.id, OLD.table_id, OLD.hand_number,
            jsonb_build_object('has_human', OLD.has_human, 'created_at', OLD.created_at));
  END IF;

  -- ALWAYS returns OLD. A guard that can refuse a delete here would stall the
  -- pruner mid-batch, which is a worse outcome than the thing it is guarding.
  RETURN OLD;
END;
$function$;

DROP TRIGGER IF EXISTS trg_log_jackpot_hand_deleted ON public.hand_history;
CREATE TRIGGER trg_log_jackpot_hand_deleted
  BEFORE DELETE ON public.hand_history
  FOR EACH ROW EXECUTE FUNCTION public.fn_log_jackpot_hand_deleted();

-- 2. A payout written with no hand to point at
CREATE OR REPLACE FUNCTION public.fn_log_jackpot_payout_without_hand()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.hand_id IS NULL THEN
    INSERT INTO public.bbj_hand_evidence_log (kind, payout_id, table_id, hand_number, detail)
    VALUES ('payout_without_hand', NEW.id, NEW.table_id, NEW.hand_number,
            jsonb_build_object('total_amount', NEW.total_amount,
                               'note', 'hand_history row was not found when the payout was written'));
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_log_jackpot_payout_without_hand ON public.bbj_payouts;
CREATE TRIGGER trg_log_jackpot_payout_without_hand
  AFTER INSERT ON public.bbj_payouts
  FOR EACH ROW EXECUTE FUNCTION public.fn_log_jackpot_payout_without_hand();

-- 3. The question, answerable on demand
CREATE OR REPLACE FUNCTION public.fn_bbj_orphaned_payouts()
RETURNS TABLE(
  payout_id uuid, awarded_at timestamptz, table_id uuid, hand_number bigint,
  total_amount numeric, recipients integer, hand_exists boolean, hand_id_set boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT p.id, p.created_at, p.table_id, p.hand_number, p.total_amount,
         (SELECT count(*)::int FROM public.bbj_payout_recipients r WHERE r.payout_id = p.id),
         EXISTS (SELECT 1 FROM public.hand_history h
                  WHERE h.table_id = p.table_id AND h.hand_number = p.hand_number),
         p.hand_id IS NOT NULL
    FROM public.bbj_payouts p
   WHERE p.hand_id IS NULL
      OR NOT EXISTS (SELECT 1 FROM public.hand_history h
                      WHERE h.table_id = p.table_id AND h.hand_number = p.hand_number)
   ORDER BY p.created_at DESC;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_bbj_orphaned_payouts() TO service_role;

-- 4. A late link is still a link.
--  The hand may be written after the payout (a retry, a repaired step). This
--  attaches any that can now be attached, and is safe to run repeatedly.
CREATE OR REPLACE FUNCTION public.fn_bbj_relink_payouts()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_linked integer;
BEGIN
  UPDATE public.bbj_payouts bp
     SET hand_id = h.id
    FROM public.hand_history h
   WHERE bp.hand_id IS NULL
     AND h.table_id = bp.table_id
     AND h.hand_number = bp.hand_number;
  GET DIAGNOSTICS v_linked = ROW_COUNT;
  RETURN v_linked;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_bbj_relink_payouts() TO service_role;

DO $$
DECLARE
  v_orphans integer;
BEGIN
  -- The 24 whose hands were pruned before 20260827d are expected here.
  SELECT count(*) INTO v_orphans FROM public.fn_bbj_orphaned_payouts();
  RAISE NOTICE 'orphaned jackpot payouts: %', v_orphans;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_log_jackpot_hand_deleted') THEN
    RAISE EXCEPTION 'the hand-deletion trigger did not install';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_log_jackpot_payout_without_hand') THEN
    RAISE EXCEPTION 'the payout-without-hand trigger did not install';
  END IF;
END $$;
