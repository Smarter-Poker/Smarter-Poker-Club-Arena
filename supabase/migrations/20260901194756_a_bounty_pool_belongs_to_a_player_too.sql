-- ═══════════════════════════════════════════════════════════════════════════
--  A BOUNTY POOL BELONGS TO A PLAYER TOO (2026-09-01)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- fn_payout_guarantee_check reconciles the PRIZE pool and says every earner is
-- paid. It was right about the prize pool and blind to the other half of the
-- money: a bounty event funds a SECOND pool out of the same buy-in, and nothing
-- asked whether that one was paid out.
--
-- It is not. 38 completed bounty events hold 1,931.24 chips of bounty pool that
-- never reached a player, and it is still happening daily - two events on
-- 2026-09-01, three on 2026-08-31.
--
-- ── WHOSE MONEY IT IS, AND WHY IT STAYED ─────────────────────────────────
--
-- finishTournament settles whatever is left in a funded bounty pool to the
-- champion: their own uncollected head plus any residue the draw left. That is
-- the rule the platform already had; fn_finalize_bounty_pool is the code for
-- it, and it works - 650 of the 673 healthy bounty events carry the champion's
-- payment.
--
-- NOT ONE of the 38 short events has one. 34 of them were completed by
-- recoverStuckCompletingTournaments, which pays the prize structure, settles
-- the rake, and never touched the bounty pool. The winner of Union PKO
-- Afternoon d2625870 is owed 121.57 and still carries an uncollected 41.25
-- head to prove the settlement never ran. The engine fix that closes that path
-- ships alongside this migration.
--
-- This is not an invented recipient. The residual has one owner by design, the
-- function that pays it is idempotent on `tourney:{id}:ownbounty:{winner}`, and
-- it pays only `bounty_pool - what the ledger shows already paid`. Re-driving
-- it cannot double-pay; it can only finish what stopped halfway.
--
-- 37 of the 38 have a champion recorded and are payable: 1,907.24 chips. The
-- one that does not (24.00 chips) is alerted and left for a human, because a
-- residual with no recipient is a question, not a payment.
--
-- ROLLBACK
--   DROP FUNCTION IF EXISTS public.fn_backpay_unfinalised_bounty_pools(boolean, integer);
--   (fn_payout_guarantee_check reverts to 20260901131129 + its two corrections)

-- ───────────────────────────────────────────────────────────────────────────
-- 1. THE REPAIR. Idempotent, dry-runnable, and it never picks a recipient.
-- ───────────────────────────────────────────────────────────────────────────
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
  r          record;
  v_res      jsonb;
  v_events   integer := 0;
  v_paid     numeric := 0;
  v_orphan   integer := 0;
  v_orphan_chips numeric := 0;
  v_alerts   integer := 0;
BEGIN
  FOR r IN
    SELECT t.id, t.name, t.club_id,
           round(COALESCE(t.bounty_pool, 0), 2) AS pool,
           COALESCE((SELECT round(sum(w.amount), 2) FROM public.wallet_transactions w
                      WHERE w.related_entity_id = t.id AND w.type = 'credit'
                        AND w.category = 'bounty'), 0) AS wallet_bounty,
           (SELECT tp.user_id FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id AND tp.status = 'winner'
             LIMIT 1) AS champion
      FROM public.tournaments t
     WHERE t.status = 'COMPLETED'
       AND COALESCE(t.bounty_pool, 0) > 0
     ORDER BY t.ended_at DESC NULLS LAST
     LIMIT GREATEST(p_limit, 1)
  LOOP
    CONTINUE WHEN r.wallet_bounty + 0.01 >= r.pool;

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
  'Settles a funded bounty pool that a completed event never paid out, by re-driving fn_finalize_bounty_pool - which is idempotent and pays only what the ledger shows is still unpaid, to the champion the event already recorded. An event with no champion is alerted, never guessed at. Found 38 events holding 1,931.24 chips on 2026-09-01, 34 of them completed by the stuck-COMPLETING watchdog, which never settled bounties.';

REVOKE ALL ON FUNCTION public.fn_backpay_unfinalised_bounty_pools(boolean, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_backpay_unfinalised_bounty_pools(boolean, integer) TO service_role;
