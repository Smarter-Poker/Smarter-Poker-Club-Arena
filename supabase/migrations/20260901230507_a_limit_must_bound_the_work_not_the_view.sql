-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 3: THE REPAIR COULD NOT SEE THE THING IT WAS WRITTEN TO REPAIR
--
-- fn_payout_guarantee_check raised a critical: "Midnight Bounty (NLH) funded a
-- 24.00 bounty pool and paid out 0". The incident names its own remedy -
-- fn_backpay_unfinalised_bounty_pools re-drives it - and that function, run at
-- its DEFAULT limit, reported everything clean.
--
-- Both were right. The function scanned
--
--     WHERE t.status = 'COMPLETED' AND bounty_pool > 0
--     ORDER BY t.ended_at DESC
--     LIMIT p_limit                       -- default 200
--
-- and only THEN skipped the ones already paid. So the limit bounded what it
-- could SEE, newest first. There are 713 completed bounty events; the unpaid
-- one sits at rank 238. At limit 200 it returns zero findings; at 300 it finds
-- the 24 chips. Measured, both ways.
--
-- That is a repair with a sliding window over its own backlog: the longer a
-- debt goes unpaid the further out of reach it moves, and it can never be
-- collected again. The worst possible failure direction for money owed.
--
-- THE FIX: the limit bounds the WORK, not the VIEW. The unpaid test moves into
-- the scan, so p_limit caps how many pools are settled per run. Ordering flips
-- to OLDEST FIRST, because the longest-outstanding debt is settled first.
-- No money logic changes.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_backpay_unfinalised_bounty_pools(
  p_apply boolean DEFAULT false,
  p_limit integer DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record; v_res jsonb;
  v_events integer := 0; v_paid numeric := 0;
  v_orphan integer := 0; v_orphan_chips numeric := 0; v_alerts integer := 0;
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
     WHERE wallet_bounty + 0.01 < pool
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
      v_res := public.fn_finalize_bounty_pool(r.id, r.champion);
      IF COALESCE((v_res->>'ok')::boolean, false) THEN
        v_paid := v_paid + COALESCE((v_res->>'residual')::numeric, 0);
      END IF;
    ELSE
      v_paid := v_paid + (r.pool - r.wallet_bounty);
    END IF;
    v_events := v_events + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'applied', p_apply,
    'events_settled', v_events, 'chips_settled', round(v_paid, 2),
    'events_without_a_champion', v_orphan,
    'chips_without_a_champion', round(v_orphan_chips, 2),
    'alerts_raised', v_alerts);
END;
$function$;

COMMENT ON FUNCTION public.fn_backpay_unfinalised_bounty_pools(boolean, integer) IS
  'Settles unpaid bounty pools to the recorded champion. p_limit caps how many are settled per run, NOT how far back the scan may look: before 2026-09-01 the limit bounded the view, newest first, so an unpaid pool at rank 238 of 713 was invisible at the default limit of 200 and drifted further out of reach as newer events completed. Oldest debt first.';

REVOKE ALL ON FUNCTION public.fn_backpay_unfinalised_bounty_pools(boolean, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_backpay_unfinalised_bounty_pools(boolean, integer) TO service_role;

-- The settlement now runs on its own instead of waiting for a human to notice.
SELECT cron.schedule('ca-bounty-backpay-hourly','12 * * * *',
  $$ SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-bounty-backpay'))
       THEN (public.fn_backpay_unfinalised_bounty_pools(true, 200))::text
       ELSE 'locked' END; $$);
