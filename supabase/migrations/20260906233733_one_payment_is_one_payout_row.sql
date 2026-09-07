-- ONE PAYMENT IS ONE PAYOUT ROW, AND THIS ONE WAS RECORDED TWICE BY ME.
--
-- Found while checking whether the 35 overfilled heads-up events conserved.
-- 32 of the 35 balance to the cent. Two are satellites, where
-- `tournament_payouts` mixes seat awards (prize_liability -> prize_liability
-- transfers) with cash credits, so summing the column against `prize_pool` was
-- never the right comparison. THE THIRD IS MINE.
--
-- Tournament 3e281f5c-2479-42dc-bf6e-afb007d9988f, a three-entry sit-and-go
-- with a 71.25 pool, holds FOUR payout rows totalling 142.50 - exactly twice
-- the pool. All four were written in the same instant, 15:41:36.203055 today:
--
--   47.50  2e26ae7c  recorded_by credit_and_log        idempotency_key set
--   23.75  00000...28 recorded_by credit_and_log       idempotency_key set
--   47.50  2e26ae7c  recorded_by operator.cowork-claude   key NULL
--   23.75  00000...28 recorded_by operator.cowork-claude   key NULL
--
-- and the second pair carries `metadata->>'migration' =
-- '20260906153943_the_suspended_heads_up_is_settled_by_a_chip_proportional_dea'`.
-- That migration is mine, from earlier today. It credited the two players
-- through the platform's own idempotent path AND recorded the payout itself,
-- not knowing that `fn_credit_and_log` records it too.
--
-- NOBODY WAS PAID TWICE, and the ledger is what says so rather than my
-- reasoning about it. `chip_ledger` for that tournament holds exactly three
-- rows after 15:00: 47.50 prize_liability -> player_wallet, 23.75
-- prize_liability -> player_wallet, 3.75 prize_liability -> union rake wallet.
-- 75.00 total, which is 3 entries x 25.00, conserving to the cent. The money
-- moved once. It is the RECORD that says it moved twice.
--
-- WHY THAT STILL MATTERS ENOUGH TO FIX. `tournament_payouts` is what a
-- conservation query sums - it is exactly what I summed an hour ago - so this
-- event reads as a 71.25 overpay to anyone who looks, for ever. The next agent
-- to check this platform's books finds an overpay that never happened and
-- spends a day on it, or worse, "corrects" it. A payment with no explanation
-- attached is the next agent's mystery (CLAUDE.md 10.9), and so is a payment
-- recorded twice.
--
-- WHAT IS DONE HERE
--
-- 1. The two rows I wrote are REMOVED, and the removal is filed in
--    ca_drift_incidents with the ids, the amounts, the players, the surviving
--    rows and the ledger evidence - so nothing is quietly erased and the whole
--    of it can be read back. This is not deleting a settled record to tidy a
--    number (10.9 forbids that): the settled record is the pair the platform's
--    own credit path wrote, and it stays exactly as it is. What goes is a
--    second copy of it that my migration added beside it.
--
-- 2. Two older rows written by `agent_reconciliation` on 2026-09-04 carry no
--    idempotency key either. They are NOT duplicates - each is the only row
--    for its payment - so they are keyed, not removed.
--
-- 3. THE CAUSE IS CLOSED AT THE WRITE. `uq_tournament_payouts_idempotency_key`
--    is a UNIQUE index that only applies `WHERE idempotency_key IS NOT NULL`,
--    so a row with no key is exempt from the one thing that stops a payment
--    being recorded twice. From now on a payout row cannot arrive without a
--    key: if a writer does not supply one, the trigger DERIVES it. It never
--    refuses - a guard that can refuse a payout row could leave a credited
--    player with no record, which is the wrong failure (11.5) - it fills in
--    the blank and lets the unique index do its work.
--
--    The repo half of this rule is
--    `tests/one-payment-is-one-payout-row.law.test.ts`: a migration that
--    credits through the platform's idempotent path must not also hand-write
--    the payout row. That is the mistake itself, and no trigger can see it.
--
-- THE TABLE ITSELF REFUSED THE FIRST ATTEMPT, and it was right to.
-- `trg_tournament_payouts_append_only` raised
-- `tournament_payouts is an append-only payout record; DELETE is refused`,
-- and its own HINT says how a correction is meant to be made:
--
--   'A DBA correcting a bad row must SET LOCAL app.payout_record_correction =
--    ''i_am_correcting_the_record'' in the same transaction, from a migration
--    that says why.'
--
-- That is this migration, and the setting is below. It is deliberately not a
-- quiet override: the flag is scoped to this transaction, it only works for
-- session_user postgres, and the reason has to be written down beside it -
-- which is the whole file above, plus the ca_drift_incidents row that records
-- exactly which rows went and what stands in their place.
--
-- One transaction, per the production DDL policy in section 2.

BEGIN;

SET LOCAL lock_timeout = '4s';
SET LOCAL app.payout_record_correction = 'i_am_correcting_the_record';

/* THE STRONGEST LOCK FIRST. The first run of this migration corrected the two
   rows and THEN created the trigger, which needs ACCESS EXCLUSIVE on a table
   live settlements are inserting into - so it held row locks while waiting for
   a table lock held against it, and deadlocked (40P01, 00:02:28). Nothing was
   applied. Taking the table lock up front means this transaction acquires
   everything in one direction and can only ever wait, never deadlock; if the
   table is busy the 4s timeout aborts it cleanly and it is simply run again. */
LOCK TABLE public.tournament_payouts IN ACCESS EXCLUSIVE MODE;

-- ---------------------------------------------------------------------------
-- 1 + 2. THE FOUR UNKEYED ROWS: two removed with the reason on the record,
--        two keyed.
-- ---------------------------------------------------------------------------
DO $settle$
DECLARE
  v_dupes   jsonb;
  v_removed int;
  v_keyed   int;
BEGIN
  /* Read them first, so what is removed is recorded before it is gone. */
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'removed_row', p.id, 'tournament_id', p.tournament_id,
           'user_id', p.user_id, 'amount', p.amount, 'source', p.source,
           'recorded_by', p.recorded_by, 'created_at', p.created_at,
           'metadata', p.metadata,
           'the_row_that_stands', (SELECT q.id FROM public.tournament_payouts q
                                    WHERE q.tournament_id = p.tournament_id
                                      AND q.user_id = p.user_id
                                      AND q.amount = p.amount
                                      AND q.idempotency_key IS NOT NULL
                                    LIMIT 1))), '[]'::jsonb)
    INTO v_dupes
    FROM public.tournament_payouts p
   WHERE p.idempotency_key IS NULL
     AND p.recorded_by = 'operator.cowork-claude'
     AND EXISTS (SELECT 1 FROM public.tournament_payouts q
                  WHERE q.tournament_id = p.tournament_id
                    AND q.user_id = p.user_id
                    AND q.amount = p.amount
                    AND q.idempotency_key IS NOT NULL);

  IF jsonb_array_length(v_dupes) <> 2 THEN
    RAISE EXCEPTION 'ABORT: expected exactly 2 duplicate payout records to remove, found % - read the table before proceeding',
      jsonb_array_length(v_dupes);
  END IF;

  INSERT INTO public.ca_drift_incidents
    (source, dedupe_key, tournament_id, classification, layer, severity,
     suspected_cause, metadata, resolution, resolved_at)
  VALUES
    ('one_payment_is_one_payout_row',
     'payout_recorded_twice:3e281f5c-2479-42dc-bf6e-afb007d9988f',
     '3e281f5c-2479-42dc-bf6e-afb007d9988f',
     'settlement_error', 'ledger', 'info',
     'migration 20260906153943 recorded the payout itself while also crediting through fn_credit_and_log, which records it too',
     jsonb_build_object(
       'removed', v_dupes,
       'money_moved_once', true,
       'ledger_evidence', 'chip_ledger for this tournament after 15:00 holds exactly 47.50 + 23.75 to the two players and 3.75 rake = 75.00 = 3 entries x 25.00',
       'pool', 71.25, 'recorded_before', 142.50, 'recorded_after', 71.25),
     'The two rows written by the migration are removed; the pair written by the platform''s own credit path stands unchanged. No wallet was touched: the players were each credited once and remain so.',
     now())
  ON CONFLICT DO NOTHING;

  WITH gone AS (
    DELETE FROM public.tournament_payouts p
     WHERE p.idempotency_key IS NULL
       AND p.recorded_by = 'operator.cowork-claude'
       AND EXISTS (SELECT 1 FROM public.tournament_payouts q
                    WHERE q.tournament_id = p.tournament_id
                      AND q.user_id = p.user_id
                      AND q.amount = p.amount
                      AND q.idempotency_key IS NOT NULL)
    RETURNING 1)
  SELECT count(*) INTO v_removed FROM gone;

  IF v_removed <> 2 THEN
    RAISE EXCEPTION 'VERIFY FAILED: removed % duplicate payout record(s), expected 2', v_removed;
  END IF;

  /* The reconciliation rows are single records. They get the key they should
     have carried, derived from what they are - never removed. */
  WITH keyed AS (
    UPDATE public.tournament_payouts p
       SET idempotency_key = 'tourney:' || p.tournament_id::text || ':' ||
                             COALESCE(p.source, 'payout') || ':' || p.user_id::text || ':' ||
                             to_char(p.amount, 'FM9999999990.00')
     WHERE p.idempotency_key IS NULL
    RETURNING 1)
  SELECT count(*) INTO v_keyed FROM keyed;

  RAISE NOTICE 'ONE_PAYMENT_ONE_ROW removed % duplicate record(s), keyed % previously unkeyed row(s)', v_removed, v_keyed;
END $settle$;

-- ---------------------------------------------------------------------------
-- 3. A PAYOUT ROW CANNOT ARRIVE WITHOUT A KEY AGAIN.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.zz_a_payout_row_carries_its_key()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  /* It fills the blank, it never refuses. A guard that can refuse a payout row
     could leave a credited player with no record of the credit, and that is the
     worse failure (CLAUDE.md 11.5). With a key present,
     uq_tournament_payouts_idempotency_key - which is partial, WHERE
     idempotency_key IS NOT NULL - can finally do the job it was built for. */
  IF NEW.idempotency_key IS NULL THEN
    NEW.idempotency_key := 'tourney:' || COALESCE(NEW.tournament_id::text, 'none') || ':' ||
                           COALESCE(NEW.source, 'payout') || ':' ||
                           COALESCE(NEW.user_id::text, 'none') || ':' ||
                           to_char(COALESCE(NEW.amount, 0), 'FM9999999990.00') || ':' ||
                           COALESCE(NEW.position::text, 'x');
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.zz_a_payout_row_carries_its_key() IS
  'BEFORE INSERT on tournament_payouts: derives an idempotency key when the writer supplied none, so the partial unique index on that column applies to every row. Added 2026-09-06 after a settlement migration recorded a payout that fn_credit_and_log had already recorded. It never refuses a row.';

REVOKE ALL ON FUNCTION public.zz_a_payout_row_carries_its_key() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zz_a_payout_row_carries_its_key ON public.tournament_payouts;
CREATE TRIGGER zz_a_payout_row_carries_its_key
  BEFORE INSERT ON public.tournament_payouts
  FOR EACH ROW EXECUTE FUNCTION public.zz_a_payout_row_carries_its_key();

-- ---------------------------------------------------------------------------
-- PROVE IT: the event now records what it paid, no row anywhere lacks a key,
-- and a row inserted without one is given one rather than refused.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_paid    numeric;
  v_unkeyed int;
  v_got_key text;
BEGIN
  SELECT COALESCE(sum(amount), 0) INTO v_paid
    FROM public.tournament_payouts
   WHERE tournament_id = '3e281f5c-2479-42dc-bf6e-afb007d9988f';
  IF v_paid <> 71.25 THEN
    RAISE EXCEPTION 'VERIFY FAILED: the event records % paid against a 71.25 pool', v_paid;
  END IF;

  SELECT count(*) INTO v_unkeyed FROM public.tournament_payouts WHERE idempotency_key IS NULL;
  IF v_unkeyed <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: % payout row(s) still carry no idempotency key', v_unkeyed;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.tournament_payouts'::regclass
                    AND tgname = 'zz_a_payout_row_carries_its_key'
                    AND NOT tgisinternal AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'VERIFY FAILED: the key trigger is not armed on tournament_payouts';
  END IF;

  /* The trigger fills a blank rather than refusing - proved on a row that is
     rolled back with the probe (CLAUDE.md 11.5). */
  BEGIN
    INSERT INTO public.tournament_payouts (tournament_id, user_id, amount, source, recorded_by)
    VALUES ('3e281f5c-2479-42dc-bf6e-afb007d9988f',
            (SELECT user_id FROM public.tournament_payouts
              WHERE tournament_id = '3e281f5c-2479-42dc-bf6e-afb007d9988f' LIMIT 1),
            0.01, 'zz_key_probe', 'zz_key_probe')
    RETURNING idempotency_key INTO v_got_key;
    RAISE EXCEPTION 'zz_rollback_the_probe';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'zz_rollback_the_probe' THEN RAISE; END IF;
  END;

  IF v_got_key IS NULL OR v_got_key NOT LIKE 'tourney:%zz_key_probe%' THEN
    RAISE EXCEPTION 'VERIFY FAILED: a row inserted with no key did not receive one (got %)', COALESCE(v_got_key, 'NULL');
  END IF;

  IF EXISTS (SELECT 1 FROM public.tournament_payouts WHERE source = 'zz_key_probe') THEN
    RAISE EXCEPTION 'VERIFY FAILED: the probe row survived its own rollback';
  END IF;

  RAISE NOTICE 'ONE_PAYMENT_ONE_ROW 3e281f5c records 71.25 against a 71.25 pool; 0 payout rows carry no key; an unkeyed insert is given one, not refused';
END $verify$;

COMMIT;
