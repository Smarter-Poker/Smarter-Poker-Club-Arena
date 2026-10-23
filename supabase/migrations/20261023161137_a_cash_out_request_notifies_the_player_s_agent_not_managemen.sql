-- 20261023161137_a_cash_out_request_notifies_the_player_s_agent_not_managemen.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan 2026-10-23: "OWNERS, CO OWNERS OR ADMINS SHOULD BE ABLE TO SEE ALL CASH
-- OUT REQUESTS AND PULL THOSE CHIPS. THEY SHOULDN'T GET THE NOTIFICATION, BUT
-- IF THEY GO TO A PLAYERS ACCOUNT, THEY SHOULD BE ABLE TO SEE 'CASH OUT
-- REQUESTED'."
--
-- Seeing and pulling already exist on the server: fn_cashout_queue returns
-- every request in a club to its owner, co-owners and admins
-- (fn_club_bank_role in owner/co_owner/admin), and fn_cashier_cashout_transition
-- lets them approve any of them (fn_club_cashier_scope = 'all'), which moves
-- the verified escrow into the approver's agent wallet. The client surfaces for
-- both ship with this change (cashier queue button, roster flag, member record).
--
-- The notification is the defect. fn_cashier_cashout_transition builds every
-- cashier document's audience as {club owner, player, assigned agent}, and
-- fn_deliver_accounting_invoice sends a messenger invoice AND a bell/push
-- notification ("Chips Held") to every member of that audience. So the club
-- owner was notified of every single cash out request in the club, whoever the
-- player's agent was.
--
-- The line that produced it is the audience line. For a HOLD (the request) the
-- audience is now {player, assigned agent}: the player gets their receipt and
-- the agent gets the request message, exactly the standing rule ("agents get a
-- message when a player requests a cashout"). When the owner IS the assigned
-- cashier (a player with no agent is assigned to the owner) the owner is in the
-- audience as that agent and is still told. Approval, decline, cancellation
-- and expiry keep their audience unchanged: the player still gets the
-- "Cashout Approved" message.
--
-- Delivery stays consistent by construction: fn_cashier_assert_delivery checks
-- deliveries against audience_user_ids, and both come from this one array.
-- Messenger visibility (fn_messenger_invoice_visible_to) reads the same array.
--
-- No table is locked. One function is replaced in one transaction.
--
-- @live-proof: (SELECT position('THEN ARRAY[r.player_id] ELSE ARRAY[club.owner_id,r.player_id] END' IN pg_get_functiondef('public.fn_cashier_cashout_transition(text,uuid,uuid,numeric,uuid,uuid,text)'::regprocedure)) > 0)

BEGIN;

DO $migration$
DECLARE
  v_def text;
  v_old constant text :=
    E'unnest(ARRAY[club.owner_id,r.player_id,\n   CASE WHEN kind IN(''approval'',''decline'') THEN actor ELSE assigned END]) x;';
  v_new constant text :=
    E'unnest(CASE WHEN kind=''hold'' THEN ARRAY[r.player_id] ELSE ARRAY[club.owner_id,r.player_id] END||ARRAY[\n   CASE WHEN kind IN(''approval'',''decline'') THEN actor ELSE assigned END]) x;';
BEGIN
  SELECT pg_get_functiondef(
           'public.fn_cashier_cashout_transition(text,uuid,uuid,numeric,uuid,uuid,text)'::regprocedure)
    INTO v_def;

  IF position(v_new IN v_def) > 0 THEN
    RAISE NOTICE 'hold audience already excludes management; nothing to do';
    RETURN;
  END IF;

  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'fn_cashier_cashout_transition audience line not found - refusing to guess';
  END IF;

  EXECUTE replace(v_def, v_old, v_new);

  SELECT pg_get_functiondef(
           'public.fn_cashier_cashout_transition(text,uuid,uuid,numeric,uuid,uuid,text)'::regprocedure)
    INTO v_def;
  IF position(v_new IN v_def) = 0 OR position(v_old IN v_def) > 0 THEN
    RAISE EXCEPTION 'hold audience was not rewritten';
  END IF;
END
$migration$;

COMMIT;
