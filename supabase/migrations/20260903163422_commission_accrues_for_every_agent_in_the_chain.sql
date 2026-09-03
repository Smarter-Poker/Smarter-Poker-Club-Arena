-- COMMISSION ACCRUES FOR EVERY AGENT IN THE CHAIN, PER HAND
-- Chip Accounting Standard Phase 2, lane 2.2 (audit F2, High), 2026-09-03.
--
-- WHAT WAS WRONG. credit_agent_commission_from_rake opened with
--
--   IF p_source_id IS NOT NULL AND EXISTS (
--     SELECT 1 FROM agent_commissions
--      WHERE source_id = p_source_id AND source_type = p_source_type LIMIT 1
--   ) THEN RETURN; END IF;
--
-- No user_id in the predicate. The RakebackSettler calls this function once
-- per contributing PLAYER of a cash hand, every call carrying the same
-- source_id (the hand id) and source_type ('rake_settlement'). The first
-- player's agent (and that agent's super-agent override) were booked; every
-- later call saw "a row exists for this source" and returned before it had
-- even looked up whose agent it was. The second, third and fourth agent at
-- the table - super agent, agent, sub agent, horse's agent or human's agent
-- alike - were never booked. Tournament attribution (fn_attribute_tournament_rake)
-- was unaffected because its source ids are per user.
--
-- MEASURED (production, 24h to 2026-09-03 16:10 UTC):
--   - rake_settlement direct rows 93,536 over 93,536 distinct sources
--     (exactly one direct agent per hand), super-agent rows 86,583 over
--     86,583 sources;
--   - 102,274 raked cash hands, 189,791.80 rake; on the 68,193 hands whose
--     contributors have an agent in the table's club, the chain rates
--     predict 219,851 direct rows / 53,332.21 and 177,218 override rows /
--     38,236.62, against 63,843 / 16,827.98 and 59,884 / 14,128.87 booked;
--   - hand 134a1847-1e96-41c0-a6a2-8c865d155790 (rake 8.00, two contributors
--     4.00 each): booked a477eee0 1.00 (sub_agent 25%) and 5c3c64a2 1.65
--     (agent 55% override); NOT booked 0362d601 2.00 (agent 50%) and
--     a9ff80c3 1.40 (super_agent 70% override) for the second contributor.
--     A rolled-back call for the second contributor wrote 0 rows.
--
-- THE RULE (standard P4, P14): each raked hand books a commission ACCRUAL
-- for every agent in the chain of every contributing player, weighted by
-- that player's contributed share; super-agent override = rate x (what
-- remains below). Idempotency is per (user_id, source_id, source_type),
-- which is the unique index uq_agent_commissions_source that already exists.
--
-- WHAT CHANGES. One thing. The early-return guard moves below the agent
-- lookup and gains "AND user_id = v_agent_user_id", so it answers "has THIS
-- agent been booked for this source" instead of "has ANY agent". Every other
-- statement in the function is byte-identical to the live body: the union
-- law club resolution, the two-step agent lookup, ROUND(.., 2), the ON
-- CONFLICT (user_id, source_id, source_type) DO NOTHING on both inserts, the
-- agents accumulator bump gated on ROW_COUNT, and the super-agent override.
-- A retry of the same (player, hand) still writes nothing: the guard sees
-- the direct agent's row; if the direct rate was 0 and only the override
-- row exists, the override insert hits ON CONFLICT DO NOTHING.
--
-- NO BACKFILL. Rows never written stay unwritten (obligations, not credits;
-- the roadmap says backfill nothing). The chip side is untouched: this
-- function moves no chips, it books a liability.
--
-- KNOWN RESIDUAL, NOT BUILT HERE: two contributing players under the SAME
-- agent at one hand still yield one row for that agent (the second player's
-- share is dropped by the key). 13,489 of 263,809 (hand, agent) pairs in
-- 24h. Fixing that needs a different idempotency key and therefore a new
-- unique index on a 1.6M-row table, which cannot be built CONCURRENTLY
-- inside a migration transaction. Reported, not built.

BEGIN;

CREATE OR REPLACE FUNCTION public.credit_agent_commission_from_rake(p_agent_user_id uuid, p_club_id uuid, p_rake_credit numeric, p_source_type text DEFAULT 'rake_settlement'::text, p_source_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent_id          UUID;
  v_agent_user_id     UUID;
  v_commission_rate   NUMERIC;
  v_parent_agent_id   UUID;
  v_parent_user_id    UUID;
  v_parent_rate       NUMERIC;
  v_direct_commission NUMERIC;
  v_parent_commission NUMERIC;
  v_remaining         NUMERIC;
  v_book_club         UUID;
  v_inserted_direct   INTEGER := 0;
BEGIN
  -- UNION LAW: the agent follows the PLAYER's club, not the table's club.
  v_book_club := public.fn_resolve_player_club_for_agent(p_agent_user_id, p_club_id, NULL);

  SELECT a.id, a.user_id, a.commission_rate, a.parent_agent_id
    INTO v_agent_id, v_agent_user_id, v_commission_rate, v_parent_agent_id
    FROM club_members cm
    JOIN agents a ON a.user_id = cm.agent_id AND a.club_id = cm.club_id AND a.status = 'active'
   WHERE cm.user_id = p_agent_user_id AND cm.club_id = v_book_club
   LIMIT 1;

  -- The caller may itself be an agent generating rake.
  IF v_agent_id IS NULL THEN
    SELECT id, user_id, commission_rate, parent_agent_id
      INTO v_agent_id, v_agent_user_id, v_commission_rate, v_parent_agent_id
      FROM agents WHERE user_id = p_agent_user_id AND status = 'active'
     ORDER BY (club_id = v_book_club) DESC
     LIMIT 1;
  END IF;

  IF v_agent_id IS NULL THEN RETURN; END IF;

  -- Idempotency is per AGENT and source, never per source alone: a hand has
  -- one row per agent in the chain of every contributing player, and only a
  -- retry for the same agent returns here (Chip Standard P4, lane 2.2).
  IF p_source_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM agent_commissions
     WHERE source_id = p_source_id AND source_type = p_source_type
       AND user_id = v_agent_user_id
     LIMIT 1
  ) THEN
    RETURN;
  END IF;

  v_direct_commission := ROUND(p_rake_credit * COALESCE(v_commission_rate, 0), 2);
  v_remaining         := p_rake_credit - v_direct_commission;

  IF v_direct_commission > 0 THEN
    INSERT INTO agent_commissions (
      club_id, user_id, amount, commission_rate, source_type, source_id, notes
    ) VALUES (
      COALESCE(v_book_club, p_club_id), v_agent_user_id, v_direct_commission, v_commission_rate,
      p_source_type, p_source_id, COALESCE(p_notes, 'agent slice (accrual)')
    )
    ON CONFLICT (user_id, source_id, source_type) WHERE source_id IS NOT NULL
    DO NOTHING;
    GET DIAGNOSTICS v_inserted_direct = ROW_COUNT;

    IF v_inserted_direct > 0 THEN
      UPDATE agents SET
        weekly_rake_generated   = COALESCE(weekly_rake_generated, 0)   + p_rake_credit,
        lifetime_rake_generated = COALESCE(lifetime_rake_generated, 0) + p_rake_credit,
        last_active_at          = NOW(),
        updated_at              = NOW()
      WHERE id = v_agent_id;
    END IF;
  END IF;

  -- Super-agent override on the downstream volume (PokerBros model).
  IF v_parent_agent_id IS NOT NULL AND v_remaining > 0 THEN
    SELECT id, user_id, commission_rate
      INTO v_parent_agent_id, v_parent_user_id, v_parent_rate
      FROM agents WHERE id = v_parent_agent_id AND status = 'active'
     LIMIT 1;

    IF v_parent_agent_id IS NOT NULL AND v_parent_rate IS NOT NULL THEN
      v_parent_commission := ROUND(v_remaining * v_parent_rate, 2);
      IF v_parent_commission > 0 THEN
        INSERT INTO agent_commissions (
          club_id, user_id, amount, commission_rate, source_type, source_id, notes
        ) VALUES (
          COALESCE(v_book_club, p_club_id), v_parent_user_id, v_parent_commission, v_parent_rate,
          p_source_type, p_source_id, 'super-agent slice (accrual)'
        )
        ON CONFLICT (user_id, source_id, source_type) WHERE source_id IS NOT NULL
        DO NOTHING;
      END IF;
    END IF;
  END IF;
END;
$function$;

-- Self-check: the live body keys its guard on the agent, the source-only
-- guard is gone, the ON CONFLICT clauses survived, the function is still one
-- overload, still not SECURITY DEFINER, and the unique index it relies on
-- exists with exactly (user_id, source_id, source_type).
DO $$
DECLARE v_src text; v_n int; v_idx text;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE proname = 'credit_agent_commission_from_rake' AND pronamespace = 'public'::regnamespace;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'credit_agent_commission_from_rake has % overloads, expected 1', v_n;
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'credit_agent_commission_from_rake' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%AND user_id = v_agent_user_id%' THEN
    RAISE EXCEPTION 'the commission guard is not keyed on the agent';
  END IF;
  IF v_src LIKE '%WHERE source_id = p_source_id AND source_type = p_source_type' || E'\n' || '     LIMIT 1%' THEN
    RAISE EXCEPTION 'the source-only guard is still in the live body';
  END IF;
  IF position('IF v_agent_id IS NULL THEN RETURN; END IF;' in v_src)
     > position('AND user_id = v_agent_user_id' in v_src) THEN
    RAISE EXCEPTION 'the guard runs before the agent is known';
  END IF;
  IF (length(v_src) - length(replace(v_src, 'ON CONFLICT (user_id, source_id, source_type) WHERE source_id IS NOT NULL', ''))) /
     length('ON CONFLICT (user_id, source_id, source_type) WHERE source_id IS NOT NULL') <> 2 THEN
    RAISE EXCEPTION 'expected exactly two ON CONFLICT (user_id, source_id, source_type) clauses';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'credit_agent_commission_from_rake'
                AND pronamespace = 'public'::regnamespace AND prosecdef) THEN
    RAISE EXCEPTION 'credit_agent_commission_from_rake must not be SECURITY DEFINER';
  END IF;
  SELECT indexdef INTO v_idx FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'agent_commissions' AND indexname = 'uq_agent_commissions_source';
  IF v_idx IS NULL OR v_idx NOT LIKE 'CREATE UNIQUE INDEX uq_agent_commissions_source ON public.agent_commissions USING btree (user_id, source_id, source_type) WHERE (source_id IS NOT NULL)' THEN
    RAISE EXCEPTION 'uq_agent_commissions_source is missing or not (user_id, source_id, source_type): %', v_idx;
  END IF;
END $$;

COMMIT;
