-- ===========================================================================
-- FINAL TABLE DEAL (2026-08-22)
--
-- fn_final_table_deal(p_tournament_id): even chip-chop (no ICM) of the
-- remaining undistributed prize pool among the players still alive, valid
-- only when the tournament opted in (final_table_deal_enabled), is RUNNING,
-- and is down to one table (remaining <= table_size). Each player receives
-- floor(chips / total_chips * undistributed) whole units; the rounding
-- remainder goes to the chip leader. Payouts are recorded in
-- tournament_payouts and the tournament is marked COMPLETING ('COMPLETING'
-- is in tournaments_status_check - verified live 2026-08-22). The SERVER
-- ENGINE calls this when tournament_deal_votes is unanimous and then settles
-- the payout rows to wallets; this function only writes the SQL record.
--
-- tournament_payouts DID NOT EXIST in prod (checked to_regclass 2026-08-22);
-- created here as the generic payout record table.
--
-- tournament_deal_votes: one row per seated player who agreed to the deal.
-- Authenticated players may insert ONLY their own vote, only while seated in
-- a RUNNING tournament with the deal feature enabled. Votes are readable by
-- any authenticated user (the table UI shows who has agreed).
--
-- Idempotent: re-runnable; the deal itself refuses to run twice.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Payout record table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tournament_payouts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL,
  position      integer,
  amount        numeric NOT NULL DEFAULT 0 CHECK (amount >= 0),
  source        text NOT NULL DEFAULT 'payout',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tournament_payouts_tournament
  ON public.tournament_payouts (tournament_id);

ALTER TABLE public.tournament_payouts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tpay_read ON public.tournament_payouts;
CREATE POLICY tpay_read ON public.tournament_payouts
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS tpay_service_all ON public.tournament_payouts;
CREATE POLICY tpay_service_all ON public.tournament_payouts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 2. Deal votes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tournament_deal_votes (
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tournament_id, user_id)
);

ALTER TABLE public.tournament_deal_votes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tdv_read ON public.tournament_deal_votes;
CREATE POLICY tdv_read ON public.tournament_deal_votes
  FOR SELECT TO authenticated USING (true);

-- Own vote only, only while seated (alive) in a RUNNING tournament that has
-- the final table deal feature enabled.
DROP POLICY IF EXISTS tdv_insert_own ON public.tournament_deal_votes;
CREATE POLICY tdv_insert_own ON public.tournament_deal_votes
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = tournament_deal_votes.tournament_id
         AND tp.user_id = auth.uid()
         AND tp.status IN ('registered', 'playing')
         AND tp.eliminated_at IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM public.tournaments t
       WHERE t.id = tournament_deal_votes.tournament_id
         AND COALESCE(t.final_table_deal_enabled, false)
         AND t.status = 'RUNNING'
    )
  );

DROP POLICY IF EXISTS tdv_service_all ON public.tournament_deal_votes;
CREATE POLICY tdv_service_all ON public.tournament_deal_votes
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 3. The deal function (engine-only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_final_table_deal(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_t             record;
  v_remaining     integer;
  v_total_chips   numeric;
  v_awarded       numeric;
  v_undistributed numeric;
  v_paid_out      numeric := 0;
  v_share         numeric;
  v_leader        uuid;
  v_remainder     numeric;
  v_p             record;
  v_payouts       jsonb := '[]'::jsonb;
BEGIN
  SELECT id, status, prize_pool, final_table_deal_enabled, COALESCE(table_size, 9) AS table_size
    INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;
  IF NOT COALESCE(v_t.final_table_deal_enabled, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'deal_not_enabled');
  END IF;
  IF v_t.status <> 'RUNNING' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_running');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_payouts
              WHERE tournament_id = p_tournament_id AND source = 'final_table_deal') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'deal_already_executed');
  END IF;

  SELECT count(*), COALESCE(sum(GREATEST(chips, 0)), 0)
    INTO v_remaining, v_total_chips
    FROM public.tournament_players
   WHERE tournament_id = p_tournament_id
     AND status IN ('registered', 'playing')
     AND eliminated_at IS NULL;

  IF v_remaining < 2 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_enough_players');
  END IF;
  IF v_remaining > v_t.table_size THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_at_final_table',
                              'detail', v_remaining);
  END IF;
  IF v_total_chips <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_chips_in_play');
  END IF;

  -- Undistributed pool: total prize pool minus what earlier finishers were
  -- already awarded (tournament_players.prize) and any payout rows already
  -- recorded for this tournament.
  SELECT COALESCE(sum(prize), 0) INTO v_awarded
    FROM public.tournament_players WHERE tournament_id = p_tournament_id;
  SELECT v_awarded + COALESCE(sum(amount), 0) INTO v_awarded
    FROM public.tournament_payouts WHERE tournament_id = p_tournament_id;

  v_undistributed := GREATEST(COALESCE(v_t.prize_pool, 0) - v_awarded, 0);
  IF v_undistributed <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_undistributed_prize');
  END IF;

  -- Chip leader takes the flooring remainder (ties: earliest registration).
  SELECT user_id INTO v_leader
    FROM public.tournament_players
   WHERE tournament_id = p_tournament_id
     AND status IN ('registered', 'playing')
     AND eliminated_at IS NULL
   ORDER BY chips DESC, registered_at ASC, user_id ASC
   LIMIT 1;

  FOR v_p IN
    SELECT user_id, chips
      FROM public.tournament_players
     WHERE tournament_id = p_tournament_id
       AND status IN ('registered', 'playing')
       AND eliminated_at IS NULL
     ORDER BY chips DESC, registered_at ASC, user_id ASC
  LOOP
    v_share := floor(GREATEST(v_p.chips, 0) / v_total_chips * v_undistributed);
    v_paid_out := v_paid_out + v_share;
    INSERT INTO public.tournament_payouts (tournament_id, user_id, amount, source)
    VALUES (p_tournament_id, v_p.user_id, v_share, 'final_table_deal');
    v_payouts := v_payouts || jsonb_build_object('user_id', v_p.user_id, 'amount', v_share);
  END LOOP;

  v_remainder := v_undistributed - v_paid_out;
  IF v_remainder > 0 AND v_leader IS NOT NULL THEN
    UPDATE public.tournament_payouts
       SET amount = amount + v_remainder
     WHERE tournament_id = p_tournament_id
       AND user_id = v_leader
       AND source = 'final_table_deal';
  END IF;

  -- Mirror the award onto the player rows so the results view is whole.
  UPDATE public.tournament_players tp
     SET prize = COALESCE(tp.prize, 0) + tpo.amount
    FROM public.tournament_payouts tpo
   WHERE tpo.tournament_id = p_tournament_id
     AND tpo.source = 'final_table_deal'
     AND tp.tournament_id = p_tournament_id
     AND tp.user_id = tpo.user_id;

  UPDATE public.tournaments
     SET status = 'COMPLETING', updated_at = now()
   WHERE id = p_tournament_id;

  RETURN jsonb_build_object('ok', true,
    'undistributed', v_undistributed,
    'remainder_to_leader', v_remainder,
    'chip_leader', v_leader,
    'payouts', v_payouts);
END; $function$;

-- Engine only: the deal moves prize money, so no browser role may call it.
REVOKE ALL ON FUNCTION public.fn_final_table_deal(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_final_table_deal(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.fn_final_table_deal(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_final_table_deal(uuid) TO service_role;

-- ── Post-apply assertions ──────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.tournament_payouts') IS NULL THEN
    RAISE EXCEPTION 'tournament_payouts was not created';
  END IF;
  IF to_regclass('public.tournament_deal_votes') IS NULL THEN
    RAISE EXCEPTION 'tournament_deal_votes was not created';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_final_table_deal') THEN
    RAISE EXCEPTION 'fn_final_table_deal missing after apply';
  END IF;
END $$;

COMMIT;
