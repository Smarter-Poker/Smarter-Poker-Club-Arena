-- 20260906152329_an_unpayable_jackpot_share_is_parked_not_lost.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  ONE UNPAYABLE SHARE NO LONGER COSTS EVERYONE ELSE THEIR JACKPOT
--  BBJ build plan phase 2.3 (docs/BBJ-BUILD-PLAN.md)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT WAS WRONG
--
-- `bbj_credit_one_recipient` pays a recipient who has LEFT the table into a
-- club wallet. If no club resolves for that player - they hold no active or
-- approved membership anywhere, having left or been removed from every club
-- between being dealt in and the payout landing - it RAISED:
--
--     RAISE EXCEPTION 'bbj_credit_one_recipient: no club wallet resolves ...'
--
-- Every credit runs inside `bbj_atomic_payout_v2`'s single transaction, so
-- that raise rolled back the WHOLE jackpot. The bad-beat holder, the hand
-- winner and every other player at the table were paid nothing because ONE
-- table-share recipient had no wallet. The reconciler then re-drove it, hit
-- the same wall every five minutes, and after 25 attempts raised a critical
-- alert - loud, correct, and still nobody paid.
--
-- The 2026-09-05 audit fixed the COMMON cause of an unresolvable wallet (a
-- union table resolved to the union's shell club, where the player was not a
-- member). This fixes the CONSEQUENCE: whatever the cause, one share must
-- never cost the rest of the table theirs.
--
-- THE CHANGE
--
-- The share is PARKED instead of raising:
--
--   1. the claim is released - the `bbj_payout_recipients` row and the
--      `wallet_credit_idempotency` key are removed - so the recipient is not
--      recorded as paid and a later re-drive CAN pay them once they hold a
--      club membership again;
--   2. the chips are returned to the jackpot pool, which is where they came
--      from moments earlier in the same transaction. This is what keeps
--      conservation EXACT at every instant: the pool was debited for the full
--      award before the credits ran, so an undelivered share must go back or
--      the platform is short by that amount. `total_paid_out` is walked back
--      by the same figure for the same reason;
--   3. a row in `bbj_unclaimed_shares` records who is owed what, from which
--      payout, and why - so the debt is data rather than a log line.
--
-- WHY THE POOL AND NOT A NEW HOLDING ACCOUNT. Chips only move in this system
-- when a balance row changes (`fn_ca_declare_ledger` sets the context a
-- trigger on the balance table reads). Parking them anywhere new would mean
-- inventing an account type in the chip standard's vocabulary, which belongs
-- to that programme and not to this one. The pool is a real, ledgered balance
-- that already holds jackpot money, the chips were in it seconds earlier, and
-- the unclaimed row is what stops "back in the pool" meaning "forgotten".
--
-- WHAT THIS DOES NOT DECIDE. It does not write the debt off, and it does not
-- pay it to anybody else. The player remains owed; `fn_bbj_unclaimed_shares()`
-- lists every open one. Deciding what happens to a share nobody ever claims is
-- a policy question about money, and it is Dan's (CLAUDE.md 10.9), not one to
-- settle silently inside a payout function.
--
-- GENERATED REWRITE, the same technique as 20260903122000 and 20260905011253:
-- the live definition is read back, ONE anchor is replaced, and a round-trip
-- assertion proves nothing else moved. Idempotent - a second apply finds the
-- marker and leaves the function alone.
--
-- ROLLBACK: apply the inverse replacement (the new block -> the old RAISE);
-- both strings are written out verbatim below.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ── The debt, as data ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bbj_unclaimed_shares (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id   uuid NOT NULL REFERENCES public.bbj_payouts(id) ON DELETE CASCADE,
  pool_id     uuid,
  table_id    uuid,
  user_id     uuid NOT NULL,
  amount      numeric(14, 2) NOT NULL CHECK (amount > 0),
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  paid_at     timestamptz,
  paid_note   text
);

COMMENT ON TABLE public.bbj_unclaimed_shares IS
  'A Bad Beat Jackpot share that could not be delivered because no club wallet resolved for the recipient. The chips were returned to the pool in the same transaction, so nothing is missing; this row is the record that the player is still owed it. BBJ phase 2.3.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_bbj_unclaimed_open
  ON public.bbj_unclaimed_shares (payout_id, user_id) WHERE paid_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bbj_unclaimed_user
  ON public.bbj_unclaimed_shares (user_id) WHERE paid_at IS NULL;

ALTER TABLE public.bbj_unclaimed_shares ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bbj_unclaimed_self_select ON public.bbj_unclaimed_shares;
CREATE POLICY bbj_unclaimed_self_select ON public.bbj_unclaimed_shares
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR public.fn_is_platform_admin());

-- ── The rewrite ─────────────────────────────────────────────────────────────
DO $mig$
DECLARE
  v_old text;
  v_new text;
  v_anchor text := $a$  IF v_club IS NULL THEN
    RAISE EXCEPTION 'bbj_credit_one_recipient: no club wallet resolves for % at table %', p_user_id, p_table_id;
  END IF;
$a$;
  v_parked text := $r$  /* PARKED, NOT RAISED (BBJ phase 2.3, 2026-09-06). This used to raise, and
     because every credit runs inside bbj_atomic_payout_v2's single
     transaction, that rolled back the ENTIRE jackpot: the bad-beat holder,
     the hand winner and the whole table were paid nothing because ONE
     table-share recipient held no club membership anywhere. Release the
     claim so a later re-drive can still pay them, hand the chips back to the
     pool they left moments ago in this same transaction (conservation stays
     exact), and record the debt as data. */
  IF v_club IS NULL THEN
    DELETE FROM public.bbj_payout_recipients
     WHERE payout_id = p_payout_id AND user_id = p_user_id;
    DELETE FROM public.wallet_credit_idempotency WHERE key = v_key;

    SELECT bp.pool_id INTO v_park_pool FROM public.bbj_payouts bp WHERE bp.id = p_payout_id;
    IF v_park_pool IS NOT NULL THEN
      PERFORM public.fn_ca_declare_ledger('bbj_payout', 'table_stack', p_table_id, NULL,
                                          'bbj_park:' || v_key, NULL);
      UPDATE public.bbj_pools
         SET main_balance   = COALESCE(main_balance, 0) + p_amount,
             total_paid_out = GREATEST(0, COALESCE(total_paid_out, 0) - p_amount),
             updated_at     = now()
       WHERE id = v_park_pool;
      PERFORM set_config('app.ledger_category', '', true);
      PERFORM set_config('app.ledger_counterparty', '', true);
      PERFORM set_config('app.ledger_counterparty_entity', '', true);
      PERFORM set_config('app.ledger_idempotency_key', '', true);
    END IF;

    INSERT INTO public.bbj_unclaimed_shares (payout_id, pool_id, table_id, user_id, amount, reason)
    VALUES (p_payout_id, v_park_pool, p_table_id, p_user_id, p_amount,
            'no club wallet resolved for this recipient; chips returned to the pool and the share is still owed')
    ON CONFLICT DO NOTHING;

    RAISE WARNING 'bbj_credit_one_recipient: parked % for % (no club wallet resolves at table %); the rest of the payout stands',
      p_amount, p_user_id, p_table_id;
    RETURN false;
  END IF;
$r$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_old
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
   WHERE p.proname = 'bbj_credit_one_recipient';
  IF v_old IS NULL THEN
    RAISE EXCEPTION 'bbj_credit_one_recipient not found';
  END IF;

  IF position('PARKED, NOT RAISED' IN v_old) > 0 THEN
    RAISE NOTICE 'bbj_credit_one_recipient already parks an unpayable share; untouched';
  ELSE
    IF (length(v_old) - length(replace(v_old, v_anchor, ''))) / length(v_anchor) <> 1 THEN
      RAISE EXCEPTION 'bbj_credit_one_recipient: expected exactly one no-club RAISE to replace';
    END IF;
    -- the parked block needs one more local; declare it beside the others
    v_new := replace(v_old,
      'DECLARE' || chr(10) || '  v_claimed integer; v_club uuid; v_after numeric; v_key text;',
      'DECLARE' || chr(10) || '  v_claimed integer; v_club uuid; v_after numeric; v_key text; v_park_pool uuid;');
    IF v_new = v_old THEN
      RAISE EXCEPTION 'bbj_credit_one_recipient: could not add the v_park_pool local (DECLARE block changed shape)';
    END IF;
    v_new := replace(v_new, v_anchor, v_parked);
    EXECUTE v_new;

    SELECT pg_get_functiondef(p.oid) INTO v_new
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
     WHERE p.proname = 'bbj_credit_one_recipient';
    IF replace(replace(v_new, v_parked, v_anchor),
               ' v_key text; v_park_pool uuid;', ' v_key text;') <> v_old THEN
      RAISE EXCEPTION 'bbj_credit_one_recipient round-trip assertion failed: more than the no-club branch changed';
    END IF;
  END IF;
END
$mig$;

-- ── What is still owed ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_bbj_unclaimed_shares()
 RETURNS TABLE(id uuid, created_at timestamptz, user_id uuid, player text, amount numeric,
               payout_id uuid, table_id uuid, hand_number bigint, reason text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT u.id, u.created_at, u.user_id,
         COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                                       pr.first_name, pr.last_name, pr.full_name), 'Player'),
         u.amount, u.payout_id, u.table_id, p.hand_number, u.reason
    FROM public.bbj_unclaimed_shares u
    LEFT JOIN public.bbj_payouts p ON p.id = u.payout_id
    LEFT JOIN public.profiles pr ON pr.id = u.user_id
   WHERE u.paid_at IS NULL
   ORDER BY u.created_at DESC;
$function$;

COMMENT ON FUNCTION public.fn_bbj_unclaimed_shares() IS
  'Bad Beat Jackpot shares that could not be delivered and are still owed. The chips are in the pool; these rows say who they belong to. Operator surface: service_role only - a player reads their OWN row through bbj_unclaimed_shares RLS. BBJ phase 2.3.';

-- OPERATOR SURFACE, NOT PUBLIC. This function is SECURITY DEFINER and so runs
-- past RLS; left with its default grants it would hand every unclaimed share -
-- user ids and amounts, across every club - to any caller, including an
-- unauthenticated one. `scripts/ci/definer-authorization.mjs` refused the push
-- that first proposed it, and it was right to: read-only is not the same as
-- harmless. A PLAYER does not need this function - the `bbj_unclaimed_self_select`
-- policy above already lets them read their own row from the table itself.
--
-- PUBLIC is named as well as the roles: anon and authenticated inherit whatever
-- PUBLIC holds, so revoking the roles alone reads as a fix and does nothing.
REVOKE ALL ON FUNCTION public.fn_bbj_unclaimed_shares() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_unclaimed_shares() TO service_role;

-- ── Assertions ──────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF position('PARKED, NOT RAISED' IN pg_get_functiondef('public.bbj_credit_one_recipient'::regproc)) = 0 THEN
    RAISE EXCEPTION 'bbj_credit_one_recipient was not rewritten';
  END IF;
  IF position('no club wallet resolves for %' IN pg_get_functiondef('public.bbj_credit_one_recipient'::regproc)) > 0 THEN
    RAISE EXCEPTION 'the old no-club RAISE is still present';
  END IF;
  -- the seat-club-first resolution from 20260905011253 must survive untouched
  IF position('THE SEAT''S CLUB FIRST' IN pg_get_functiondef('public.bbj_credit_one_recipient'::regproc)) = 0 THEN
    RAISE EXCEPTION 'the seat-club-first wallet resolution was lost';
  END IF;
  IF to_regclass('public.bbj_unclaimed_shares') IS NULL THEN
    RAISE EXCEPTION 'bbj_unclaimed_shares was not created';
  END IF;
END $$;

COMMIT;
