-- ============================================================================
-- A BUSY FINISH LANE IS A WARNING UNTIL IT STRANDS A WINNER
-- ============================================================================
--
-- Measured on production (kuklfnapbkmacvwxktbh) 2026-10-03 19:10-19:30 UTC,
-- with short indexed reads only.
--
-- WHAT RESET THE LAUNCH GATE
--
-- Incident 03f5b137 (15:36:37), financial_alerts:Tournament.atomic_finish_refused
-- for SNG 4b3f2f27 (house club fade0000). Context: proven_refusal true,
-- refusal_reason 'timeout', refusal_streak 3, outcome_unknown false. Timeline:
--   15:33:33.8  last elimination (2 entrants); the event is decided
--   15:33-15:36 three finish passes refused before commit (lock/statement
--               timeout on the finish lane: the house club finished 7-24
--               events a minute between 15:25 and 15:45, one at a time per
--               bank scope)
--   15:36:37    the third identical refusal reaches
--               TournamentManagerBase.TRANSIENT_FINISH_REFUSAL_ALERT_STREAK (3)
--               and the engine raises the alert; the incident bridge files it
--               CRITICAL with classification 'unknown'
--   15:37:02.7  the next pass commits: tournament COMPLETED,
--               tournament_terminal_settlements receipt_version 2, one payout
--               f916c729 of 3.80 to the winner 92ecbaed (position 1), escrow
--               closed "terminal receipt: exact zero" (gross_in 4.00 =
--               prize_out 3.80 + fee_out 0.20), chip_ledger: two 2.00
--               tournament_buyin legs in, one 3.80 tournament_prize leg to the
--               winner, one 0.20 rake leg to the union wallet.
-- The winner was unpaid for 3.5 minutes and paid exactly once. Nothing was
-- owed at any moment that the database did not already hold in escrow.
--
-- WHY IT IS THE WRONG SIGNAL
--
-- A proven refusal is refused BEFORE commit: nothing moved. A timeout or
-- deadlock is, by the engine's own definition (finishRefusalIsTransient), the
-- database saying "not now", and the next pass pays it. Of the 51
-- Tournament.atomic_finish_refused incidents filed 2026-10-01 -> 2026-10-03,
-- every tournament is COMPLETED with its terminal receipt; none named money
-- that was owed. The condition that actually means an unpaid winner - a
-- decided event that has not completed - already has its own critical
-- detector: fn_ca_tournament_finished_but_not_completed (every 5 minutes; 15
-- live engine minutes, or 45 wall-clock minutes whatever the breaks). A busy
-- lane that never clears trips that detector; a busy lane that clears in 25
-- seconds should not page as a money incident. And because no code ever
-- closed a transient refusal alert when its tournament completed, each one
-- also sat as an unresolved 'unknown' until a person closed it by hand.
--
-- THE CHANGE
--
-- 1. fn_ca_financial_alert_to_incident: Tournament.atomic_finish_refused with
--    proven_refusal true AND refusal_reason in ('timeout', 'deadlock') files
--    as WARNING, not critical. It still opens, still pages, still counts as an
--    unresolved unknown until it is closed. Every rule refusal ('other',
--    fee sources, prize set, ...), every unproven/unknown outcome, and every
--    satellite source keeps its current severity.
-- 2. fn_ca_tournament_finished_but_not_completed (the unpaid-winner detector,
--    which already closes its own alerts on re-measurement) also closes an
--    open transient finish-refusal alert once, and only once, its tournament
--    is COMPLETED with a tournament_terminal_settlements receipt AND its
--    escrow is terminally closed with prize and bounty balances at 0.00. The
--    resolution names the receipt, the payout rows and their sum. A refused
--    tournament that is CANCELLED, missing, still RUNNING or holding escrow
--    keeps its alert open for a person.
--
-- Not changed: any money, seat, lease or tournament row; the engine; any
-- other source's severity; any schedule. No job is added.
--
-- @live-proof: (SELECT position('A BUSY FINISH LANE IS A WARNING UNTIL IT STRANDS A WINNER' in pg_get_functiondef('public.fn_ca_financial_alert_to_incident()'::regprocedure)) > 0 AND position('A BUSY FINISH LANE IS A WARNING UNTIL IT STRANDS A WINNER' in pg_get_functiondef('public.fn_ca_tournament_finished_but_not_completed(integer)'::regprocedure)) > 0)

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $mig$
DECLARE
  v_fn text; v_src text; v_new text; v_anchor text; v_ins text; v_n int;
  v_marker constant text := 'A BUSY FINISH LANE IS A WARNING UNTIL IT STRANDS A WINNER';
  v_expect constant jsonb := jsonb_build_object(
    'fn_ca_financial_alert_to_incident',           '9fcf79de808e45cd4a1fad478ea93228',
    'fn_ca_tournament_finished_but_not_completed', '67618c4a085bb0950589c7ca0fee82a3');
  v_edits jsonb;
  e jsonb;
BEGIN
  IF NOT (current_user IN ('postgres','service_role','supabase_admin')) THEN
    RAISE EXCEPTION 'operator-only';
  END IF;

  v_edits := jsonb_build_array(
    -- 1. The bridge: a proven transient finish refusal is a warning.
    jsonb_build_object('fn', 'fn_ca_financial_alert_to_incident', 'mode', 'before',
      'anchor', $a$      WHEN NEW.source LIKE 'postHandTasks.%'
        THEN CASE WHEN lower(COALESCE(NEW.context->>'moves_chips','true')) IN ('false','f','0')$a$,
      'with', $w$      /* A BUSY FINISH LANE IS A WARNING UNTIL IT STRANDS A WINNER (2026-10-03).
         A finish the database refused BEFORE commit for a timeout or a
         deadlock moved nothing, and the next pass pays it (03f5b137: refused
         three times 15:33-15:36, paid exactly once at 15:37:02). The unpaid
         winner it could become is paged by
         fn_ca_tournament_finished_but_not_completed. Warning, not critical:
         it still opens, pages, and stays an open unknown until that detector
         closes it on the terminal receipt. Rule refusals and unknown
         outcomes keep the branch below. */
      WHEN NEW.source = 'Tournament.atomic_finish_refused'
           AND lower(COALESCE(NEW.context->>'proven_refusal', '')) IN ('true', 't', '1')
           AND lower(COALESCE(NEW.context->>'outcome_unknown', 'false')) IN ('false', 'f', '0')
           AND COALESCE(NEW.context->>'refusal_reason', '') IN ('timeout', 'deadlock')
        THEN 'warning'
$w$),
    -- 2a. The unpaid-winner detector counts what it closes.
    jsonb_build_object('fn', 'fn_ca_tournament_finished_but_not_completed', 'mode', 'after',
      'anchor', E'  v_resolved int := 0;\n',
      'with', E'  v_refusals_closed int := 0;\n'),
    -- 2b. ... and closes a transient finish refusal on its terminal receipt.
    jsonb_build_object('fn', 'fn_ca_tournament_finished_but_not_completed', 'mode', 'after',
      'anchor', E'  GET DIAGNOSTICS v_resolved = ROW_COUNT;\n',
      'with', $w$
  /* A BUSY FINISH LANE IS A WARNING UNTIL IT STRANDS A WINNER (2026-10-03).
     A proven timeout/deadlock finish refusal is closed when the tournament it
     names is COMPLETED with its immutable terminal receipt and its escrow is
     terminally closed at zero - the refused finish was retried and paid. A
     refused tournament in any other state keeps its alert for a person. */
  WITH refused AS (
    SELECT fa.id AS alert_id, t.id AS tournament_id, s.receipt_version,
           COALESCE(s.settled_at, s.completed_at) AS settled_at
      FROM public.financial_alerts fa
      JOIN public.tournaments t
        ON t.id = CASE
                    WHEN (fa.context->>'tournament_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    THEN (fa.context->>'tournament_id')::uuid
                  END
      JOIN public.tournament_terminal_settlements s ON s.tournament_id = t.id
      JOIN public.tournament_escrow e ON e.tournament_id = t.id
     WHERE fa.source = 'Tournament.atomic_finish_refused'
       AND NOT fa.resolved
       AND lower(COALESCE(fa.context->>'proven_refusal', '')) IN ('true', 't', '1')
       AND COALESCE(fa.context->>'refusal_reason', '') IN ('timeout', 'deadlock')
       AND t.status = 'COMPLETED'
       AND e.terminal_closed_at IS NOT NULL
       AND COALESCE(e.prize_balance, 0) = 0
       AND COALESCE(e.bounty_balance, 0) = 0
  ), evidence AS (
    SELECT r.alert_id,
           format('tournament %s COMPLETED with terminal receipt v%s at %s; escrow closed at '
                  || 'zero; %s payout row(s) totalling %s',
                  r.tournament_id, r.receipt_version, r.settled_at,
                  (SELECT count(*) FROM public.tournament_payouts p
                    WHERE p.tournament_id = r.tournament_id),
                  (SELECT COALESCE(sum(p.amount), 0) FROM public.tournament_payouts p
                    WHERE p.tournament_id = r.tournament_id)) AS note
      FROM refused r
  )
  UPDATE public.financial_alerts fa
     SET resolved    = true,
         resolved_at = now(),
         resolution  = 'Re-measured by fn_ca_tournament_finished_but_not_completed at '
                       || now() || ': the finish refused before commit (timeout/deadlock) was '
                       || 'retried and paid - ' || ev.note
                       || '. A BUSY FINISH LANE IS A WARNING UNTIL IT STRANDS A WINNER.'
    FROM evidence ev
   WHERE fa.id = ev.alert_id
     AND NOT fa.resolved;
  GET DIAGNOSTICS v_refusals_closed = ROW_COUNT;
$w$),
    -- 2c. ... and reports it.
    jsonb_build_object('fn', 'fn_ca_tournament_finished_but_not_completed', 'mode', 'after',
      'anchor', E'    ''resolved'', v_resolved,\n',
      'with', E'    ''refusals_closed'', v_refusals_closed,\n')
  );

  FOR v_fn IN SELECT DISTINCT x->>'fn' FROM jsonb_array_elements(v_edits) x LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_fn;
    IF v_src IS NULL THEN RAISE EXCEPTION '% not found', v_fn; END IF;
    IF position(v_marker in v_src) > 0 THEN
      RAISE NOTICE '% already carries the change; skipping', v_fn;
      CONTINUE;
    END IF;
    IF md5(v_src) <> v_expect->>v_fn THEN
      RAISE EXCEPTION '% has changed since it was measured (md5 % <> %) - re-read it before editing',
        v_fn, md5(v_src), v_expect->>v_fn;
    END IF;
    v_new := v_src;
    FOR e IN SELECT x FROM jsonb_array_elements(v_edits) x WHERE x->>'fn' = v_fn LOOP
      v_anchor := e->>'anchor';
      v_ins := e->>'with';
      v_n := (length(v_new) - length(replace(v_new, v_anchor, ''))) / length(v_anchor);
      IF v_n <> 1 THEN
        RAISE EXCEPTION 'anchor in % appears % times, expected exactly 1', v_fn, v_n;
      END IF;
      IF e->>'mode' = 'before' THEN
        v_new := replace(v_new, v_anchor, v_ins || v_anchor);
      ELSE
        v_new := replace(v_new, v_anchor, v_anchor || v_ins);
      END IF;
    END LOOP;
    IF v_new = v_src OR position(v_marker in v_new) = 0 THEN
      RAISE EXCEPTION 'substitution in % produced no marked change', v_fn;
    END IF;
    EXECUTE v_new;
  END LOOP;

  PERFORM public.fn_ca_declare_guard_redefinition(
    'fn_ca_financial_alert_to_incident',
    'migration 20261003193000_a_busy_finish_lane_is_a_warning_until_it_strands_a_winner'
  );
END
$mig$;

-- Prove the bridge branch is in place, ahead of the postHandTasks branch, and
-- that the detector still runs.
DO $prove$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef('public.fn_ca_financial_alert_to_incident()'::regprocedure) INTO v_def;
  IF position($p$WHEN NEW.source = 'Tournament.atomic_finish_refused'$p$ in v_def) = 0 THEN
    RAISE EXCEPTION 'the warning branch is not in the live bridge';
  END IF;
  IF position($p$WHEN NEW.source = 'Tournament.atomic_finish_refused'$p$ in v_def)
     > position($p$WHEN NEW.source LIKE 'postHandTasks.%'$p$ in v_def) THEN
    RAISE EXCEPTION 'the warning branch must precede the postHandTasks.%% branch';
  END IF;
  SELECT pg_get_functiondef('public.fn_ca_tournament_finished_but_not_completed(integer)'::regprocedure) INTO v_def;
  IF position('v_refusals_closed' in v_def) = 0
     OR position($p$fa.source = 'Tournament.atomic_finish_refused'$p$ in v_def) = 0 THEN
    RAISE EXCEPTION 'the refusal closer is not in the live detector';
  END IF;
END
$prove$;

COMMIT;
