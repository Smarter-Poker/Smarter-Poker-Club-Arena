-- ═══════════════════════════════════════════════════════════════════════════
--  THE MINI CAN BE DRILLED TOO
--  BBJ programme, post-audit phase 2 of 5 (2026-09-11)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Phase 4 of the original programme built the drill so the MAIN jackpot payout
-- could be proved end to end with real chips at a drill club: a real showdown,
-- real players, real board, real pot, and only the verdict injected.
--
-- The mini got nothing. It is a separate product - its own reserve
-- (`backup_balance`), its own flat tiers, its own payout RPC
-- (`fn_bbj_mini_payout`), its own refusal reasons - and the only way to watch
-- one pay has been to wait for a real one. Twenty-one have happened in the
-- mini's whole life; that is not a test cycle, it is a vigil.
--
-- Worse, the drill actively HID the mini. `claimBBJDrill` is tried when the
-- main rule refused, which is exactly the case the mini exists to catch, and
-- the drill's verdict then took the main branch - so on a drill table a hand
-- that genuinely qualified for the mini never reached mini detection at all.
-- "One hand pays one jackpot" makes that the right OUTCOME; nothing made it a
-- decision anybody had taken, and nothing let an operator drill the other one.
--
-- ── WHAT AN ARM NOW CARRIES ───────────────────────────────────────────────
--
-- `bbj_drill_arms.kind` - 'main' or 'mini', defaulting to 'main' so every
-- existing caller and every historical row means exactly what it meant.
--
-- ── THE GUARDS ARE THE MINI'S OWN, NOT THE MAIN'S ─────────────────────────
--
-- A main arm is refused above a 1,000.00 main balance, because a drill must
-- never pay a large jackpot. A mini pays a FLAT tier amount capped at the
-- tier table itself, so that ceiling is already structural and the danger is
-- the opposite one: arming a mini drill against a reserve that cannot cover
-- the payout, which would fire the arm and then have `fn_bbj_mini_payout`
-- refuse it - an operator burning an arm and watching nothing happen.
--
-- So a mini arm additionally requires:
--
--   * the mini is ENABLED on that pool (`bbj_pools.mini_enabled`), because a
--     disabled mini refuses every payout by design;
--   * the reserve covers the LARGEST enabled tier ABOVE its floor. Largest
--     rather than this table's tier, so the guard needs no big-blind-to-tier
--     mapping in SQL - that mapping lives in the engine and duplicating it
--     here is how two halves of one rule drift apart. Conservative by
--     construction: if the largest is affordable, every tier is.
--
-- Everything the main arm refuses, a mini arm refuses too, for the same
-- reasons: platform admin only, and NEVER a union pool - that is where the
-- production jackpot lives, and it is out of reach of a drill by construction.

BEGIN;

ALTER TABLE public.bbj_drill_arms
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'main';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.bbj_drill_arms'::regclass AND conname = 'bbj_drill_arms_kind_ck'
  ) THEN
    ALTER TABLE public.bbj_drill_arms
      ADD CONSTRAINT bbj_drill_arms_kind_ck CHECK (kind IN ('main', 'mini'));
  END IF;
END $$;

COMMENT ON COLUMN public.bbj_drill_arms.kind IS
  'Which jackpot this arm drills: main (a share of the pool) or mini (a flat '
  'tier amount out of the backup reserve). Defaults to main so every row '
  'written before 2026-09-11 means what it meant.';

-- ── ARMING ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_bbj_arm_drill(
  p_table_id uuid,
  p_note     text DEFAULT NULL::text,
  p_kind     text DEFAULT 'main'
)
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
  v_kind     text := lower(coalesce(p_kind, 'main'));
  v_mini     record;
  v_largest  numeric;
BEGIN
  IF NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_platform_admin');
  END IF;

  IF v_kind NOT IN ('main', 'mini') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_drill_kind', 'kind', p_kind);
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
     shared by every club in the union and is where the real money sits. Both
     kinds refuse it: the mini pays out of that same pool's reserve. */
  SELECT (bp.union_id IS NOT NULL) INTO v_is_union
    FROM public.bbj_pools bp WHERE bp.id = v_pool.pool_id;
  IF v_is_union THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'union_pool_is_never_a_drill_target',
                              'pool_id', v_pool.pool_id);
  END IF;

  IF v_kind = 'main' THEN
    IF COALESCE(v_pool.main_balance, 0) > v_ceiling THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'pool_above_drill_ceiling',
                                'balance', v_pool.main_balance, 'ceiling', v_ceiling);
    END IF;

    IF COALESCE(v_pool.main_balance, 0) <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'pool_is_empty_nothing_to_pay',
                                'pool_id', v_pool.pool_id);
    END IF;
  ELSE
    /* THE MINI'S OWN PRECONDITIONS. Arming against a reserve that cannot pay
       would fire the arm and then have fn_bbj_mini_payout refuse it - an
       operator burning their one arm and watching nothing happen, which is
       the failure the main arm's own "refuse before claiming, never after"
       comment was written about. */
    SELECT bp.mini_enabled, bp.backup_balance, bp.mini_reserve_floor
      INTO v_mini
      FROM public.bbj_pools bp WHERE bp.id = v_pool.pool_id;

    IF NOT COALESCE(v_mini.mini_enabled, false) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'mini_is_off_for_this_pool',
                                'pool_id', v_pool.pool_id);
    END IF;

    /* LARGEST enabled tier, not this table's: the big-blind-to-tier mapping
       lives in the engine and duplicating it here is how two halves of one
       rule drift apart. Conservative - if the largest is affordable, so is
       whichever tier this table actually plays at. */
    SELECT COALESCE(max(mt.amount) FILTER (WHERE mt.enabled), 0) INTO v_largest
      FROM public.bbj_mini_tiers mt;
    IF v_largest <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'no_mini_tier_is_enabled');
    END IF;

    IF COALESCE(v_mini.backup_balance, 0) - COALESCE(v_mini.mini_reserve_floor, 0) < v_largest THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'reserve_cannot_cover_a_mini_payout',
                                'backup_balance', v_mini.backup_balance,
                                'reserve_floor', v_mini.mini_reserve_floor,
                                'largest_tier', v_largest);
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM public.bbj_drill_arms a
              WHERE a.table_id = p_table_id AND a.fired_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_armed');
  END IF;

  INSERT INTO public.bbj_drill_arms
    (table_id, club_id, pool_id, pool_balance_at_arm, note, armed_by, kind)
  VALUES (p_table_id, v_club, v_pool.pool_id, v_pool.main_balance, p_note, auth.uid(), v_kind)
  RETURNING id INTO v_arm;

  INSERT INTO public.financial_alerts (severity, source, message, context)
  VALUES ('info', 'fn_bbj_arm_drill',
          'A Bad Beat Jackpot ' || upper(v_kind) || ' DRILL was armed on table ' || p_table_id ||
          '. The next showdown there will be treated as a ' || v_kind ||
          ' jackpot hit and will pay real chips out of pool ' || v_pool.pool_id ||
          '. This is a drill, not a real bad beat.',
          jsonb_build_object('armId', v_arm, 'tableId', p_table_id, 'clubId', v_club,
                             'poolId', v_pool.pool_id, 'balance', v_pool.main_balance,
                             'kind', v_kind, 'note', p_note));

  RETURN jsonb_build_object('ok', true, 'armId', v_arm, 'tableId', p_table_id,
                            'poolId', v_pool.pool_id, 'balance', v_pool.main_balance,
                            'kind', v_kind);
END;
$function$;

COMMENT ON FUNCTION public.fn_bbj_arm_drill(uuid, text, text) IS
  'Arm one drill on a table. p_kind ''main'' pays a share of the pool; ''mini'' '
  'pays a flat tier amount out of the backup reserve. A mini arm additionally '
  'requires the mini to be enabled and the reserve to cover the largest enabled '
  'tier above its floor, so an arm cannot fire into a refusal. Neither kind may '
  'target a union pool.';

-- ── CLAIMING ──────────────────────────────────────────────────────────────

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
  RETURNING a.id, a.pool_id, a.club_id, a.note, a.kind INTO v_arm;

  IF v_arm.id IS NULL THEN
    RETURN jsonb_build_object('claimed', false);
  END IF;

  INSERT INTO public.financial_alerts (severity, source, message, context)
  VALUES ('info', 'fn_bbj_claim_drill',
          'A Bad Beat Jackpot ' || upper(COALESCE(v_arm.kind, 'main')) || ' DRILL fired on table ' ||
          p_table_id || ' hand #' || p_hand_number ||
          '. The payout that follows is a drill, not a real bad beat. The chips are real.',
          jsonb_build_object('armId', v_arm.id, 'tableId', p_table_id,
                             'handNumber', p_hand_number, 'poolId', v_arm.pool_id,
                             'kind', COALESCE(v_arm.kind, 'main'), 'note', v_arm.note));

  /* The KIND travels back with the claim. The engine cannot read the arm row
     and must not guess: a mini drill taking the main branch would pay a share
     of the pool for an arm that asked for a flat tier out of the reserve. */
  RETURN jsonb_build_object('claimed', true, 'armId', v_arm.id, 'poolId', v_arm.pool_id,
                            'kind', COALESCE(v_arm.kind, 'main'));
END $function$;

COMMENT ON FUNCTION public.fn_bbj_claim_drill(uuid, bigint) IS
  'Claim the open drill arm on a table, atomically and once. Returns the arm''s '
  'kind so the engine routes a mini drill to the mini payout rather than the '
  'main one. A row written before 2026-09-11 reads as ''main''.';

-- ── GRANTS ────────────────────────────────────────────────────────────────
-- EVERY CLONE NAMES ITS GRANTS. `CREATE OR REPLACE` preserves whatever the
-- live function already held, so re-declaring one and saying nothing about
-- its grants leaves the posture correct HERE and undefined in any database
-- rebuilt from these files. `check-definer-authorization` refuses that, and
-- it refused this - correctly: `fn_bbj_claim_drill` is a SECURITY DEFINER
-- that WRITES (it fires the arm) and it never asks who is calling, so if a
-- browser role could reach it a player could burn an operator's armed drill
-- on a hand of their choosing.
--
-- Nobody in a browser calls it. The ENGINE claims a drill, as service_role,
-- on the settlement path. PUBLIC is named as well as the roles: revoking one
-- role while PUBLIC still holds it reads as a fix and does nothing.
REVOKE ALL ON FUNCTION public.fn_bbj_claim_drill(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_claim_drill(uuid, bigint) TO service_role;

-- ARMING is different and stays reachable from a browser: it is how a platform
-- admin arms a drill from an operator surface, and it asks who is calling on
-- its first line (`fn_is_platform_admin()` reads `auth.uid()`). anon holds
-- nothing - a signed-out visitor has no admin surface to arm from.
REVOKE ALL ON FUNCTION public.fn_bbj_arm_drill(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_arm_drill(uuid, text, text) TO authenticated, service_role;


-- ── ASSERTIONS ────────────────────────────────────────────────────────────

DO $$
DECLARE v_default text; v_claim jsonb;
BEGIN
  SELECT column_default INTO v_default FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'bbj_drill_arms' AND column_name = 'kind';
  IF v_default IS NULL OR v_default NOT LIKE '%main%' THEN
    RAISE EXCEPTION 'bbj_drill_arms.kind must default to main, got %', v_default;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.bbj_drill_arms'::regclass AND conname = 'bbj_drill_arms_kind_ck'
  ) THEN
    RAISE EXCEPTION 'the kind column accepts values that are neither main nor mini';
  END IF;

  /* A claim on a table with no arm must still answer, and answer the same
     shape it always did - the engine treats anything but claimed:true as
     "no drill" and must never see an error here. */
  v_claim := public.fn_bbj_claim_drill('00000000-0000-0000-0000-000000000000'::uuid, 1);
  IF (v_claim->>'claimed')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'claiming a drill on a table with no arm must answer claimed=false, got %', v_claim;
  END IF;

  /* The three-argument arm must not have displaced the two-argument one: every
     existing caller passes (table, note) and must keep meaning 'main'. */
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_bbj_arm_drill'
       AND pg_get_function_identity_arguments(p.oid) = 'p_table_id uuid, p_note text, p_kind text'
  ) THEN
    RAISE EXCEPTION 'fn_bbj_arm_drill did not gain its kind argument';
  END IF;
END $$;

COMMIT;
