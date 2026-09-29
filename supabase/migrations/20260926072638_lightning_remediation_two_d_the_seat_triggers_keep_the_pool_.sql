-- 20260926072638_lightning_remediation_two_d_the_seat_triggers_keep_the_pool_.sql
--
-- LIGHTNING REMEDIATION TWO, FILE D OF FOUR: THE SEAT TRIGGERS KEEP THE POOL ON
-- ITS ANCHOR.
--
-- The four triggers file C's functions need on public.table_seats, alone in
-- their own transaction, and their declarations in ca_declared_money_triggers.
-- Nothing here locks `tables` or cash_cluster_events: CREATE TRIGGER takes
-- SHARE ROW EXCLUSIVE on table_seats only, for the milliseconds to COMMIT, with
-- a two-second lock wait.
--
--   trg_table_seats_lightning_anchor_guard: BEFORE UPDATE, WHEN the stack, the
--     departure or the occupant changes. Refuses (PLT01,
--     LIGHTNING_HAND_IN_PROGRESS) a change to the anchor of a player in a live
--     Lightning hand unless ca.lightning_settlement_hand names that hand.
--   trg_table_seats_lightning_anchor_delete_guard: BEFORE DELETE. Refuses
--     (PLT01, LIGHTNING_ANCHOR_SEAT_IS_IN_THE_POOL) deleting a seat that anchors
--     an OPEN pool session. This, not a foreign key, holds the anchor; the
--     buy-in's DELETE of a departed seat whose session has exited is untouched.
--   trg_table_seats_lightning_pool_on_insert and
--   trg_table_seats_lightning_pool_follows_seat: DEFERRED constraint triggers
--     (the buy-in writes the seat before the cash session) whose WHEN clauses
--     admit only an arrival, a departure, a turnover, a sit-out or sit-in, a
--     leave request or its withdrawal, or a stack crossing zero. They move a
--     player into and out of the pool with the seat.
--
-- Requires file C (the trigger functions). Re-appliable: every CREATE is
-- guarded and the declarations are ON CONFLICT DO NOTHING.
--
-- @live-proof: (SELECT count(*) = 2 AND bool_and(t.tgdeferrable AND t.tginitdeferred AND t.tgenabled = 'O' AND t.tgqual IS NOT NULL AND t.tgfoid = 'public.fn_table_seats_lightning_pool_follows_seat()'::regprocedure) FROM pg_trigger t WHERE t.tgrelid = 'public.table_seats'::regclass AND t.tgname IN ('trg_table_seats_lightning_pool_on_insert', 'trg_table_seats_lightning_pool_follows_seat'))
-- @live-proof: (SELECT pg_get_triggerdef(t.oid) ~ 'old\.left_at IS DISTINCT FROM new\.left_at' AND pg_get_triggerdef(t.oid) ~ 'old\.is_sitting_out IS DISTINCT FROM new\.is_sitting_out' AND pg_get_triggerdef(t.oid) ~ 'old\.leave_pending IS DISTINCT FROM new\.leave_pending' AND pg_get_triggerdef(t.oid) ~ 'COALESCE\(old\.stack' AND (t.tgtype::integer & 16) <> 0 FROM pg_trigger t WHERE t.tgrelid = 'public.table_seats'::regclass AND t.tgname = 'trg_table_seats_lightning_pool_follows_seat')
-- @live-proof: (SELECT (t.tgtype::integer & 2) <> 0 AND (t.tgtype::integer & 16) <> 0 AND (t.tgtype::integer & 4) = 0 AND t.tgenabled = 'O' AND pg_get_triggerdef(t.oid) ~ 'old\.stack IS DISTINCT FROM new\.stack' AND pg_get_triggerdef(t.oid) ~ 'old\.left_at IS DISTINCT FROM new\.left_at' AND t.tgfoid = 'public.fn_table_seats_lightning_anchor_guard()'::regprocedure FROM pg_trigger t WHERE t.tgrelid = 'public.table_seats'::regclass AND t.tgname = 'trg_table_seats_lightning_anchor_guard')
-- @live-proof: (SELECT count(*) = 4 FROM public.ca_declared_money_triggers d WHERE d.table_name = 'table_seats' AND d.trigger_name IN ('trg_table_seats_lightning_anchor_guard', 'trg_table_seats_lightning_anchor_delete_guard', 'trg_table_seats_lightning_pool_on_insert', 'trg_table_seats_lightning_pool_follows_seat'))
-- @live-proof: (SELECT (t.tgtype::integer & 2) <> 0 AND (t.tgtype::integer & 8) <> 0 AND t.tgenabled = 'O' AND t.tgfoid = 'public.fn_table_seats_lightning_anchor_guard()'::regprocedure FROM pg_trigger t WHERE t.tgrelid = 'public.table_seats'::regclass AND t.tgname = 'trg_table_seats_lightning_anchor_delete_guard')

BEGIN;

-- table_seats is written by every hand. CREATE TRIGGER takes SHARE ROW
-- EXCLUSIVE on it until COMMIT, so this file touches table_seats and the
-- trigger register and nothing else - never `tables`, which the seat triggers
-- read - and waits two seconds at most for its lock.
SET LOCAL lock_timeout = '2s';

DO $seat_triggers$
BEGIN
  -- DEFECT 4: the anchor guard. BEFORE UPDATE, and its WHEN clause admits only
  -- a change to the stack, the departure or the occupant, so a row update that
  -- touches none of them never reaches PL/pgSQL.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.table_seats'::regclass
                   AND tgname = 'trg_table_seats_lightning_anchor_guard') THEN
    CREATE TRIGGER trg_table_seats_lightning_anchor_guard
      BEFORE UPDATE ON public.table_seats
      FOR EACH ROW
      WHEN (OLD.stack IS DISTINCT FROM NEW.stack
            OR OLD.left_at IS DISTINCT FROM NEW.left_at
            OR OLD.user_id IS DISTINCT FROM NEW.user_id)
      EXECUTE FUNCTION public.fn_table_seats_lightning_anchor_guard();
  END IF;

  -- The anchor is held by this, not by a foreign key: a seat that anchors an
  -- OPEN pool session is not deleted. A departed seat whose session has exited
  -- - the one the buy-in deletes before re-seating a chair - is.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.table_seats'::regclass
                   AND tgname = 'trg_table_seats_lightning_anchor_delete_guard') THEN
    CREATE TRIGGER trg_table_seats_lightning_anchor_delete_guard
      BEFORE DELETE ON public.table_seats
      FOR EACH ROW
      EXECUTE FUNCTION public.fn_table_seats_lightning_anchor_guard();
  END IF;

  -- DEFECT 2: the pool follows the seat, deferred to commit, because the
  -- buy-in writes the seat before the cash session. The WHEN clauses keep
  -- every ordinary stack update - a stack that stays above zero - from
  -- queueing anything at all.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.table_seats'::regclass
                   AND tgname = 'trg_table_seats_lightning_pool_on_insert') THEN
    CREATE CONSTRAINT TRIGGER trg_table_seats_lightning_pool_on_insert
      AFTER INSERT ON public.table_seats
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      WHEN (NEW.left_at IS NULL AND NEW.user_id IS NOT NULL AND coalesce(NEW.stack, 0) > 0
            AND coalesce(NEW.is_sitting_out, false) = false
            AND coalesce(NEW.leave_pending, false) = false)
      EXECUTE FUNCTION public.fn_table_seats_lightning_pool_follows_seat();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.table_seats'::regclass
                   AND tgname = 'trg_table_seats_lightning_pool_follows_seat') THEN
    CREATE CONSTRAINT TRIGGER trg_table_seats_lightning_pool_follows_seat
      AFTER UPDATE ON public.table_seats
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      WHEN (OLD.left_at IS DISTINCT FROM NEW.left_at
            OR OLD.user_id IS DISTINCT FROM NEW.user_id
            OR OLD.is_sitting_out IS DISTINCT FROM NEW.is_sitting_out
            OR OLD.leave_pending IS DISTINCT FROM NEW.leave_pending
            OR (coalesce(OLD.stack, 0) > 0) IS DISTINCT FROM (coalesce(NEW.stack, 0) > 0))
      EXECUTE FUNCTION public.fn_table_seats_lightning_pool_follows_seat();
  END IF;
END
$seat_triggers$;

-- FOUR TRIGGERS ON A MONEY TABLE, DECLARED IN THE MIGRATION THAT CREATES THEM.
INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note) VALUES
  ('table_seats', 'trg_table_seats_lightning_anchor_guard',
   'Lightning remediation two (file D). BEFORE UPDATE, WHEN stack, left_at or user_id changes: refuses (LIGHTNING_HAND_IN_PROGRESS, SQLSTATE PLT01) any change to a seat that anchors an open Lightning pool session whose player is in a live Lightning hand, unless ca.lightning_settlement_hand names that hand. Writes nothing; one index probe for every other seat.'),
  ('table_seats', 'trg_table_seats_lightning_anchor_delete_guard',
   'Lightning remediation two (file D). BEFORE DELETE: refuses (LIGHTNING_ANCHOR_SEAT_IS_IN_THE_POOL, PLT01) deleting a seat that anchors an OPEN Lightning pool session; a departed seat whose session has exited deletes normally. Writes nothing.'),
  ('table_seats', 'trg_table_seats_lightning_pool_on_insert',
   'Lightning remediation two (file D). Deferred AFTER INSERT, WHEN the seat is live eligible: enters the seat into the Lightning pool of a lightning-mode Cluster (fn_lightning_pool_enter). Writes lightning_pool_session, lightning_pool_slot and cash_cluster_events only; never a stack.'),
  ('table_seats', 'trg_table_seats_lightning_pool_follows_seat',
   'Lightning remediation two (file D). Deferred AFTER UPDATE, WHEN left_at, user_id, is_sitting_out or leave_pending changes or the stack crosses zero: exits the pool session of an anchor that left or turned over and enters a seat that became eligible. Writes lightning_pool_session, lightning_pool_slot and cash_cluster_events only; never a stack.')
ON CONFLICT (table_name, trigger_name) DO NOTHING;

DO $readback$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(q.what, '; ') INTO v_bad FROM (VALUES
    ('the guard fires before update only when stack, left_at or user_id moves', EXISTS (SELECT 1 FROM pg_trigger t
        WHERE t.tgrelid = 'public.table_seats'::regclass AND t.tgname = 'trg_table_seats_lightning_anchor_guard'
          AND (t.tgtype::integer & 2) <> 0 AND (t.tgtype::integer & 16) <> 0 AND t.tgenabled = 'O'
          AND pg_get_triggerdef(t.oid) ~ 'old\.stack IS DISTINCT FROM new\.stack'
          AND pg_get_triggerdef(t.oid) ~ 'old\.left_at IS DISTINCT FROM new\.left_at')),
    ('the delete guard fires before delete', EXISTS (SELECT 1 FROM pg_trigger t
        WHERE t.tgrelid = 'public.table_seats'::regclass AND t.tgname = 'trg_table_seats_lightning_anchor_delete_guard'
          AND (t.tgtype::integer & 2) <> 0 AND (t.tgtype::integer & 8) <> 0 AND t.tgenabled = 'O'
          AND t.tgfoid = 'public.fn_table_seats_lightning_anchor_guard()'::regprocedure)),
    ('the two deferred pool triggers', (SELECT count(*) = 2 FROM pg_trigger t
        WHERE t.tgrelid = 'public.table_seats'::regclass
          AND t.tgname IN ('trg_table_seats_lightning_pool_on_insert', 'trg_table_seats_lightning_pool_follows_seat')
          AND t.tgdeferrable AND t.tginitdeferred AND t.tgenabled = 'O' AND t.tgqual IS NOT NULL)),
    ('the four declarations', (SELECT count(*) = 4 FROM public.ca_declared_money_triggers
        WHERE table_name = 'table_seats' AND trigger_name IN ('trg_table_seats_lightning_anchor_guard',
          'trg_table_seats_lightning_anchor_delete_guard', 'trg_table_seats_lightning_pool_on_insert',
          'trg_table_seats_lightning_pool_follows_seat')))
  ) q(what, ok) WHERE q.ok IS DISTINCT FROM true;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'LIGHTNING_REMEDIATION_TWO_READBACK: the catalogue does not carry: %', v_bad;
  END IF;
END
$readback$;

COMMIT;
