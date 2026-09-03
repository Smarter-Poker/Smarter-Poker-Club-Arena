-- Mirror of the live catalog (applied 2026-08-20 via mcp apply_migration).
-- Documents a consequence of the 7-day horse retention. Changes no data.
--
-- rake_records.hand_id has a UNIQUE index but NO foreign key to hand_history.
-- Horse-only hands are now pruned at 7 days instead of 90, so a rake row can
-- outlive the hand it points at and its hand_id becomes a dangling reference.
--
-- Checked before writing this down: no function in the catalog joins
-- rake_records to hand_history, so nothing silently drops rows because of it.
-- The unlinkable-rows audit counts `hand_id IS NULL`, which a dangling id is
-- NOT — so this does not pollute that signal either.
--
-- The important part is what NOT to do about it: do not "clean up" by setting
-- those hand_ids back to NULL. That would move real, correctly-attributed rake
-- into the unattributable bucket and re-raise the exact alert that took a day
-- to trace. A dangling id means "this rake belongs to a hand whose history has
-- expired", which is true and is the intended outcome.
COMMENT ON COLUMN public.rake_records.hand_id IS
  'hand_history.id for the hand this rake came from. NOT a foreign key. May DANGLE: horse-only hands are pruned after 7 days (see sp_prune_hand_history) while the rake row is kept forever, so the referenced hand can be gone. That is intended — it means "the hand history expired", not "this rake is unattributable". Do NOT null these out to tidy them: NULL is the unattributable marker that FeeReconciler.auditBBJDrift alarms on, and nulling a valid link would manufacture that alert. NULL here means the link was never established (see fn_relink_rake_record_to_hand). Documented 2026-08-20.';
