-- RAKE ATTRIBUTION THAT FAILED IS RETRIED, NOT JUST ANNOUNCED.
--
-- fn_settle_tournament_rake moves the rake and then attributes it per player -
-- VIP points, agent commission, rakeback stats. The attribution call is wrapped
-- in an exception handler that files a financial_alert and carries on, which is
-- the right call for the RAKE (it is already banked; aborting would roll the
-- settlement back over a downstream failure). What was missing is the other
-- half: nothing recorded that the attribution had not happened, and nothing
-- ever tried again. The alert was the entire remedy, and an alert is not a
-- remedy - it is a request that a human become one.
--
-- Live example, 2026-08-27 22:45: tournament 72c185e8, 1.20 chips of rake
-- settled, attribution lost to 'deadlock detected'. Every player in that event
-- is short their VIP points and their agent short the commission, permanently,
-- and the only trace is one warning row among two thousand.
--
-- fn_attribute_tournament_rake is idempotent by construction - vip_points_ledger
-- is keyed (user_id, source_type, source_id), the commission carries an md5
-- idempotency uuid, and apply_rakeback_player_stats is keyed by rake row - so
-- re-running it is safe and is what this does.
--
-- THE BACKFILL IS AN HONEST BASELINE, NOT A CLAIM. 31,699 settlements predate
-- this column. Re-attributing all of them would be safe but pointless work
-- measured in hours, so they are stamped attributed_at = settled_at, and then
-- every tournament named in an unresolved fn_settle_tournament_rake alert is
-- stamped back to NULL. The queue therefore starts at exactly the failures we
-- have evidence for, and the column means "attributed, or believed attributed
-- as of this migration" - not "verified".
--
-- ROLLBACK
--   ALTER TABLE public.tournament_rake_settlements
--     DROP COLUMN attributed_at, DROP COLUMN attribution_error;
--   DROP FUNCTION public.fn_repair_tournament_rake_attribution(integer);
--   then re-apply fn_settle_tournament_rake from
--   20260827_tournament_rake_attribution_and_creation_caps.

ALTER TABLE public.tournament_rake_settlements
  ADD COLUMN IF NOT EXISTS attributed_at     timestamptz,
  ADD COLUMN IF NOT EXISTS attribution_error text;

-- Baseline: everything already settled is presumed attributed...
UPDATE public.tournament_rake_settlements
   SET attributed_at = settled_at
 WHERE attributed_at IS NULL AND settled_at IS NOT NULL;

-- ...except the ones we have an open alert saying failed.
UPDATE public.tournament_rake_settlements s
   SET attributed_at = NULL,
       attribution_error = COALESCE(s.attribution_error, 'recorded from financial_alerts backlog')
  FROM public.financial_alerts a
 WHERE a.source = 'fn_settle_tournament_rake'
   AND a.resolved IS NOT TRUE
   AND a.message LIKE 'Rake settled but attribution failed%'
   AND (a.context->>'tournament_id')::uuid = s.tournament_id;

CREATE INDEX IF NOT EXISTS idx_rake_settlements_unattributed
  ON public.tournament_rake_settlements (settled_at)
  WHERE attributed_at IS NULL;

CREATE OR REPLACE FUNCTION public.fn_repair_tournament_rake_attribution(p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row record; v_att jsonb; v_msg text;
  v_repaired integer := 0; v_failed integer := 0;
  v_before integer; v_after integer;
BEGIN
  -- The debt is filtered in the query: only settlements that banked real rake
  -- and are not attributed. A sweep that pages through rows owing nothing is
  -- how the Heads-Up back-pay starved while reporting success.
  SELECT count(*) INTO v_before
    FROM public.tournament_rake_settlements
   WHERE attributed_at IS NULL AND settled_at IS NOT NULL AND amount > 0;

  FOR v_row IN
    SELECT tournament_id
      FROM public.tournament_rake_settlements
     WHERE attributed_at IS NULL AND settled_at IS NOT NULL AND amount > 0
     ORDER BY settled_at ASC
     LIMIT GREATEST(p_limit, 1)
  LOOP
    BEGIN
      v_att := public.fn_attribute_tournament_rake(v_row.tournament_id);

      IF COALESCE((v_att->>'ok')::boolean, false) THEN
        UPDATE public.tournament_rake_settlements
           SET attributed_at = now(), attribution_error = NULL
         WHERE tournament_id = v_row.tournament_id;
        v_repaired := v_repaired + 1;

        UPDATE public.financial_alerts
           SET resolved = true, resolved_at = now()
         WHERE source = 'fn_settle_tournament_rake'
           AND resolved IS NOT TRUE
           AND message LIKE 'Rake settled but attribution failed%'
           AND (context->>'tournament_id')::uuid = v_row.tournament_id;
      ELSE
        -- 'no_club' is terminal, not a transient failure: there is nobody to
        -- attribute to and retrying forever would pin the head of the queue.
        IF v_att->>'reason' = 'no_club' THEN
          UPDATE public.tournament_rake_settlements
             SET attributed_at = now(), attribution_error = 'no_club'
           WHERE tournament_id = v_row.tournament_id;
        ELSE
          UPDATE public.tournament_rake_settlements
             SET attribution_error = COALESCE(v_att->>'reason', 'unknown')
           WHERE tournament_id = v_row.tournament_id;
          v_failed := v_failed + 1;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      UPDATE public.tournament_rake_settlements
         SET attribution_error = v_msg
       WHERE tournament_id = v_row.tournament_id;
      v_failed := v_failed + 1;
    END;
  END LOOP;

  -- Second measurement: the queue must actually be shorter.
  SELECT count(*) INTO v_after
    FROM public.tournament_rake_settlements
   WHERE attributed_at IS NULL AND settled_at IS NOT NULL AND amount > 0;

  RETURN jsonb_build_object('ok', true, 'queue_before', v_before,
    'queue_after', v_after, 'repaired', v_repaired, 'still_failing', v_failed);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_repair_tournament_rake_attribution(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_repair_tournament_rake_attribution(integer) TO service_role;

DO $post$
DECLARE v_q integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='tournament_rake_settlements'
                    AND column_name='attributed_at') THEN
    RAISE EXCEPTION 'attributed_at was not added';
  END IF;
  IF to_regprocedure('public.fn_repair_tournament_rake_attribution(integer)') IS NULL THEN
    RAISE EXCEPTION 'fn_repair_tournament_rake_attribution was not created';
  END IF;
  -- The baseline must leave a SMALL queue. If it left tens of thousands the
  -- backfill did not run and the sweep would re-attribute all of history.
  SELECT count(*) INTO v_q
    FROM public.tournament_rake_settlements
   WHERE attributed_at IS NULL AND settled_at IS NOT NULL AND amount > 0;
  IF v_q > 1000 THEN
    RAISE EXCEPTION 'baseline left % unattributed settlements; expected the known failures only', v_q;
  END IF;
  RAISE LOG 'rake attribution repair queue starts at % settlement(s)', v_q;
END
$post$;
