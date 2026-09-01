-- =============================================================================
-- deep_stack_unwind_for_clean_funding_redo
-- Applied to production via Supabase MCP 2026-09-01 13:57 UTC.
--
-- Dan, 2026-09-01: "REDO ALL THE CHIP TRANSACTIONS ... INSURE IT WAS DONE
-- EXACTLY THIS WAY ONLY." Step 1 of the redo: every Deep Stack horse player
-- wallet (416 x 10,000 = 4,160,000) and every agent wallet (3,340,000)
-- returns to the club bank, leaving the bank holding the full
-- pre-distribution pool (9,979,213). The clean redo then re-runs the
-- designed top-down flow through the canonical authenticated RPCs as the
-- correct actors: owner -> super agents (one bank send per branch), each
-- manager -> its downline from its own agent wallet (child managers funded
-- in ONE send covering their whole subtree), each manager -> its own seat
-- via fn_agent_wallet_self_stake. Runner: .agent/deep-stack-society/fund-v2.mjs
-- (448 idempotent transactions).
--
-- Retry note: the first attempt timed out inside fn_ca_chip_ledger_enrich's
-- prev_hash lookup -- chip_ledger has NO index on chain_seq (316k rows;
-- every ledger insert platform-wide pays a sequential scan). A unique index
-- on chain_seq is staged separately as 20260901150000 pending apply.
-- =============================================================================
SET LOCAL statement_timeout = '600s';

DO $$
DECLARE
  v_club uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  v_bank_before numeric; v_bank_after numeric;
  v_players numeric; v_agents numeric; v_batch int; v_open int;
BEGIN
  SELECT count(*) INTO v_open
    FROM table_seats ts JOIN tables t ON t.id=ts.table_id
   WHERE t.club_id=v_club AND ts.left_at IS NULL;
  IF v_open <> 0 THEN
    RAISE EXCEPTION 'refusing: % open seats', v_open;
  END IF;

  SELECT chip_treasury INTO v_bank_before FROM clubs WHERE id=v_club FOR UPDATE;
  SELECT coalesce(sum(chip_balance),0) INTO v_players
    FROM club_members WHERE club_id=v_club AND is_bot;
  SELECT coalesce(sum(agent_wallet_balance),0) INTO v_agents
    FROM agents WHERE club_id=v_club;

  IF v_players <> 4160000 OR v_agents <> 3340000 THEN
    RAISE EXCEPTION 'pre-state unexpected: players=% agents=%', v_players, v_agents;
  END IF;

  UPDATE agents SET agent_wallet_balance = 0
   WHERE club_id=v_club AND agent_wallet_balance <> 0;

  LOOP
    WITH pick AS (
      SELECT ctid FROM club_members
       WHERE club_id=v_club AND is_bot AND chip_balance <> 0 LIMIT 30)
    UPDATE club_members cm SET chip_balance = 0
      FROM pick WHERE cm.ctid = pick.ctid;
    GET DIAGNOSTICS v_batch = ROW_COUNT;
    EXIT WHEN v_batch = 0;
  END LOOP;

  UPDATE clubs SET chip_treasury = chip_treasury + v_players + v_agents
   WHERE id=v_club;
  SELECT chip_treasury INTO v_bank_after FROM clubs WHERE id=v_club;
  IF v_bank_after <> v_bank_before + 7500000 THEN
    RAISE EXCEPTION 'unwind wrong: bank % -> % (expected +7,500,000)', v_bank_before, v_bank_after;
  END IF;

  IF (SELECT count(*) FROM club_members WHERE club_id=v_club AND is_bot AND chip_balance<>0) <> 0
     OR (SELECT count(*) FROM agents WHERE club_id=v_club AND agent_wallet_balance<>0) <> 0 THEN
    RAISE EXCEPTION 'unwind left nonzero balances';
  END IF;
END $$;
