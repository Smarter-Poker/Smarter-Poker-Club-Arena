-- A registering player refreshes the provisional ladder, and a deadlocked
-- bust payment retries inside its own transaction (2026-10-22).
--
-- 1. THE PROVISIONAL LADDER WAS SKIPPED WHENEVER A PERSON REGISTERED.
--    Read from the postgres log at 02:58:35 UTC: "provisional payout ladder
--    refresh for 62a7c3b1-... failed: Tournament contract cannot be modified
--    after a player has registered". The Midweek Mystery sat at 25 places for
--    a 201-player field (12.5% of 201 is 26) until the next engine-written
--    entry refreshed it. The cause is fn_guard_registered_tournament_contract:
--    it refuses any contract change while auth.uid() is set, and a browser
--    registration runs the AFTER INSERT ladder trigger inside that player's
--    request, so the refresh was refused for every human entry and only
--    horse and engine entries moved the ladder. 20261022020721 taught
--    fn_guard_managed_game_lifecycle the one exception and missed this second
--    guard. It now admits the same single value: until the pool is finalized,
--    payout_structure may change only to the derived ladder of the current
--    field at its paid depth. Every other contract field keeps its refusal.
--
-- 2. A BUST PAYMENT THAT LOST A DEADLOCK WAS NOT RETRIED.
--    financial_alerts 'tournament.real_time_payout_refused' for Nightly 10K
--    (dd9114ae-...) at 01:42:37 UTC: sqlstate 40P01, deadlock detected. The
--    payer runs at commit and restamps standings that another table's commit
--    can be holding, so two simultaneous busts can each wait on the other.
--    Postgres kills one; the bust stood, the payment step was dropped and
--    left for the next bust or the terminal settlement. Nothing was owed in
--    that case (0 obligations; the field was still far from the money), but
--    the same race in the money would have delayed a payment. The deferred
--    wrapper now retries a deadlock, lock timeout or serialization failure up
--    to four times in a fresh subtransaction, with a short growing wait so
--    the winner of the deadlock can commit first. Only a refusal that
--    survives every attempt is recorded. This is the live path retrying
--    inside its own transaction, not a sweep.
--
-- Verified after apply with one self-aborting DO block: under a set
-- auth.uid() the guard admits the derived ladder and still refuses any other
-- ladder or any other contract field.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_guard_registered_tournament_contract()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old jsonb;
  v_new jsonb;
BEGIN
  v_old := public.fn_managed_game_contract_document('tournament', to_jsonb(OLD));
  v_new := public.fn_managed_game_contract_document('tournament', to_jsonb(NEW));

  -- THE PROVISIONAL LADDER FOLLOWS THE FIELD (Dan 2026-10-21): until the pool
  -- is finalized, payout_structure may take exactly one value, the paid depth
  -- of the current field. A browser registration refreshes it inside the
  -- player's own request, so this holds whoever is signed in.
  IF NOT COALESCE(OLD.prize_pool_finalized, false)
     AND NOT COALESCE(NEW.prize_pool_finalized, false)
     AND OLD.payout_structure IS DISTINCT FROM NEW.payout_structure
     AND public.fn_safe_jsonb_array(NEW.payout_structure::text)
         IS NOT DISTINCT FROM public.fn_ca_provisional_payout_structure(NEW.id) THEN
    v_old := v_old - 'payout_structure';
    v_new := v_new - 'payout_structure';
  END IF;

  -- auth.uid() is present for an operator/browser request and null for the
  -- service-role tournament engine. The engine may execute deterministic
  -- lifecycle adaptations such as fitting a payout ladder to the final field;
  -- those changes are captured as a new system revision below. Operators can
  -- never use that exception because their JWT keeps auth.uid() populated.
  IF auth.uid() IS NOT NULL AND v_old IS DISTINCT FROM v_new AND EXISTS (
    SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'Tournament contract cannot be modified after a player has registered'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_guard_registered_tournament_contract() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.trg_ca_pay_tournament_finishers_at_commit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_flag text;
  v_result jsonb;
  v_state text;
  v_message text;
  v_attempt integer := 0;
BEGIN
  IF TG_TABLE_NAME = 'tournaments' THEN
    v_tournament_id := NEW.id;
  ELSE
    v_tournament_id := NEW.tournament_id;
  END IF;
  IF v_tournament_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Deferred triggers fire at COMMIT after every row is written, so one call
  -- per tournament per transaction sees the whole batch.
  v_flag := 'ca_instant_pay.t' || replace(v_tournament_id::text, '-', '');
  IF current_setting(v_flag, true) = 'done' THEN
    RETURN NULL;
  END IF;
  PERFORM set_config(v_flag, 'done', true);

  /* Two tables committing busts at once can each hold a standing the other
     restamps. Postgres ends that by killing one; the killed attempt's
     subtransaction releases what it took, the winner commits, and the retry
     then sees a settled board. Only these transient lock outcomes retry. */
  LOOP
    v_attempt := v_attempt + 1;
    BEGIN
      v_result := public.fn_ca_pay_tournament_finishers_now(v_tournament_id);
      EXIT;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
      v_result := jsonb_build_object('ok', false, 'sqlstate', v_state,
                                     'error', v_message, 'attempts', v_attempt);
      EXIT WHEN v_state NOT IN ('40P01', '55P03', '40001') OR v_attempt >= 4;
      PERFORM pg_sleep(0.05 * v_attempt);
    END;
  END LOOP;

  IF COALESCE((v_result->>'ok')::boolean, false) IS NOT TRUE THEN
    -- The bust stays recorded and the terminal settlement still pays the
    -- place; this says, once per event, that it was not paid at the bust.
    INSERT INTO public.financial_alerts(severity, source, message, context)
    SELECT 'warning', 'tournament.real_time_payout_refused',
           'A finisher was not paid at the moment of the bust; the terminal settlement will pay the place.',
           jsonb_build_object('tournament_id', v_tournament_id, 'result', v_result)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts fa
        WHERE fa.source = 'tournament.real_time_payout_refused'
          AND NOT fa.resolved
          AND fa.context->>'tournament_id' = v_tournament_id::text);
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_ca_pay_tournament_finishers_at_commit() FROM PUBLIC, anon, authenticated;

COMMIT;
