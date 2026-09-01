-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").
-- Applied 2026-08-31 23:46:06 UTC on kuklfnapbkmacvwxktbh.

-- The rakeback close's two incident raises passed layer 'union_wallet', which
-- the ca_drift_incidents layer CHECK rejects (allowed: ledger/projection/
-- cache/reporting/settlement/unknown) - the raise fn swallowed the violation,
-- so a refused close would have screamed into a pillow. Layer is 'settlement'.
DO $do$
DECLARE src text; anchor text; cnt int;
BEGIN
  anchor := '''union_wallet'', ''union'', p_union_id';
  SELECT pg_get_functiondef(p.oid) INTO src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_union_weekly_rakeback_close';
  cnt := (length(src) - length(replace(src, anchor, ''))) / length(anchor);
  IF cnt <> 2 THEN
    RAISE EXCEPTION 'layer fix: anchor matched % times (need exactly 2)', cnt;
  END IF;
  src := replace(src, anchor, '''settlement'', ''union'', p_union_id');
  EXECUTE src;
END $do$;;
