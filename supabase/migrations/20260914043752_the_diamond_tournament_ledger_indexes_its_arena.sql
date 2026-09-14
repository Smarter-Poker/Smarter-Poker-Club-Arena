-- ============================================================================
-- THE DIAMOND TOURNAMENT LEDGER INDEXES ITS ARENA
-- ============================================================================
-- poker_diamond_tournament_ledger.arena_id references clubs and had no index
-- leading on it, so a club retirement's DELETE would scan the ledger to
-- check the foreign key. Found by the post-deploy club-FK gate the moment the
-- Phase 8 ledger reached main. The table holds zero rows (the tournament
-- switch is off), so a plain build is instant. Applied once to
-- kuklfnapbkmacvwxktbh.
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_poker_diamond_tournament_ledger_arena_id_fk
  ON public.poker_diamond_tournament_ledger (arena_id);
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='poker_diamond_tournament_ledger'
                  AND indexname='idx_poker_diamond_tournament_ledger_arena_id_fk') THEN
    RAISE EXCEPTION 'the arena index on the Diamond tournament ledger is missing';
  END IF;
END $do$;
