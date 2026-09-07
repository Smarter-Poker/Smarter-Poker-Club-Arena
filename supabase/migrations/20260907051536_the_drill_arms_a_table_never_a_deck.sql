-- 20260907051536_the_drill_arms_a_table_never_a_deck.sql
--
-- Named for the version the Supabase MCP recorded when it applied this, so a
-- rebuild from these files records the same version the database has.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  THE DRILL ARMS A TABLE, NEVER A DECK
--  BBJ build plan phase 4.1 (docs/BBJ-BUILD-PLAN.md)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS IS FOR. The Bad Beat Jackpot fires about once a fortnight - the
-- last real one was 2026-08-19 - so the whole path downstream of detection has
-- never been watched end to end on live infrastructure: the celebration, the
-- fan-out to sibling tables, the lobby card, the notifications, the ticker,
-- Previous Winners, and real chips landing in real stacks. Everything about it
-- so far is proven by probe and by test.
--
-- WHAT IT DELIBERATELY IS NOT: A RIGGED DECK.
--
-- The plan called for one. It should not exist. `detectBBJHit` is a pure
-- function with 32 tests over every qualifying rule, every variant and every
-- rejection reason - dealing one lucky hand would prove a single case those
-- already prove, in exchange for putting code in a real-money poker engine
-- that can choose a player's hole cards. There is no ring-fence worth that.
-- The engine's deck stays crypto-shuffled, unseeded and uninjectable.
--
-- So the drill arms a TABLE, and what it injects is the DETECTION RESULT: on
-- the next hand at an armed table, the engine treats the real showdown - real
-- players, real board, real pot - as a qualifying hit. Everything downstream
-- then runs for real, because it IS real: the payout RPC, the recipients, the
-- notifications, the hub events, the ledger rows. A drill produces a genuine
-- jackpot at a drill club, so nothing in the history is fabricated and no
-- surface has to learn to lie about it.
--
-- ═══ FIVE THINGS THAT MAKE THIS SAFE ═══════════════════════════════════════
--
-- 1. THE ENGINE NEVER DECIDES. The arm lives here, and the engine only reads
--    it. There is no environment variable, no config flag and no build that
--    turns this on - which means it cannot be turned on by a deploy, and it
--    cannot be left on by one.
-- 2. ONLY A PLATFORM ADMIN CAN ARM. `fn_is_platform_admin()`, the same gate
--    the mint and the venue operations use.
-- 3. IT CAN NEVER TOUCH THE PRODUCTION JACKPOT. An arm is REFUSED if the
--    table's pool is a UNION pool. That is where the 107,727.33 lives, shared
--    by every club in the union; a drill must be incapable of reaching it,
--    not merely discouraged from it.
-- 4. THE BLAST RADIUS IS BOUNDED AND DERIVED. An arm is refused if the pool
--    holds more than 1,000.00. At that ceiling the largest possible drill
--    payout is about 850 - the same order as the SMALLEST real jackpot ever
--    paid here (654.14), visible against a median member balance of 10,216,
--    and 0.8% of the production pool. Big enough to see in a wallet, small
--    enough that a mistake is a rounding error.
-- 5. SINGLE SHOT, CLAIMED ATOMICALLY. The engine consumes the arm with an
--    UPDATE ... WHERE fired_at IS NULL RETURNING, so a forgotten arm fires
--    once and a race cannot fire it twice. There is no way to leave a table
--    permanently rigged.
--
-- And it is LOUD at both ends: arming and firing each write a financial_alerts
-- row, so a drill is never mistaken for a real jackpot by whoever reads that
-- table next, and a real jackpot is never dismissed as a drill.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.fn_bbj_claim_drill(uuid, bigint);
--   DROP FUNCTION IF EXISTS public.fn_bbj_arm_drill(uuid, text);
--   DROP FUNCTION IF EXISTS public.fn_bbj_drill_arms();
--   DROP TABLE IF EXISTS public.bbj_drill_arms;

BEGIN;

CREATE TABLE IF NOT EXISTS public.bbj_drill_arms (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id           uuid NOT NULL REFERENCES public.tables (id) ON DELETE CASCADE,
  club_id            uuid NOT NULL REFERENCES public.clubs (id) ON DELETE CASCADE,
  pool_id            uuid NOT NULL,
  pool_balance_at_arm numeric(14, 2) NOT NULL,
  note               text,
  armed_by           uuid NOT NULL,
  armed_at           timestamptz NOT NULL DEFAULT now(),
  fired_at           timestamptz,
  fired_hand_number  bigint,
  CONSTRAINT bbj_drill_arms_fired_together
    CHECK ((fired_at IS NULL) = (fired_hand_number IS NULL))
);

COMMENT ON TABLE public.bbj_drill_arms IS
  'One row per Bad Beat Jackpot drill armed by a platform admin. Single shot: the engine claims it atomically and treats the next real showdown at that table as a qualifying hit. It arms a TABLE, never a deck - the engine cannot choose anybody''s cards. BBJ phase 4.1.';

-- Only ONE un-fired arm per table can exist. This is the constraint that makes
-- "single shot" true rather than merely intended.
CREATE UNIQUE INDEX IF NOT EXISTS bbj_drill_arms_one_live_per_table
  ON public.bbj_drill_arms (table_id) WHERE fired_at IS NULL;

CREATE INDEX IF NOT EXISTS bbj_drill_arms_armed_at_idx
  ON public.bbj_drill_arms (armed_at DESC);

ALTER TABLE public.bbj_drill_arms ENABLE ROW LEVEL SECURITY;

-- Operator surface only. There is no browser policy at all: a player has no
-- business reading which tables are armed, and an admin reads it through
-- fn_bbj_drill_arms() below.
REVOKE ALL ON public.bbj_drill_arms FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.bbj_drill_arms TO service_role;

-- ── Arming: platform admin only, and it refuses more than it accepts ────────
CREATE OR REPLACE FUNCTION public.fn_bbj_arm_drill(p_table_id uuid, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ceiling  constant numeric := 1000.00;
  v_club     uuid;
  v_pool     record;
  v_is_union boolean;
  v_arm      uuid;
BEGIN
  IF NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_platform_admin');
  END IF;

  SELECT t.club_id INTO v_club FROM public.tables t WHERE t.id = p_table_id;
  IF v_club IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found_or_has_no_club');
  END IF;

  SELECT p.pool_id, p.main_balance INTO v_pool
    FROM public.fn_bbj_pool_for_club(v_club) p LIMIT 1;
  IF v_pool.pool_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'club_has_no_jackpot_pool');
  END IF;

  /* THE PRODUCTION JACKPOT IS OUT OF REACH, BY CONSTRUCTION. A union pool is
     shared by every club in the union and is where the real money sits. */
  SELECT (bp.union_id IS NOT NULL) INTO v_is_union
    FROM public.bbj_pools bp WHERE bp.id = v_pool.pool_id;
  IF v_is_union THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'union_pool_is_never_a_drill_target',
                              'pool_id', v_pool.pool_id);
  END IF;

  IF COALESCE(v_pool.main_balance, 0) > v_ceiling THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pool_above_drill_ceiling',
                              'balance', v_pool.main_balance, 'ceiling', v_ceiling);
  END IF;

  IF COALESCE(v_pool.main_balance, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pool_is_empty_nothing_to_pay',
                              'pool_id', v_pool.pool_id);
  END IF;

  IF EXISTS (SELECT 1 FROM public.bbj_drill_arms a
              WHERE a.table_id = p_table_id AND a.fired_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_armed');
  END IF;

  INSERT INTO public.bbj_drill_arms
    (table_id, club_id, pool_id, pool_balance_at_arm, note, armed_by)
  VALUES (p_table_id, v_club, v_pool.pool_id, v_pool.main_balance, p_note, auth.uid())
  RETURNING id INTO v_arm;

  INSERT INTO public.financial_alerts (severity, source, message, context)
  VALUES ('info', 'fn_bbj_arm_drill',
          'A Bad Beat Jackpot DRILL was armed on table ' || p_table_id ||
          '. The next showdown there will be treated as a jackpot hit and will pay real chips out of pool ' ||
          v_pool.pool_id || ' (balance ' || v_pool.main_balance ||
          '). This is a drill, not a real bad beat.',
          jsonb_build_object('armId', v_arm, 'tableId', p_table_id, 'clubId', v_club,
                             'poolId', v_pool.pool_id, 'balance', v_pool.main_balance,
                             'note', p_note));

  RETURN jsonb_build_object('ok', true, 'armId', v_arm, 'tableId', p_table_id,
                            'poolId', v_pool.pool_id, 'balance', v_pool.main_balance);
END $function$;

COMMENT ON FUNCTION public.fn_bbj_arm_drill(uuid, text) IS
  'Arm a single-shot Bad Beat Jackpot drill on one table. Platform admin only. Refuses a union pool (the production jackpot), a pool over 1,000.00, an empty pool, and a table already armed. It arms a TABLE, never a deck. BBJ phase 4.1.';

-- ── Claiming: the engine, exactly once ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_bbj_claim_drill(p_table_id uuid, p_hand_number bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_arm record;
BEGIN
  /* ATOMIC. The WHERE fired_at IS NULL is what makes this single-shot: two
     engines racing the same hand cannot both win the UPDATE. */
  UPDATE public.bbj_drill_arms a
     SET fired_at = now(), fired_hand_number = p_hand_number
   WHERE a.table_id = p_table_id
     AND a.fired_at IS NULL
  RETURNING a.id, a.pool_id, a.club_id, a.note INTO v_arm;

  IF v_arm.id IS NULL THEN
    RETURN jsonb_build_object('claimed', false);
  END IF;

  INSERT INTO public.financial_alerts (severity, source, message, context)
  VALUES ('info', 'fn_bbj_claim_drill',
          'A Bad Beat Jackpot DRILL fired on table ' || p_table_id || ' hand #' || p_hand_number ||
          '. The payout that follows is a drill, not a real bad beat. The chips are real.',
          jsonb_build_object('armId', v_arm.id, 'tableId', p_table_id,
                             'handNumber', p_hand_number, 'poolId', v_arm.pool_id,
                             'note', v_arm.note));

  RETURN jsonb_build_object('claimed', true, 'armId', v_arm.id, 'poolId', v_arm.pool_id);
END $function$;

COMMENT ON FUNCTION public.fn_bbj_claim_drill(uuid, bigint) IS
  'Consume a single armed Bad Beat Jackpot drill for one hand. Engine only (service_role). Atomic, so an arm fires exactly once. BBJ phase 4.1.';

-- ── Reading: operators ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_bbj_drill_arms()
RETURNS TABLE (
  id uuid, table_id uuid, club_id uuid, pool_id uuid,
  pool_balance_at_arm numeric, note text,
  armed_by uuid, armed_at timestamptz,
  fired_at timestamptz, fired_hand_number bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT a.id, a.table_id, a.club_id, a.pool_id, a.pool_balance_at_arm, a.note,
         a.armed_by, a.armed_at, a.fired_at, a.fired_hand_number
    FROM public.bbj_drill_arms a
   ORDER BY a.armed_at DESC
   LIMIT 100;
$function$;

COMMENT ON FUNCTION public.fn_bbj_drill_arms() IS
  'Every Bad Beat Jackpot drill armed, and whether it fired. Operator surface: service_role only. BBJ phase 4.1.';

-- Every one of these is SECURITY DEFINER and none of them asks who is calling
-- except fn_bbj_arm_drill, which asks first. PUBLIC is named as well as the
-- roles: anon and authenticated inherit whatever PUBLIC holds, so revoking the
-- roles alone reads as a fix and does nothing.
REVOKE ALL ON FUNCTION public.fn_bbj_arm_drill(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_arm_drill(uuid, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_bbj_claim_drill(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_claim_drill(uuid, bigint) TO service_role;
REVOKE ALL ON FUNCTION public.fn_bbj_drill_arms() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_drill_arms() TO service_role;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.fn_bbj_arm_drill(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can arm a drill';
  END IF;
  IF has_function_privilege('authenticated', 'public.fn_bbj_claim_drill(uuid, bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can claim a drill - only the engine may';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.role_table_grants
              WHERE table_schema='public' AND table_name='bbj_drill_arms'
                AND grantee IN ('anon','authenticated')) THEN
    RAISE EXCEPTION 'a browser role can reach bbj_drill_arms directly';
  END IF;
END $$;

COMMIT;
