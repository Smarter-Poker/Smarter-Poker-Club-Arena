-- 20260906153943_the_suspended_heads_up_is_settled_by_a_chip_proportional_dea.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (CLAUDE.md 10.9, an agent settling real chips):
--
-- PLO4 Heads-Up 25 (3e281f5c, JAQK, buy-in 23.75 + 1.25, pool 71.25) took
-- THREE entrants into a heads-up format on 2026-09-03 and dealt 37 hands. At
-- 14:20 UTC f44d72f2 busted (recorded as position 2, which for three
-- entrants is wrong - the first bust of three is third). The engine then
-- flipped the event to COMPLETING with TWO players still holding chips -
-- 2e26ae7c with 2,000 and 00000000-...-0028 with 1,000 of the 3,000 in play
-- - and no hand has been dealt since. Nothing was ever paid: chip_ledger
-- holds the three entries and no prize, no rake. It sat three days.
--
-- The platform's own recovery refuses it BY DESIGN: "has 2 player(s) still
-- playing against 1 paid place(s) - that is a tournament that was still being
-- PLAYED when its engine died, not one that was finishing. Refusing to rank
-- it by chipstack and pay the structure; left in COMPLETING for a live engine
-- to resume or an operator to settle." It was flipped back to RUNNING at
-- 15:25 UTC today so a live engine could resume it; twenty minutes later no
-- manager had adopted it, and the boot-time stale sweep (twelve hours old, no
-- hand in the last hour) would return it to COMPLETING at the next cutover
-- regardless. So: the operator settles.
--
-- A suspended two-handed match is settled by a chip-proportional deal. For
-- two players that IS the ICM figure, and it is the deal fn_final_table_deal
-- would compute; that function cannot be used here because the event's
-- final_table_deal_enabled flag is locked by the management contract and
-- the engine, not SQL, settles its rows. The same numbers, through the door
-- Phase 6.1 built for an agent under 10.9: an approved ca_manual_adjustments
-- row per player naming this migration, settled through
-- fn_settle_tournament_obligation under kind final_table_deal, recorded in
-- tournament_payouts as source final_table_deal so the reconciler treats the
-- event as chopped and never pays the structure on top.
--
--   2e26ae7c-0d4a-42da-b8ee-90a498eb25dd   2,000 / 3,000 x 71.25 = 47.50   place 1
--   00000000-0000-0000-0000-000000000028   1,000 / 3,000 x 71.25 = 23.75   place 2
--   f44d72f2-a596-4938-af60-2e36b18de73f   busted first of three            place 3, 0
--
-- Both survivors are horses (10.5: paid exactly as a person would be). The
-- rake (3.75 collected) is settled through fn_settle_tournament_rake, and
-- the event is closed COMPLETING -> COMPLETED with the engine's own guarded
-- statement. Probed rolled back first on 2026-09-06 (psql, BEGIN ... ROLLBACK);
-- the numbers below are the numbers the probe returned, asserted so this
-- aborts if the board moved.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

DO $$
DECLARE
  c_tid   constant uuid := '3e281f5c-2479-42dc-bf6e-afb007d9988f';
  c_lead  constant uuid := '2e26ae7c-0d4a-42da-b8ee-90a498eb25dd';
  c_short constant uuid := '00000000-0000-0000-0000-000000000028';
  c_out   constant uuid := 'f44d72f2-a596-4938-af60-2e36b18de73f';
  c_mig   constant text := '20260906153943_the_suspended_heads_up_is_settled_by_a_chip_proportional_dea';
  v_t     record;
  v_lead_chips  integer;
  v_short_chips integer;
  v_paid  numeric;
  v_adj_lead  uuid;
  v_adj_short uuid;
  v_res   jsonb;
  v_rake  jsonb;
  v_reason_lead  text;
  v_reason_short text;
BEGIN
  -- THE BOARD, AS READ. Abort if anything moved since it was read.
  SELECT * INTO v_t FROM public.tournaments WHERE id = c_tid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'VERIFY: 3e281f5c is gone'; END IF;
  IF v_t.status NOT IN ('RUNNING', 'COMPLETING') THEN
    RAISE EXCEPTION 'VERIFY: 3e281f5c is % now, not RUNNING/COMPLETING - somebody settled it', v_t.status;
  END IF;
  IF v_t.prize_pool <> 71.25 THEN RAISE EXCEPTION 'VERIFY: pool is % not 71.25', v_t.prize_pool; END IF;
  SELECT chips INTO v_lead_chips  FROM public.tournament_players WHERE tournament_id = c_tid AND user_id = c_lead  AND status = 'playing';
  SELECT chips INTO v_short_chips FROM public.tournament_players WHERE tournament_id = c_tid AND user_id = c_short AND status = 'playing';
  IF v_lead_chips IS DISTINCT FROM 2000 OR v_short_chips IS DISTINCT FROM 1000 THEN
    RAISE EXCEPTION 'VERIFY: chips read 2000/1000, found %/%', v_lead_chips, v_short_chips;
  END IF;
  SELECT COALESCE(sum(amount), 0) INTO v_paid FROM public.chip_ledger
   WHERE tournament_id = c_tid AND category IN ('tournament_prize', 'prize', 'spin_prize');
  IF v_paid <> 0 THEN RAISE EXCEPTION 'VERIFY: % already paid on 3e281f5c', v_paid; END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_payouts WHERE tournament_id = c_tid) THEN
    RAISE EXCEPTION 'VERIFY: a payout record already exists for 3e281f5c';
  END IF;

  v_reason_lead :=
    'PLO4 Heads-Up 25 (3e281f5c, JAQK) took three entrants into a heads-up format on 2026-09-03, dealt 37 hands, '
    || 'busted f44d72f2 at 14:20 UTC and was flipped to COMPLETING with two players still holding chips: 2e26ae7c with 2,000 '
    || 'and 00000000-...-0028 with 1,000 of 3,000. No hand since, nothing paid, three days. The platform recovery refuses it '
    || 'for an operator by design; a revive to RUNNING at 15:25 UTC on 2026-09-06 was not adopted. Settled by a chip-proportional '
    || 'deal, which for two players is the ICM figure and what fn_final_table_deal would compute: 2e26ae7c 47.50 (place 1), '
    || '00000000-...-0028 23.75 (place 2), f44d72f2 corrected to place 3 with 0. Read from the rows, paid once through '
    || 'fn_settle_tournament_obligation under kind final_table_deal, recorded as a final_table_deal payout so the reconciler never '
    || 'pays the structure on top, nothing taken back, probed rolled back first: migration ' || c_mig || '.';
  v_reason_short := replace(v_reason_lead, 'Settled by a chip-proportional', 'This row is the 23.75 to 00000000-...-0028. Settled by a chip-proportional');

  -- Positions the truth: first bust of three is third. The collision watch
  -- refuses two rows at 2, so the busted player moves first.
  UPDATE public.tournament_players SET position = 3 WHERE tournament_id = c_tid AND user_id = c_out;

  -- THE APPROVED ADJUSTMENTS (Phase 6.1), one per player, naming this migration.
  v_adj_lead  := public.fn_ca_adjustment_under_10_9(c_tid, c_lead,  47.50, v_reason_lead,  c_mig, 'table stakes (Claude, cowork)');
  v_adj_short := public.fn_ca_adjustment_under_10_9(c_tid, c_short, 23.75, v_reason_short, c_mig, 'table stakes (Claude, cowork)');

  -- THE RECORD OF THE DEAL, so fn_tournament_payout_reconcile and the
  -- recovery both see a chopped event and pay no structure prize on top.
  INSERT INTO public.tournament_payouts (tournament_id, user_id, position, amount, source, recorded_by, metadata)
  VALUES (c_tid, c_lead,  1, 47.50, 'final_table_deal', 'operator.cowork-claude', jsonb_build_object('migration', c_mig, 'chips', 2000, 'of', 3000)),
         (c_tid, c_short, 2, 23.75, 'final_table_deal', 'operator.cowork-claude', jsonb_build_object('migration', c_mig, 'chips', 1000, 'of', 3000));

  -- THE CHIPS, through the platform's idempotent path.
  v_res := public.fn_settle_tournament_obligation(c_tid, 'final_table_deal', 1, c_lead, 47.50, 'operator.cowork-claude',
             'Chip-proportional deal, suspended heads-up (2,000 of 3,000)', v_adj_lead);
  IF COALESCE((v_res->>'ok')::boolean, false) IS NOT TRUE OR (v_res->>'paid')::numeric <> 47.50 THEN
    RAISE EXCEPTION 'VERIFY: place 1 settle returned %', v_res;
  END IF;
  v_res := public.fn_settle_tournament_obligation(c_tid, 'final_table_deal', 2, c_short, 23.75, 'operator.cowork-claude',
             'Chip-proportional deal, suspended heads-up (1,000 of 3,000)', v_adj_short);
  IF COALESCE((v_res->>'ok')::boolean, false) IS NOT TRUE OR (v_res->>'paid')::numeric <> 23.75 THEN
    RAISE EXCEPTION 'VERIFY: place 2 settle returned %', v_res;
  END IF;
  UPDATE public.ca_manual_adjustments SET status = 'settled' WHERE id IN (v_adj_lead, v_adj_short);

  -- THE ROSTER: places and prizes as settled; both survivors finished.
  UPDATE public.tournament_players SET position = 1, prize = 47.50, status = 'winner'
   WHERE tournament_id = c_tid AND user_id = c_lead;
  UPDATE public.tournament_players SET position = 2, prize = 23.75, status = 'eliminated', eliminated_at = COALESCE(eliminated_at, now())
   WHERE tournament_id = c_tid AND user_id = c_short;

  -- THE CLOSE, in the engine's order: COMPLETING first (the rake settle
  -- refuses a non-terminal event), the rake, then the guarded COMPLETED.
  UPDATE public.tournaments SET status = 'COMPLETING', updated_at = now() WHERE id = c_tid AND status = 'RUNNING';

  -- THE RAKE, the engine's own function.
  v_rake := public.fn_settle_tournament_rake(c_tid, 'operator.cowork-claude');
  IF COALESCE((v_rake->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'VERIFY: rake settle returned %', v_rake;
  END IF;

  UPDATE public.tournaments SET status = 'COMPLETED', ended_at = now(), on_break = false, break_ends_at = null
   WHERE id = c_tid AND status = 'COMPLETING';
  IF NOT EXISTS (SELECT 1 FROM public.tournaments WHERE id = c_tid AND status = 'COMPLETED') THEN
    RAISE EXCEPTION 'VERIFY: 3e281f5c did not reach COMPLETED';
  END IF;

  -- WHAT LEFT: exactly the pool, exactly once.
  SELECT COALESCE(sum(amount), 0) INTO v_paid FROM public.chip_ledger
   WHERE tournament_id = c_tid AND to_entity_id IN (c_lead, c_short) AND created_at > now() - interval '5 minutes';
  IF v_paid <> 71.25 THEN RAISE EXCEPTION 'VERIFY: % left the pool, expected 71.25', v_paid; END IF;

  INSERT INTO public.financial_alerts (severity, source, message, context, resolved_at, resolution)
  VALUES ('info', 'operator.cowork-claude',
          'PLO4 Heads-Up 25 (3e281f5c) settled by chip-proportional deal after three days suspended two-handed',
          jsonb_build_object('tournament_id', c_tid, 'migration', c_mig, 'paid', 71.25, 'adjustments', jsonb_build_array(v_adj_lead, v_adj_short)),
          now(), 'Accepted: a suspended heads-up is settled by chip proportion (ICM for two). 47.50 / 23.75 paid through fn_settle_tournament_obligation under approved 10.9 adjustments; rake settled; COMPLETED.');
END $$;

COMMIT;
