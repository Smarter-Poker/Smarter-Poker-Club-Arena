-- ═══════════════════════════════════════════════════════════════════════════
--  A PLAYER WHO EARNED A PAYOUT IS ALWAYS PAID (2026-09-01)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan, verbatim: "IT IS AN ABSOLUTE MUST THAT PLAYERS ALWAYS 100% GET PAID OUT
-- OF EVERY SINGLE MTT, SPIN OR HEADS UP THEY PLAY (IF THEY EARNED A PAYOUT)."
--
-- This migration ships the check that makes that verifiable, and closes two
-- ways the existing repair machinery could fail the rule quietly.
--
-- ── WHAT THE AUDIT FOUND, MEASURED AGAINST THE MONEY ──────────────────────
--
-- 49,044 completed events with a prize pool in the 120 days to 2026-09-01,
-- reconciled against wallet_transactions rather than against paperwork:
--
--   SPIN  32,433 events   0 underpaid
--   SNG   15,010 events   0 underpaid
--   MTT    1,601 events  12 underpaid, 76.70 chips
--
-- Every one of the twelve is the same defect and it has a signature nothing
-- was looking for: A PAID PLACE WITH NOBODY IN IT. Late Night Grind (PLO4) on
-- 2026-06-07 seated ten players and recorded finishing places 1, 2, then 6
-- through 13. Places 3, 4 and 5 pay 18%, 10% and 7% of the pool. Nobody held
-- them, so nobody was paid them, and 17.50 of a 50.00 pool stayed where it was.
-- Fifteen events carry nineteen such vacancies between 2026-05-08 and
-- 2026-07-19. There are none after 2026-07-19: the distinct-places work of that
-- day and the payout-integrity passes that followed fixed the cause. Nothing
-- fixed the blindness - no check on this platform asks whether a place the
-- structure pays actually has a holder, which is why it ran for ten weeks.
--
-- ── THE SECOND FINDING: THE RECORD IS NOT THE MONEY ───────────────────────
--
-- 61 events hold 5,515.91 chips of prizes that reached player wallets and were
-- never written to tournament_payouts - the record only became authoritative on
-- 2026-08-31 and the historical backfill did not reach them. That is a
-- paperwork gap, not a payment gap, and on its own it would be harmless.
--
-- It is not harmless, because fn_tournament_payout_reconcile computes "already
-- paid" FROM tournament_payouts (deliberately: counting ledger rows instead
-- caused two real double-pays, 88a6aced and b687e4aa). On an event with an
-- incomplete record it therefore concludes that money is still owed. Today it
-- concludes exactly that for 5,315.41 chips, and the ONLY reason the platform
-- has not paid them a second time is that those pools cannot back the payment.
-- That is luck, not a safety property. fn_pay_backed_payout_shortfalls gains a
-- conservation guard below so it can never be the thing that gets unlucky.
--
-- APPLIED AS TWO MIGRATIONS, and this file is the union of them:
--   20260901131129  a_player_who_earned_a_payout_is_always_paid
--   20260901131228  a_player_who_earned_a_payout_is_always_paid_comments
-- The first apply carried the SQL without the reasoning that belongs inside
-- fn_pay_backed_payout_shortfalls; the second put it back. Both function
-- bodies in this file were then checked against production rather than
-- assumed - md5 of pg_proc.prosrc against md5 of the body in this file,
-- 2026-09-01:
--   fn_payout_guarantee_check        9d06324aa69260cdeb985d7111209674 11379 bytes
--   fn_pay_backed_payout_shortfalls  a528ce2103f371fb1f4f565dffb7589c  7361 bytes
-- The first hash has moved twice as the check earned corrections, and is
-- re-verified at each: c8c2e7ec when 20260901133841 gave it the five-cent
-- tolerance, and 9d06324a when 20260901200x gave it the bounty pool. Only the
-- latest is checked in; the earlier values are recorded so a reader can tell
-- drift from a deliberate change.
-- Only the bodies can match byte for byte; pg_get_functiondef rewrites the
-- signature and the SET clauses into its own layout.
--
-- ROLLBACK
--   DROP FUNCTION IF EXISTS public.fn_payout_guarantee_check(integer);
--   (and restore fn_pay_backed_payout_shortfalls from
--    20260831... the migration that introduced it)

-- ───────────────────────────────────────────────────────────────────────────
-- 1. THE CHECK. Three independent ways a player can be owed and unpaid, asked
--    of every completed event in the window, in one place, against the money.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_payout_guarantee_check(
  p_since_days integer DEFAULT 7
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_days     integer := LEAST(GREATEST(COALESCE(p_since_days, 7), 1), 400);
  v_since    timestamptz;
  v_vacant   integer := 0;
  v_vac_chips numeric := 0;
  v_short    integer := 0;
  v_short_chips numeric := 0;
  v_gap      integer := 0;
  v_gap_chips numeric := 0;
  v_bounty   integer := 0;
  v_bounty_chips numeric := 0;
  v_alerts   integer := 0;
  v_row      record;
BEGIN
  v_since := now() - make_interval(days => v_days);

  FOR v_row IN
    WITH ev AS (
      SELECT t.id, t.name, t.club_id, t.tournament_type, t.ended_at,
             COALESCE(t.prize_pool, 0) AS pool,
             (SELECT count(*) FROM public.tournament_players tp
               WHERE tp.tournament_id = t.id) AS entrants,
             t.payout_structure
        FROM public.tournaments t
       WHERE t.status = 'COMPLETED'
         AND t.ended_at >= v_since
         AND COALESCE(t.prize_pool, 0) > 0
         AND COALESCE(t.satellite_seats, 0) = 0
         AND COALESCE(t.variant, '') <> 'satellite'
    ), places AS (
      SELECT ev.*, (elem->>'place')::int AS place, (elem->>'percentage')::numeric AS pct
        FROM ev
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(ev.payout_structure::jsonb) = 'array'
               THEN ev.payout_structure::jsonb ELSE '[]'::jsonb END) elem
    )
    SELECT p.id, p.name, p.club_id, p.tournament_type, p.ended_at, p.pool, p.entrants,
           array_agg(p.place ORDER BY p.place) AS vacant_places,
           round(sum(p.pool * p.pct / 100), 2) AS chips
      FROM places p
     WHERE p.place <= p.entrants
       AND NOT EXISTS (SELECT 1 FROM public.tournament_players tp
                        WHERE tp.tournament_id = p.id AND tp.position = p.place)
     GROUP BY p.id, p.name, p.club_id, p.tournament_type, p.ended_at, p.pool, p.entrants
  LOOP
    v_vacant := v_vacant + 1;
    v_vac_chips := v_vac_chips + COALESCE(v_row.chips, 0);
    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT 'critical', 'fn_payout_guarantee_check',
           format('%s ranked a %s-player field but left paid place(s) %s with nobody in them, so %s chips were paid to no one',
                  COALESCE(v_row.name, v_row.id::text), v_row.entrants,
                  array_to_string(v_row.vacant_places, ', '), v_row.chips),
           jsonb_build_object('kind','vacant_paid_place','tournament_id',v_row.id,
             'club_id',v_row.club_id,'tournament_type',v_row.tournament_type,
             'entrants',v_row.entrants,'prize_pool',v_row.pool,
             'vacant_places',to_jsonb(v_row.vacant_places),'chips',v_row.chips,
             'ended_at',v_row.ended_at,
             'detail','whoever finished in those places was mislabelled; no money was moved by this check')
     WHERE NOT EXISTS (SELECT 1 FROM public.financial_alerts fa
                        WHERE fa.source = 'fn_payout_guarantee_check'
                          AND fa.resolved IS NOT TRUE
                          AND fa.context->>'kind' = 'vacant_paid_place'
                          AND fa.context->>'tournament_id' = v_row.id::text);
    IF FOUND THEN v_alerts := v_alerts + 1; END IF;
  END LOOP;

  FOR v_row IN
    WITH ev AS (
      SELECT t.id, t.name, t.club_id, t.tournament_type, t.ended_at,
             COALESCE(t.prize_pool, 0) AS pool, t.payout_structure
        FROM public.tournaments t
       WHERE t.status = 'COMPLETED'
         AND t.ended_at >= v_since
         AND COALESCE(t.prize_pool, 0) > 0
         AND COALESCE(t.satellite_seats, 0) = 0
         AND COALESCE(t.variant, '') <> 'satellite'
    ), owed AS (
      SELECT ev.id, ev.name, ev.club_id, ev.tournament_type, ev.ended_at,
             tp.user_id, tp.position,
             round(ev.pool * (elem->>'percentage')::numeric / 100, 2) AS place_worth
        FROM ev
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(ev.payout_structure::jsonb) = 'array'
               THEN ev.payout_structure::jsonb ELSE '[]'::jsonb END) elem
        JOIN public.tournament_players tp
          ON tp.tournament_id = ev.id AND tp.position = (elem->>'place')::int
    )
    SELECT o.*, COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
                           WHERE w.related_entity_id = o.id AND w.user_id = o.user_id
                             AND w.type = 'credit'
                             AND w.category IN ('prize','bounty')), 0) AS credited
      FROM owed o
     /* FIVE CENTS, NOT ONE (2026-09-01, same day). place_worth here is the flat
        pool * percentage. The engine allocates in whole cents and gives the
        last paid place the remainder, so a place can legitimately land a cent
        or two either side of the flat figure - the first run of this check
        reported the ninth place of a $100 Freeroll as short by 0.02 on exactly
        that difference, and it was not short. A player who was paid nothing
        still trips this at any tolerance; what the tolerance buys is that the
        one alert it raises is real. */
     WHERE COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
                      WHERE w.related_entity_id = o.id AND w.user_id = o.user_id
                        AND w.type = 'credit'
                        AND w.category IN ('prize','bounty')), 0) + 0.05 < o.place_worth
  LOOP
    v_short := v_short + 1;
    v_short_chips := v_short_chips + (v_row.place_worth - v_row.credited);
    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT 'critical', 'fn_payout_guarantee_check',
           format('%s: the player who finished %s is owed %s and their wallet received %s',
                  COALESCE(v_row.name, v_row.id::text), v_row.position,
                  v_row.place_worth, v_row.credited),
           jsonb_build_object('kind','earner_not_paid','tournament_id',v_row.id,
             'club_id',v_row.club_id,'tournament_type',v_row.tournament_type,
             'user_id',v_row.user_id,'position',v_row.position,
             'place_worth',v_row.place_worth,'credited',v_row.credited,
             'short',round(v_row.place_worth - v_row.credited, 2),
             'ended_at',v_row.ended_at,
             'detail','no money was moved by this check')
     WHERE NOT EXISTS (SELECT 1 FROM public.financial_alerts fa
                        WHERE fa.source = 'fn_payout_guarantee_check'
                          AND fa.resolved IS NOT TRUE
                          AND fa.context->>'kind' = 'earner_not_paid'
                          AND fa.context->>'tournament_id' = v_row.id::text
                          AND fa.context->>'user_id' = v_row.user_id::text);
    IF FOUND THEN v_alerts := v_alerts + 1; END IF;
  END LOOP;

  /* THE OTHER POOL (2026-09-01). Everything above reconciles the PRIZE pool,
     and a bounty event funds a SECOND pool out of the same buy-in. Nothing
     asked whether that one was paid out, and 38 completed events were holding
     1,931.24 chips of it - 34 of them completed by the stuck-COMPLETING
     watchdog, which settled the rake and never touched bounties. The rule the
     platform already had is that whatever is left settles to the champion;
     fn_backpay_unfinalised_bounty_pools re-drives it. This is the check that
     makes the failure visible rather than the repair. */
  FOR v_row IN
    SELECT t.id, t.name, t.club_id, t.ended_at,
           round(COALESCE(t.bounty_pool, 0), 2) AS pool,
           COALESCE((SELECT round(sum(w.amount), 2) FROM public.wallet_transactions w
                      WHERE w.related_entity_id = t.id AND w.type = 'credit'
                        AND w.category = 'bounty'), 0) AS paid
      FROM public.tournaments t
     WHERE t.status = 'COMPLETED'
       AND t.ended_at >= v_since
       AND COALESCE(t.bounty_pool, 0) > 0
  LOOP
    CONTINUE WHEN v_row.paid + 0.01 >= v_row.pool;
    v_bounty := v_bounty + 1;
    v_bounty_chips := v_bounty_chips + (v_row.pool - v_row.paid);
    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT 'critical', 'fn_payout_guarantee_check',
           format('%s funded a %s bounty pool and paid out %s, so %s chips of it reached no player',
                  COALESCE(v_row.name, v_row.id::text), v_row.pool, v_row.paid,
                  round(v_row.pool - v_row.paid, 2)),
           jsonb_build_object('kind','bounty_pool_retained','tournament_id',v_row.id,
             'club_id',v_row.club_id,'bounty_pool',v_row.pool,'paid',v_row.paid,
             'retained',round(v_row.pool - v_row.paid, 2),'ended_at',v_row.ended_at,
             'detail','the residual settles to the champion; fn_backpay_unfinalised_bounty_pools re-drives it. No money was moved by this check')
     WHERE NOT EXISTS (SELECT 1 FROM public.financial_alerts fa
                        WHERE fa.source = 'fn_payout_guarantee_check'
                          AND fa.resolved IS NOT TRUE
                          AND fa.context->>'kind' = 'bounty_pool_retained'
                          AND fa.context->>'tournament_id' = v_row.id::text);
    IF FOUND THEN v_alerts := v_alerts + 1; END IF;
  END LOOP;

  SELECT count(*), COALESCE(round(sum(gap), 2), 0) INTO v_gap, v_gap_chips
    FROM (
      SELECT t.id,
             COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
                        WHERE w.related_entity_id = t.id AND w.type='credit'
                          AND w.category='prize'), 0)
           - COALESCE((SELECT sum(p.amount) FROM public.tournament_payouts p
                        WHERE p.tournament_id = t.id
                          AND p.source NOT IN ('bounty','own_bounty','mystery_bounty_residual')), 0)
             AS gap
        FROM public.tournaments t
       WHERE t.status='COMPLETED' AND t.ended_at >= v_since
         AND COALESCE(t.prize_pool,0) > 0
    ) g
   WHERE g.gap > 0.01;

  IF v_gap > 0 THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT 'warning', 'fn_payout_guarantee_check',
           format('%s event(s) in the last %s days paid %s chips of prizes that were never written to tournament_payouts; the reconciler reads that record and will treat those chips as still owed',
                  v_gap, v_days, v_gap_chips),
           jsonb_build_object('kind','paid_but_unrecorded','events',v_gap,
             'chips',v_gap_chips,'since_days',v_days,
             'detail','no player is short; this is what arms a double-pay if the pool is ever funded')
     WHERE NOT EXISTS (SELECT 1 FROM public.financial_alerts fa
                        WHERE fa.source='fn_payout_guarantee_check'
                          AND fa.resolved IS NOT TRUE
                          AND fa.context->>'kind' = 'paid_but_unrecorded'
                          AND fa.created_at > now() - interval '20 hours');
    IF FOUND THEN v_alerts := v_alerts + 1; END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'since_days', v_days,
    'vacant_paid_place_events', v_vacant,
    'vacant_paid_place_chips', round(v_vac_chips, 2),
    'earners_not_paid', v_short,
    'earners_not_paid_chips', round(v_short_chips, 2),
    'bounty_pool_retained_events', v_bounty,
    'bounty_pool_retained_chips', round(v_bounty_chips, 2),
    'paid_but_unrecorded_events', v_gap,
    'paid_but_unrecorded_chips', v_gap_chips,
    'alerts_raised', v_alerts);
END;
$function$;

COMMENT ON FUNCTION public.fn_payout_guarantee_check(integer) IS
  'The one place that asks whether every player who earned a payout in an MTT, Spin or Heads-Up actually received it. Three independent failures: a paid place with no holder, an earner whose wallet never saw the money, and prizes paid without a tournament_payouts record (which is what arms a double-pay, since the reconciler reads that record). Measured against wallet_transactions, never against paperwork. Raises deduped financial_alerts and moves no money.';

REVOKE ALL ON FUNCTION public.fn_payout_guarantee_check(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_payout_guarantee_check(integer) TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. THE SWEEP THAT PAYS. Three corrections, none of which change what it
--    pays today, all of which change what it can never do again.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_pay_backed_payout_shortfalls(
  p_apply boolean DEFAULT false,
  p_limit integer DEFAULT 500
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record; v_res jsonb;
  v_paid numeric := 0; v_events integer := 0;
  v_withheld numeric := 0; v_withheld_events integer := 0;
  v_refused integer := 0; v_refused_chips numeric := 0;
  v_alerts integer := 0;
  v_delta_after numeric;
BEGIN
  FOR r IN
    SELECT t.id, t.name, t.club_id, t.prize_pool,
           COALESCE((public.fn_tournament_payout_reconcile(t.id, false)->>'total_top_up')::numeric, 0) AS topup,
           public.fn_tournament_conservation_delta(t.id) AS delta,
           COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
                      WHERE w.related_entity_id = t.id AND w.type = 'credit'
                        AND w.category = 'prize'), 0) AS wallet_prizes
      FROM public.tournaments t
     WHERE t.status = 'COMPLETED'
       -- Satellites award seats, not cash. Reconciling them against a cash
       -- pool would invent prizes that do not exist.
       AND COALESCE(t.variant, '') <> 'satellite'
       -- A Spin's pool is funded by the reserve, not by this game's own
       -- collections, so its delta does not mean what it means elsewhere.
       AND COALESCE(t.variant, '') <> 'spin'
       /* THE LOG IS A RECEIPT, NOT A TOMBSTONE (2026-09-01).
          This clause used to be `NOT EXISTS (... backfill_log ...)`, so one
          pass over an event excluded it from every future pass, for good. That
          is wrong in principle rather than in practice today: an event can
          become payable AFTER its pass - a guarantee gets funded, a
          conservation baseline is acknowledged - and nothing would ever look
          at it again. Measured before this change, no logged event is payable
          right now (all 57 fail the conservation filter below on their own
          merits), so removing the clause unlocks no payment today and closes
          the door on a shortfall that outlives its one and only inspection.
          "Nothing is owed" is the only correct exclusion, and it is computed
          below as `topup <= 0.005`. The log stays, as the audit trail it
          should always have been. */
       AND public.fn_tournament_conservation_delta(t.id) > 0.01
     ORDER BY t.ended_at ASC NULLS LAST
     LIMIT GREATEST(p_limit, 1)
  LOOP
    CONTINUE WHEN r.topup <= 0.005;

    /* CONSERVATION REFUSES BEFORE THE POOL DOES (2026-09-01).
       The reconciler computes "already paid" from tournament_payouts, on
       purpose - counting ledger rows instead caused two real double-pays. The
       cost of that choice is that an event whose record is incomplete reports
       a debt it does not have, and 61 events on this platform hold 5,515.91
       chips of prizes that reached wallets and were never recorded. If such a
       pool is ever funded, this sweep would pay them a second time.

       An event that has already disbursed its whole pool to wallets owes
       nobody, whatever the paperwork says. Refuse, and say so, so the record
       gets fixed rather than paid twice. */
    IF r.wallet_prizes + 0.01 >= COALESCE(r.prize_pool, 0) AND COALESCE(r.prize_pool, 0) > 0 THEN
      v_refused := v_refused + 1;
      v_refused_chips := v_refused_chips + r.topup;
      INSERT INTO public.financial_alerts (severity, source, message, context)
      SELECT 'warning', 'fn_pay_backed_payout_shortfalls',
             format('%s already paid %s of its %s pool to wallets, so the %s the reconciler reports as owed is a missing tournament_payouts record, not a debt. Paying nothing.',
                    COALESCE(r.name, r.id::text), round(r.wallet_prizes,2),
                    round(COALESCE(r.prize_pool,0),2), round(r.topup,2))
           , jsonb_build_object('kind','refused_already_disbursed','tournament_id',r.id,
               'club_id',r.club_id,'wallet_prizes',round(r.wallet_prizes,2),
               'prize_pool',round(COALESCE(r.prize_pool,0),2),'reported_top_up',round(r.topup,2))
       WHERE NOT EXISTS (SELECT 1 FROM public.financial_alerts fa
                          WHERE fa.source='fn_pay_backed_payout_shortfalls'
                            AND fa.resolved IS NOT TRUE
                            AND fa.context->>'kind'='refused_already_disbursed'
                            AND fa.context->>'tournament_id' = r.id::text);
      IF FOUND THEN v_alerts := v_alerts + 1; END IF;
      CONTINUE;
    END IF;

    -- The event must be holding at least what it is about to pay out. Not
    -- `delta >= 0` - that would let an event with 3 chips spare pay out 300.
    IF r.delta < r.topup THEN
      v_withheld := v_withheld + r.topup;
      v_withheld_events := v_withheld_events + 1;
      /* WITHHOLDING IS NEVER SILENT (2026-09-01).
         This branch used to increment a counter that reached a console line
         and nothing else. Money owed to a player and not paid produced no
         durable record anywhere, so nobody could find it later, and nobody
         did. It is a deduped alert now, per event, naming the gap. */
      INSERT INTO public.financial_alerts (severity, source, message, context)
      SELECT 'critical', 'fn_pay_backed_payout_shortfalls',
             format('%s owes players %s and its pool holds %s, so nothing was paid. The shortfall needs funding before anyone can be paid.',
                    COALESCE(r.name, r.id::text), round(r.topup,2), round(r.delta,2))
           , jsonb_build_object('kind','withheld_unfunded_pool','tournament_id',r.id,
               'club_id',r.club_id,'owed',round(r.topup,2),'pool_holds',round(r.delta,2),
               'funding_gap',round(r.topup - r.delta,2),
               'detail','no money was moved; funding an advertised guarantee is a human decision')
       WHERE NOT EXISTS (SELECT 1 FROM public.financial_alerts fa
                          WHERE fa.source='fn_pay_backed_payout_shortfalls'
                            AND fa.resolved IS NOT TRUE
                            AND fa.context->>'kind'='withheld_unfunded_pool'
                            AND fa.context->>'tournament_id' = r.id::text);
      IF FOUND THEN v_alerts := v_alerts + 1; END IF;
      CONTINUE;
    END IF;

    IF p_apply THEN
      v_res := public.fn_tournament_payout_reconcile(r.id, true);
      v_delta_after := public.fn_tournament_conservation_delta(r.id);

      IF v_delta_after < -0.01 THEN
        RAISE EXCEPTION 'paying % would leave conservation at %; refusing', r.id, v_delta_after;
      END IF;

      INSERT INTO public.tournament_payout_backfill_log
        (tournament_id, top_up, delta_before, delta_after)
      VALUES (r.id, COALESCE((v_res->>'total_top_up')::numeric, r.topup), r.delta, v_delta_after)
      ON CONFLICT (tournament_id) DO UPDATE
        SET top_up = EXCLUDED.top_up,
            delta_before = EXCLUDED.delta_before,
            delta_after = EXCLUDED.delta_after;

      v_paid := v_paid + COALESCE((v_res->>'total_top_up')::numeric, 0);
    ELSE
      v_paid := v_paid + r.topup;
    END IF;
    v_events := v_events + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'applied', p_apply,
    'events_paid', v_events, 'chips_paid', round(v_paid, 2),
    'events_withheld_unfunded_pool', v_withheld_events,
    'chips_withheld_unfunded_pool', round(v_withheld, 2),
    'events_refused_already_disbursed', v_refused,
    'chips_refused_already_disbursed', round(v_refused_chips, 2),
    'alerts_raised', v_alerts);
END;
$function$;

-- CREATE OR REPLACE does not reset an ACL, and production already holds
-- exactly this grant, so these two statements change nothing there. They are
-- here because check-definer-authorization reads the migration, not the
-- database, and it is right to: a migration that declares a SECURITY DEFINER
-- function which moves money should say on its face who may call it. Nobody in
-- a browser calls a sweep.
REVOKE ALL ON FUNCTION public.fn_pay_backed_payout_shortfalls(boolean, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_pay_backed_payout_shortfalls(boolean, integer) TO service_role;

COMMENT ON FUNCTION public.fn_pay_backed_payout_shortfalls(boolean, integer) IS
  'Pays what a completed event still owes its players, when the event is holding the chips to pay it. Refuses an event whose wallet credits already cover its pool (a missing payout record is not a debt), alerts on every event whose pool cannot back what it owes rather than withholding silently, and treats tournament_payout_backfill_log as a receipt rather than a tombstone so a shortfall stays visible until it is genuinely settled.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='fn_payout_guarantee_check') THEN
    RAISE EXCEPTION 'fn_payout_guarantee_check was not created';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='fn_pay_backed_payout_shortfalls'
                AND pg_get_functiondef(p.oid) LIKE '%tournament_payout_backfill_log l%') THEN
    RAISE EXCEPTION 'fn_pay_backed_payout_shortfalls still excludes on the backfill log';
  END IF;
END $$;
