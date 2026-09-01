-- ═══════════════════════════════════════════════════════════════════════════
--  THE AGENT'S BOOKS TELL THE TRUTH
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Phase 7 of 7, the last one. Phase 6 built the path that pays an agent. This
-- is the pass that makes every screen and every function in front of that path
-- report the same number the ledger holds.
--
-- WHAT PRODUCTION SAID ON 2026-09-01, the day after phase 6 shipped:
--
--   agent_commissions   988,530 unsettled rows   408,809.59 chips   114 agents
--                       nobody has claimed yet
--
--   SHARK CLUB           owed 399,609.57   treasury 1,376,610.47   68 agents
--   Club JAQK            owed   8,499.76   treasury 1,051,788.71   43 agents
--   Midway Union         owed     607.05   treasury         0.00    19 agents
--   Deep Stack Society   owed      95.37   treasury    97,800.23   70 agents
--
-- AND WHAT THE AGENT WAS SHOWN INSTEAD: four zeros.
--
--   fn_get_agent_commission_summary   a STUB. Its entire body was
--                                     "-- STUB: underlying commission table
--                                     amount column drift. Return zeros."
--                                     It is what fills Total Earned, This Week,
--                                     This Month, Pending Payout and Last
--                                     Payout on the agent dashboard. It also
--                                     returned bigint, which cannot carry the
--                                     two decimal places of a chip, and RETURNS
--                                     TABLE, which reaches PostgREST as an
--                                     array - so the client's
--                                     summaryData.total_earned was undefined
--                                     even before the zeros got there.
--
--   commission_records                0 rows, ever. The dashboard's Records tab
--                                     reads it, and the realtime subscription
--                                     that refreshes the page listens to it, so
--                                     the tab is always empty and the listener
--                                     can never fire.
--
--   commission_history                0 rows, ever. Read by the World Hub agent
--                                     leaderboard (every agent's earnings: 0),
--                                     by the club financials page (club
--                                     commission: 0), and by
--                                     get_daily_commission_summary, which asks
--                                     it for a column named amount that it does
--                                     not have - so the trends endpoint 42703s
--                                     rather than returning a zero.
--
--   agents.pending_commission         26,859.87 across 5 agents, against a
--                                     ledger holding 408,809.59 across 114.
--                                     Read by fn_club_set_member_role, so a
--                                     demotion reported "owed nothing" to the
--                                     person doing it for 109 of those 114.
--                                     Read by fn_ca_gdpr_financial_precheck, so
--                                     an account holding unclaimed commission
--                                     could be cleared for deletion.
--
-- THE PHANTOM SETTLEMENT. 548,987 rows carry settled_at
-- '2026-08-20 17:18:22.456863+00' - every one of them the same instant, 75
-- agents, 3 clubs, 256,765.50 chips. There is no chip_transactions row of any
-- commission type in that window, or anywhere in that table's history, and no
-- audit_trail row between 16:00 and 19:00 that day. Nobody was paid. A bulk
-- statement marked the debt settled and no chips moved.
--
-- Dan, 2026-09-01: "ITS RAKE BACK RIGHT? PAY IT OUT FROM THE OWNER ACCOUNT FROM
-- THE CLUB BANK". So the stamp is removed and the money becomes claimable again
-- through fn_agent_claim_commission, which debits the club bank for exactly
-- what it credits. This migration moves no chips itself: it restores a debt
-- that was erased, and the agent draws it the way phase 6 says they must.
--
-- THE DOUBLE-PAY THIS ALSO CLOSES. credit_agent_commission_from_rake writes
-- BOTH an agent_commissions row AND agents.weekly_rake_generated. The World
-- Hub's settle-period close then computes commission a second time from
-- weekly_rake_generated and inserts it into commission_records - so one piece
-- of rake would have become two payable liabilities, one claimable by the agent
-- and one payable by staff through pay_all. It has never fired: those tables
-- are empty because every historical close 401'd or stalled. The World Hub half
-- is removed in Smarter-Poker-World-Hub; this half removes the tables it wrote
-- to, so it cannot come back.
--
-- NOTHING IN THIS MIGRATION MOVES A CHIP. It was run in full against production
-- inside a transaction that was rolled back, with its probes in the same
-- transaction, per CLAUDE.md section 11.5.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. THE SUMMARY THE DASHBOARD ASKS FOR, ANSWERED FROM THE LEDGER
-- ───────────────────────────────────────────────────────────────────────────
--
-- The old signature returned TABLE(bigint, bigint, bigint, bigint, timestamptz)
-- and cannot be replaced in place, so it is dropped. jsonb is what the client
-- already destructures, and numeric is what a chip is.
--
-- IDENTITY. A read of what somebody has earned is theirs. auth.uid() is the
-- only identity a browser can establish, so p_agent_id is honoured ONLY for a
-- trusted backend caller - the same rule fn_club_set_member_role applies to
-- p_actor_user_id, and the same reason phase 6 gave the claim no payee
-- parameter at all.
DROP FUNCTION IF EXISTS public.fn_get_agent_commission_summary(uuid);

CREATE OR REPLACE FUNCTION public.fn_get_agent_commission_summary(
  p_agent_id uuid DEFAULT NULL,
  p_club_id  uuid DEFAULT NULL
) RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid    uuid;
  v_result jsonb;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    IF COALESCE(auth.role(), 'service_role') = 'service_role' AND p_agent_id IS NOT NULL THEN
      v_uid := p_agent_id;
    ELSE
      RETURN jsonb_build_object('error', 'identity required');
    END IF;
  END IF;
  -- A browser that passes somebody else's id is answered for ITSELF rather than
  -- refused, so a stale client cannot read another agent's book by passing an
  -- id it happens to know.

  SELECT jsonb_build_object(
           'total_earned',   COALESCE(SUM(ac.amount), 0),
           'this_week',      COALESCE(SUM(ac.amount) FILTER (WHERE ac.created_at >= now() - interval '7 days'), 0),
           'this_month',     COALESCE(SUM(ac.amount) FILTER (WHERE ac.created_at >= now() - interval '30 days'), 0),
           'pending_payout', COALESCE(SUM(ac.amount) FILTER (WHERE ac.settled_at IS NULL), 0),
           'last_payout',    MAX(ac.settled_at))
    INTO v_result
    FROM public.agent_commissions ac
   WHERE ac.user_id = v_uid
     AND (p_club_id IS NULL OR ac.club_id = p_club_id);

  RETURN COALESCE(v_result, jsonb_build_object(
    'total_earned', 0, 'this_week', 0, 'this_month', 0,
    'pending_payout', 0, 'last_payout', NULL));
END;
$function$;

COMMENT ON FUNCTION public.fn_get_agent_commission_summary(uuid, uuid) IS
  'Agent commission summary read from agent_commissions. Replaced a stub that returned zeros in bigint columns while the ledger held 408,809.59 chips. pending_payout is what fn_agent_claim_commission would pay; last_payout is when the ledger says they were actually paid.';

REVOKE ALL ON FUNCTION public.fn_get_agent_commission_summary(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_get_agent_commission_summary(uuid, uuid) TO authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. THE DAILY TREND, OFF THE EMPTY TABLE
-- ───────────────────────────────────────────────────────────────────────────
--
-- It read commission_history.amount. commission_history has no column called
-- amount (it has commission_earned), so this did not return zero - it raised
-- 42703 at every call, and the World Hub trends endpoint swallowed that into an
-- all-zero sparkline.
--
-- The caller passes an auth user id, but an agents.id PK is what other parts of
-- this schema mean by "agent id", so both are accepted and resolved.
CREATE OR REPLACE FUNCTION public.get_daily_commission_summary(p_club_id uuid, p_agent_id uuid, p_days integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid    uuid;
  v_result jsonb;
BEGIN
  v_uid := p_agent_id;
  IF NOT EXISTS (SELECT 1 FROM public.agent_commissions ac WHERE ac.user_id = v_uid) THEN
    SELECT a.user_id INTO v_uid FROM public.agents a WHERE a.id = p_agent_id;
    v_uid := COALESCE(v_uid, p_agent_id);
  END IF;

  SELECT jsonb_object_agg(day_str, total_amount) INTO v_result
    FROM (
      SELECT to_char(ac.created_at, 'YYYY-MM-DD') AS day_str,
             COALESCE(SUM(ac.amount), 0) AS total_amount
        FROM public.agent_commissions ac
       WHERE ac.club_id = p_club_id
         AND ac.user_id = v_uid
         AND ac.created_at >= now() - ((p_days)::text || ' days')::interval
       GROUP BY 1
    ) sub;

  RETURN COALESCE(v_result, '{}'::jsonb);
END;
$function$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. FOUR FUNCTIONS THAT ONLY EVER TOUCHED THE DEAD OBJECTS
-- ───────────────────────────────────────────────────────────────────────────
--
--   get_agent_commission_history   SELECTs commission_history. No caller in
--                                  either repo.
--   generate_period_settlement     a stub: "commission_records.updated_at
--                                  column drift". No caller. The plural
--                                  generate_period_settlements, which the
--                                  settlement dashboard does call, is a
--                                  different function over agents and
--                                  agent_commissions, and is untouched.
--   atomic_pay_agent_settlement    STAFF paying an agent, decrementing
--                                  agents.pending_commission. It contradicts
--                                  Dan's phase 6 ruling - "AGENTS HANDLE THEIR
--                                  OWN PAYOUTS" - and it decremented a column
--                                  nothing incremented, so it would have paid
--                                  against a figure that was already wrong. No
--                                  caller.
--   increment_agent_rake           the ONLY writer of pending_commission
--                                  anywhere in this database, and it has no
--                                  caller: the live accrual is
--                                  credit_agent_commission_from_rake, which
--                                  writes agent_commissions and
--                                  weekly_rake_generated. A writer with no
--                                  caller is why the column froze at 26,859.87.
DROP FUNCTION IF EXISTS public.get_agent_commission_history(uuid, integer);
DROP FUNCTION IF EXISTS public.generate_period_settlement(uuid, uuid, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.atomic_pay_agent_settlement(uuid, uuid, numeric, uuid);
DROP FUNCTION IF EXISTS public.increment_agent_rake(uuid, numeric);

-- ───────────────────────────────────────────────────────────────────────────
-- 4. THE TWO GUARDS THAT NAMED atomic_pay_agent_settlement
-- ───────────────────────────────────────────────────────────────────────────
--
-- fn_union_money_path_check treats a named function that no longer exists as a
-- breach, in its own words - so removing the function without removing the name
-- would leave the estate guard reporting a failure every hour that nobody could
-- fix. Nothing takes its place on the list, for the reason the comment already
-- in this function gives about transfer_chips_agent_to_player.
CREATE OR REPLACE FUNCTION public.fn_union_money_path_check()
 RETURNS TABLE(fn text, detail text)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT x.fn,
         'money path no longer reaches club scope (directly or through any '
         || 'function it calls, to 4 levels) - club wallets would be commingled'
    FROM (VALUES
            ('atomic_table_buyin'),('atomic_table_cashout'),
            ('atomic_table_rebuy'),('atomic_table_addon'),
            ('atomic_tournament_register'),('atomic_tournament_unregister'),
            ('process_tournament_rebuy'),
            ('credit_player_wallet'),('atomic_cancel_tournament'),
            ('fn_pay_player_chips'),
            ('atomic_pay_player_rakeback'),('credit_player_rakeback')
            -- transfer_chips_agent_to_player was here. It is dropped: it
            -- debited the agent's PLAYER wallet, its only caller was an unused
            -- World Hub route, and fn_agent_wallet_send is the path.
            --
            -- atomic_pay_agent_settlement was here until phase 7, and is
            -- dropped for the same shape of reason: staff paying an agent out
            -- of a column nothing maintained, against Dan's ruling that agents
            -- claim their own. What replaces it, fn_agent_claim_commission, is
            -- club-scoped by construction - it takes p_club_id, locks that
            -- club's row and debits that club's treasury - so there is nothing
            -- here for this check to discover about it.
         ) AS x(fn)
   -- A function that has been deleted outright is still a breach; one that
   -- exists but cannot reach club scope is the breach this was written for.
   WHERE NOT EXISTS (
           SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = x.fn)
      OR NOT public.fn_money_path_reaches_club_scope(x.fn, 4);
$function$;

-- guard_wallet_balance_write whitelists the functions permitted to move
-- balances. atomic_pay_agent_settlement sat on that list; it is gone, so its
-- name goes too. Nothing replaces it: fn_agent_claim_commission writes
-- clubs.chip_treasury and club_members.chip_balance, neither of which this
-- guard covers.
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
    'atomic_pay_player_rakeback','credit_agent_commission',
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
    -- removed 2026-09-01 (phase 7): atomic_pay_agent_settlement, a staff payout
    -- that decremented a column nothing incremented.
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
-- 5. DELETING AN ACCOUNT CANNOT ERASE WHAT THE CLUB OWES IT
-- ───────────────────────────────────────────────────────────────────────────
--
-- The GDPR precheck lists every balance a departing account might still hold,
-- and summed pending_commission among them - a column that says 0.00 for 109 of
-- the 114 agents who are owed money. An account with unclaimed commission was
-- reported clear and could be deleted with the claim still sitting in the
-- ledger, and the claim pays auth.uid() and nobody else, so deletion is the one
-- act that makes it unrecoverable. It now asks the ledger, per club, and names
-- the figure.
CREATE OR REPLACE FUNCTION public.fn_ca_gdpr_financial_precheck(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_blockers jsonb := '[]'::jsonb;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('clear', false, 'blockers', jsonb_build_array('missing user id'));
  END IF;

  SELECT COALESCE(jsonb_agg(b), '[]'::jsonb) INTO v_blockers FROM (
    SELECT 'club ' || cm.club_id || ': chip balance ' || cm.chip_balance AS b
      FROM public.club_members cm
     WHERE cm.user_id = p_user_id AND round(COALESCE(cm.chip_balance,0),2) <> 0
    UNION ALL
    SELECT 'club ' || cm.club_id || ': promo balance ' || cm.promo_balance
      FROM public.club_members cm
     WHERE cm.user_id = p_user_id AND round(COALESCE(cm.promo_balance,0),2) <> 0
    UNION ALL
    SELECT 'seated at table ' || ts.table_id || ' with stack ' || ts.stack
      FROM public.table_seats ts
     WHERE ts.user_id = p_user_id AND COALESCE(ts.stack,0) > 0
    UNION ALL
    SELECT 'pending rakeback payout ' || p.id
      FROM public.rakeback_period_payouts p
     WHERE p.user_id = p_user_id AND p.status NOT IN ('paid','cancelled','failed')
    UNION ALL
    SELECT 'outstanding tournament ticket ' || t.id || ' (value ' || t.value || ')'
      FROM public.tournament_tickets t
     WHERE t.holder_id = p_user_id AND t.status NOT IN ('redeemed','cancelled')
    UNION ALL
    SELECT 'agent record in club ' || a.club_id || ' holds balances or credit (credit_used ' || COALESCE(a.credit_used,0) || ')'
      FROM public.agents a
     WHERE a.user_id = p_user_id
       AND (round(COALESCE(a.agent_wallet_balance,0) + COALESCE(a.player_wallet_balance,0)
                + COALESCE(a.promo_wallet_balance,0),2) <> 0
            OR round(COALESCE(a.credit_used,0),2) <> 0)
    UNION ALL
    SELECT 'club ' || ac.club_id || ': unclaimed commission '
           || trim(to_char(SUM(ac.amount), 'FM999,999,999,990.00'))
           || ' chips, claimable but not yet claimed'
      FROM public.agent_commissions ac
     WHERE ac.user_id = p_user_id AND ac.settled_at IS NULL
     GROUP BY ac.club_id
    HAVING round(SUM(ac.amount), 2) <> 0
  ) s;

  RETURN jsonb_build_object('clear', jsonb_array_length(v_blockers) = 0,
                            'blockers', v_blockers, 'checked_at', now());
END;
$function$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. A ROLE CHANGE REPORTS WHAT IS ACTUALLY OWED
-- ───────────────────────────────────────────────────────────────────────────
--
-- Two changes to fn_club_set_member_role, and nothing else in it moves:
--
--   1. v_commission comes from fn_agent_unsettled_commission - the ledger,
--      through the same function phase 6 gave the dashboard - rather than from
--      agents.pending_commission, which this migration drops.
--   2. It is computed for EVERY role change instead of only on the demotion
--      that takes the agent wallet away. It was declared, reported in the
--      success payload, and left NULL on every other path - so a promotion has
--      always reported 0 no matter what the club owed the person being
--      promoted.
--   3. The key it is reported under is renamed pending_commission ->
--      unclaimed_commission. The old name was the dead column's name, and no
--      caller in either repo reads the key. tests/a-demotion-closes-the-books
--      pins it and is updated in this same commit, which is the rule when you
--      deliberately replace behaviour a test holds.
--
-- The cost is one partial-index lookup per role change
-- (agent_commissions_unsettled_idx on club_id, user_id WHERE settled_at IS
-- NULL).
--
-- IT IS APPLIED AS A PATCH TO THE LIVE DEFINITION, and that is deliberate. This
-- function is 18,519 characters that four phases have edited in turn, and
-- re-emitting all of it to change ten lines does two bad things: it hides the
-- change inside four hundred unchanged lines, and it silently CLOBBERS whatever
-- another agent may have landed in it between this file being written and being
-- applied. Every replacement below is asserted to match exactly once, so a
-- definition this migration does not recognise stops it rather than being
-- overwritten by it.
DO $patch$
DECLARE
  v_def   text;
  v_new   text;
  v_old_1 text;
  v_new_1 text;
  v_old_2 text;
  v_new_2 text;
  v_old_3 text;
  v_new_3 text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'fn_club_set_member_role'
     AND pg_get_function_identity_arguments(p.oid) =
         'p_club_id uuid, p_user_id uuid, p_role text, p_actor_user_id uuid, p_commission_rate numeric, p_player_rakeback_rate numeric, p_is_prepaid boolean, p_credit_limit numeric';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fn_club_set_member_role is not where this migration expects it';
  END IF;

  -- 1. The read of the dead column goes. The float and the debt still come from
  --    the agents row; only the commission moves.
  v_old_1 := $m1$    SELECT COALESCE(a.agent_wallet_balance, 0), COALESCE(a.credit_used, 0),
           COALESCE(a.pending_commission, 0)
      INTO v_float, v_owed, v_commission
      FROM agents a
     WHERE a.club_id = p_club_id AND a.user_id = p_user_id;$m1$;
  v_new_1 := $m1$    SELECT COALESCE(a.agent_wallet_balance, 0), COALESCE(a.credit_used, 0)
      INTO v_float, v_owed
      FROM agents a
     WHERE a.club_id = p_club_id AND a.user_id = p_user_id;$m1$;

  -- 2. The ledger is asked once, before any branch. It used to be read only
  --    inside the demotion that takes the agent wallet away, and reported in the
  --    success payload of EVERY role change - where it was therefore always
  --    NULL, always rendered 0.
  v_old_2 := $m2$  v_keeps_wallet := p_role <> 'player';$m2$;
  v_new_2 := $m2$  v_keeps_wallet := p_role <> 'player';

  -- PHASE 7. What the club still owes this person, from the ledger the claim
  -- path settles - rather than from the agents column that migration drops,
  -- which nothing ever wrote. It said 26,859.87 across 5 agents on a day the
  -- ledger held 408,809.59 across 114, so 109 of those 114 were reported to the
  -- person changing their role as owed nothing at all. One partial-index lookup
  -- (agent_commissions_unsettled_idx).
  v_commission := public.fn_agent_unsettled_commission(p_club_id, p_user_id);$m2$;

  -- 3. The reported key was named after the column. Renamed in both payloads;
  --    no caller in either repo reads it, and the law test that pins it moves
  --    in this same commit.
  v_old_3 := $m3$'pending_commission', COALESCE(v_commission, 0)$m3$;
  v_new_3 := $m3$'unclaimed_commission', COALESCE(v_commission, 0)$m3$;

  -- ALREADY APPLIED? A patch is not idempotent by nature, and a migration that
  -- cannot be replayed is a migration that fails the first time anybody rebuilds
  -- this database or re-runs the file to check it. If the ledger read is already
  -- there and the dead column is already gone from the body, there is nothing to
  -- do and saying so is the whole job.
  IF position('fn_agent_unsettled_commission(p_club_id, p_user_id)' in v_def) <> 0
     AND position('pending_commission' in v_def) = 0 THEN
    RAISE NOTICE 'phase 7: fn_club_set_member_role already reads the ledger, nothing to patch';
    RETURN;
  END IF;

  IF (length(v_def) - length(replace(v_def, v_old_1, ''))) / length(v_old_1) <> 1 THEN
    RAISE EXCEPTION 'the agents-row read is not what this migration expects';
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old_2, ''))) / length(v_old_2) <> 1 THEN
    RAISE EXCEPTION 'the wallet-keeping line is not what this migration expects';
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old_3, ''))) / length(v_old_3) <> 2 THEN
    RAISE EXCEPTION 'the reported commission key is not reported exactly twice';
  END IF;

  v_new := replace(v_def, v_old_1, v_new_1);
  v_new := replace(v_new, v_old_2, v_new_2);
  v_new := replace(v_new, v_old_3, v_new_3);

  IF position('pending_commission' in v_new) <> 0 THEN
    RAISE EXCEPTION 'a reference to the dropped column survived the patch';
  END IF;
  IF position('fn_agent_unsettled_commission(p_club_id, p_user_id)' in v_new) = 0 THEN
    RAISE EXCEPTION 'the patched function does not read the ledger';
  END IF;
  -- The landmarks that must survive untouched: this is a patch, not a rewrite.
  IF position('needs_settlement' in v_new) = 0
     OR position('fn_club_grantable_roles' in v_new) = 0
     OR position('fn_raise_notification' in v_new) = 0
     OR position('Move them to another agent first.' in v_new) = 0 THEN
    RAISE EXCEPTION 'the patch removed something it was not supposed to touch';
  END IF;

  EXECUTE v_new;
END;
$patch$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6b. WHAT AN AGENT'S DOWNLINE IS OWED
-- ───────────────────────────────────────────────────────────────────────────
--
-- The Sub-Agents tab printed agents.pending_commission for each downline. It
-- cannot simply read the ledger instead: RLS on agent_commissions lets an
-- authenticated caller see THEIR OWN rows and nobody else's - which is correct,
-- and is why this needs a definer function rather than a wider policy.
--
-- It answers UNCLAIMED rather than lifetime earnings, deliberately: unclaimed is
-- what the club still owes, it is the number an upline can act on, and it is the
-- one the partial index answers without reading the whole table
-- (agent_commissions_unsettled_idx on club_id, user_id WHERE settled_at IS
-- NULL). A lifetime figure would scan every row every downline has ever
-- generated, on a page load with an 8 second budget.
CREATE OR REPLACE FUNCTION public.fn_agent_downline_commission(p_club_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid    uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'agent_id',  d.id,
           'user_id',   d.user_id,
           'club_id',   d.club_id,
           'unclaimed', COALESCE(t.unclaimed, 0))), '[]'::jsonb)
    INTO v_result
    FROM public.agents me
    JOIN public.agents d ON d.parent_agent_id = me.id
    LEFT JOIN LATERAL (
           SELECT SUM(ac.amount) AS unclaimed
             FROM public.agent_commissions ac
            WHERE ac.club_id = d.club_id
              AND ac.user_id = d.user_id
              AND ac.settled_at IS NULL
         ) t ON TRUE
   WHERE me.user_id = v_uid
     AND (p_club_id IS NULL OR me.club_id = p_club_id);

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_agent_downline_commission(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_agent_downline_commission(uuid) TO authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 6bb. WHAT A CLUB HAS ACCRUED IN AGENT COMMISSION
-- ───────────────────────────────────────────────────────────────────────────
--
-- The club financials page summed commission_history and printed the result as
-- "Agent Commissions" - 0.00 for every club and every period, while SHARK CLUB
-- alone had accrued 399,609.57. It cannot read agent_commissions directly
-- either: RLS gives an authenticated caller their OWN rows, so a club owner
-- reading their club's commission would see only what they had personally
-- earned - a smaller lie in place of a larger one.
--
-- So the aggregate is answered by a definer function that checks the caller is
-- staff of that club, and nothing row-level is exposed to do it.
CREATE OR REPLACE FUNCTION public.fn_club_commission_accrued(
  p_club_id uuid,
  p_since   timestamptz DEFAULT NULL,
  p_until   timestamptz DEFAULT NULL
) RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_total numeric;
BEGIN
  IF p_club_id IS NULL THEN
    RETURN 0;
  END IF;

  -- Staff of THIS club, or a service caller. Anybody else gets zero rather than
  -- an error: this feeds a summary card, and a card is not the place to leak
  -- whether a club exists.
  IF NOT (public.fn_is_club_admin_uid(p_club_id)
          OR (auth.uid() IS NULL AND COALESCE(auth.role(), 'service_role') = 'service_role')) THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(SUM(ac.amount), 0) INTO v_total
    FROM public.agent_commissions ac
   WHERE ac.club_id = p_club_id
     AND (p_since IS NULL OR ac.created_at >= p_since)
     AND (p_until IS NULL OR ac.created_at <  p_until);

  RETURN COALESCE(v_total, 0);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_club_commission_accrued(uuid, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_commission_accrued(uuid, timestamptz, timestamptz) TO authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 6c. THE INDEX THE RECORDS TAB NEEDS
-- ───────────────────────────────────────────────────────────────────────────
--
-- The Records tab is "this agent's last 50 commission rows, newest first". On
-- user_id alone that is a top-N sort over every row the agent has ever
-- generated - 198,304 of them for the largest, which phase 6 measured at
-- 1,194ms for exactly this ORDER BY. The same index serves the summary's week
-- and month windows.
--
-- ON PRODUCTION THIS INDEX IS BUILT CONCURRENTLY, BEFORE THIS MIGRATION RUNS,
-- and the statement below then finds it and does nothing. Measured in the
-- rolled-back rehearsal: an ordinary CREATE INDEX on this table takes 14.5
-- seconds and holds a lock that blocks every commission INSERT for all of it -
-- and commission rows are inserted as hands settle, so that is 14.5 seconds of
-- stalled hands. CONCURRENTLY cannot run inside a transaction, which is what a
-- migration is, so it cannot live in this file. The statement stays here so a
-- database built from these migrations still gets the index.
CREATE INDEX IF NOT EXISTS agent_commissions_user_recent_idx
  ON public.agent_commissions (user_id, created_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 7. THE SETTLEMENT THAT NEVER PAID ANYBODY
-- ───────────────────────────────────────────────────────────────────────────
--
-- One instant, 548,987 rows, 75 agents, 3 clubs, 256,765.50 chips, and not one
-- chip_transactions row or audit_trail row anywhere near it. The stamp is
-- removed by that exact timestamp and nothing else, so a genuine settlement -
-- there are none yet, but there will be - cannot be caught by it.
--
-- This restores a DEBT. No chips move here. The agent claims through
-- fn_agent_claim_commission, which refuses a club whose bank cannot cover it
-- and names the shortfall, so Midway Union's 122.35 waits for an owner to fund
-- the bank rather than being paid out of nowhere.
--
-- IT IS DONE IN BATCHES, and that is not tidiness. The rolled-back rehearsal ran
-- it as one statement and was killed at exactly 120 seconds by the role's
-- statement_timeout, 548,987 rows in and nothing to show - the same shape of
-- failure phase 6 found when settling one agent's 198,304 rows took 64.6
-- seconds against an 8 second budget. A statement that cannot finish is not a
-- migration, it is an outage with a rollback.
--
-- ON PRODUCTION these batches are run first, as separate committed statements,
-- and this block then finds nothing left to reverse and says so. Run against a
-- database where the stamp is still there, it does the whole job itself.
--
-- statement_timeout is lifted FOR THIS TRANSACTION ONLY. It is 120 seconds
-- here, and it applies to the DO block as a whole rather than to each statement
-- inside it - so batching alone does not escape it, as the second rehearsal
-- proved by dying four batches in. There is no index on settled_at (the only
-- one is partial, WHERE settled_at IS NULL, and excludes precisely these rows),
-- so each batch pays a scan to find the next 20,000: about 26 seconds. The
-- whole reversal is a few minutes of work on rows nothing else touches, because
-- the engine only ever INSERTS into this table.
SET LOCAL statement_timeout = '0';

DO $reverse$
DECLARE
  v_rows    bigint;
  v_chips   numeric;
  v_agents  bigint;
  v_batch   bigint;
  v_done    bigint := 0;
BEGIN
  SELECT count(*), COALESCE(SUM(amount), 0), count(DISTINCT user_id)
    INTO v_rows, v_chips, v_agents
    FROM public.agent_commissions
   WHERE settled_at = TIMESTAMPTZ '2026-08-20 17:18:22.456863+00';

  IF v_rows = 0 THEN
    RAISE NOTICE 'phase 7: the phantom settlement is already reversed, nothing to do';
    RETURN;
  END IF;

  -- A settlement that paid somebody leaves a trail. If one ever appears against
  -- this timestamp, this migration must not quietly un-pay it.
  IF EXISTS (
    SELECT 1 FROM public.chip_transactions ct
     WHERE ct.created_at BETWEEN TIMESTAMPTZ '2026-08-20 16:00:00+00'
                             AND TIMESTAMPTZ '2026-08-20 19:00:00+00'
       AND (ct.transaction_type ILIKE '%commission%' OR ct.notes ILIKE '%commission%')
  ) THEN
    RAISE EXCEPTION
      'a commission payment exists in the window this migration calls a phantom - stop and reconcile by hand';
  END IF;

  -- The set is collected ONCE, by primary key, and then drained. The obvious
  -- shape - UPDATE ... WHERE settled_at = <stamp> LIMIT 20000, repeatedly -
  -- re-scans 1.5 million rows on every pass to find the next batch, which the
  -- rehearsal measured at 26 seconds per batch and 28 batches to go. One scan
  -- to fill this table, then every batch is a primary-key lookup.
  CREATE TEMP TABLE p7_phantom ON COMMIT DROP AS
    SELECT id FROM public.agent_commissions
     WHERE settled_at = TIMESTAMPTZ '2026-08-20 17:18:22.456863+00';

  LOOP
    WITH batch AS (
      DELETE FROM p7_phantom
       WHERE ctid IN (SELECT ctid FROM p7_phantom LIMIT 20000)
      RETURNING id
    )
    UPDATE public.agent_commissions ac
       SET settled_at = NULL
      FROM batch
     WHERE ac.id = batch.id;

    GET DIAGNOSTICS v_batch = ROW_COUNT;
    EXIT WHEN v_batch = 0;
    v_done := v_done + v_batch;
    RAISE NOTICE 'phase 7: reversed % of % phantom-settled rows', v_done, v_rows;
  END LOOP;

  -- The reversal is journalled in ca_ledger_mutation_log rather than
  -- audit_trail: audit_trail.actor_id is NOT NULL and carries a foreign key
  -- into auth.users, and there is no human actor here - inventing one to
  -- satisfy a constraint would put a person's name on a migration's work.
  INSERT INTO public.ca_ledger_mutation_log
    (source_table, operation, db_role, application, reason, old_row, new_row)
  VALUES
    ('agent_commissions', 'UPDATE', current_user,
     COALESCE(current_setting('application_name', true), 'migration'),
     'phase 7: ' || v_rows || ' rows for ' || v_agents || ' agents carried '
     || 'settled_at 2026-08-20 17:18:22.456863+00 - one instant, no chip '
     || 'movement in chip_transactions, no audit_trail row. Nobody was paid. '
     || 'The stamp is removed and ' || trim(to_char(v_chips, 'FM999,999,999,990.00'))
     || ' chips are claimable again through fn_agent_claim_commission, which '
     || 'pays from the club bank. Dan, 2026-09-01: "PAY IT OUT FROM THE OWNER '
     || 'ACCOUNT FROM THE CLUB BANK".',
     jsonb_build_object('rows', v_rows, 'chips', v_chips, 'agents', v_agents,
                        'settled_at', '2026-08-20T17:18:22.456863+00:00'),
     jsonb_build_object('settled_at', NULL));

  RAISE NOTICE 'phase 7: reversed % phantom-settled rows, % chips, % agents', v_rows, v_chips, v_agents;
END;
$reverse$;

-- ───────────────────────────────────────────────────────────────────────────
-- 8. THE THREE DEAD OBJECTS
-- ───────────────────────────────────────────────────────────────────────────
--
-- Dan, 2026-09-01, asked for all three dropped once every screen reads the
-- ledger: "Drop all three".
--
-- ORDER MATTERS ACROSS REPOSITORIES. The World Hub stops reading
-- commission_history and stops writing both tables in
-- Smarter-Poker-World-Hub#<pr>, which is merged and serving before this
-- migration is applied. Club Arena's readers are repointed in the same commit
-- as this file.
--
-- Nothing else in the database depends on them: no view, no foreign key into
-- them, and after section 3 no function mentions them. Both tables have never
-- held a single row.
ALTER TABLE public.agents DROP COLUMN IF EXISTS pending_commission;

DROP TABLE IF EXISTS public.commission_records;
DROP TABLE IF EXISTS public.commission_history;

-- ───────────────────────────────────────────────────────────────────────────
-- SELF-ASSERTIONS. This migration refuses to commit a state it did not mean.
-- ───────────────────────────────────────────────────────────────────────────
DO $verify$
DECLARE
  v_def       text;
  v_names     text;
  v_summary   jsonb;
  v_stamped   bigint;
BEGIN
  -- The three dead objects are gone.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'agents'
                AND column_name = 'pending_commission') THEN
    RAISE EXCEPTION 'agents.pending_commission survived this migration';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'public'
                AND table_name IN ('commission_records','commission_history')) THEN
    RAISE EXCEPTION 'an empty commission table survived this migration';
  END IF;

  -- And nothing in the schema still reaches for them. A dropped column that a
  -- function still names is a runtime error waiting for the first caller.
  SELECT string_agg(p.proname, ', ') INTO v_names
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosrc ~ '(pending_commission|commission_records|commission_history)';
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION 'these functions still reference a dropped object: %', v_names;
  END IF;

  -- The four retired functions are gone.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public'
                AND p.proname IN ('get_agent_commission_history','generate_period_settlement',
                                  'atomic_pay_agent_settlement','increment_agent_rake')) THEN
    RAISE EXCEPTION 'a retired commission function survived this migration';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'guard_wallet_balance_write';
  IF v_def LIKE '%''atomic_pay_agent_settlement''%' THEN
    RAISE EXCEPTION 'the wallet guard still allows a function that no longer exists';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_union_money_path_check';
  IF v_def LIKE '%''atomic_pay_agent_settlement''%' THEN
    RAISE EXCEPTION 'the union money-path guard still requires a function that no longer exists';
  END IF;

  -- The summary is no longer a stub, and answers in chips rather than whole
  -- numbers.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_get_agent_commission_summary';
  IF v_def IS NULL OR v_def NOT LIKE '%agent_commissions%' THEN
    RAISE EXCEPTION 'the commission summary does not read the ledger';
  END IF;
  IF v_def LIKE '%STUB%' OR v_def LIKE '%Return zeros%' THEN
    RAISE EXCEPTION 'the commission summary is still a stub';
  END IF;
  IF v_def LIKE '%bigint%' THEN
    RAISE EXCEPTION 'the commission summary still answers in bigint, which cannot carry a chip';
  END IF;

  -- The role change reads the ledger and does it on every path.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_club_set_member_role';
  IF v_def NOT LIKE '%fn_agent_unsettled_commission(p_club_id, p_user_id)%' THEN
    RAISE EXCEPTION 'the role change does not read commission from the ledger';
  END IF;

  -- The GDPR precheck blocks on unclaimed commission.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_gdpr_financial_precheck';
  IF v_def NOT LIKE '%unclaimed commission%' THEN
    RAISE EXCEPTION 'an account with unclaimed commission can still be cleared for deletion';
  END IF;

  -- The phantom stamp is gone, and no chips moved to make that true.
  SELECT count(*) INTO v_stamped
    FROM public.agent_commissions
   WHERE settled_at = TIMESTAMPTZ '2026-08-20 17:18:22.456863+00';
  IF v_stamped <> 0 THEN
    RAISE EXCEPTION 'the phantom settlement is still stamped on % rows', v_stamped;
  END IF;

  -- Every commission row in this database is now unsettled, because nobody has
  -- ever actually been paid one. If that stops being true it is because a real
  -- claim landed, and this assertion is the thing that would notice.
  IF EXISTS (SELECT 1 FROM public.agent_commissions WHERE settled_at IS NOT NULL) THEN
    RAISE NOTICE 'phase 7: settled commission rows exist - a real claim has landed since this was written';
  END IF;
END;
$verify$;

-- ───────────────────────────────────────────────────────────────────────────
-- ROLLBACK (tier 3: this migration drops a column and two tables)
-- ───────────────────────────────────────────────────────────────────────────
--
-- The two tables held zero rows on the day they were dropped, so recreating
-- them loses nothing; the column held 26,859.87 across 5 agents, which was
-- wrong when it was written and has no writer to make it right again. The
-- figures are recorded here rather than restored, because restoring a number
-- nothing maintains is what this migration exists to end.
--
--   ALTER TABLE public.agents ADD COLUMN pending_commission numeric DEFAULT 0;
--
--   CREATE TABLE public.commission_records (
--     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
--     period_id uuid, agent_id uuid, gross_rake numeric, commission_rate numeric,
--     commission_amount numeric, status text, paid_at timestamptz,
--     created_at timestamptz DEFAULT now());
--
--   CREATE TABLE public.commission_history (
--     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
--     club_id uuid, agent_id uuid, period_id uuid,
--     period_start timestamptz, period_end timestamptz,
--     player_rake_generated numeric, commission_rate numeric,
--     commission_earned numeric, sub_agent_commission numeric,
--     net_commission numeric, status text, paid_at timestamptz,
--     created_at timestamptz DEFAULT now());
--
--   -- and to re-stamp the phantom settlement, which would take 256,765.50
--   -- chips of claim away from 75 agents for a second time:
--   -- UPDATE public.agent_commissions SET settled_at = '2026-08-20 17:18:22.456863+00'
--   --  WHERE settled_at IS NULL AND created_at < '2026-08-20 17:18:22.456863+00';
--   -- The predicate is NOT exact - the original stamp did not record what it
--   -- covered - so this would sweep in rows the phantom never touched. If it is
--   -- ever needed, reconstruct the set from this migration's audit_trail row
--   -- and a point-in-time copy, not from that WHERE clause.
--
-- The dropped functions are recoverable from git: their last definitions are in
-- the migrations that created them, and every one of them is quoted in the
-- comments above.
