-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820001323 "deprecate_hands_and_hand_actions"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 931754437f1debe50b838baaa67c5539 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- REGISTER THE REST OF THE CLIENT-SIDE HAND TABLES AS DEPRECATED (2026-08-19)
--
-- hands, hand_players and hand_actions all hold ZERO rows and always have.
-- HandHistoryService.saveHand inserts into `hands` first and returns early if
-- that fails — which it evidently always does — so the hand_players and
-- hand_actions writes below it are unreachable. The server-authoritative
-- engine writes hand_history instead.
--
-- The write code is left in place on purpose: it belongs to MIGRATION-LAW
-- STEP 1 ("RIP OUT client-side engine code"), which is a governed, sequenced
-- phase, and it is inert — it fails and returns rather than corrupting
-- anything. What actually causes damage is READING these tables, because the
-- query succeeds, returns [], and the UI renders a confident zero. Five
-- features were found doing exactly that. So the guard is extended instead of
-- the code being cut out of sequence.
-- ============================================================================

INSERT INTO deprecated_tables (table_name, reason, replacement, last_write_at) VALUES
  ('hands',
   'Client-side hand persistence from before the server-authoritative migration. Zero rows, ever; saveHand fails on this insert and returns.',
   'hand_history', NULL),
  ('hand_actions',
   'Client-side per-action log. Zero rows, ever — unreachable behind the failing hands insert.',
   'hand_history.actions (jsonb)', NULL)
ON CONFLICT (table_name) DO UPDATE
  SET reason = EXCLUDED.reason, replacement = EXCLUDED.replacement;

COMMENT ON TABLE hands IS
  'DEPRECATED 2026-08-19 — zero rows, ever. Superseded by the server-authoritative engine; use hand_history.';
COMMENT ON TABLE hand_actions IS
  'DEPRECATED 2026-08-19 — zero rows, ever. Per-action detail lives in hand_history.actions.';

DO $$
BEGIN
  IF (SELECT count(*) FROM deprecated_tables) < 5 THEN
    RAISE EXCEPTION 'ASSERTION FAILED: expected 5 deprecated tables registered';
  END IF;
END $$;
