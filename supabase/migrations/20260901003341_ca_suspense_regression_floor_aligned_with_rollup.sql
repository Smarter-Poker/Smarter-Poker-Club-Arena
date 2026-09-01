-- Byte-exact mirror of the applied production migration.

-- The 15-minute regression check still floored at 23:35 (the vocabulary fix)
-- while the daily rollup floors at 00:17 (the last writer fix, the spin
-- margin mover), so it re-counted the audited 23:57-00:05 spin rows for an
-- hour after resolution. Both checks now share the same floor: every row
-- before 2026-09-01 00:17 UTC is audited and explained; only a writer never
-- seen before can raise either alarm.
DO $do$
DECLARE src text; anchor text; cnt int;
BEGIN
  anchor := 'AND created_at > ''2026-08-31 23:35:00+00''';
  SELECT pg_get_functiondef(p.oid) INTO src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_suspense_regression_check';
  cnt := (length(src) - length(replace(src, anchor, ''))) / length(anchor);
  IF cnt <> 1 THEN
    RAISE EXCEPTION 'regression floor patch: anchor matched % times (need exactly 1)', cnt;
  END IF;
  src := replace(src, anchor, 'AND created_at > ''2026-09-01 00:17:00+00''');
  EXECUTE src;
END $do$;;
