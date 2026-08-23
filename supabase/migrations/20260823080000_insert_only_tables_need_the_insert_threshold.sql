-- 20260823080000_insert_only_tables_need_the_insert_threshold.sql
--
-- Corrects a defect in 20260823070000 (mine, one migration earlier).
--
-- That migration gave union_wallet_transactions an aggressive
-- autovacuum_vacuum_threshold. On an INSERT-ONLY table that setting can never
-- fire: it is measured in DEAD tuples, and an append-only ledger never produces
-- any. Measured immediately after applying it:
--
--   n_dead_tup = 0, autovacuum_count = 0, last_autovacuum = NULL
--
-- So the table would have gone on never being vacuumed, its visibility map
-- would have stayed unset, and the covering index added alongside it would have
-- kept degrading into heap fetches:
--
--   Parallel Index Only Scan ... Heap Fetches: 226,432   Execution: 340 ms
--
-- which is the exact failure that took the platform down on 2026-08-22, just on
-- a different table. The knob for an append-only table is
-- autovacuum_vacuum_insert_threshold (PG13+; this instance is 17.6), which
-- counts INSERTS since the last vacuum. Vacuuming an append-only table is
-- almost pure profit: it sets the visibility map and freezes tuples, and there
-- is nothing to reclaim, so it is cheap - the first-ever VACUUM of this
-- 698,820-row table took 1.4 seconds.
ALTER TABLE public.union_wallet_transactions SET (
  autovacuum_vacuum_insert_threshold    = 5000,
  autovacuum_vacuum_insert_scale_factor = 0.0
);

-- hand_history and hand_state_snapshots DO get deletes (the prunes), so their
-- dead-tuple thresholds from 20260822230941 are correct and stay. They are
-- given insert thresholds too, because between prune runs they are effectively
-- append-only and the visibility map is what the hand-insert path depends on.
ALTER TABLE public.hand_history SET (
  autovacuum_vacuum_insert_threshold    = 10000,
  autovacuum_vacuum_insert_scale_factor = 0.0
);

ALTER TABLE public.hand_state_snapshots SET (
  autovacuum_vacuum_insert_threshold    = 10000,
  autovacuum_vacuum_insert_scale_factor = 0.0
);

DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(t, ', ') INTO v_missing
    FROM unnest(ARRAY['public.union_wallet_transactions',
                      'public.hand_history',
                      'public.hand_state_snapshots']) AS t
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_class c, unnest(c.reloptions) o
      WHERE c.oid = t::regclass
        AND o LIKE 'autovacuum_vacuum_insert_threshold=%'
   );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'insert threshold missing on: %', v_missing;
  END IF;
END $$;

-- ROLLBACK
--   ALTER TABLE public.union_wallet_transactions RESET (autovacuum_vacuum_insert_threshold, autovacuum_vacuum_insert_scale_factor);
--   ALTER TABLE public.hand_history            RESET (autovacuum_vacuum_insert_threshold, autovacuum_vacuum_insert_scale_factor);
--   ALTER TABLE public.hand_state_snapshots    RESET (autovacuum_vacuum_insert_threshold, autovacuum_vacuum_insert_scale_factor);
