-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260905180235; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260905180235   (the stamp IS the apply time, UTC: 2026-09-05 18:02:35)
--   name        add_bomb_pot_award_gap_check
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 1208 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260905180235 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     VIEW           ops.bomb_pot_award_gaps
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- Replaces the safety-net role of bomb-multi-winner-repair-hourly (removed
-- 2026-09-05) without its hourly cost. That job scanned 22,635 bomb hands every
-- hour to find zero work. This answers the same question on demand.
-- If this ever returns rows, run:
--   select * from public.fn_backfill_bomb_multi_winner_units(500, false);
create or replace view ops.bomb_pot_award_gaps as
select h.id as hand_history_id, h.table_id, h.hand_number, h.created_at,
       jsonb_array_length(coalesce(h.winners,'[]'::jsonb)) as winner_count,
       h.pot_size, h.rake_amount, h.bbj_amount
from public.hand_history h
where h.bomb_pot is not null
  and jsonb_array_length(coalesce(h.winners,'[]'::jsonb)) > 1
  and coalesce(h.pot_size,0) > 0
  and not exists (select 1 from public.bomb_pot_award_units a
                  where a.hand_history_id = h.id);

comment on view ops.bomb_pot_award_gaps is
  'Multi-winner bomb pot hands missing award units. Expected to be empty: the '
  'live settlement path writes units 0.15-2.8s after the hand. Non-empty means '
  'the live path missed one - run fn_backfill_bomb_multi_winner_units(500,false).';

revoke all on all tables in schema ops from public, anon, authenticated;
