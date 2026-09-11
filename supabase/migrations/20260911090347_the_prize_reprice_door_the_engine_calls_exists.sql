-- 20260911090347_the_prize_reprice_door_the_engine_calls_exists
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-11 09:03:47 UTC.
--
-- WHAT HAPPENED (2026-09-11, read from production)
--
-- The engine's prize recalculation (TournamentManagerEliminations, since
-- #4066/#4105) certifies every changed place prize through
--
--   supabase.rpc('fn_ca_reprice_unpaid_tournament_place', ...)
--
-- and treats a failure as "atomic completion will refuse an incomplete prize
-- set": the finish is refused and retried for ever. That function exists in
-- exactly one migration, 20260910000905_final_tournament_roster_seat_authority
-- _after_scheduler_fence, which is part of the M6 seat-authority cutover and
-- was never applied (it refuses to run without M6's tables, and 20260910051125
-- explains why that cutover must not be applied from an incident). Production
-- has therefore never had the door the deployed engine calls. At 09:01 UTC
-- the engine logged, for fe72385b:
--
--   [Tournament.prize_recalc_record_failed] prize recalc could not certify
--   prize=54.45 for fb7da841: Could not find the function
--   public.fn_ca_reprice_unpaid_tournament_place(...) in the schema cache
--
-- Any event whose recorded prizes stop matching its ladder (a pool that grows
-- after places were stamped, or standings corrected to true bust order, as
-- fe72385b and 5aa7eeba were at 08:38) can never finish.
--
-- WHAT THIS DOES
--
-- Installs exactly that door, VERBATIM from 20260910000905 L2129-2243 (the
-- text is copied by line range from origin/main, not retyped), with one
-- deliberate edit marked "-- HOTFIX EDIT" inline: it enters this tournament's
-- settlement lane through fn_ca_lock_settlement_lane_for_tournament instead of
-- taking the raw global key exclusively, matching 20260910035245 and the
-- 20260910051125 hotfix of fn_move_tournament_player.
--
-- NOT included: 20260910000905's REVOKE INSERT,UPDATE,DELETE ON
-- tournament_players FROM service_role, and everything else in that cutover.
-- Nothing existing is replaced, renamed or dropped. When the M6 chain is
-- applied, its CREATE OR REPLACE supersedes this body; its owner reconciles
-- the lane-lock edit then.
--
-- Must not be applied inside minute :50-:03 UTC (CLAUDE.md DDL rule 8).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regprocedure('public.fn_caller_is_engine()') IS NULL
     OR to_regprocedure('public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_tournament_payout_key_is_place_evidence(uuid,text)') IS NULL
     OR to_regclass('public.tournament_place_settlement_batches') IS NULL
     OR to_regclass('public.tournament_satellite_settlement_batches') IS NULL
     OR to_regclass('public.tournament_terminal_settlements') IS NULL
     OR to_regclass('public.tournament_cancellation_receipts') IS NULL
     OR to_regclass('public.tournament_obligations') IS NULL
     OR to_regclass('public.tournament_payouts') IS NULL THEN
    RAISE EXCEPTION 'the reprice door needs its dependencies; re-measure';
  END IF;
  IF to_regprocedure('public.fn_ca_reprice_unpaid_tournament_place(uuid,uuid,numeric,numeric)') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_proc
        WHERE oid = to_regprocedure('public.fn_ca_reprice_unpaid_tournament_place(uuid,uuid,numeric,numeric)')
          AND md5(prosrc) = '691a3f79a0a36e48f822832d98e12052') THEN
    RAISE EXCEPTION 'fn_ca_reprice_unpaid_tournament_place already exists with another body; reconcile, do not overwrite';
  END IF;
END;
$preflight$;

-- Prize recalculation keeps one narrow database door. It is allowed only while
-- the event is RUNNING, before a place/satellite batch, terminal/cancellation
-- receipt, or any prepared or paid place evidence exists. Compare-and-set makes
-- a retry or stale engine snapshot explicit instead of silently overwriting a
-- new value.
CREATE OR REPLACE FUNCTION public.fn_ca_reprice_unpaid_tournament_place(
  p_tournament_id uuid,
  p_user_id uuid,
  p_expected_prize numeric,
  p_new_prize numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $reprice_unpaid_tournament_place$
DECLARE
  v_tournament_status text;
  v_roster_id uuid;
  v_current_prize numeric;
  v_updated_prize numeric;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'tournament prize repricing requires service authority'
      USING ERRCODE='28000';
  END IF;
  IF p_tournament_id IS NULL OR p_user_id IS NULL
     OR p_expected_prize IS NULL OR p_new_prize IS NULL
     OR p_expected_prize::text IN ('NaN','Infinity','-Infinity')
     OR p_new_prize::text IN ('NaN','Infinity','-Infinity')
     OR p_expected_prize<0 OR p_new_prize<0
     OR p_expected_prize<>round(p_expected_prize,2)
     OR p_new_prize<>round(p_new_prize,2) THEN
    RAISE EXCEPTION 'tournament prize repricing requires finite nonnegative exact cents'
      USING ERRCODE='22023';
  END IF;

  -- HOTFIX EDIT (20260911090347): this tournament's settlement lane
  -- (G shared, T(id) exclusive) instead of the raw global key, as
  -- 20260910051125 did for fn_move_tournament_player. A reprice is one
  -- tournament's roster row: it must exclude that tournament's hands and any
  -- terminal authority, not every hand on the platform.
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  SELECT upper(COALESCE(t.status::text,'')) INTO v_tournament_status
    FROM public.tournaments t
   WHERE t.id=p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist',p_tournament_id
      USING ERRCODE='P0002';
  END IF;
  IF v_tournament_status<>'RUNNING' THEN
    RAISE EXCEPTION 'tournament prize repricing requires RUNNING status'
      USING ERRCODE='55000';
  END IF;

  SELECT tp.id,tp.prize::numeric INTO v_roster_id,v_current_prize
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament player does not exist'
      USING ERRCODE='P0002';
  END IF;

  IF EXISTS (SELECT 1 FROM public.tournament_place_settlement_batches b
              WHERE b.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_satellite_settlement_batches b
                 WHERE b.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_terminal_settlements h
                 WHERE h.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_cancellation_receipts c
                 WHERE c.tournament_id=p_tournament_id)
     OR EXISTS (
       SELECT 1 FROM public.tournament_obligations o
        WHERE o.tournament_id=p_tournament_id
          AND o.kind IN (
            'place','bubble_protection','final_table_deal',
            'late_reg_adjustment'))
     OR EXISTS (
       SELECT 1 FROM public.tournament_payouts p
        WHERE p.tournament_id=p_tournament_id
          AND (p.source IN (
            'structure','reconcile','hu_shortfall','late_reg_adjustment',
            'clawback','spin_backpay','overlay_backpay','final_table_deal')
            OR public.fn_tournament_payout_key_is_place_evidence(
                 p.tournament_id,p.idempotency_key))) THEN
    RAISE EXCEPTION
      'tournament prize repricing is closed after prepared or paid terminal evidence'
      USING ERRCODE='55000';
  END IF;

  IF v_current_prize IS DISTINCT FROM p_expected_prize THEN
    RAISE EXCEPTION 'tournament prize changed from expected % to %',
      p_expected_prize,v_current_prize USING ERRCODE='40001';
  END IF;

  UPDATE public.tournament_players tp
     SET prize=p_new_prize
   WHERE tp.id=v_roster_id
     AND tp.tournament_id=p_tournament_id
     AND tp.user_id=p_user_id
     AND tp.prize IS NOT DISTINCT FROM p_expected_prize
  RETURNING tp.prize::numeric INTO v_updated_prize;
  IF NOT FOUND OR v_updated_prize IS DISTINCT FROM p_new_prize THEN
    RAISE EXCEPTION 'tournament prize compare-and-set lost its locked row'
      USING ERRCODE='40001';
  END IF;

  RETURN jsonb_build_object(
    'ok',true,'tournament_id',p_tournament_id,'user_id',p_user_id,
    'prize',v_updated_prize);
END;
$reprice_unpaid_tournament_place$;

REVOKE ALL ON FUNCTION public.fn_ca_reprice_unpaid_tournament_place(
  uuid,uuid,numeric,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_reprice_unpaid_tournament_place(
  uuid,uuid,numeric,numeric) TO service_role;

DO $postflight$
DECLARE
  v_oid oid := 'public.fn_ca_reprice_unpaid_tournament_place(uuid,uuid,numeric,numeric)'::regprocedure;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_oid
                   AND md5(prosrc) = '691a3f79a0a36e48f822832d98e12052'
                   AND prosecdef
                   AND proowner = 'postgres'::regrole
                   AND proconfig = ARRAY['search_path=public, pg_temp']::text[]) THEN
    RAISE EXCEPTION 'the reprice door did not install the reviewed body';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'the reprice door has the wrong grants';
  END IF;
END;
$postflight$;

COMMIT;
