-- Reserved using scripts/reserve-migration-version.sh.
-- The add-on purchase window permits play until its final configured break.
-- Match the manager's 1..10-minute clamp while holding the same parent lock.
-- Preserve the already-applied authority body, metadata and grants.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $patch$
DECLARE
  v_oid regprocedure := 'public.fn_publish_tournament_blind_level(uuid,uuid,integer,integer,numeric,numeric,numeric)'::regprocedure;
  v_source text;
  v_needle text := $needle$  IF COALESCE(v_t.on_break,false) OR public.fn_platform_frozen() THEN$needle$;
  v_replacement text := $replacement$  IF COALESCE(v_t.on_break,false) OR public.fn_platform_frozen()
     OR (COALESCE(v_t.add_on_available,false)
         AND COALESCE(v_t.addon_period_triggered,false)
         AND NOT COALESCE(v_t.prize_pool_finalized,false)
         AND v_t.addon_period_ends_at>clock_timestamp()
         AND clock_timestamp()>=v_t.addon_period_ends_at-make_interval(mins =>
           LEAST(10,GREATEST(1,COALESCE(v_t.addon_break_minutes,1))))) THEN$replacement$;
BEGIN
  SELECT prosrc INTO v_source FROM pg_proc WHERE oid=v_oid;
  IF md5(v_source)='ea893550ec280993c522bb8dfb78fcd3' THEN RETURN; END IF;
  IF md5(v_source) IS DISTINCT FROM '4d74d457a6883d4c7786caa0301a9028' THEN
    RAISE EXCEPTION 'Blind publication add-on guard refuses unreviewed source';
  END IF;
  EXECUTE replace(pg_get_functiondef(v_oid),v_needle,v_replacement);
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=v_oid) IS DISTINCT FROM 'ea893550ec280993c522bb8dfb78fcd3' THEN
    RAISE EXCEPTION 'Blind publication add-on guard failed source verification';
  END IF;
END;
$patch$;
COMMIT;
