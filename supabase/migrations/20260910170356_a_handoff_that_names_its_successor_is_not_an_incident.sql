-- a_handoff_that_names_its_successor_is_not_an_incident
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Incident 6ef0e37d opened at 16:46 from
-- ServerTableEngine.post_commit_obligations_pending, whose own message reads:
--
--   "Hand ...#9221460 committed, but this engine abandoned its durable
--    post-commit envelope behind the causal settlement barrier after 0
--    attempt(s); the outbox row remains authoritative and the projection
--    worker is its successor"
--
-- MEASURED: the hand is in hand_history and has its hand_atomic_commits
-- receipt, so it committed. `attempts` is ZERO - nothing was tried and failed;
-- the engine handed the envelope on rather than doing the work itself. And this
-- is not rare: 274 of these in the last 24 hours and 1,485 since the source
-- existed. It is the ordinary shape of an engine stepping back from post-commit
-- projection at a barrier, and the message names its own successor.
--
-- fn_ca_financial_alert_to_incident promotes only `critical`, and the engine
-- writes this one as critical, so the bridge dutifully files it. The severity
-- rule downgrades it to `info` - correct, it names no chip - but an `info`
-- board item that recurs 274 times a day is still an item somebody has to
-- clear, and it is the fourth instance today of our own routine machinery
-- setting off an alarm.
--
-- THE PRECEDENT IS ALREADY IN THIS FUNCTION, written 2026-09-09 for the same
-- reason: "A REFUSED HAND IS A RATE, NOT AN INCIDENT ... promoting each refused
-- hand here as well only fills the money board faster than it can be read." A
-- post-commit envelope handed to the durable outbox is the same kind of fact.
-- This adds it to that list rather than inventing a new mechanism.
--
-- NOTHING IS HIDDEN. The alert is still written to financial_alerts and still
-- counted, exactly as the refusal exemption leaves refusals visible. What stops
-- is one board item per distinct message shape for a handoff that succeeded.
-- If the outbox itself ever stops draining, that is a different source and it
-- raises on its own terms.
--
-- fn_ca_financial_alert_to_incident is on fn_ca_guard_watchlist(), so this
-- declares its own redefinition in the same transaction
-- (a_declared_guard_change_is_recorded_not_raised, today) - otherwise the guard
-- watcher would open a notice about this very migration.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $body$
DECLARE
  v_def text;
  v_n integer;
  v_rows integer;
  v_old text := E'  IF NEW.source = ''ServerTableEngine.authoritative_hand_semantic_refusal''\n'
             || E'     OR COALESCE(NEW.context->>''error'', '''') LIKE ''%authoritative_hand_semantic_refusal%'' THEN\n'
             || E'    RETURN NEW;\n'
             || E'  END IF;\n';
  v_new text := E'  IF NEW.source = ''ServerTableEngine.authoritative_hand_semantic_refusal''\n'
             || E'     OR COALESCE(NEW.context->>''error'', '''') LIKE ''%authoritative_hand_semantic_refusal%'' THEN\n'
             || E'    RETURN NEW;\n'
             || E'  END IF;\n'
             || E'\n'
             || E'  /* A HANDOFF THAT NAMES ITS SUCCESSOR IS NOT AN INCIDENT (2026-09-10).\n'
             || E'     post_commit_obligations_pending says the hand COMMITTED and that the\n'
             || E'     engine handed its post-commit envelope to the durable outbox - after\n'
             || E'     zero attempts, because nothing failed; it stepped back at the causal\n'
             || E'     settlement barrier and named the projection worker as its successor.\n'
             || E'     274 of them in 24 hours and 1,485 since the source existed. Same\n'
             || E'     reasoning as the refusal exemption above: the alert is still written\n'
             || E'     to financial_alerts and still counted, but one board item per message\n'
             || E'     shape for work that succeeded only fills the money board faster than\n'
             || E'     it can be read. An outbox that stops DRAINING is a different source\n'
             || E'     and raises on its own terms. */\n'
             || E'  IF NEW.source = ''ServerTableEngine.post_commit_obligations_pending'' THEN\n'
             || E'    RETURN NEW;\n'
             || E'  END IF;\n';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f'
     AND p.proname = 'fn_ca_financial_alert_to_incident';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fn_ca_financial_alert_to_incident is missing';
  END IF;

  IF position('A HANDOFF THAT NAMES ITS SUCCESSOR' IN v_def) = 0 THEN
    v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the refusal exemption anchor appears % times, expected 1', v_n;
    END IF;
    EXECUTE replace(v_def, v_old, v_new);

    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
       AND p.proname = 'fn_ca_financial_alert_to_incident';
  END IF;

  -- the bridge still promotes everything else, and still only from `critical`
  IF position('IF NEW.severity <> ''critical'' THEN RETURN NEW; END IF;' IN v_def) = 0
     OR position('authoritative_hand_semantic_refusal' IN v_def) = 0
     OR position('fn_ca_raise_drift_incident' IN v_def) = 0
     OR position('prize_credit_failed' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the alert bridge lost a rule it must keep';
  END IF;

  -- declare the redefinition so the guard watcher has nothing to report
  PERFORM public.fn_ca_declare_guard_redefinition(
    'fn_ca_financial_alert_to_incident',
    'migration a_handoff_that_names_its_successor_is_not_an_incident');

  UPDATE public.ca_drift_incidents i
     SET status = 'resolved', resolved_at = now(),
         root_cause = 'ServerTableEngine.post_commit_obligations_pending is written at severity `critical`, so fn_ca_financial_alert_to_incident promoted it to the board. Its own message says the hand COMMITTED and that the engine handed its post-commit envelope to the durable outbox after ZERO attempts - a handoff at the causal settlement barrier, not a failure - and it names the projection worker as its successor. Verified for the hand it names: the row is in hand_history and carries its hand_atomic_commits receipt. It fires 274 times in 24 hours and 1,485 times since the source existed.',
         correction_ref = 'migration a_handoff_that_names_its_successor_is_not_an_incident',
         resolution = 'Added to the same exemption list the refused-hand rule already uses in that bridge, for the same stated reason: the alert is still written to financial_alerts and still counted, but a handoff that succeeded does not open a board item per message shape. An outbox that stops draining is a different source and raises on its own terms. The bridge still promotes every other critical alert and still refuses to promote anything below critical.'
   WHERE i.status <> 'resolved'
     AND i.source = 'financial_alerts:ServerTableEngine.post_commit_obligations_pending';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows < 1 THEN
    RAISE EXCEPTION 'expected to resolve the post-commit handoff notice, resolved %', v_rows;
  END IF;
END
$body$;

COMMIT;
