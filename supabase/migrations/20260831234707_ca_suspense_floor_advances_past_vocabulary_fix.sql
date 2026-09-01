-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").
-- Applied 2026-08-31 23:47:07 UTC on kuklfnapbkmacvwxktbh.

-- The 23:03 club-opening rows (vocabulary now extended) sit inside the
-- suspense check's 60-minute lookback and re-page each tick until they age
-- out. The floor advances to the vocabulary fix; every row before it is
-- explained and audited (incidents 2ebf1108/c9664d38/e97902e4 resolutions).
DO $do$
DECLARE src text; anchor text; cnt int;
BEGIN
  anchor := 'AND created_at > ''2026-08-31 20:10:00+00''';
  SELECT pg_get_functiondef(p.oid) INTO src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_suspense_regression_check';
  cnt := (length(src) - length(replace(src, anchor, ''))) / length(anchor);
  IF cnt <> 1 THEN
    RAISE EXCEPTION 'suspense floor patch: anchor matched % times (need exactly 1)', cnt;
  END IF;
  src := replace(src, anchor, 'AND created_at > ''2026-08-31 23:35:00+00''');
  EXECUTE src;
END $do$;

SELECT public.fn_ca_incident_action('2ebf1108-108b-4e0b-92d2-83ddbbe802d4'::uuid, 'resolve',
  'no-op guard: already resolved earlier this session', NULL, NULL, NULL)
WHERE false;;
