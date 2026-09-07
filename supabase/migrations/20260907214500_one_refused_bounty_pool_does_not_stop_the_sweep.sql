-- ============================================================================
--  ONE REFUSED BOUNTY POOL MUST NOT STOP EVERY OTHER POOL FROM BEING PAID
--
--  ca-bounty-backpay-hourly has failed on every run since 2026-09-07 08:12 UTC
--  (14 consecutive failures at the time of writing) with:
--
--    fn_finalize_bounty_pool: residual of 2310.00 to 13133bc4-... in
--    tournament 3f19bd70-... (Sunday Funday High Roller PKO) refused
--    (escrow_short)
--
--  That refusal is CORRECT: the chip standard's one payer,
--  fn_settle_tournament_obligation, holds less escrow for that bank than the
--  residual owed, and it must not invent chips. It also already raises the
--  critical financial alert that names the shortfall. The defect is in the
--  SWEEP: fn_backpay_unfinalised_bounty_pools walks pools oldest-first and
--  calls fn_finalize_bounty_pool, which RAISES on a refusal, so the first
--  refused pool aborts the whole run and every pool behind it - pools whose
--  escrow is perfectly sufficient - stays unpaid, hour after hour, for as
--  long as the one short pool exists. Money that could be paid is not,
--  because money that cannot be paid is in front of it.
--
--  The change is confined to the sweep: each pool is attempted inside its own
--  exception block. A refusal is counted, reported once per tournament
--  (fn_raise_server_financial_alert dedupes on the key), and the loop moves
--  on. Nothing about WHAT is paid, or by which path, changes: every payment
--  still goes through fn_finalize_bounty_pool -> fn_settle_tournament_obligation.
--
--  Probe (rolled back, production, 2026-09-07 21:4x UTC): with the fix the
--  run returns ok with events_refused = 1 and settles the pools behind it;
--  without it the run aborts at the first refusal.
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.fn_backpay_unfinalised_bounty_pools(p_apply boolean DEFAULT false, p_limit integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record; v_res jsonb;
  v_events integer := 0; v_paid numeric := 0;
  v_orphan integer := 0; v_orphan_chips numeric := 0; v_alerts integer := 0;
  v_refused integer := 0; v_refused_chips numeric := 0;
  v_state text; v_msg text;
BEGIN
  FOR r IN
    WITH scanned AS (
      SELECT t.id, t.name, t.club_id, t.ended_at,
             round(COALESCE(t.bounty_pool, 0), 2) AS pool,
             COALESCE((SELECT round(sum(w.amount), 2)
                         FROM public.wallet_transactions w
                        WHERE w.related_entity_id = t.id
                          AND w.type = 'credit'
                          AND w.category = 'bounty'), 0) AS wallet_bounty,
             (SELECT tp.user_id FROM public.tournament_players tp
               WHERE tp.tournament_id = t.id AND tp.status = 'winner'
               LIMIT 1) AS champion
        FROM public.tournaments t
       WHERE t.status = 'COMPLETED'
         AND COALESCE(t.bounty_pool, 0) > 0
    )
    SELECT * FROM scanned
     -- the unpaid test is part of the SCAN now, so the limit below caps how
     -- much work one run does instead of how far back it can look
     WHERE wallet_bounty + 0.01 < pool
     -- oldest debt first: a pool that has been owed longest is settled first,
     -- and can never be pushed out of reach by newer events completing
     ORDER BY ended_at ASC NULLS LAST
     LIMIT GREATEST(p_limit, 1)
  LOOP
    IF r.champion IS NULL THEN
      v_orphan := v_orphan + 1;
      v_orphan_chips := v_orphan_chips + (r.pool - r.wallet_bounty);
      PERFORM public.fn_raise_server_financial_alert(
        'warning', 'fn_backpay_unfinalised_bounty_pools',
        format('%s holds %s chips of unpaid bounty pool and has no champion recorded, so there is nobody to settle it to',
               COALESCE(r.name, r.id::text), round(r.pool - r.wallet_bounty, 2)),
        jsonb_build_object('kind','no_champion','tournament_id',r.id,
          'club_id',r.club_id,'bounty_pool',r.pool,'paid',r.wallet_bounty,
          'retained',round(r.pool - r.wallet_bounty, 2),
          'detail','no money was moved; a residual with no recipient is a question, not a payment'),
        r.id::text);
      v_alerts := v_alerts + 1;
      CONTINUE;
    END IF;

    IF p_apply THEN
      -- ONE POOL AT A TIME (2026-09-07). fn_finalize_bounty_pool RAISES when
      -- the one payer refuses (escrow_short and friends). That refusal is
      -- right and the payer has already raised its own critical alert; what
      -- must not happen is the refusal aborting THIS run and leaving every
      -- pool behind it unpaid. The block below is a savepoint: the refused
      -- pool's partial work rolls back, the rest of the run continues.
      BEGIN
        v_res := public.fn_finalize_bounty_pool(r.id, r.champion);
        IF COALESCE((v_res->>'ok')::boolean, false) THEN
          v_paid := v_paid + COALESCE((v_res->>'residual')::numeric, 0);
        END IF;
        v_events := v_events + 1;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        v_refused := v_refused + 1;
        v_refused_chips := v_refused_chips + (r.pool - r.wallet_bounty);
        PERFORM public.fn_raise_server_financial_alert(
          'critical', 'fn_backpay_unfinalised_bounty_pools',
          format('%s: bounty residual of %s chips could not be settled to the champion (%s); the sweep moved on to the next pool',
                 COALESCE(r.name, r.id::text), round(r.pool - r.wallet_bounty, 2), left(v_msg, 300)),
          jsonb_build_object('kind','refused','tournament_id',r.id,'club_id',r.club_id,
            'bounty_pool',r.pool,'paid',r.wallet_bounty,
            'residual',round(r.pool - r.wallet_bounty, 2),
            'sqlstate',v_state,'error',left(v_msg, 500),
            'detail','no money was moved for this pool; every pool behind it was still attempted'),
          'refused:' || r.id::text);
        v_alerts := v_alerts + 1;
      END;
    ELSE
      v_paid := v_paid + (r.pool - r.wallet_bounty);
      v_events := v_events + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'applied', p_apply,
    'events_settled', v_events, 'chips_settled', round(v_paid, 2),
    'events_refused', v_refused, 'chips_refused', round(v_refused_chips, 2),
    'events_without_a_champion', v_orphan,
    'chips_without_a_champion', round(v_orphan_chips, 2),
    'alerts_raised', v_alerts);
END;
$function$;

COMMENT ON FUNCTION public.fn_backpay_unfinalised_bounty_pools(boolean, integer) IS
  'Hourly sweep (ca-bounty-backpay-hourly): settles every completed tournament whose bounty pool is still owed to its champion, oldest first, through fn_finalize_bounty_pool. A pool the one payer refuses is reported (once per tournament) and skipped so the pools behind it are still paid.';

REVOKE ALL ON FUNCTION public.fn_backpay_unfinalised_bounty_pools(boolean, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_backpay_unfinalised_bounty_pools(boolean, integer) TO service_role;

DO $$
DECLARE v_def text := pg_get_functiondef('public.fn_backpay_unfinalised_bounty_pools(boolean, integer)'::regprocedure);
BEGIN
  IF position('EXCEPTION WHEN OTHERS' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the bounty backpay sweep must attempt each pool inside its own exception block';
  END IF;
  IF position('fn_finalize_bounty_pool(r.id, r.champion)' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the sweep must still pay through fn_finalize_bounty_pool';
  END IF;
END $$;

COMMIT;
