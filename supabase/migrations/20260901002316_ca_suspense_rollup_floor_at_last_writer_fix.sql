-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").

-- The daily suspense rollup counts rows since midnight, so rows from BEFORE
-- a same-day root-cause fix keep re-raising the tracker all day after it is
-- resolved. The rollup now floors at the last uncategorized-writer fix
-- (fn_spin_move_owner_wallet, 2026-09-01 00:17 UTC): every row before the
-- floor is audited and explained; only flow from a writer we have NOT met
-- yet can raise it now.
DO $do$
DECLARE src text; anchor text; cnt int;
BEGIN
  anchor := 'AND created_at > CURRENT_DATE';
  SELECT pg_get_functiondef(p.oid) INTO src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_quick_reconcile';
  cnt := (length(src) - length(replace(src, anchor, ''))) / length(anchor);
  IF cnt < 1 OR cnt > 3 THEN
    RAISE EXCEPTION 'suspense rollup floor: anchor matched % times (expected 1-3)', cnt;
  END IF;
  src := replace(src, anchor,
    'AND created_at > GREATEST(CURRENT_DATE::timestamptz, ''2026-09-01 00:17:00+00''::timestamptz)');
  EXECUTE src;
END $do$;;
