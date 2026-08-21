-- ═══════════════════════════════════════════════════════════════════════
-- 20260820q_drop_free_register_for_tournament.sql
-- ═══════════════════════════════════════════════════════════════════════
-- TIER: 3 (DROP)  |  APPLIED: 2026-08-20 (migration `drop_free_register_for_tournament`)
-- AFFECTS: public.register_for_tournament(uuid,uuid,text)
--
-- WHY
--   This legacy RPC created a tournament_players row WITHOUT charging
--   anyone. Proven live on 2026-08-20: an agent-seated entry (kingfish)
--   played two complete spins for free -- club balance untouched, no
--   tournament_buyin ledger row (charged retroactively afterwards). Dan's
--   rule, verbatim: "spins can NEVER START until 3 players are registered
--   and have paid." A callable free-entry path is incompatible with that
--   rule existing at all.
--
--   Legitimate paths are unaffected and complete:
--     humans  -> fn_register_for_tournament(uuid)            (auth-scoped, debits)
--     horses  -> fn_register_horse_for_tournament(uuid,uuid) (debits)
--   The engine additionally enforces the rule at start time: a spin
--   registration with no tournament_buyin debit is removed and the start
--   stands down until 3 PAID players are seated
--   (TournamentManagerBase paid-gate, same change set).
--
-- ROLLBACK
--   Restore from the Supabase migration history dump of this function's
--   prior definition. Deliberately not pasted here: re-creating a free
--   registration path should require going and getting it.
-- ═══════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.register_for_tournament(uuid, uuid, text);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='register_for_tournament'
  ) THEN
    RAISE EXCEPTION 'register_for_tournament still exists after drop';
  END IF;
END $$;
