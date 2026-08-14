-- ============================================================================
-- AUDIT M17 (part 1 of N) — make the special-bonus claim actually work,
--                           without opening a chip mint
-- ============================================================================
--
-- WHAT WAS BROKEN
-- `BonusService.claimSpecialBonus` did three client-side writes:
--
--   1. UPDATE special_bonuses SET claimed = true ...
--   2. rpc('atomic_credit_wallet_and_log', { p_amount: bonus.reward, ... })
--   3. rpc('add_vip_points', ...)   (the non-chips branch)
--
-- Probed against production as role `authenticated` inside a rolled-back
-- transaction, all three are dead:
--
--   (1) special_bonuses has RLS on with a SELECT-only policy, so the UPDATE
--       matches ZERO ROWS. PostgREST reports no error for a zero-row write, so
--       the client sails on and the UI reports a successful claim.
--   (2) 42501 — wallets has no UPDATE policy.
--   (3) 42501 permission denied for function — add_vip_points is granted to
--       postgres and service_role only.
--
-- So the feature has no working branch. It is an outage, not a corruption:
-- nothing is half-applied, because nothing is applied.
--
-- WHY NOT JUST MAKE THE WRAPPER SECURITY DEFINER
-- Because `atomic_credit_wallet_and_log` takes the amount from its caller. A
-- DEFINER version of it, granted to `authenticated`, is an unlimited chip mint
-- for any signed-in player — worse than the bug it fixes. The rule this
-- migration establishes: a DEFINER money function must READ the amount from
-- authoritative state and enforce its own authorization. Never both DEFINER and
-- caller-supplied.
--
-- WHY THIS ONE IS SAFE
-- The amount comes from special_bonuses.reward, and a player cannot write that
-- row. Verified by probe rather than assumed: as `authenticated`, an INSERT into
-- special_bonuses fails with 42501 (RLS on, no INSERT policy), and the UPDATE
-- above matches zero rows. Only service_role — the engine and the ops tooling —
-- can create or alter a bonus. The claimant therefore cannot influence the
-- payout, only trigger it.
--
-- A THIRD GUARD NOBODY HAD MENTIONED
-- The first draft of this function updated public.wallets directly and was
-- rejected at runtime by guard_wallet_balance_write, a Phase 4.1.6a trigger
-- that inspects PG_CONTEXT and refuses any balance mutation whose call stack
-- does not name one of ~35 whitelisted money RPCs. That guard is a good piece
-- of engineering and it is worth recording what it implies: its own error text
-- calls the whitelist "SECURITY DEFINER RPCs", but atomic_credit_wallet_and_log
-- and fn_idempotent_credit_wallet — two of the names on that list — are
-- SECURITY INVOKER. The guard was written expecting a property the functions do
-- not have. That is the same wrong assumption audit finding M1 was closed on,
-- found independently in a second place.
--
-- ORDERING
-- The claim and the credit happen in ONE transaction, claim first so that the
-- `claimed = false` predicate is the concurrency guard. If the credit raises,
-- the claim rolls back with it, so the bonus is never consumed without being
-- paid. That is the property the client version could not have even in
-- principle, because it made two independent round trips.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_claim_special_bonus(p_bonus_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid      uuid := auth.uid();
  v_bonus    public.special_bonuses%ROWTYPE;
  v_amount   numeric;
BEGIN
  -- Attribution is mandatory. Under service_role auth.uid() is NULL, and this
  -- function must never run unattributed: the whole authorization model is
  -- "the caller may only claim rows whose user_id is their own".
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_claim_special_bonus requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;

  -- The `user_id = v_uid` predicate IS the authorization check. FOR UPDATE
  -- serialises concurrent claims of the same row.
  SELECT * INTO v_bonus
  FROM public.special_bonuses
  WHERE id = p_bonus_id AND user_id = v_uid
  FOR UPDATE;

  -- Every rejection below returns a reason rather than raising. A raise would
  -- roll back and read to the client as an infrastructure fault; these are
  -- ordinary business outcomes and the UI needs to tell them apart.
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_bonus.claimed THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_claimed');
  END IF;

  IF v_bonus.expires_at IS NOT NULL AND v_bonus.expires_at <= now() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'expired');
  END IF;

  IF v_bonus.progress < v_bonus.target THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'requirements_not_met');
  END IF;

  -- Truncate rather than round: rounding up invents a fraction of a chip on
  -- every claim, and the mint has to balance.
  v_amount := trunc(v_bonus.reward * 100) / 100;

  IF v_amount IS NULL OR v_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'non_positive_reward');
  END IF;

  -- Consume the bonus first. `claimed = false` in the predicate means a
  -- concurrent claimer that slipped past the lock still loses here.
  UPDATE public.special_bonuses
     SET claimed = true, claimed_at = now()
   WHERE id = p_bonus_id AND user_id = v_uid AND claimed = false;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_claimed');
  END IF;

  IF v_bonus.reward_type = 'chips' THEN
    -- Delegate rather than touch `wallets` directly. Two reasons, both load-bearing:
    --
    --   * public.wallets carries the Phase 4.1.6a trigger guard
    --     (guard_wallet_balance_write), which rejects any balance mutation whose
    --     PG_CONTEXT call stack does not name one of ~35 whitelisted money RPCs.
    --     A hand-rolled UPDATE here fails with 42501 — verified by probe before
    --     this version was written. Adding this function to the guard's
    --     whitelist would have worked too, and was rejected: the whitelist is a
    --     money-safety inventory, and it should grow only when a genuinely new
    --     primitive appears, not when a caller does.
    --   * atomic_credit_wallet_and_log already owns the full credit shape —
    --     upsert-if-no-wallet, the club_id fallback chain that reconciliation
    --     queries assume is never NULL, and the chip_transactions audit row.
    --     Reimplementing it here would fork a money path.
    --
    -- The idempotency key is derived from the bonus id, so a retried claim
    -- credits exactly once even if this transaction is replayed. It is not
    -- strictly required (the claimed=false predicate above already serialises),
    -- but a money path should not depend on a single guard.
    IF NOT public.atomic_credit_wallet_and_log(
         v_uid,
         v_amount,
         'bonus',
         'Special bonus: ' || COALESCE(NULLIF(v_bonus.name, ''),
                                       NULLIF(v_bonus.title, ''),
                                       'reward'),
         NULL,
         NULL,
         v_bonus.id,
         'bonus:' || v_bonus.id::text
       ) THEN
      -- Roll the claim back with it. Consuming a bonus without paying it is the
      -- exact failure this function exists to make impossible.
      RAISE EXCEPTION 'fn_claim_special_bonus: credit failed for bonus %', v_bonus.id
        USING ERRCODE = '25000';
    END IF;

  ELSIF v_bonus.reward_type = 'vip_points' THEN
    -- add_vip_points is SECURITY INVOKER and granted to postgres/service_role
    -- only, which is why the direct client call fails. Called from inside this
    -- DEFINER function it runs as the owner, so it resolves without widening
    -- the grant for anyone else.
    PERFORM public.add_vip_points(v_uid, v_amount::integer);

  ELSE
    -- Deliberately a raise, not a reason: an unrecognised reward_type means the
    -- row is malformed, and consuming a bonus we do not know how to pay is the
    -- one outcome worth rolling back for.
    RAISE EXCEPTION 'fn_claim_special_bonus: unsupported reward_type %', v_bonus.reward_type
      USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'reward_type', v_bonus.reward_type,
    'amount', v_amount
  );
END;
$function$;

-- Grants. `anon` must be named explicitly: Supabase's ALTER DEFAULT PRIVILEGES
-- grants EXECUTE on new public functions to `anon` BY NAME, so revoking from
-- PUBLIC alone leaves it in place. This trap was hit once already in M7.
REVOKE ALL ON FUNCTION public.fn_claim_special_bonus(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_claim_special_bonus(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_claim_special_bonus(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_claim_special_bonus(uuid) TO service_role;

COMMENT ON FUNCTION public.fn_claim_special_bonus(uuid) IS
  'AUDIT M17: claims one special_bonuses row and pays it, atomically. '
  'SECURITY DEFINER is safe here ONLY because the payout amount is read from '
  'the bonus row and a player cannot write that table (RLS: SELECT-own only, '
  'verified by probe). Never add an amount parameter to this function.';
