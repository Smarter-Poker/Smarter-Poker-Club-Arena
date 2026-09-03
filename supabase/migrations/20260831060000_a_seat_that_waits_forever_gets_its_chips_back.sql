-- ============================================================================
-- 20260831060000_a_seat_that_waits_forever_gets_its_chips_back.sql
-- TIER: 3 | AFFECTS: new table spin_fill_policy, new fn_spin_expire_unfilled,
--                    new view v_spin_unfilled_waits.
-- Applied to production via the Supabase MCP on 2026-08-31.
-- PHASE 2 of the 2026-08-31 spins follow-up.
--
-- THE GAP. A Spin is seat-first: you pay when you sit, and the game starts
-- when the third seat is sold. Nothing anywhere bounded the wait in between.
-- If the third player never arrived, the chips of everyone already seated
-- were locked with no timeout, no refund, and no way out but a human noticing.
--
-- Measured over the 7 days to 2026-08-31: 20,896 spins filled (99.7%), median
-- wait first-to-third seat 180s, p90 407s - and a worst case of 76,648s, or
-- 21 HOURS. Nine spins waited over six hours. Every one was horse-seated, so
-- no human has been harmed yet; the fleet fills tiers fast enough that this
-- stayed invisible. It is latent, not theoretical: the first human to sit at
-- a thin stake inherits exactly that 21-hour wait.
--
-- HORSES ARE PLAYERS (CLAUDE.md 10.5). There is no is_horse branch here. A
-- horse's chips come out of the club wallet and are refunded on the same
-- terms - which also returns the fleet capacity those 21 hours consumed.
--
-- THE RULE. A spin is expired when it is still open, has not started, has at
-- least one seat waiting longer than the policy, and is NOT full. A full
-- unstarted game is one about to deal and is never touched. Cancellation goes
-- through atomic_cancel_tournament, the sanctioned refund path that
-- trg_tournaments_cancel_must_refund insists on.
--
-- THE TIMEOUT IS A CONFIG ROW, NOT A CONSTANT: p90 is under 7 minutes, so the
-- 30-minute default is ~4.4x the slowest normal fill. Dan tunes it, and 0
-- disables the sweep without a deploy.
--
-- VERIFIED by two rolled-back probes against production: a 90-minute-old
-- partial expired (status CANCELLED, seat released, refund path run), and a
-- FULL spin with 5-hour-old seats was correctly left alone.
--
-- ROLLBACK
--   UPDATE public.spin_fill_policy SET unfilled_timeout_minutes = 0;  -- disable
--   DROP VIEW IF EXISTS public.v_spin_unfilled_waits;
--   DROP FUNCTION IF EXISTS public.fn_spin_expire_unfilled(integer);
--   DROP TABLE IF EXISTS public.spin_fill_policy;
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.spin_fill_policy (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  unfilled_timeout_minutes integer NOT NULL DEFAULT 30,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spin_fill_policy_sane CHECK (unfilled_timeout_minutes >= 0 AND unfilled_timeout_minutes <= 10080)
);
COMMENT ON TABLE public.spin_fill_policy IS
  'One row. How long a seat may wait in an unfilled Spin before the game is '
  'cancelled and every seated player refunded. 0 disables the sweep. '
  'Dan tunes this; it is deliberately not a code constant.';

INSERT INTO public.spin_fill_policy (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.spin_fill_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.spin_fill_policy FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.spin_fill_policy TO service_role;

CREATE OR REPLACE FUNCTION public.fn_spin_expire_unfilled(p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_minutes integer;
  g record;
  res jsonb;
  v_expired integer := 0;
  v_failed integer := 0;
  v_refunded numeric := 0;
  v_ids jsonb := '[]'::jsonb;
BEGIN
  SELECT unfilled_timeout_minutes INTO v_minutes FROM public.spin_fill_policy LIMIT 1;
  v_minutes := COALESCE(v_minutes, 30);

  -- 0 (or a missing row) means the operator has switched the sweep off.
  IF v_minutes <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'disabled', true, 'expired', 0);
  END IF;

  FOR g IN
    SELECT t.id,
           t.buy_in_amount,
           (SELECT count(*) FROM public.table_seats s
              JOIN public.tables tb ON tb.id = s.table_id
             WHERE tb.tournament_id = t.id AND s.left_at IS NULL) AS live_seats
      FROM public.tournaments t
     WHERE t.variant = 'spin'
       AND t.status IN ('REGISTERING', 'ANNOUNCED')
       AND t.started_at IS NULL
       -- somebody has actually been waiting too long
       AND EXISTS (SELECT 1 FROM public.table_seats s
                     JOIN public.tables tb ON tb.id = s.table_id
                    WHERE tb.tournament_id = t.id
                      AND s.left_at IS NULL
                      AND s.joined_at < now() - make_interval(mins => v_minutes))
       -- and the game is NOT full: a full unstarted spin is about to deal.
       AND (SELECT count(*) FROM public.table_seats s
              JOIN public.tables tb ON tb.id = s.table_id
             WHERE tb.tournament_id = t.id AND s.left_at IS NULL)
           < COALESCE(t.max_players, 3)
     ORDER BY t.created_at
     LIMIT GREATEST(COALESCE(p_limit, 50), 1)
  LOOP
    BEGIN
      res := public.atomic_cancel_tournament(g.id, NULL);
      v_expired := v_expired + 1;
      v_refunded := v_refunded + (COALESCE(g.buy_in_amount, 0) * COALESCE(g.live_seats, 0));
      v_ids := v_ids || to_jsonb(g.id::text);
    EXCEPTION WHEN OTHERS THEN
      -- Loud, never fatal: one stuck game must not stop the rest being freed.
      v_failed := v_failed + 1;
      RAISE WARNING 'fn_spin_expire_unfilled: could not cancel %: %', g.id, SQLERRM;
    END;
    -- The counter derives from the seats either way (see 20260830110000).
    PERFORM public.fn_sync_seat_first_player_count(g.id);
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'expired', v_expired,
    'failed', v_failed,
    'chips_refunded_estimate', round(v_refunded, 2),
    'timeout_minutes', v_minutes,
    'tournament_ids', v_ids);
END;
$function$;

-- Engine-only: it cancels games and moves refunds. No browser calls this.
REVOKE ALL ON FUNCTION public.fn_spin_expire_unfilled(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_expire_unfilled(integer) TO service_role;

COMMENT ON FUNCTION public.fn_spin_expire_unfilled(integer) IS
  'Cancels and refunds Spins whose seats have waited past spin_fill_policy. '
  'Idempotent, horse-inclusive, never cancels a full-but-unstarted game.';

-- Observability: what is waiting right now, and what the sweep would act on.
CREATE OR REPLACE VIEW public.v_spin_unfilled_waits AS
SELECT t.id AS tournament_id,
       t.club_id,
       t.name,
       t.buy_in_amount,
       t.max_players,
       (SELECT count(*) FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
         WHERE tb.tournament_id = t.id AND s.left_at IS NULL) AS live_seats,
       (SELECT min(s.joined_at) FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
         WHERE tb.tournament_id = t.id AND s.left_at IS NULL) AS oldest_seat_at,
       age(now(), (SELECT min(s.joined_at) FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
         WHERE tb.tournament_id = t.id AND s.left_at IS NULL)) AS longest_wait,
       round(t.buy_in_amount * (SELECT count(*) FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
         WHERE tb.tournament_id = t.id AND s.left_at IS NULL), 2) AS chips_locked
  FROM public.tournaments t
 WHERE t.variant = 'spin'
   AND t.status IN ('REGISTERING', 'ANNOUNCED')
   AND t.started_at IS NULL
   AND (SELECT count(*) FROM public.table_seats s JOIN public.tables tb ON tb.id = s.table_id
         WHERE tb.tournament_id = t.id AND s.left_at IS NULL) BETWEEN 1 AND COALESCE(t.max_players, 3) - 1;
