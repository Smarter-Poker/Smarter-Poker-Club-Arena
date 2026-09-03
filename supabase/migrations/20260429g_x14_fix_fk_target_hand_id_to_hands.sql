-- ═══════════════════════════════════════════════════════════════════════════════
-- Walkthrough Round 12 — fix Round 11 FK targets.
--
-- Round 11 created hand_actions + rake_attributions with hand_id FK targeting
-- public.hand_history(id). But the actual writers run on the frontend:
--
--   src/services/HandHistoryService.ts:560-569 — INSERT INTO hands ... RETURNING id
--   src/services/HandHistoryService.ts:594-608 — INSERT INTO hand_actions with that id
--   src/services/CommissionService.ts:241-252 — INSERT INTO rake_attributions with that id
--
-- And public.hand_players.hand_id already FKs to public.hands(id), not
-- hand_history(id). So the new tables had to match that pattern, otherwise
-- every hand_actions / rake_attributions INSERT would FK-fail.
--
-- The pre-existing hands vs hand_history split (frontend = normalized
-- hands + hand_players + hand_actions; engine = denormalized hand_history with
-- JSONB winners/players/actions) is a known architectural divergence.
-- Reconciling that is a separate project; this migration just fixes the FKs
-- so the new Round 11 tables work with the actual writers in production.
--
-- Applied to production via Supabase MCP migration
-- x14_fix_fk_target_hand_id_to_hands_2026_04_29.
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.hand_actions
  DROP CONSTRAINT IF EXISTS hand_actions_hand_id_fkey;
ALTER TABLE public.hand_actions
  ADD CONSTRAINT hand_actions_hand_id_fkey
      FOREIGN KEY (hand_id) REFERENCES public.hands(id) ON DELETE CASCADE;

ALTER TABLE public.rake_attributions
  DROP CONSTRAINT IF EXISTS rake_attributions_hand_id_fkey;
ALTER TABLE public.rake_attributions
  ADD CONSTRAINT rake_attributions_hand_id_fkey
      FOREIGN KEY (hand_id) REFERENCES public.hands(id) ON DELETE CASCADE;
