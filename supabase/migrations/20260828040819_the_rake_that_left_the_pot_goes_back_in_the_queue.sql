-- THE RAKE THAT LEFT THE POT GOES BACK IN THE QUEUE.
--
-- 1,459 open FeeReconciler.queue_failed criticals, carrying 4,331.43 chips of
-- rake and 295.21 of BBJ that came out of real pots and reached no bank. The
-- alert text ends "These chips left the pot and are now recoverable only by
-- hand."
--
-- That last clause stopped being true on 2026-08-22 and nobody noticed. On that
-- day FeeReconciler.ts was changed to write the WHOLE payload into the alert
-- context rather than a summary, with the reasoning stated in the code: a
-- summary "names chips nobody can safely re-drive" because
-- atomic_distribute_rake needs pot, num_players and above all `contributions`,
-- the per-player split. All of it has been in financial_alerts.context ever
-- since. The chips have been recoverable from data for six days.
--
-- WHY THIS RE-QUEUES RATHER THAN RE-BANKS. The failure was never in banking -
-- it was in the INSERT into pending_fee_distributions, the safety net itself,
-- knocked over by Cloudflare 520s and PostgREST schema-cache errors (both are
-- quoted verbatim in the contexts). The drain loop that empties that queue is
-- healthy and has always been: 10,313 rows queued all-time, 10,312 resolved,
-- last pass 02:19 today. So the correct repair is to put the rows back in the
-- queue the engine already drains, not to invent a second banking path beside
-- a working one.
--
-- IDEMPOTENT BY INDEX, IN BOTH SHAPES. pending_fee_distributions carries two
-- partial unique indexes - (hand_id, kind) where hand_id IS NOT NULL, and
-- (table_id, hand_number, kind) where it IS NULL. Only 160 of the 1,459 alerts
-- have a hand_id, so the second index is the one doing the work here.
--
-- THE ACCOUNTED CHECK IS A PORT, NOT A GUESS. Before queueing anything this
-- re-runs feeIsAccountedFor() from FeeReconciler.ts:224 in SQL, branch for
-- branch. The contexts say `verifiedUnbanked: true`, but that was true when the
-- alert was raised and days have passed - re-driving a fee that has since been
-- banked would double-book it. MEASURED: 1,205 of the 1,459 had been banked in
-- the meantime. Without this check the repair would have double-booked 83% of
-- what it touched. Only 254 were genuinely still owed (865.64 rake, 60.95 BBJ).
--
-- 404 of the alerts carry `contributions: {}`. They are still queued: the chips
-- reach the club either way. Attribution that was never captured cannot be
-- invented here - auditBBJDrift in the same file says plainly that "guessing it
-- would corrupt rakeback attribution".
--
-- ROLLBACK
--   DELETE FROM pending_fee_distributions p
--    USING fee_requeue_log l WHERE l.pending_id = p.id;
--   then reopen the alerts named in that table.

CREATE TABLE IF NOT EXISTS public.fee_requeue_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id     uuid NOT NULL UNIQUE,
  pending_id   uuid,
  kind         text NOT NULL,
  table_id     uuid,
  hand_number  bigint,
  rake         numeric,
  bbj          numeric,
  outcome      text NOT NULL,
  requeued_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.fee_requeue_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fee_requeue_log FROM PUBLIC;
GRANT SELECT ON public.fee_requeue_log TO service_role;

CREATE OR REPLACE FUNCTION public.fn_fee_is_accounted_for(
  p_kind text, p_table_id uuid, p_hand_id uuid, p_hand_number bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    -- Cheapest check, and the one that is true most often.
    (p_hand_number > 0 AND EXISTS (
       SELECT 1 FROM public.pending_fee_distributions q
        WHERE q.table_id = p_table_id AND q.hand_number = p_hand_number
          AND q.kind = p_kind))
    OR CASE WHEN p_kind = 'rake' THEN
         (p_hand_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.rake_records r WHERE r.hand_id = p_hand_id))
         OR (p_hand_number > 0 AND EXISTS (
            SELECT 1 FROM public.rake_records r
             WHERE r.table_id = p_table_id AND r.global_hand_id = p_hand_number))
       ELSE
         (p_hand_number > 0 AND EXISTS (
            SELECT 1 FROM public.bbj_contributions b
             WHERE b.table_id = p_table_id AND b.hand_number = p_hand_number))
       END;
$function$;

REVOKE ALL ON FUNCTION public.fn_fee_is_accounted_for(text, uuid, uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_fee_is_accounted_for(text, uuid, uuid, bigint) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_requeue_unbanked_fees(
  p_apply boolean DEFAULT false,
  p_limit integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  a record; v_pending uuid; v_accounted boolean;
  v_requeued int := 0; v_already int := 0; v_skipped int := 0;
  v_rake numeric := 0; v_bbj numeric := 0;
  v_open_before int; v_open_after int;
BEGIN
  SELECT count(*) INTO v_open_before FROM public.financial_alerts
   WHERE source = 'FeeReconciler.queue_failed' AND resolved IS NOT TRUE;

  FOR a IN
    SELECT f.id AS alert_id, f.context AS c
      FROM public.financial_alerts f
     WHERE f.source = 'FeeReconciler.queue_failed'
       AND f.resolved IS NOT TRUE
       AND f.context->>'kind' IS NOT NULL
       AND f.context->>'tableId' IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.fee_requeue_log l WHERE l.alert_id = f.id)
     ORDER BY f.created_at ASC
     LIMIT GREATEST(p_limit, 1)
  LOOP
    v_accounted := public.fn_fee_is_accounted_for(
      a.c->>'kind',
      (a.c->>'tableId')::uuid,
      NULLIF(a.c->>'handId', '')::uuid,
      COALESCE((a.c->>'handNumber')::bigint, 0));

    IF v_accounted THEN
      IF p_apply THEN
        INSERT INTO public.fee_requeue_log
          (alert_id, kind, table_id, hand_number, rake, bbj, outcome)
        VALUES (a.alert_id, a.c->>'kind', (a.c->>'tableId')::uuid,
                COALESCE((a.c->>'handNumber')::bigint, 0),
                COALESCE((a.c->>'rake')::numeric, 0),
                COALESCE((a.c->>'bbj')::numeric, 0), 'already_accounted')
        ON CONFLICT (alert_id) DO NOTHING;
        UPDATE public.financial_alerts
           SET resolved = true, resolved_at = now() WHERE id = a.alert_id;
      END IF;
      v_already := v_already + 1;
      CONTINUE;
    END IF;

    IF NOT p_apply THEN
      v_requeued := v_requeued + 1;
      v_rake := v_rake + COALESCE((a.c->>'rake')::numeric, 0);
      v_bbj  := v_bbj  + COALESCE((a.c->>'bbj')::numeric, 0);
      CONTINUE;
    END IF;

    INSERT INTO public.pending_fee_distributions
      (table_id, club_id, hand_id, hand_number, rake, bbj, pot, num_players,
       contributions, tournament_id, big_blind, kind, last_error)
    VALUES (
      (a.c->>'tableId')::uuid,
      NULLIF(a.c->>'clubId', '')::uuid,
      NULLIF(a.c->>'handId', '')::uuid,
      COALESCE((a.c->>'handNumber')::bigint, 0),
      COALESCE((a.c->>'rake')::numeric, 0),
      COALESCE((a.c->>'bbj')::numeric, 0),
      COALESCE((a.c->>'pot')::numeric, 0),
      COALESCE((a.c->>'numPlayers')::int, 0),
      COALESCE(a.c->'contributions', '{}'::jsonb),
      NULLIF(a.c->>'tournamentId', '')::uuid,
      NULLIF(a.c->>'bigBlind', '')::numeric,
      a.c->>'kind',
      'requeued from financial_alerts by fn_requeue_unbanked_fees')
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_pending;

    INSERT INTO public.fee_requeue_log
      (alert_id, pending_id, kind, table_id, hand_number, rake, bbj, outcome)
    VALUES (a.alert_id, v_pending, a.c->>'kind', (a.c->>'tableId')::uuid,
            COALESCE((a.c->>'handNumber')::bigint, 0),
            COALESCE((a.c->>'rake')::numeric, 0),
            COALESCE((a.c->>'bbj')::numeric, 0),
            CASE WHEN v_pending IS NULL THEN 'already_queued' ELSE 'requeued' END)
    ON CONFLICT (alert_id) DO NOTHING;

    UPDATE public.financial_alerts
       SET resolved = true, resolved_at = now() WHERE id = a.alert_id;

    IF v_pending IS NULL THEN
      v_skipped := v_skipped + 1;
    ELSE
      v_requeued := v_requeued + 1;
      v_rake := v_rake + COALESCE((a.c->>'rake')::numeric, 0);
      v_bbj  := v_bbj  + COALESCE((a.c->>'bbj')::numeric, 0);
    END IF;
  END LOOP;

  -- Second measurement: the alert queue itself must be shorter.
  SELECT count(*) INTO v_open_after FROM public.financial_alerts
   WHERE source = 'FeeReconciler.queue_failed' AND resolved IS NOT TRUE;

  RETURN jsonb_build_object('ok', true, 'applied', p_apply,
    'requeued', v_requeued, 'rake_requeued', round(v_rake, 2),
    'bbj_requeued', round(v_bbj, 2),
    'already_accounted', v_already, 'already_queued', v_skipped,
    'alerts_open_before', v_open_before, 'alerts_open_after', v_open_after);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_requeue_unbanked_fees(boolean, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_requeue_unbanked_fees(boolean, integer) TO service_role;

DO $post$
DECLARE v_t boolean;
BEGIN
  IF to_regprocedure('public.fn_requeue_unbanked_fees(boolean, integer)') IS NULL THEN
    RAISE EXCEPTION 'fn_requeue_unbanked_fees was not created';
  END IF;
  -- The accounted check must actually discriminate. A version that returns
  -- true for everything would resolve 1,459 alerts and bank nothing; one that
  -- returns false for everything would double-book. Prove both directions.
  SELECT public.fn_fee_is_accounted_for('rake', r.table_id, r.hand_id, r.global_hand_id)
    INTO v_t
    FROM public.rake_records r
   WHERE r.hand_id IS NOT NULL AND r.table_id IS NOT NULL LIMIT 1;
  IF v_t IS NOT TRUE THEN
    RAISE EXCEPTION 'fn_fee_is_accounted_for said an existing rake_records hand was unaccounted';
  END IF;
  IF public.fn_fee_is_accounted_for(
       'rake', '00000000-0000-0000-0000-0000000000ff'::uuid, NULL, 999999999::bigint) THEN
    RAISE EXCEPTION 'fn_fee_is_accounted_for said a nonexistent hand was accounted';
  END IF;
END
$post$;
