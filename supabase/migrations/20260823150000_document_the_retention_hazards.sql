-- 20260823150000_document_the_retention_hazards.sql
--
-- Two tables look like obvious cleanup targets and are not. Both invitations
-- were investigated on 2026-08-23; the findings are recorded ON THE OBJECTS so
-- the next person to notice them sees the answer before acting, not after.
--
-- 1. public.tables - 62,122 closed rows, ~1,500/day, 40,400 older than 90 days.
--    Deleting old closed tables is NOT a retention tweak. It cascades to eight
--    child tables (table_seats, table_chat, table_activity,
--    table_cashout_history, hand_state_snapshots, insurance_transactions,
--    table_waitlist, favorite_tables) and, worst,
--    rake_records_table_id_fkey is ON DELETE SET NULL - so pruning would
--    silently blank table_id on historical rake records and destroy the
--    financial provenance of every raked hand at those tables.
--    It is also not costing anything: the whole table is 67 MB and the club
--    lobby reads it in 3.5 ms through a partial index on open games.
--
-- 2. public.solved_spots_gold - 72 GB, 8.6M rows, 66 GB of it TOAST.
--    Not garbage and not Club Arena's. It is the GTO solver store, actively
--    ingested by World Hub's scripts/ingest_god_mode.py and
--    scripts/analyze-pio-data.js and scheduled through
--    scripts/openclaw-cron-dispatcher.py. strategy_matrix (v1) is populated on
--    every row; strategy_matrix_v2 on ~16% - a backfill in progress, not a
--    superseded column, so v1 cannot be dropped either. It is cold: it never
--    appears on the hot path and does not affect query latency. Its size is a
--    storage and backup cost question for Dan, not a performance defect.

COMMENT ON TABLE public.tables IS
  'Poker tables, all statuses. DO NOT PRUNE closed rows without reading this: '
  'DELETE cascades to table_seats, table_chat, table_activity, '
  'table_cashout_history, hand_state_snapshots, insurance_transactions, '
  'table_waitlist and favorite_tables, and rake_records.table_id is '
  'ON DELETE SET NULL - pruning blanks the table link on historical rake '
  'records and destroys financial provenance. 62k closed rows cost 67 MB and '
  'the lobby reads open games in 3.5 ms via a partial index, so there is '
  'nothing to gain. Investigated 2026-08-23.';

COMMENT ON TABLE public.solved_spots_gold IS
  'GTO solver output, owned by the World Hub ingestion pipeline '
  '(scripts/ingest_god_mode.py, scripts/analyze-pio-data.js, scheduled via '
  'openclaw-cron-dispatcher.py). 8.6M rows / 72 GB, 66 GB of it TOAST. '
  'strategy_matrix (v1) is on every row; strategy_matrix_v2 on ~16% and still '
  'backfilling, so v1 is NOT superseded. Cold data - never on the hot path. '
  'Size is a storage/backup cost decision, not a performance defect. '
  'Investigated 2026-08-23.';

DO $assert$
BEGIN
  IF obj_description('public.tables'::regclass) IS NULL
     OR obj_description('public.solved_spots_gold'::regclass) IS NULL THEN
    RAISE EXCEPTION 'retention hazard comments were not applied';
  END IF;
  -- The hazard this documents must still be real; if the FK is ever changed to
  -- CASCADE or RESTRICT, this comment becomes wrong and should be revisited.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'rake_records_table_id_fkey'
       AND confdeltype = 'n'   -- 'n' = SET NULL
  ) THEN
    RAISE EXCEPTION 'rake_records_table_id_fkey is no longer ON DELETE SET NULL - re-check the comment on public.tables';
  END IF;
END $assert$;

-- ROLLBACK
--   COMMENT ON TABLE public.tables IS NULL;
--   COMMENT ON TABLE public.solved_spots_gold IS NULL;
