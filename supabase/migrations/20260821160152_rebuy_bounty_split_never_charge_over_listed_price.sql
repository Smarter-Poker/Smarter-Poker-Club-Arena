-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821160152 "rebuy_bounty_split_never_charge_over_listed_price"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 840a32770c55e25854c3690d3961db63 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
--  A REBUY IN A BOUNTY EVENT SPLITS LIKE AN ENTRY (Dan, 2026-08-21)
-- ═══════════════════════════════════════════════════════════════════════════
--  "If it's a bounty tournament, say 20 buy-in, 10 bounty: players buy in OR
--   REBUY for 20, 10 to the bounty pool, 8 to the prize pool, 2 for rake."
--
--  Registration already did exactly that (fn_tournament_entry_split returns
--  charge 20 / rake 2 / bounty 10 / prize 8). process_tournament_rebuy did
--  not: it never read a bounty column at all, so a rebuy in a bounty event
--  put the WHOLE post-fee amount into the prize pool and nothing on the
--  player's head. The 10 that should have become a bounty was paid out twice
--  over the life of the event - once as prize money it was never meant to
--  fund, and never as the head it was collected for.
--
--  Also confirms the ceiling rule: v_total is the listed price and is the
--  only thing charged. Rake and bounty are both cut OUT of it.
--
--  TIER 3. Patched in place from pg_get_functiondef so the seat-atomicity
--  guard and the exact-grant assertion are carried across verbatim.
--  ROLLBACK at the bottom.

DO $mig$
DECLARE
  v_def text;
  v_new text;
  v_old text;
  v_rep text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'process_tournament_rebuy';
  IF v_def IS NULL THEN RAISE EXCEPTION 'process_tournament_rebuy not found'; END IF;
  v_new := v_def;

  -- 1. Two more locals.
  v_old := '  v_t record; v_p record; v_balance numeric; v_ratio numeric;';
  v_rep := '  v_t record; v_p record; v_balance numeric; v_ratio numeric;
  v_is_bounty boolean; v_bounty_head numeric;';
  IF position(v_old in v_new) = 0 THEN RAISE EXCEPTION 'declare block not found'; END IF;
  v_new := replace(v_new, v_old, v_rep);

  -- 2. The tournament row has to carry the bounty configuration.
  v_old := 'max_reentries, addon_cost, addon_chips, addon_levels, current_level, prize_pool';
  v_rep := 'max_reentries, addon_cost, addon_chips, addon_levels, current_level, prize_pool,
         is_bounty, is_pko, is_mystery_bounty, bounty_amount';
  IF position(v_old in v_new) = 0 THEN RAISE EXCEPTION 'tournament select list not found'; END IF;
  v_new := replace(v_new, v_old, v_rep);

  -- 3. Cut the bounty out of the price, after the rake, before the prize pool.
  v_old := 'v_total := round(v_base::numeric); v_fee := CASE WHEN v_ratio > 0 AND v_total > 0 THEN LEAST(v_total, GREATEST(1, round(v_total * v_ratio))) ELSE 0 END; v_base := v_total - v_fee;';
  v_rep := 'v_total := round(v_base::numeric); v_fee := CASE WHEN v_ratio > 0 AND v_total > 0 THEN LEAST(v_total, GREATEST(1, round(v_total * v_ratio))) ELSE 0 END; v_base := v_total - v_fee;
  -- Dan 2026-08-21: a rebuy in a bounty event splits exactly like an entry.
  -- The listed price is the ceiling; rake comes out first, then the bounty,
  -- and only what is left reaches the prize pool. Add-ons are excluded: they
  -- buy chips, not an entry, so they put no new head in play.
  -- LEAST() against v_base is the guard that keeps the prize share from going
  -- negative on a misconfigured event where bounty + rake exceeds the price.
  v_is_bounty := COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
                 OR COALESCE(v_t.is_mystery_bounty,false);
  IF v_is_bounty AND p_rebuy_type <> ''addon'' THEN
    v_bounty_head := LEAST(GREATEST(0, round(COALESCE(v_t.bounty_amount,0))), v_base);
    v_base := v_base - v_bounty_head;
  ELSE
    v_bounty_head := 0;
  END IF;';
  IF position(v_old in v_new) = 0 THEN RAISE EXCEPTION 'pricing line not found'; END IF;
  v_new := replace(v_new, v_old, v_rep);

  -- 4. Put the bounty on the player''s head.
  v_old := '  -- DETERMINISTIC SEAT 2026-08-20: pick the player''s CURRENT seat, not an';
  v_rep := '  -- The head this purchase paid for. A re-entry is a fresh entry so it gets
  -- a fresh head; a rebuy adds another one on top of the head already in play.
  -- Mystery events roll their multiplier at REGISTRATION only - a rebuy adds
  -- the configured face value, so a player cannot re-roll for a 13x head.
  IF v_bounty_head > 0 THEN
    UPDATE tournament_players
       SET current_bounty = CASE WHEN p_rebuy_type = ''reentry'' THEN v_bounty_head
                                 ELSE COALESCE(current_bounty, 0) + v_bounty_head END
     WHERE tournament_id = p_tournament_id AND user_id = p_user_id;
  END IF;

  -- DETERMINISTIC SEAT 2026-08-20: pick the player''s CURRENT seat, not an';
  IF position(v_old in v_new) = 0 THEN RAISE EXCEPTION 'seat comment anchor not found'; END IF;
  v_new := replace(v_new, v_old, v_rep);

  EXECUTE v_new;
END
$mig$;

DO $post$
DECLARE d text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO d FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='process_tournament_rebuy';
  IF position('v_base := v_base - v_bounty_head;' in d) = 0 THEN
    RAISE EXCEPTION 'the bounty is still not cut out of a rebuy';
  END IF;
  IF position('SET current_bounty = CASE WHEN p_rebuy_type' in d) = 0 THEN
    RAISE EXCEPTION 'the rebuy does not credit a head';
  END IF;
  IF position('v_base := v_total - v_fee;' in d) = 0 THEN
    RAISE EXCEPTION 'the rake is no longer cut out of the price';
  END IF;
  -- Everything that was protecting money must survive the patch.
  IF position('refusing to charge for chips that would be overwritten' in d) = 0
     OR position('Chip grant did not land' in d) = 0
     OR position('caller may only transact for themselves' in d) = 0 THEN
    RAISE EXCEPTION 'a safety guard was lost in the patch';
  END IF;
END
$post$;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK: re-run the DO block with each v_old/v_rep pair swapped. The four
-- edits are independent and each is anchored on text that appears once.
-- ═══════════════════════════════════════════════════════════════════════════
