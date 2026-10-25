-- 20261024220301_cashout_decision_tells_the_assigned_agent.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, 2026-10-24: "WHO EVER APPROVES THE CASH OUT, THOSE CHIPS ARE CREDITED
-- TO THAT PERSONS AGENT WALLET", then "FULLY BUILD, FIX AND ENHANCE ALL OF
-- THESE" on the follow-ups, one of which was: tell the assigned agent.
--
-- A cash-out request is sent to the player's agent (the HOLD audience is
-- {player, assigned agent}, 20261023161137). Since the same day any owner,
-- co-owner or admin may accept or cancel it, and the chips go to whoever
-- accepts. Read on production: CA-2026-00012497, Golddigger's 20.00 was
-- assigned to DarthBayter, KingFish accepted it, and the decision's audience
-- was {club owner, player, actor} = {KingFish, Golddigger}. DarthBayter, whose
-- player it was and who had been asked to decide, was never told that it had
-- been decided, by whom, or that the chips were not coming to him.
--
-- The line that produced it is the decision audience in
-- fn_cashier_cashout_transition. For an approval or a decline the audience now
-- also carries the assigned agent. array_agg(DISTINCT) already folds him away
-- when he is the actor or the owner, so nobody gets two copies. He is added
-- only when he still has a profile: the audience guard raises
-- cashier_document_audience_unavailable on a missing profile, and a removed
-- agent must never be the reason a payout cannot be accepted.
--
-- The bell copy is unchanged. fn_cashier_notice_copy already gives a
-- recipient who is neither the player nor the actor the third-party line
-- ("Golddigger's Payout Of 20.00 Chips Was Accepted. Invoice ..."), and
-- fn_cashier_assert_delivery recomputes that copy for every delivery, past
-- ones included, so the copy function is deliberately not touched.
-- Cancellation (the player's own) and expiry keep their audience.
--
-- Delivery stays consistent by construction: fn_cashier_assert_delivery
-- checks deliveries against audience_user_ids, and both come from this array;
-- messenger visibility (fn_messenger_invoice_visible_to) reads the same array.
--
-- No table is locked. One function is replaced in one transaction.
--
-- @live-proof: (SELECT position('THEN ARRAY[assigned] ELSE ARRAY[]::uuid[] END) x;' IN pg_get_functiondef('public.fn_cashier_cashout_transition(text,uuid,uuid,numeric,uuid,uuid,text)'::regprocedure)) > 0)

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $migration$
DECLARE
  v_def text;
  v_old constant text :=
    E'unnest(CASE WHEN kind=''hold'' THEN ARRAY[r.player_id] ELSE ARRAY[club.owner_id,r.player_id] END||ARRAY[\n   CASE WHEN kind IN(''approval'',''decline'') THEN actor ELSE assigned END]) x;';
  v_new constant text :=
    E'unnest(CASE WHEN kind=''hold'' THEN ARRAY[r.player_id] ELSE ARRAY[club.owner_id,r.player_id] END||ARRAY[\n   CASE WHEN kind IN(''approval'',''decline'') THEN actor ELSE assigned END]\n   ||CASE WHEN kind IN(''approval'',''decline'') AND assigned IS NOT NULL\n        AND EXISTS(SELECT 1 FROM public.profiles ap WHERE ap.id=assigned)\n      THEN ARRAY[assigned] ELSE ARRAY[]::uuid[] END) x;';
BEGIN
  SELECT pg_get_functiondef(
           'public.fn_cashier_cashout_transition(text,uuid,uuid,numeric,uuid,uuid,text)'::regprocedure)
    INTO v_def;

  IF position(v_new IN v_def) > 0 THEN
    RAISE NOTICE 'decision audience already carries the assigned agent; nothing to do';
    RETURN;
  END IF;

  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'fn_cashier_cashout_transition decision audience line not found - refusing to guess';
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'fn_cashier_cashout_transition audience line is not unique - refusing to guess';
  END IF;

  EXECUTE replace(v_def, v_old, v_new);

  SELECT pg_get_functiondef(
           'public.fn_cashier_cashout_transition(text,uuid,uuid,numeric,uuid,uuid,text)'::regprocedure)
    INTO v_def;
  IF position(v_new IN v_def) = 0 OR position(v_old IN v_def) > 0 THEN
    RAISE EXCEPTION 'decision audience was not rewritten';
  END IF;
  -- The wrappers that reach it are untouched and still definer-only.
  IF has_function_privilege('anon',
       'public.fn_cashier_cashout_transition(text,uuid,uuid,numeric,uuid,uuid,text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_cashier_cashout_transition became reachable by anon';
  END IF;
END
$migration$;

COMMIT;
