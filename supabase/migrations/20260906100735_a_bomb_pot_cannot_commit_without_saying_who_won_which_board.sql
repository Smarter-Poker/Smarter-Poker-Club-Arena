-- A BOMB POT CANNOT COMMIT WITHOUT SAYING WHO WON WHICH BOARD.
--
-- Dan, this session: "WE AREN'T USING ANY CRONS TO MONITOR OR FIX, THATS A
-- BANDAID, NOT A HARD CODED SOLUTION. WE NEED TO FIX THE ISSUES AT THE CODE
-- LEVEL. NOT CONSTANTLY RUNNING AROUND RECONCILING."
--
-- He is right and this migration replaces the answer I gave an hour ago.
-- 20260906100405 rescheduled two repair sweeps to rebuild bomb_pot_award_units
-- after the fact. That leaves the losing write exactly as lossy as it was and
-- pays somebody to follow it around with a bucket. Both are unscheduled here.
--
-- THE DEFECT, measured: 25,888 bomb-pot hands in seven days, 18 with NO rows in
-- bomb_pot_award_units at all. The hand settled, the pot was paid, rake and BBJ
-- were taken - only the record of which board and which player got which share
-- was never written.
--
-- WHY IT COULD BE LOST. The hand row and its award units are TWO SEPARATE
-- WRITES over two round trips. insertHandHistoryRow does `.insert(row)`; the
-- award units follow afterwards as a `.upsert()` that is explicitly
-- fire-and-forget - "it must never be able to fail a hand". That instinct is
-- correct for a hand in progress and wrong as an architecture: two writes with
-- no transaction between them means one of them can be the only one that lands,
-- and no amount of retrying changes that.
--
-- THE FIX IS THAT THEY ARE ONE WRITE.
--
--   1. fn_ca_insert_hand_with_awards(p_row, p_units) inserts the hand_history
--      row and its award units in ONE transaction, in ONE round trip - so the
--      hot path still costs exactly one request, which the retry-queue design
--      above insertHandHistoryRow deliberately bought and must keep.
--
--   2. A DEFERRABLE INITIALLY DEFERRED constraint trigger checks at COMMIT that
--      a bomb-pot hand with chips to distribute has award units that sum to
--      them. Deferred is the whole point: the two inserts happen in either
--      order inside the transaction and are judged together at the end.
--
-- (2) is what makes this a fix rather than a better habit. A future code path
-- that writes a bomb hand and forgets its units does not produce a gap for a
-- sweep to find later - it fails to commit, at once, with a message naming the
-- hand. The condition stops being possible instead of being cleaned up.

BEGIN;

-- ---------------------------------------------------------------------------
-- Undo the band-aid.
-- ---------------------------------------------------------------------------
DO $unsched$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname='bomb-award-units-repair-hourly') THEN
    PERFORM cron.unschedule('bomb-award-units-repair-hourly');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname='bomb-multi-winner-repair-hourly') THEN
    PERFORM cron.unschedule('bomb-multi-winner-repair-hourly');
  END IF;
END $unsched$;

DELETE FROM public.ca_expected_cron_jobs
 WHERE jobname IN ('bomb-award-units-repair-hourly','bomb-multi-winner-repair-hourly');

-- ---------------------------------------------------------------------------
-- One write.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_insert_hand_with_awards(
  p_row jsonb,
  p_units jsonb DEFAULT '[]'::jsonb)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.hand_history
  SELECT * FROM jsonb_populate_record(null::public.hand_history, p_row)
  RETURNING id INTO v_id;

  IF jsonb_array_length(COALESCE(p_units,'[]'::jsonb)) > 0 THEN
    INSERT INTO public.bomb_pot_award_units
      (hand_history_id, table_id, hand_number, pot_index, board, side, user_id, amount, hand_name)
    SELECT v_id,
           (u->>'table_id')::uuid,
           (u->>'hand_number')::bigint,
           (u->>'pot_index')::int,
           COALESCE((u->>'board')::int, 1),
           COALESCE(u->>'side','high'),
           (u->>'user_id')::uuid,
           (u->>'amount')::numeric,
           NULLIF(u->>'hand_name','')
      FROM jsonb_array_elements(p_units) u
    ON CONFLICT (hand_history_id, pot_index, board, side, user_id) DO NOTHING;
  END IF;

  RETURN v_id;
END $fn$;

REVOKE ALL ON FUNCTION public.fn_ca_insert_hand_with_awards(jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_insert_hand_with_awards(jsonb, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- And the guarantee, judged at COMMIT.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_bomb_hand_keeps_its_award_units()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_distributable numeric;
  v_units numeric;
  v_n int;
BEGIN
  IF NEW.bomb_pot IS NULL THEN RETURN NULL; END IF;

  v_distributable := round(COALESCE(NEW.pot_size,0)
                           - COALESCE(NEW.rake_amount,0)
                           - COALESCE(NEW.bbj_amount,0), 2);
  /* Nothing to distribute means nothing to attribute: a folded-around bomb, or
     a hand voided before showdown. Not every bomb row owes a breakdown. */
  IF v_distributable <= 0 THEN RETURN NULL; END IF;

  SELECT COALESCE(round(sum(amount),2),0), count(*)
    INTO v_units, v_n
    FROM public.bomb_pot_award_units
   WHERE hand_history_id = NEW.id;

  IF v_n = 0 THEN
    RAISE EXCEPTION
      'bomb pot hand #% (%) would commit with % chips distributed and no award units. '
      'Write the hand and its units together through fn_ca_insert_hand_with_awards - '
      'two separate writes is how 18 bomb pots lost their record in the week to '
      '2026-09-06.',
      NEW.hand_number, NEW.id, v_distributable
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF v_units <> v_distributable THEN
    RAISE EXCEPTION
      'bomb pot hand #% (%) distributes % chips but its % award unit(s) sum to %.',
      NEW.hand_number, NEW.id, v_distributable, v_n, v_units
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NULL;
END $fn$;

DROP TRIGGER IF EXISTS zz_ca_bomb_hand_keeps_its_award_units ON public.hand_history;
CREATE CONSTRAINT TRIGGER zz_ca_bomb_hand_keeps_its_award_units
  AFTER INSERT ON public.hand_history
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.bomb_pot IS NOT NULL)
  EXECUTE FUNCTION public.fn_ca_bomb_hand_keeps_its_award_units();

COMMENT ON FUNCTION public.fn_ca_bomb_hand_keeps_its_award_units() IS
  'DEFERRED to COMMIT so the hand row and its award units may be inserted in '
  'either order inside one transaction and are judged together at the end. A '
  'bomb pot that distributes chips and cannot say who won which board does not '
  'commit. Added 2026-09-06 - Dan: fix it at the code level, do not run around '
  'reconciling.';

-- ---------------------------------------------------------------------------
-- Close the 19 incidents: the condition is gone and cannot return.
-- ---------------------------------------------------------------------------
DO $close$
DECLARE v_gaps int; v_closed int;
BEGIN
  SELECT count(*) INTO v_gaps
    FROM public.hand_history h
   WHERE h.bomb_pot IS NOT NULL
     AND h.created_at > now() - interval '7 days'
     AND round(COALESCE(h.pot_size,0)-COALESCE(h.rake_amount,0)-COALESCE(h.bbj_amount,0),2) > 0
     AND NOT EXISTS (SELECT 1 FROM public.bomb_pot_award_units a WHERE a.hand_history_id = h.id);

  IF v_gaps <> 0 THEN
    RAISE EXCEPTION 'still % bomb hand(s) with no award units - not closing anything', v_gaps;
  END IF;

  UPDATE public.ca_drift_incidents
     SET status='resolved', resolved_at=now(),
         correction_ref='migration 20260906100735_a_bomb_pot_cannot_commit_without_saying_who_won_which_board',
         root_cause='hand_history and bomb_pot_award_units were two separate writes with no '
           || 'transaction between them; the second was fire-and-forget, so it could be the '
           || 'one that did not land.',
         resolution='Closed 2026-09-06. The units are rebuilt and, more to the point, the '
           || 'condition can no longer occur: fn_ca_insert_hand_with_awards writes the hand '
           || 'and its units in one transaction, and a DEFERRABLE constraint trigger refuses '
           || 'at COMMIT to let a bomb pot that distributes chips exist without award units '
           || 'that sum to them. No sweep repairs this now - it cannot happen.'
   WHERE status <> 'resolved'
     AND (source = 'ledger_reconcile_log:fn_bomb_pot_ledger_gaps'
          OR source = 'ledger_reconcile_log:bomb_award_ledger_gap');
  GET DIAGNOSTICS v_closed = ROW_COUNT;
  RAISE NOTICE 'BOMB_INCIDENTS_CLOSED %', v_closed;
END $close$;

COMMIT;
