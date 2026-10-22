-- A deadlocked bust payment yields to its partner instead of retrying
-- (2026-10-22).
--
-- 20261022030638 retried a deadlocked payment (40P01) up to four times. The
-- postgres log for the Midnight Bounty at 06:11:38-06:11:42 UTC shows process
-- 38717 detect the deadlock on the tournament's settlement lane at 38.8, 39.8,
-- 40.9 and 42.1 s: each retry closed the same cycle, because its partner was
-- waiting on the tournaments row (relation 27579) this transaction holds from
-- its own top-level write. A subtransaction cannot release that, so a retry
-- can never succeed; it only held the engine's hand commit four seconds.
--
-- The cycle resolves itself: Postgres aborts this payment step, this
-- transaction commits, and its partner gets the lock. When the partner is
-- another bust's payer (the case both refusals so far), it reads the committed
-- bust with a fresh READ COMMITTED snapshot and pays every unpaid place; any
-- other partner leaves it to the next bust of the event or the terminal
-- settlement, both of which pay every unpaid place. Measured today: 827 paid places since 02:00 UTC,
-- median 2.4 s from bust to wallet, 99th percentile 17 s. A lock timeout
-- (55P03) or serialization failure (40001) is not a cycle and still retries.

BEGIN;

SET LOCAL lock_timeout = '5s';

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

  /* A DEADLOCK IS NEVER RETRIED HERE (2026-10-22). Measured at 06:11:38 UTC:
     every retry of a deadlocked payment deadlocked again, four times, 1 s
     each, because the other member of the cycle waits on a lock this
     transaction holds at top level (its tournaments row, or its hand
     settlement's shared tournament lane), which no subtransaction can give
     back. Retrying only held the hand commit four seconds longer. The partner
     proceeds the moment this transaction commits; a partner that is another
     bust's payer reads the committed bust and pays it, and otherwise the next
     bust or the terminal settlement does. A lock timeout or serialization
     failure is not a cycle, so those still retry. */
  LOOP
    v_attempt := v_attempt + 1;
    BEGIN
      v_result := public.fn_ca_pay_tournament_finishers_now(v_tournament_id);
      EXIT;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
      v_result := jsonb_build_object('ok', false, 'sqlstate', v_state,
                                     'error', v_message, 'attempts', v_attempt);
      EXIT WHEN v_state NOT IN ('55P03', '40001') OR v_attempt >= 4;
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
