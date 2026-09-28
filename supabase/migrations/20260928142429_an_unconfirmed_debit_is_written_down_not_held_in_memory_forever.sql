-- ════════════════════════════════════════════════════════════════════════════
--  AN UNCONFIRMED DEBIT IS WRITTEN DOWN, NOT HELD IN MEMORY FOREVER
--  (2026-09-28)
-- ════════════════════════════════════════════════════════════════════════════
--
-- `fn_consume_time_bank` is a non-idempotent debit against a player's ACCOUNT
-- entitlement (VIP allowance, purchased uses). The engine sends it best-effort
-- from `handleTimeBankTerminalEvent`: gameplay never waits for it. When the
-- reply is lost, the engine sets `timeBankAccountingUnconfirmed`, whose comment
-- states the constraint exactly:
--
--     // An unacknowledged non-idempotent debit must not be retried or certified.
--
-- Both halves of that are right. What was missing is the third outcome. The
-- flag had NO clearing path anywhere in the codebase, and every consumer reads
-- it as "this table's stopped time bank is not on disk":
--
--   · `shouldPersistStoppedCustody()` refuses while it is set, so the stopped
--     bank is never written;
--   · `persistPresenceForRestart('parked')` throws over it, so the bank is not
--     written on that path either;
--   · `hasUnretiredStoppedTimeBankCustody()` returns true from it directly, so
--     every manager stop fails `retained time-bank custody`;
--   · `maintenanceDurabilityReason()` answers `stopped_bank_custody_*`, which
--     refuses the platform restart.
--
-- Measured 2026-09-28: ONE `fn_consume_time_bank` reply lost to
-- `supabase_timeout` latched one table of tournament 87a68e55. Its manager
-- failed to stop 112 times over 115 minutes, its 43 tables and 335 seated
-- players were frozen from 12:19Z, and the same table reported
-- `stopped_bank_custody_stuck` past its 600s bound - which refuses the hourly
-- restart, so the one mechanism that would have cleared it was shut by it.
-- An unbounded fail-closed gate on a resource the whole platform shares is the
-- defect this platform's own census bounded for the F06 class in #4909, for the
-- reason written there: "a stuck table never recovers" is the worse bug.
--
-- A debit that cannot be retried and cannot be certified can still be WRITTEN
-- DOWN. This is where it goes. Once the owed seconds are on disk against an
-- idempotency key the engine chose before it sent them, the process is no
-- longer the only place that knows: the seconds are neither lost (as they are
-- today the moment the process dies) nor double-charged (the key refuses a
-- replay), and the in-memory question has an answer. Nothing here debits
-- anything - settlement is a separate, deliberate act.

-- ── THE RECORD OF A DEBIT WHOSE OUTCOME NOBODY KNOWS ───────────────────────
CREATE TABLE smarter_private.time_bank_consume_unconfirmed (
  attempt_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  seconds integer NOT NULL,
  table_id uuid NOT NULL,
  tournament_id uuid,
  hand_number bigint,
  engine_instance text NOT NULL,
  reason text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  settlement text,
  CHECK (seconds > 0),
  CHECK (length(engine_instance) BETWEEN 1 AND 200),
  CHECK (length(reason) BETWEEN 1 AND 500),
  CHECK (settlement IS NULL OR settlement IN ('applied', 'not_applied', 'written_off')),
  CHECK ((settled_at IS NULL) = (settlement IS NULL))
);
ALTER TABLE smarter_private.time_bank_consume_unconfirmed ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.time_bank_consume_unconfirmed
  FROM PUBLIC, anon, authenticated, service_role;
CREATE INDEX time_bank_consume_unconfirmed_open
  ON smarter_private.time_bank_consume_unconfirmed (recorded_at)
  WHERE settled_at IS NULL;

/* Append-only but for its ONE designed transition: a reconciler that has
   determined what actually happened to the debit stamps the outcome once.
   Nothing else about the row may change, and no row may be deleted - the
   seconds a player was charged (or was not) are not erasable. */
CREATE FUNCTION smarter_private.time_bank_consume_unconfirmed_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $imm$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'TIME_BANK_CONSUME_UNCONFIRMED_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF OLD.settled_at IS NOT NULL THEN
    RAISE EXCEPTION 'TIME_BANK_CONSUME_UNCONFIRMED_ALREADY_SETTLED' USING ERRCODE = '55000';
  END IF;
  IF (NEW.attempt_id, NEW.user_id, NEW.seconds, NEW.table_id, NEW.tournament_id,
      NEW.hand_number, NEW.engine_instance, NEW.reason, NEW.recorded_at)
     IS DISTINCT FROM
     (OLD.attempt_id, OLD.user_id, OLD.seconds, OLD.table_id, OLD.tournament_id,
      OLD.hand_number, OLD.engine_instance, OLD.reason, OLD.recorded_at) THEN
    RAISE EXCEPTION 'TIME_BANK_CONSUME_UNCONFIRMED_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.settled_at IS NULL THEN
    RAISE EXCEPTION 'TIME_BANK_CONSUME_UNCONFIRMED_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $imm$;
REVOKE ALL ON FUNCTION smarter_private.time_bank_consume_unconfirmed_immutable()
  FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER time_bank_consume_unconfirmed_immutable BEFORE UPDATE OR DELETE
  ON smarter_private.time_bank_consume_unconfirmed FOR EACH ROW
  EXECUTE FUNCTION smarter_private.time_bank_consume_unconfirmed_immutable();

COMMENT ON TABLE smarter_private.time_bank_consume_unconfirmed IS
  'One row per fn_consume_time_bank debit whose reply the engine never got. The engine chooses attempt_id BEFORE it sends the debit, so recording it later is exactly-once and a replay charges nobody twice. Written only by fn_record_unconfirmed_time_bank_consume, as the process, never under a tournament lease. Append-only but for one settlement stamp. It records that seconds are owed and unverified; it debits nothing. 2026-09-28.';

-- ── THE DOOR ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_record_unconfirmed_time_bank_consume(
  p_attempt_id uuid,
  p_user_id uuid,
  p_seconds integer,
  p_table_id uuid,
  p_engine_instance text,
  p_reason text,
  p_tournament_id uuid DEFAULT NULL,
  p_hand_number bigint DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE
  v_existing smarter_private.time_bank_consume_unconfirmed;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'fn_record_unconfirmed_time_bank_consume is engine-only';
  END IF;
  IF p_attempt_id IS NULL OR p_user_id IS NULL OR p_table_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'refused', 'incomplete_attestation');
  END IF;
  IF p_seconds IS NULL OR p_seconds <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'refused', 'seconds_not_positive');
  END IF;
  IF p_engine_instance IS NULL OR length(p_engine_instance) = 0
     OR p_reason IS NULL OR length(p_reason) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'refused', 'unnamed_attempt');
  END IF;

  /* The engine chose this id before it sent the debit, so the SAME unanswered
     debit recorded twice is one row, and a genuinely different debit cannot
     collide with it. A replay whose terms disagree is not this attempt and is
     refused rather than silently folded into it. */
  SELECT * INTO v_existing
    FROM smarter_private.time_bank_consume_unconfirmed t
   WHERE t.attempt_id = p_attempt_id;
  IF FOUND THEN
    IF (v_existing.user_id, v_existing.seconds, v_existing.table_id)
       IS DISTINCT FROM (p_user_id, p_seconds, p_table_id) THEN
      RETURN jsonb_build_object('ok', false, 'refused', 'attempt_terms_differ',
                                'attempt_id', p_attempt_id);
    END IF;
    RETURN jsonb_build_object('ok', true, 'attempt_id', p_attempt_id, 'replayed', true);
  END IF;

  INSERT INTO smarter_private.time_bank_consume_unconfirmed
    (attempt_id, user_id, seconds, table_id, tournament_id, hand_number,
     engine_instance, reason)
  VALUES
    (p_attempt_id, p_user_id, p_seconds, p_table_id, p_tournament_id, p_hand_number,
     left(p_engine_instance, 200), left(p_reason, 500))
  ON CONFLICT (attempt_id) DO NOTHING;

  RETURN jsonb_build_object('ok', true, 'attempt_id', p_attempt_id, 'replayed', false);
END
$function$;

REVOKE ALL ON FUNCTION public.fn_record_unconfirmed_time_bank_consume(uuid,uuid,integer,uuid,text,text,uuid,bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_record_unconfirmed_time_bank_consume(uuid,uuid,integer,uuid,text,text,uuid,bigint)
  TO service_role;

COMMENT ON FUNCTION public.fn_record_unconfirmed_time_bank_consume(uuid,uuid,integer,uuid,text,text,uuid,bigint) IS
  'Record one fn_consume_time_bank debit whose outcome the engine never learned, under the id the engine chose before it sent it. Exactly-once by that id; refuses a replay whose terms differ. Debits nothing and grants nothing: it makes an unknown durable so no engine has to hold it in memory forever. 2026-09-28.';
