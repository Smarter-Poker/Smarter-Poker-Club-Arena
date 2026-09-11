-- ═══════════════════════════════════════════════════════════════════════════
--  THE ARM ASKS WHAT THE PAYOUT ASKS
--  BBJ programme, post-audit phase 2 of 5, corrective pass (2026-09-11)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `20260911230511` gave the drill a kind and guarded a mini arm so it could not
-- "fire into a refusal". An adversarial review of that migration found the
-- guard does not actually match the payout's, in three ways, and that the arm
-- records the wrong number. Every finding below is real and every one is
-- closed here.
--
-- ── 1. THE GUARD WAS NOT THE PAYOUT'S GUARD ───────────────────────────────
--
--   arm  : backup_balance - mini_reserve_floor < largest_enabled_tier  -> refuse
--   payout: v_backup - fn_bbj_parked_reserve(pool,'backup') - v_amount < v_floor
--
-- Three holes, each of which fires the arm and then refuses the payout - the
-- exact failure the guard was written to prevent:
--
--   * PARKED RESERVE IGNORED. `fn_bbj_parked_reserve` sums unpaid
--     `bbj_unclaimed_shares` against the backup bank: money that is still in
--     `backup_balance` and already owed to somebody. A pool with parked shares
--     passed the arm and got `reserve_at_floor` from the payout.
--   * THE WRONG TIER'S ENABLED FLAG. The arm checked the largest ENABLED
--     tier's AMOUNT; the payout checks THIS TABLE's tier's `enabled` bit
--     (`mini_disabled_for_tier`). With `nosebleeds` on and `nano` off, arming
--     a nano table passed and the payout refused.
--   * VARIANT NEVER CHECKED. `bbj_qualifying_hands.eligible` is false for
--     PLO6 and Short Deck, and a mini drill bypasses `detectMiniBBJHit`
--     entirely - so a mini drill on a Short Deck table would pay a mini for a
--     variant the mini does not cover, and file it in the winners history.
--
-- The first migration justified the largest-tier shortcut as avoiding a
-- big-blind-to-tier mapping "duplicated in SQL". **That mapping was already
-- in SQL**: `bbj_stakes_tiers` carries `min_bb`/`max_bb`, and
-- `fn_bbj_mini_for_club` already computes the payable predicate from it. The
-- argument was wrong and the shortcut it justified was the defect. The arm
-- now resolves this table's own tier and asks exactly what the payout asks.
--
-- ── 2. THE ARM RECORDED THE WRONG BANK ────────────────────────────────────
--
-- `pool_balance_at_arm` stored `main_balance` for a MINI arm - the one number
-- a mini arm has nothing to do with - and returned it to the operator as
-- confirmation and put it in the `financial_alerts` context. A mini arm now
-- records the bank it is actually armed against, and says which bank that is.
--
-- ── 3. `already_armed` WAS CHECKED LAST ───────────────────────────────────
--
-- Pre-existing, and widened by that migration from two masking refusals to
-- five: an operator with an open arm was told `pool_above_drill_ceiling` (or
-- now `mini_is_off_for_this_pool`) and went to chase a pool balance when the
-- real fix is to fire or clear the arm they already have. It is asked as soon
-- as the table is known, before any balance is read.
--
-- ── 4. THE ARMS LISTING COULD NOT TELL THE KINDS APART ────────────────────
--
-- `fn_bbj_drill_arms()` is the surface the runbook tells an operator to use to
-- see what is armed. It did not return `kind`, so a mini arm and a main arm
-- looked identical - beside a `pool_balance_at_arm` that was misleading for
-- one of them.

BEGIN;

-- ── THE ARM ───────────────────────────────────────────────────────────────

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
  v_variant  text;
  v_bb       numeric;
  v_pool     record;
  v_is_union boolean;
  v_arm      uuid;
  v_kind     text := lower(coalesce(p_kind, 'main'));
  v_mini     record;
  v_tier     record;
  v_parked   numeric;
  v_headroom numeric;
  v_armed    numeric;   -- the balance of the bank this arm is armed AGAINST
  v_bank     text;
BEGIN
  IF NOT public.fn_is_platform_admin() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_platform_admin');
  END IF;

  IF v_kind NOT IN ('main', 'mini') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_drill_kind', 'kind', p_kind);
  END IF;

  SELECT t.club_id, t.game_variant, t.big_blind INTO v_club, v_variant, v_bb
    FROM public.tables t WHERE t.id = p_table_id;
  IF v_club IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found_or_has_no_club');
  END IF;

  /* ASKED AS SOON AS THE TABLE IS KNOWN. It used to be the LAST check, so an
     operator with an open arm was told the pool was above the ceiling and went
     to chase a balance when the real fix was to fire or clear the arm they
     already had. A refusal that names the wrong cause is worse than a slow
     one. */
  IF EXISTS (SELECT 1 FROM public.bbj_drill_arms a
              WHERE a.table_id = p_table_id AND a.fired_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_armed');
  END IF;

  SELECT p.pool_id, p.main_balance INTO v_pool
    FROM public.fn_bbj_pool_for_club(v_club) p LIMIT 1;
  IF v_pool.pool_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'club_has_no_jackpot_pool');
  END IF;

  /* THE PRODUCTION JACKPOT IS OUT OF REACH, BY CONSTRUCTION. A union pool is
     shared by every club in the union and is where the real money sits. Both
     kinds refuse it: the mini pays out of that same pool's reserve. Checked
     BEFORE the kinds diverge, so neither branch can miss it. */
  SELECT (bp.union_id IS NOT NULL) INTO v_is_union
    FROM public.bbj_pools bp WHERE bp.id = v_pool.pool_id;
  IF v_is_union THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'union_pool_is_never_a_drill_target',
                              'pool_id', v_pool.pool_id);
  END IF;

  IF v_kind = 'main' THEN
    v_bank  := 'main';
    v_armed := COALESCE(v_pool.main_balance, 0);

    IF v_armed > v_ceiling THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'pool_above_drill_ceiling',
                                'balance', v_armed, 'ceiling', v_ceiling);
    END IF;

    IF v_armed <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'pool_is_empty_nothing_to_pay',
                                'pool_id', v_pool.pool_id);
    END IF;
  ELSE
    v_bank := 'backup';

    /* A VARIANT THE JACKPOT DOES NOT COVER GETS NO MINI. A mini drill bypasses
       detectMiniBBJHit entirely, so this is the only place it can be asked.
       Same source the engine reads: bbj_qualifying_hands.eligible. */
    IF NOT EXISTS (
      SELECT 1 FROM public.bbj_qualifying_hands q
       WHERE q.variant = lower(COALESCE(v_variant, 'nlh'))
         AND COALESCE(q.eligible, false)
         AND q.hand_rank IS NOT NULL
    ) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'variant_is_not_eligible_for_the_jackpot',
                                'variant', v_variant);
    END IF;

    SELECT bp.mini_enabled, bp.backup_balance, bp.mini_reserve_floor
      INTO v_mini
      FROM public.bbj_pools bp WHERE bp.id = v_pool.pool_id;
    v_armed := COALESCE(v_mini.backup_balance, 0);

    IF NOT COALESCE(v_mini.mini_enabled, false) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'mini_is_off_for_this_pool',
                                'pool_id', v_pool.pool_id);
    END IF;

    /* THIS TABLE'S TIER, not the largest. The ladder is already in SQL -
       bbj_stakes_tiers carries min_bb/max_bb and fn_bbj_mini_for_club already
       joins it - so the "do not duplicate the mapping" reasoning the first cut
       leaned on was simply wrong about the facts. */
    SELECT st.id AS tier_id, mt.amount, mt.enabled
      INTO v_tier
      FROM public.bbj_stakes_tiers st
      JOIN public.bbj_mini_tiers mt ON mt.tier_id = st.id
     WHERE COALESCE(v_bb, 0) >= st.min_bb AND COALESCE(v_bb, 0) <= st.max_bb
     LIMIT 1;

    IF v_tier.tier_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'no_stakes_tier_for_this_big_blind',
                                'big_blind', v_bb);
    END IF;

    IF NOT COALESCE(v_tier.enabled, false) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'mini_disabled_for_this_tier',
                                'tier_id', v_tier.tier_id);
    END IF;

    /* THE PAYOUT'S OWN ARITHMETIC, including the parked reserve: chips still
       sitting in backup_balance that are already owed to somebody. Leaving it
       out is what let an arm pass and the payout answer reserve_at_floor. */
    v_parked   := COALESCE(public.fn_bbj_parked_reserve(v_pool.pool_id, 'backup'), 0);
    v_headroom := v_armed - v_parked - COALESCE(v_tier.amount, 0);

    IF v_headroom < COALESCE(v_mini.mini_reserve_floor, 0) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'reserve_cannot_cover_a_mini_payout',
                                'backup_balance', v_armed,
                                'parked', v_parked,
                                'tier_id', v_tier.tier_id,
                                'tier_amount', v_tier.amount,
                                'reserve_floor', v_mini.mini_reserve_floor);
    END IF;
  END IF;

  /* THE BANK THIS ARM IS ARMED AGAINST. It stored main_balance for a mini arm -
     the one number a mini arm has nothing to do with - and handed it back to
     the operator as confirmation. */
  INSERT INTO public.bbj_drill_arms
    (table_id, club_id, pool_id, pool_balance_at_arm, note, armed_by, kind)
  VALUES (p_table_id, v_club, v_pool.pool_id, v_armed, p_note, auth.uid(), v_kind)
  RETURNING id INTO v_arm;

  INSERT INTO public.financial_alerts (severity, source, message, context)
  VALUES ('info', 'fn_bbj_arm_drill',
          'A Bad Beat Jackpot ' || upper(v_kind) || ' DRILL was armed on table ' || p_table_id ||
          '. The next showdown there will be treated as a ' || v_kind ||
          ' jackpot hit and will pay real chips out of the ' || v_bank ||
          ' bank of pool ' || v_pool.pool_id || ' (balance ' || v_armed ||
          '). This is a drill, not a real bad beat.',
          jsonb_build_object('armId', v_arm, 'tableId', p_table_id, 'clubId', v_club,
                             'poolId', v_pool.pool_id, 'bank', v_bank, 'balance', v_armed,
                             'kind', v_kind, 'tierId', v_tier.tier_id, 'note', p_note));

  RETURN jsonb_build_object('ok', true, 'armId', v_arm, 'tableId', p_table_id,
                            'poolId', v_pool.pool_id, 'bank', v_bank, 'balance', v_armed,
                            'kind', v_kind, 'tierId', v_tier.tier_id);
END;
$function$;

COMMENT ON FUNCTION public.fn_bbj_arm_drill(uuid, text, text) IS
  'Arm one drill on a table. p_kind ''main'' pays a share of the pool; ''mini'' '
  'pays this table''s tier amount out of the backup reserve. A mini arm asks '
  'exactly what fn_bbj_mini_payout asks - the variant is eligible, the mini is '
  'on for the pool AND for this table''s tier, and backup minus the PARKED '
  'reserve minus the tier amount still clears the floor - so an arm cannot fire '
  'into a refusal. Neither kind may target a union pool. balance/bank in the '
  'answer name the bank the arm is armed against.';

REVOKE ALL ON FUNCTION public.fn_bbj_arm_drill(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_arm_drill(uuid, text, text) TO authenticated, service_role;

-- ── THE LISTING ───────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.fn_bbj_drill_arms();

CREATE OR REPLACE FUNCTION public.fn_bbj_drill_arms()
RETURNS TABLE(
  id uuid, table_id uuid, club_id uuid, pool_id uuid, kind text,
  pool_balance_at_arm numeric, note text, armed_by uuid, armed_at timestamptz,
  fired_at timestamptz, fired_hand_number bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  /* KIND IS IN THE ANSWER, AND THE CALLER IS NAMED HERE rather than one call
     down. check-definer-authorization refused the first cut as "a roster
     nobody can be scoped out of": SECURITY DEFINER so RLS does not apply, no
     arguments so it cannot be scoped, returns a SET rather than answering one
     question, and fn_is_platform_admin() reads auth.uid() a level down where
     the guard cannot see it. It cites the incident it was written from -
     fn_bbj_unclaimed_shares() shipped in this exact shape and returned every
     unpaid share on the platform to any account that could log in. "It is
     scoped, trust me" is the claim a guard exists to refuse.
     KIND itself: This is the surface the runbook sends an operator
     to for "what is armed", and without it a mini arm and a main arm are
     indistinguishable - beside a balance that meant different banks. */
  SELECT a.id, a.table_id, a.club_id, a.pool_id, a.kind,
         a.pool_balance_at_arm, a.note, a.armed_by, a.armed_at,
         a.fired_at, a.fired_hand_number
    FROM public.bbj_drill_arms a
   WHERE auth.uid() IS NOT NULL
     AND public.fn_is_platform_admin()
   ORDER BY a.armed_at DESC;
$function$;

COMMENT ON FUNCTION public.fn_bbj_drill_arms() IS
  'Every drill arm, newest first, for a platform admin and nobody else. '
  'Carries `kind` so a mini arm can be told from a main one, and '
  '`pool_balance_at_arm` is the balance of the bank that arm was armed '
  'against - main for a main arm, backup for a mini.';

REVOKE ALL ON FUNCTION public.fn_bbj_drill_arms() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_drill_arms() TO authenticated, service_role;

-- ── ASSERTIONS ────────────────────────────────────────────────────────────

DO $$
DECLARE v_src text; v_listing text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_bbj_arm_drill';

  /* The three holes the review found, each asserted by the thing that closes
     it rather than by its absence. */
  IF position('fn_bbj_parked_reserve' in v_src) = 0 THEN
    RAISE EXCEPTION 'the arm does not subtract the parked reserve, so it can still fire into a refusal';
  END IF;
  IF position('bbj_stakes_tiers' in v_src) = 0 THEN
    RAISE EXCEPTION 'the arm does not resolve this table''s own tier';
  END IF;
  IF position('bbj_qualifying_hands' in v_src) = 0 THEN
    RAISE EXCEPTION 'the arm does not check variant eligibility';
  END IF;

  /* already_armed must be asked before any balance is read, or it is masked. */
  IF position('already_armed' in v_src) > position('fn_bbj_pool_for_club' in v_src) THEN
    RAISE EXCEPTION 'already_armed is still checked after the pool balance is read';
  END IF;

  /* A mini arm must never record the main balance again. */
  IF position('v_pool.main_balance, p_note' in v_src) > 0 THEN
    RAISE EXCEPTION 'the arm still records the MAIN balance whatever kind it is';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_listing
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_bbj_drill_arms';
  IF position('a.kind' in v_listing) = 0 THEN
    RAISE EXCEPTION 'the arms listing still cannot tell a mini arm from a main one';
  END IF;

  IF has_function_privilege('anon', 'public.fn_bbj_drill_arms()', 'EXECUTE') THEN
    RAISE EXCEPTION 'a signed-out visitor can list the drill arms';
  END IF;
END $$;

COMMIT;
