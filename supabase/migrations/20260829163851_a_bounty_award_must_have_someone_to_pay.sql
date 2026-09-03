-- ═══════════════════════════════════════════════════════════════════════════
--  A BOUNTY AWARD MUST HAVE SOMEBODY TO PAY (2026-08-29)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- fn_mystery_bounty_reserve flips a chest to 'reserved' and inserts the
-- tournament_bounty_awards row BEFORE it works out who the recipients are.
-- If the recipient insert produces no rows it does this:
--
--     GET DIAGNOSTICS v_n = ROW_COUNT;
--     IF v_n = 0 THEN
--       RETURN jsonb_build_object('ok', false, 'reason', 'no_recipients');
--     END IF;
--
-- A RETURN COMMITS. Only the RAISE twelve lines below it ('mystery bounty
-- split lost money') rolls anything back. So the chest is permanently consumed
-- with nobody to pay -- and it is then swept to the champion as "unclaimed" by
-- fn_mystery_bounty_settle, which is money taken from the knocker who earned
-- it and handed to the winner.
--
-- Reachable when every entry in p_recipients has a null user_id: the earlier
-- guard checks the array is non-empty, not that any element is usable.
--
-- WHY A DEFERRED CONSTRAINT TRIGGER RATHER THAN EDITING THE FUNCTION.
-- The recipients are inserted after the award inside the same transaction, so
-- a row-level trigger cannot see them. A DEFERRABLE INITIALLY DEFERRED
-- constraint trigger fires at COMMIT, when the full picture exists, and it
-- guards EVERY path that can create an award -- including whatever writes one
-- next year -- instead of the single call site that happens to be wrong today.
--
-- BLAST RADIUS: tournament_bounty_awards has never had a row (104 chests built
-- across 27 events, every one voided without ever being reserved), so this
-- cannot break existing data.
--
-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- DROP TRIGGER trg_bounty_award_has_recipients ON public.tournament_bounty_awards;
-- DROP FUNCTION public.fn_assert_bounty_award_has_recipients();
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_assert_bounty_award_has_recipients()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_recipients int;
  v_sum        bigint;
BEGIN
  SELECT count(*), COALESCE(sum(amount_cents), 0)
    INTO v_recipients, v_sum
    FROM public.tournament_bounty_award_recipients
   WHERE award_id = NEW.id;

  IF v_recipients = 0 THEN
    RAISE EXCEPTION
      'bounty award % consumed chest % on tournament % with NO recipients - refusing to commit a chest nobody can be paid from',
      NEW.id, NEW.chest_id, NEW.tournament_id;
  END IF;

  -- The split must also hand out the whole chest. The function has its own
  -- check for this, but it only covers its own arithmetic; this covers the
  -- row as committed, whoever wrote it.
  IF v_sum <> NEW.amount_cents THEN
    RAISE EXCEPTION
      'bounty award % splits % cents across its recipients but the chest holds % - refusing to commit a split that loses or invents money',
      NEW.id, v_sum, NEW.amount_cents;
  END IF;

  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_bounty_award_has_recipients ON public.tournament_bounty_awards;

CREATE CONSTRAINT TRIGGER trg_bounty_award_has_recipients
  AFTER INSERT ON public.tournament_bounty_awards
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_assert_bounty_award_has_recipients();

DO $$
BEGIN
  PERFORM 1 FROM pg_trigger
   WHERE tgname = 'trg_bounty_award_has_recipients' AND tgdeferrable AND tginitdeferred;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the guard is not installed as a deferred constraint trigger';
  END IF;
END $$;
