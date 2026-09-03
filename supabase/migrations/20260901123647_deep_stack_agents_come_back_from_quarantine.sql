-- =============================================================================
-- deep_stack_agents_come_back_from_quarantine
-- Applied to production via Supabase MCP 2026-09-01 12:36 UTC.
--
-- Dan, 2026-09-01: "RESTORE THE AGENTS."
--
-- The 20260902050000_user_clubs_are_human_only migration deleted all 32
-- agents rows for Deep Stack Society (club 11192 / 2a1132b9). The originals
-- were preserved verbatim in club_financial_quarantine under source_table
-- 'agents_automated_recurrence'. This puts them back exactly as they were:
-- hierarchy (parent_agent_id), commission rates (70/60-40/30-20), player
-- rakeback rates, credit limits (all credit-line, not prepaid), and the
-- agent banks totaling exactly 3,340,000.
--
-- The ledger needs no hand-written rows: trg_ca_autoledger_insert on agents
-- records every arriving nonzero balance automatically, exactly mirroring
-- the 32 'correction' retirements it wrote when the balances left.
-- Probed first inside a rolled-back transaction: 32 rows, 3,340,000, 32
-- auto-ledger entries.
-- =============================================================================
DO $$
DECLARE v_n int; v_banks numeric; v_ledger int; v_sa int; v_ag int; v_sub int;
BEGIN
  IF EXISTS (SELECT 1 FROM agents WHERE club_id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3') THEN
    RAISE EXCEPTION 'agents rows already present for Deep Stack; refusing to double-restore';
  END IF;

  -- dependency order: super agents (no parent), then agents, then sub agents
  INSERT INTO agents SELECT (jsonb_populate_record(null::agents, q.row_data)).*
    FROM club_financial_quarantine q
   WHERE q.club_id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'
     AND q.source_table='agents_automated_recurrence' AND q.row_data->>'role'='super_agent';
  INSERT INTO agents SELECT (jsonb_populate_record(null::agents, q.row_data)).*
    FROM club_financial_quarantine q
   WHERE q.club_id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'
     AND q.source_table='agents_automated_recurrence' AND q.row_data->>'role'='agent';
  INSERT INTO agents SELECT (jsonb_populate_record(null::agents, q.row_data)).*
    FROM club_financial_quarantine q
   WHERE q.club_id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'
     AND q.source_table='agents_automated_recurrence' AND q.row_data->>'role'='sub_agent';

  SELECT count(*), sum(agent_wallet_balance) INTO v_n, v_banks
    FROM agents WHERE club_id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  SELECT count(*) FILTER (WHERE role='super_agent'),
         count(*) FILTER (WHERE role='agent'),
         count(*) FILTER (WHERE role='sub_agent') INTO v_sa, v_ag, v_sub
    FROM agents WHERE club_id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  SELECT count(*) INTO v_ledger FROM chip_ledger
   WHERE club_id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'
     AND to_type='agent_wallet' AND created_at > now() - interval '1 minute';

  IF v_n <> 32 OR v_banks <> 3340000 OR v_sa <> 2 OR v_ag <> 10 OR v_sub <> 20 THEN
    RAISE EXCEPTION 'restore wrong: rows=% banks=% sa=% ag=% sub=%', v_n, v_banks, v_sa, v_ag, v_sub;
  END IF;
  IF v_ledger <> 32 THEN
    RAISE EXCEPTION 'autoledger wrote % rows, expected 32', v_ledger;
  END IF;

  -- every agent/sub agent parent resolves inside the same club
  IF EXISTS (
    SELECT 1 FROM agents a
     WHERE a.club_id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3' AND a.role <> 'super_agent'
       AND NOT EXISTS (SELECT 1 FROM agents p
                        WHERE p.id=a.parent_agent_id
                          AND p.club_id=a.club_id)) THEN
    RAISE EXCEPTION 'orphaned parent_agent_id after restore';
  END IF;
END $$;
