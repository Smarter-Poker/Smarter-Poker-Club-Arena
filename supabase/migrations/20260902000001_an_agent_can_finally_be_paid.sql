-- ═══════════════════════════════════════════════════════════════════════════
--  AN AGENT CAN FINALLY BE PAID
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Phase 6 of 7. Phases 4 and 5 each wrote the same sentence into a comment and
-- moved on: "there is no payout path to send them to yet (phase 6 builds one)".
-- This is that path.
--
-- WHAT WAS TRUE ON PRODUCTION BEFORE THIS MIGRATION, measured 2026-08-31:
--
--   agent_commissions      1,507,614 rows
--     unsettled              958,627 rows, 394,904.61 chips, 96 agents
--     settled                548,987 rows, every one stamped on 2026-08-20 by
--                            a single bulk operation
--   accruing since 2026-04-28 and still accruing today
--
--   SHARK CLUB           owed 386,208.84   treasury 1,376,610.47   68 agents
--   Club JAQK            owed   8,120.03   treasury 1,051,788.71   43 agents
--   Midway Union         owed     568.18   treasury         0.00    3 agents
--   Deep Stack Society   owed      20.27   treasury    78,725.36   24 agents
--
-- THREE BROKEN THINGS STOOD WHERE THE PAYOUT PATH SHOULD HAVE BEEN.
--
--   fn_pay_commission_atomic  a stub. Its entire body returned
--                             {'success': false, 'error': 'not_implemented'}.
--
--   execute_commission_payout worse than a stub - a money bug. It credited a
--                             wallet, debited NOTHING (chips from nowhere), and
--                             never set settled_at, so the same commission row
--                             could be paid again and again forever. Nothing in
--                             the app called it, which is the only reason it
--                             never fired.
--
--   sum_agent_commissions     read commission_history, a table with 0 rows. It
--                             answered {total: 0, paid: 0} to every question
--                             ever asked of it.
--
-- All three are dropped here. None had a caller.
--
-- AND ONE NUMBER THAT WAS SIMPLY WRONG. agents.pending_commission is written by
-- no function and no trigger anywhere in this database. It says 26,859.87 owed
-- across 5 agents; agent_commissions says 394,904.61 across 96. Phase 4's
-- demotion refusal, Phase 5's promotion result and the agent dashboard all
-- reported the stale column to people's faces. fn_agent_unsettled_commission
-- below answers from the ledger, and the callers are moved onto it.
--
-- THE RULES, from Dan, 2026-08-31:
--
--   "AGENTS HANDLE THEIR OWN PAYOUTS, THEY SELL THEIR RAKE BACK CHIPS BACK TO
--    THEIR DOWNLINES" - so this is claimed by the agent, not paid out by staff.
--    The actor IS the payee; there is no path here to pay somebody else.
--
--   Commission lands in the PLAYER wallet (club_members.chip_balance) - their
--   own money. Not the agent wallet: Phase 5 refuses to demote anybody whose
--   agent wallet still holds chips, so paying earnings there would build a
--   settlement blocker into every future demotion.
--
--   "COMES FROM THE CLUB BANK AND DOCUMENTED IN THE TRANSACTION LEDGER" - the
--   club treasury is debited by exactly what the agent is credited, and one
--   chip_transactions row records it. Chips are never created.
--
--   "THEY PAY THE BALANCE OFF WEEKLY, AND ANY RAKE BACK GOES ON TOP." Commission
--   is NOT netted against credit_used. An agent carrying a debt still squares
--   the invoice in full, and their rakeback is added on top of it. This
--   migration therefore never touches credit_used, and that is deliberate.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- THE THREE DEAD ENDS GO FIRST
-- ───────────────────────────────────────────────────────────────────────────
-- Dropped rather than left refusing. A function that answers "not_implemented"
-- still reads, to the next person, like a thing that might work one day; and a
-- function that mints chips is not made safe by having no caller today.
DROP FUNCTION IF EXISTS public.fn_pay_commission_atomic(uuid, uuid, uuid, numeric, uuid);
DROP FUNCTION IF EXISTS public.execute_commission_payout(uuid);
DROP FUNCTION IF EXISTS public.sum_agent_commissions(uuid, uuid, timestamptz);

-- ───────────────────────────────────────────────────────────────────────────
-- WHAT IS ACTUALLY OWED
-- ───────────────────────────────────────────────────────────────────────────
-- One place answers this question from now on, so a screen and a payout cannot
-- disagree about the same person's money.
CREATE OR REPLACE FUNCTION public.fn_agent_unsettled_commission(
  p_club_id uuid,
  p_user_id uuid
) RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(SUM(amount), 0)::numeric
    FROM public.agent_commissions
   WHERE club_id = p_club_id
     AND user_id = p_user_id
     AND settled_at IS NULL;
$function$;

COMMENT ON FUNCTION public.fn_agent_unsettled_commission(uuid, uuid) IS
  'Commission this member has earned and not yet claimed, read from agent_commissions. '
  'Replaces agents.pending_commission, which no function or trigger has ever written.';

-- ───────────────────────────────────────────────────────────────────────────
-- THE CLAIM
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_agent_claim_commission(
  p_club_id  uuid,
  p_op_id    uuid DEFAULT NULL,
  p_max_rows integer DEFAULT 1000
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor      uuid;
  v_op_id      uuid := COALESCE(p_op_id, gen_random_uuid());
  v_role       text;
  v_amount     numeric;
  v_rows       bigint;
  v_bank_before numeric;
  v_bank_after  numeric;
  v_to_after    numeric;
  v_prior      jsonb;
  v_club_name  text;
  v_batch      integer;
  v_more       boolean;
  v_ids        uuid[];
BEGIN
  -- IDENTITY. auth.uid() is the only identity a browser can establish, and this
  -- RPC pays the caller. There is deliberately no p_user_id: a parameter naming
  -- somebody else would make this a way to move another person's earnings, and
  -- Dan's rule is that agents handle their own payouts.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sign In To Claim Your Commission');
  END IF;

  -- REPLAY. Same op_id, same answer, no second payment. The client sends one
  -- id per intent, so a double tap or a retried request settles once.
  SELECT metadata INTO v_prior
    FROM chip_transactions
   WHERE club_id = p_club_id
     AND to_user_id = v_actor
     AND transaction_type = 'commission_claim'
     AND metadata ->> 'op_id' = v_op_id::text
   LIMIT 1;
  IF v_prior IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'replayed', true,
      'amount', (v_prior ->> 'amount')::numeric,
      'rows_settled', (v_prior ->> 'rows_settled')::bigint,
      'more', EXISTS (SELECT 1 FROM agent_commissions
                        WHERE club_id = p_club_id AND user_id = v_actor
                          AND settled_at IS NULL),
      'op_id', v_op_id);
  END IF;

  -- MEMBERSHIP, NOT ROLE. A demoted agent keeps what they earned - Phase 4 let
  -- the demotion through precisely because "the agents row survives with the
  -- figure intact". If claiming required an agent role, the demotion would have
  -- quietly confiscated the money instead of deferring it.
  SELECT cm.role INTO v_role
    FROM club_members cm
   WHERE cm.club_id = p_club_id
     AND cm.user_id = v_actor
     AND COALESCE(cm.status, 'active') IN ('active', 'approved');
  IF v_role IS NULL THEN
    RETURN jsonb_build_object('success', false,
      'error', 'You Are Not An Active Member Of This Club');
  END IF;

  -- WHAT IS OWED, LOCKED, AND BOUNDED.
  --
  -- MEASURED ON PRODUCTION, 2026-08-31: the largest agent has 192,135 unsettled
  -- rows, and settling all of them in one statement took 64.6 SECONDS. The
  -- authenticated role's statement_timeout is 8s, so the three biggest agents
  -- (192k, 114k, 113k rows) could never have been paid at all.
  --
  -- The timeout is the smaller half of the problem. That statement also holds
  -- FOR UPDATE on the clubs row for its whole life, so a single claim would
  -- have frozen every chip movement in that club for a minute.
  --
  -- So a claim settles a BATCH and reports whether more is left. Measured on
  -- production against the largest agent: 2,000 rows took 2.95s, so the default
  -- is 1,000 - roughly 1.5s, a comfortable margin under 8s on a database that
  -- is also serving everybody else. The caller repeats while `more` is true -
  -- WITH A FRESH op_id EACH TIME, because op_id identifies one batch. Reusing
  -- one is what makes a retry safe; reusing one for the NEXT batch would
  -- replay the previous answer instead of settling anything.
  v_batch := LEAST(GREATEST(COALESCE(p_max_rows, 1000), 1), 5000);

  -- LOCK AND TOTAL THE BATCH. NOTHING IS WRITTEN YET.
  --
  -- ORDER MATTERS HERE AND IT IS THE WHOLE POINT. A refusal below returns
  -- JSON, and a plain RETURN does not roll anything back - PostgREST commits
  -- the transaction. So every write in this function happens AFTER the last
  -- thing that can refuse. An earlier draft folded the lock, the settle and
  -- the sum into one CTE for speed, which stamped settled_at before the club
  -- bank had been checked: a short bank would then have returned "cannot pay"
  -- while leaving the rows marked paid. That is the worst bug this function
  -- could have had, and it is why the settle is the last write, below.
  SELECT array_agg(id), COALESCE(SUM(amount), 0), COUNT(*)
    INTO v_ids, v_amount, v_rows
    FROM (
      SELECT id, amount
        FROM agent_commissions
       WHERE club_id = p_club_id
         AND user_id = v_actor
         AND settled_at IS NULL
       -- NO ORDER BY, deliberately. Measured on production: ORDER BY
       -- created_at made this read 1,194ms because it walks all 192,135
       -- matching index entries and top-N sorts them; without it the same
       -- read is 84ms, because the partial index (club_id, user_id) WHERE
       -- settled_at IS NULL can stop at the LIMIT. Money does not care which
       -- of an agent's own rows settle first, and 1.1 seconds on every claim
       -- is a real price for a cosmetic ordering.
       LIMIT v_batch
         FOR UPDATE
    ) locked;

  IF COALESCE(v_amount, 0) <= 0 THEN
    RETURN jsonb_build_object('success', false, 'nothing_owed', true,
      'error', 'You Have No Commission To Claim Yet');
  END IF;

  v_amount := round(v_amount, 2);

  -- THE CLUB BANK PAYS, AND IT PAYS ONLY WHAT IT HAS. Midway Union owes 568.18
  -- against a treasury of 0.00, so this refusal is not hypothetical. Naming the
  -- shortfall is the difference between "try later" and "somebody has to fund
  -- the bank" - and it is the same refusal fn_club_bank_send already gives.
  SELECT COALESCE(c.chip_treasury, 0), c.name
    INTO v_bank_before, v_club_name
    FROM clubs c WHERE c.id = p_club_id FOR UPDATE;
  IF v_bank_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Club Not Found');
  END IF;
  IF v_bank_before < v_amount THEN
    RETURN jsonb_build_object('success', false, 'bank_short', true,
      'error', 'The Club Bank Holds '
               || trim(to_char(v_bank_before, 'FM999,999,999,990.00'))
               || ' Chips And Owes You '
               || trim(to_char(v_amount, 'FM999,999,999,990.00'))
               || '. Ask An Owner To Fund The Bank, Then Claim Again.',
      'balance', v_bank_before, 'requested', v_amount);
  END IF;

  UPDATE clubs
     SET chip_treasury = COALESCE(chip_treasury, 0) - v_amount,
         updated_at = now()
   WHERE id = p_club_id
   RETURNING chip_treasury INTO v_bank_after;

  -- INTO THEIR OWN MONEY, not the agent wallet. See the header.
  UPDATE club_members
     SET chip_balance = COALESCE(chip_balance, 0) + v_amount,
         updated_at = now()
   WHERE club_id = p_club_id AND user_id = v_actor
   RETURNING chip_balance INTO v_to_after;

  -- SETTLED, LAST. This is the line execute_commission_payout never had, and
  -- its absence is what let that function pay the same row forever. It runs
  -- after the bank has been debited and the agent credited, so no row is ever
  -- marked paid by a claim that did not pay.
  UPDATE agent_commissions
     SET settled_at = now()
   WHERE id = ANY (v_ids);

  INSERT INTO chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  VALUES
    (p_club_id, NULL, v_actor, v_amount, 'commission_claim',
     'Commission Claimed By Agent',
     jsonb_build_object(
       'op_id', v_op_id,
       'amount', v_amount,
       'rows_settled', v_rows,
       'role_at_claim', v_role,
       'bank_before', v_bank_before,
       'bank_after', v_bank_after),
     v_to_after);

  BEGIN
    PERFORM public.fn_raise_notification(
      v_actor, 'commission_claimed',
      'You Claimed ' || trim(to_char(v_amount, 'FM999,999,999,990.00')) || ' Chips',
      'Your Commission From ' || COALESCE(v_club_name, 'Your Club')
        || ' Is Now In Your Chip Balance.',
      '/clubs/' || p_club_id::text,
      jsonb_build_object('club_id', p_club_id, 'amount', v_amount, 'rows_settled', v_rows));
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- the money has moved and is recorded; the notice is a courtesy
  END;

  -- IS THERE MORE? An EXISTS, not a COUNT and a SUM.
  --
  -- Reporting the exact remaining figure here cost 1,474ms on production,
  -- because it re-scans every one of the agent's remaining rows - on a call
  -- whose entire budget is 8 seconds. EXISTS answers the only question the
  -- caller needs in order to loop (0.25ms), and the exact figure is available
  -- from fn_agent_unsettled_commission on a screen that can afford it.
  SELECT EXISTS (
    SELECT 1 FROM agent_commissions
     WHERE club_id = p_club_id AND user_id = v_actor AND settled_at IS NULL
  ) INTO v_more;

  RETURN jsonb_build_object('success', true, 'amount', v_amount,
    'rows_settled', v_rows, 'chip_balance', v_to_after,
    'bank_after', v_bank_after, 'op_id', v_op_id,
    'more', v_more);
END;
$function$;

-- ───────────────────────────────────────────────────────────────────────────
-- AUTHORIZATION
-- ───────────────────────────────────────────────────────────────────────────
-- Both are SECURITY DEFINER. The claim moves chips, so the grant is named
-- explicitly rather than inherited from the PUBLIC default that CREATE
-- FUNCTION hands out on a database that does not have these yet.
REVOKE ALL ON FUNCTION public.fn_agent_claim_commission(uuid, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_agent_claim_commission(uuid, uuid, integer) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.fn_agent_unsettled_commission(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_agent_unsettled_commission(uuid, uuid) TO authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- THE WALLET GUARD LEARNS THE NEW NAME, AND FORGETS A DEAD ONE
-- ───────────────────────────────────────────────────────────────────────────
-- guard_wallet_balance_write whitelists the functions permitted to move
-- balances. execute_commission_payout sat on that list; it is gone, so its
-- name goes too, and nothing replaces it there - fn_agent_claim_commission
-- writes clubs.chip_treasury and club_members.chip_balance, neither of which
-- that guard covers (it guards wallets and clubs.chip_pool). Leaving a dead
-- name on an allow-list is how an allow-list stops meaning anything.
CREATE OR REPLACE FUNCTION public.guard_wallet_balance_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_stack   TEXT;
  v_bypass  TEXT;
  v_allowed TEXT[] := ARRAY[
    'atomic_credit_wallet_and_log','atomic_deduct_wallet_and_log','atomic_wallet_transfer',
    'atomic_chip_transfer','fn_idempotent_credit_wallet','fn_idempotent_deduct_wallet',
    'fn_idempotent_wallet_transfer','atomic_table_buyin','atomic_table_cashout',
    'atomic_table_rebuy','atomic_table_addon','atomic_table_withdraw','atomic_seat_horse','player_leave_table','atomic_tournament_register',
    'atomic_tournament_unregister','atomic_cancel_tournament','distribute_tournament_prizes',
    'process_tournament_rebuy',
    'atomic_pay_agent_settlement','atomic_pay_player_rakeback','credit_agent_commission',
    'credit_player_rakeback','fn_cancel_cashout','fn_reject_cashout',
    'fn_clawback_chips_atomic','distribute_chips','mint_club_chips','add_chips','add_to_promo_wallet',
    'credit_player_wallet','deduct_player_wallet','wallet_internal_transfer','wallet_user_transfer',
    'create_user_wallets','reconcile_ledger_nightly',
    -- added 2026-08-15 with the chip-removal authority policy
    'fn_admin_remove_player_chips','fn_approve_cashout_atomic','fn_cancel_cashout_atomic',
    -- added 2026-08-21 with the diamond-backed Chip Mint (Dan's directive)
    'fn_mint_chips_from_diamonds',
    -- added 2026-08-23 with the Club Bank Cashier (Dan directive)
    'fn_club_bank_send',
    'fn_club_bank_claim_back', 'fn_promo_wallet_send',
    'fn_club_bank_reverse'
    -- removed 2026-08-31 (phase 6): execute_commission_payout, which credited a
    -- wallet, debited nothing and never marked the commission settled.
  ];
  v_fn TEXT;
BEGIN
  v_bypass := current_setting('app.bypass_wallet_guard', true);
  IF v_bypass = 'on' THEN RETURN NEW; END IF;
  GET DIAGNOSTICS v_stack = PG_CONTEXT;
  FOREACH v_fn IN ARRAY v_allowed LOOP
    IF v_stack ~ ('function (public\.)?' || v_fn || '\(') THEN
      RETURN NEW;
    END IF;
  END LOOP;
  RAISE EXCEPTION
    'Direct balance mutation on %.% is forbidden by Phase 4.1.6a guard. '
    'All balance changes must flow through the whitelisted SECURITY DEFINER '
    'RPCs (atomic_*, fn_idempotent_*, distribute_chips, mint_club_chips, etc.) '
    'that log to chip_ledger. Admin override: '
    'SELECT set_config(''app.bypass_wallet_guard'', ''on'', true);',
    TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$function$;

-- ───────────────────────────────────────────────────────────────────────────
-- SELF-ASSERTIONS. This migration refuses to commit a state it did not mean.
-- ───────────────────────────────────────────────────────────────────────────
DO $verify$
DECLARE
  v_def text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public'
                AND p.proname IN ('fn_pay_commission_atomic','execute_commission_payout','sum_agent_commissions')) THEN
    RAISE EXCEPTION 'a dead commission function survived this migration';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'guard_wallet_balance_write';
  IF v_def LIKE '%''execute_commission_payout''%' THEN
    RAISE EXCEPTION 'the wallet guard still allows a function that no longer exists';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_agent_claim_commission';

  -- The three lines that separate this from the function it replaces.
  IF v_def NOT LIKE '%SET settled_at = now()%' THEN
    RAISE EXCEPTION 'the claim does not mark the commission settled, so it would pay twice';
  END IF;
  IF v_def NOT LIKE '%chip_treasury = COALESCE(chip_treasury, 0) - v_amount%' THEN
    RAISE EXCEPTION 'the claim does not debit the club bank, so it would create chips';
  END IF;
  IF v_def NOT LIKE '%metadata ->> ''op_id''%' THEN
    RAISE EXCEPTION 'the claim has no replay guard';
  END IF;
  -- Unbounded, this could not finish inside the 8s statement timeout and would
  -- hold the club row locked for a minute while failing.
  IF v_def NOT LIKE '%LIMIT v_batch%' THEN
    RAISE EXCEPTION 'the claim settles an unbounded number of rows';
  END IF;

  -- THE ORDERING INVARIANT. A refusal returns JSON, and a plain RETURN commits
  -- rather than rolls back, so every write must come after the last refusal.
  -- If the settle ever moves above the treasury debit, a short bank marks rows
  -- paid without paying them.
  IF position('SET settled_at = now()' in v_def)
     < position('SET chip_treasury = COALESCE(chip_treasury, 0) - v_amount' in v_def) THEN
    RAISE EXCEPTION 'the claim marks commission settled before it debits the bank';
  END IF;
  IF position('SET settled_at = now()' in v_def)
     < position('SET chip_balance = COALESCE(chip_balance, 0) + v_amount' in v_def) THEN
    RAISE EXCEPTION 'the claim marks commission settled before it credits the agent';
  END IF;
  -- Dan: rake back goes ON TOP of the debt, it does not pay it down.
  IF v_def LIKE '%credit_used%' THEN
    RAISE EXCEPTION 'the claim touches credit_used; commission must not net against debt';
  END IF;
  -- It pays the caller and nobody else. Read from the SIGNATURE, not the whole
  -- definition: the body's own comment explains why there is no p_user_id, and
  -- the first draft of this assertion matched that sentence and failed on it.
  IF substring(v_def from 'fn_agent_claim_commission\(([^)]*)\)') ~ 'user_id' THEN
    RAISE EXCEPTION 'the claim accepts a payee parameter; it must only pay auth.uid()';
  END IF;

  IF has_function_privilege('anon', 'public.fn_agent_claim_commission(uuid, uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can claim commission';
  END IF;
END
$verify$;

COMMIT;
