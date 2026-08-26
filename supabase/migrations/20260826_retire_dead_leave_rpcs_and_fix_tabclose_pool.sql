-- 20260826_retire_dead_leave_rpcs_and_fix_tabclose_pool.sql
--
-- TIER 3. Touches a money path. Read the whole header before changing it.
--
-- =====================================================================
-- PART A -- player_leave_table() credits a pool nothing reads
-- =====================================================================
--
-- player_leave_table(p_table_id, p_user_id) is the tab-close auto-cashout. It is
-- live: TablePage.tsx:5181 fires it through navigator.sendBeacon on unload.
--
-- It refunds the stack like this:
--
--     INSERT INTO wallets (user_id, wallet_type, balance) VALUES (..., v_stack)
--       ON CONFLICT ... DO UPDATE SET balance = wallets.balance + v_stack
--
-- public.wallets is NOT the live chip pool. Every other money path on the
-- platform settles into club_members.chip_balance through fn_add_chips():
-- atomic_table_buyin, fn_leave_seat_and_refund, the engine cash-out, all of it.
--
-- Evidence that wallets is dead:
--     wallets last updated_at .......... 2026-08-21 00:59:34Z  (5 days stale)
--     rows updated in last 24h ......... 0        (against 6,511 seat exits)
--     stranded balance ................. 732,591,994.33
--     live pool (club_members) ......... 121,205,561.53
--
-- So a tab-close refund would credit a ledger no cashier reads while
-- simultaneously closing the table_seats row -- the stack leaves the felt and
-- lands nowhere reachable. This is precisely the failure CLAUDE.md section 11.5
-- was written about.
--
-- WHY THIS HAS NOT BILLED ANYONE YET
--     wallet_transactions rows matching 'Tab-close%' .... 0  (all time)
-- The function has never once completed. It is a landmine, not an active leak.
-- That is also why this change is safe to make: there is no in-flight behaviour
-- to preserve.
--
-- WHAT CHANGES
--   - destination pool: wallets  ->  fn_add_chips() into club_members.chip_balance
--   - audit row: direct INSERT   ->  log_wallet_transaction() (the shared helper)
--   - unresolvable club now RAISES instead of silently crediting the void
--
-- WHAT DELIBERATELY DOES NOT CHANGE
--   - the security context stays INVOKER. Promoting this to SECURITY DEFINER
--     would very likely be what makes it start firing, and turning on an
--     untested money path is a separate decision that needs its own evidence.
--     This migration makes the payout correct IF it fires. It does not make it
--     fire.
--
-- PER CLAUDE.md 11.5 RULE 5: this path was reasoned about and asserted below,
-- NOT executed against production. No probe was run. No chips were moved.
--
-- ROLLBACK: git show HEAD~1 of this file's directory, or restore the prior body
-- from migration 20260317_create_player_leave_table_rpc.sql.
--
-- =====================================================================
-- PART B -- two fn_leave_table stubs that answer 'not_implemented'
-- =====================================================================
--
-- fn_leave_table(uuid) and fn_leave_table(uuid, uuid) both return
--     {"success": false, "error": "not_implemented", "note": "Old engine; ..."}
-- Zero call sites in either repo (only an entry in the generated
-- src/types/supabase.ts). They exist solely to be picked by an agent grepping
-- for "leave table" and to widen the RPC surface. Dropped.

-- (No explicit BEGIN/COMMIT: the migration runner already wraps this file in a
-- single transaction. An inner COMMIT would end it early and let PART B land
-- without PART A.)

-- ---------- PART A ----------
CREATE OR REPLACE FUNCTION public.player_leave_table(p_table_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_seat_number   integer;
  v_stack         numeric;
  v_tournament_id uuid;
  v_club_id       uuid;
BEGIN
  SELECT seat_number, stack
    INTO v_seat_number, v_stack
    FROM table_seats
   WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT tournament_id, club_id
    INTO v_tournament_id, v_club_id
    FROM tables
   WHERE id = p_table_id;

  -- Cash tables only. A tournament seat is settled by the tournament engine.
  IF v_tournament_id IS NULL AND v_stack > 0 THEN
    IF v_club_id IS NULL THEN
      v_club_id := public.fn_player_home_club(p_user_id, NULL);
    END IF;

    -- Never close the seat if we cannot say where the chips go. Raising leaves
    -- the seat open and the stack intact; the engine's startup sweep will cash
    -- the player out correctly on the next pass.
    IF v_club_id IS NULL THEN
      RAISE EXCEPTION
        'player_leave_table: refusing to close seat for user % on table % -- no club wallet resolved for a % chip stack',
        p_user_id, p_table_id, v_stack;
    END IF;

    -- Live pool. NOT public.wallets -- see PART A of this migration's header.
    PERFORM public.fn_add_chips(p_user_id, v_club_id, v_stack);

    PERFORM public.log_wallet_transaction(
      p_user_id,            -- p_user_id
      'PLAYER',             -- p_wallet_type
      v_stack,              -- p_amount
      'credit',             -- p_type
      'cashout',            -- p_category
      'Tab-close auto-cashout',
      p_table_id,           -- p_table_id
      NULL,                 -- p_hand_id
      NULL                  -- p_related_entity_id
    );
  END IF;

  UPDATE table_seats
     SET left_at = NOW(), leave_pending = false
   WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;

  UPDATE tables
     SET current_players = (
           SELECT COUNT(*) FROM table_seats
            WHERE table_id = p_table_id AND left_at IS NULL)
   WHERE id = p_table_id;
END;
$function$;

-- ---------- PART B ----------
DROP FUNCTION IF EXISTS public.fn_leave_table(uuid);
DROP FUNCTION IF EXISTS public.fn_leave_table(uuid, uuid);

-- ---------- assertions ----------
DO $$
DECLARE
  v_body   text;
  v_stubs  int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'player_leave_table';

  IF v_body IS NULL THEN
    RAISE EXCEPTION 'assertion failed: player_leave_table disappeared';
  END IF;

  -- must no longer write the dead pool
  IF v_body ~* 'INSERT\s+INTO\s+wallets' THEN
    RAISE EXCEPTION 'assertion failed: player_leave_table still writes public.wallets';
  END IF;

  -- must settle into the live pool
  IF v_body !~* 'fn_add_chips' THEN
    RAISE EXCEPTION 'assertion failed: player_leave_table does not credit club_members via fn_add_chips';
  END IF;

  SELECT count(*) INTO v_stubs
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_leave_table';

  IF v_stubs <> 0 THEN
    RAISE EXCEPTION 'assertion failed: % fn_leave_table stub(s) survived the drop', v_stubs;
  END IF;

  RAISE NOTICE 'player_leave_table now settles to club_members.chip_balance; % fn_leave_table stubs remain', v_stubs;
END $$;
