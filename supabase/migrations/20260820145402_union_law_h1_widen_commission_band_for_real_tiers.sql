-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820145402 "union_law_h1_widen_commission_band_for_real_tiers"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ae73a4ab426cb7930dc2d6a81493c557 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- H1 — WIDEN THE COMMISSION BAND TO THE REAL TIER RANGES (2026-08-20)
--
-- P4 enforced unions.settings min_agent_commission = 0.40, which was the value
-- already sitting in the union row. The owner has now specified the ranges
-- actually used in practice:
--
--   super agent  60-70%
--   agent        20-50%
--   sub agent    20-30%
--
-- Agents and sub-agents therefore legitimately sit BELOW 0.40, and the trigger
-- added in P4 would reject them. The band is widened to 0.20-0.70 so the real
-- structure is representable, and the tier-specific ranges are recorded in the
-- union settings so the intent is not lost.
-- ============================================================================

UPDATE public.unions
   SET settings = COALESCE(settings, '{}'::jsonb)
                  || jsonb_build_object(
                       'min_agent_commission', 0.20,
                       'max_agent_commission', 0.70,
                       'tier_commission_ranges', jsonb_build_object(
                         'super_agent', jsonb_build_object('min', 0.60, 'max', 0.70),
                         'agent',       jsonb_build_object('min', 0.20, 'max', 0.50),
                         'sub_agent',   jsonb_build_object('min', 0.20, 'max', 0.30)),
                       'player_rakeback_range', jsonb_build_object('min', 0.10, 'max', 0.50),
                       'player_rakeback_min_gap', 0.10),
       updated_at = now()
 WHERE id = 'fade0000-0000-0000-0000-000000000001';

