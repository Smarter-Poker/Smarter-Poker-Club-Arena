-- Read-only SOURCE metadata. Output is private SQL for the exact disposable
-- destination, inside its parent's transaction; never execute on source.
SET search_path=pg_catalog;
SELECT format($output$
DO $extension_trigger$
DECLARE observed record; prior_search_path text:=current_setting('search_path');
BEGIN
  IF session_user<>'leaderboard_qualification_bootstrap'
     OR inet_server_addr() IS NOT NULL OR current_database()<>'postgres' THEN
    RAISE EXCEPTION 'Exact isolated bootstrap socket required';
  END IF;
  -- Native deparsers must use the same name visibility as the source reader.
  -- Restore the caller setting before this block returns; errors abort parent.
  PERFORM pg_catalog.set_config('search_path','pg_catalog',true);
  SELECT pg_catalog.pg_get_triggerdef(t.oid) AS definition,t.tgenabled::text AS enabled
    INTO observed FROM pg_catalog.pg_trigger t
    WHERE t.tgrelid=pg_catalog.to_regclass(%1$L) AND t.tgname=%2$L AND NOT t.tgisinternal;
  IF FOUND THEN
    IF observed.definition IS DISTINCT FROM %3$L OR observed.enabled IS DISTINCT FROM %4$L THEN
      RAISE EXCEPTION 'Existing extension-table trigger differs from source';
    END IF;
  ELSE
    EXECUTE %3$L;
    EXECUTE %5$L;
    SELECT pg_catalog.pg_get_triggerdef(t.oid) AS definition,t.tgenabled::text AS enabled
      INTO STRICT observed FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid=pg_catalog.to_regclass(%1$L) AND t.tgname=%2$L AND NOT t.tgisinternal;
    IF observed.definition IS DISTINCT FROM %3$L OR observed.enabled IS DISTINCT FROM %4$L THEN
      RAISE EXCEPTION 'Restored extension-table trigger differs from source';
    END IF;
  END IF;
  PERFORM pg_catalog.set_config('search_path',prior_search_path,true);
END $extension_trigger$;
$output$,format('%I.%I',n.nspname,c.relname),t.tgname,
  pg_get_triggerdef(t.oid),t.tgenabled::text,
  format('ALTER TABLE %I.%I %s TRIGGER %I',n.nspname,c.relname,
    CASE t.tgenabled WHEN 'O' THEN 'ENABLE' WHEN 'D' THEN 'DISABLE'
      WHEN 'R' THEN 'ENABLE REPLICA' WHEN 'A' THEN 'ENABLE ALWAYS' END,t.tgname))
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
JOIN pg_depend relation_dependency ON relation_dependency.classid='pg_class'::regclass
  AND relation_dependency.objid=c.oid AND relation_dependency.refclassid='pg_extension'::regclass
  AND relation_dependency.deptype='e'
WHERE NOT t.tgisinternal AND t.tgparentid=0
  AND NOT EXISTS(SELECT 1 FROM pg_depend trigger_dependency
    WHERE trigger_dependency.classid='pg_trigger'::regclass AND trigger_dependency.objid=t.oid
      AND trigger_dependency.refclassid='pg_extension'::regclass AND trigger_dependency.deptype='e')
ORDER BY n.nspname,c.relname,t.tgname;
