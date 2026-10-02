-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821000733 "drop_free_register_for_tournament"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 adc0379dd336d06238980cec13650e5c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════
-- drop_free_register_for_tournament
-- ═══════════════════════════════════════════════════════════════════════
-- TIER: 3 (DROP)  |  AFFECTS: public.register_for_tournament(uuid,uuid,text)
--
-- WHY
--   This legacy RPC created a tournament_players row WITHOUT charging
--   anyone. Proven live on 2026-08-20: an agent-seated entry (kingfish)
--   played two complete spins for free — club balance untouched, no
--   tournament_buyin ledger row (charged retroactively afterwards). Dan's
--   rule, verbatim: "spins can NEVER START until 3 players are registered
--   and have paid." A callable free-entry path is incompatible with that
--   rule existing at all.
--
--   Legitimate paths are unaffected and complete:
--     humans  -> fn_register_for_tournament(uuid)        (auth-scoped, debits)
--     horses  -> fn_register_horse_for_tournament(uuid,uuid) (debits)
--   Client usage: ONE call site (SpinAndGoLobby, an unrouted component)
--   which invoked this with the wrong arity and could never have succeeded;
--   it is being repointed at the paid path in the same change set.
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
