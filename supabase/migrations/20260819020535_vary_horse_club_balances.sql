-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819020535 "vary_horse_club_balances"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 c5553d21c2bdc592098f816ab34769f0 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Dan 2026-08-19: every horse held exactly 50,000 club chips, so the members
-- roster rendered a perfect column of "50,000" and identified them instantly.
-- Horses must be indistinguishable from human players, which means their
-- bankrolls have to look like human bankrolls: a long-tailed spread, not a
-- constant. Deterministic per user_id so re-running is idempotent-ish and the
-- values stay stable rather than churning on every deploy.
DO $$
DECLARE
  v_before_distinct int;
  v_after_distinct  int;
  v_updated         int;
BEGIN
  SELECT count(DISTINCT cm.chip_balance) INTO v_before_distinct
    FROM club_members cm JOIN profiles p ON p.id = cm.user_id
   WHERE p.is_horse = true;

  WITH horse_rows AS (
    SELECT cm.club_id,
           cm.user_id,
           -- Stable pseudo-random in [0,1) derived from the user id.
           ('x' || substr(md5(cm.user_id::text || cm.club_id::text), 1, 8))::bit(32)::bigint
             / 4294967296.0 AS r
      FROM club_members cm
      JOIN profiles p ON p.id = cm.user_id
     WHERE p.is_horse = true
       AND cm.chip_balance = 50000
  )
  UPDATE club_members cm
     SET chip_balance = GREATEST(
           500,
           -- Log-uniform between ~1.2k and ~420k, rounded to a human-looking
           -- step so the column reads like real bankrolls.
           round((exp(ln(1200) + hr.r * (ln(420000) - ln(1200))) / 50)::numeric) * 50
         )
    FROM horse_rows hr
   WHERE cm.club_id = hr.club_id
     AND cm.user_id = hr.user_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  SELECT count(DISTINCT cm.chip_balance) INTO v_after_distinct
    FROM club_members cm JOIN profiles p ON p.id = cm.user_id
   WHERE p.is_horse = true;

  RAISE NOTICE 'horse balances: updated=% distinct_before=% distinct_after=%',
    v_updated, v_before_distinct, v_after_distinct;

  IF v_updated > 0 AND v_after_distinct <= 2 THEN
    RAISE EXCEPTION 'Spread failed: still only % distinct horse balances', v_after_distinct;
  END IF;
END $$;
