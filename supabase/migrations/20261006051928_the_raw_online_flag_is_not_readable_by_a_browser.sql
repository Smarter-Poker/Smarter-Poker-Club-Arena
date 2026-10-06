-- Applied to production as version 20261006051928 (match by name).
--
-- THE RAW ONLINE FLAG IS NOT READABLE BY A BROWSER
--
-- Presence has one door, fn_profile_presence (fresh heartbeat or a live seat).
-- No browser code reads profiles.is_online raw any more (Club Arena #6174,
-- #6182, World Hub #2156); the raw flag, stale for most accounts, told a
-- person from a horse. Signed-in players keep UPDATE for their heartbeat.
--
-- @live-proof: (NOT has_column_privilege('authenticated', 'public.profiles', 'is_online', 'SELECT') AND NOT has_column_privilege('anon', 'public.profiles', 'is_online', 'SELECT') AND has_column_privilege('authenticated', 'public.profiles', 'is_online', 'UPDATE'))

REVOKE SELECT (is_online) ON TABLE public.profiles FROM PUBLIC, anon, authenticated;

DO $post$
DECLARE v_probe uuid;
BEGIN
  IF has_column_privilege('authenticated', 'public.profiles', 'is_online', 'SELECT')
     OR has_column_privilege('anon', 'public.profiles', 'is_online', 'SELECT') THEN
    RAISE EXCEPTION 'a browser role still reads profiles.is_online';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.profiles', 'is_online', 'UPDATE') THEN
    RAISE EXCEPTION 'the heartbeat lost its write';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.fn_profile_presence(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'presence lost its door';
  END IF;

  -- Prove the heartbeat still works as a signed-in player, then undo the probe.
  SELECT p.id INTO v_probe FROM public.profiles p
   WHERE NOT EXISTS (SELECT 1 FROM public.content_authors c WHERE c.profile_id = p.id)
     AND coalesce(p.status, '') <> 'deleted'
   ORDER BY p.created_at LIMIT 1;
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_probe)::text, true);
    SET LOCAL ROLE authenticated;
    PERFORM public.fn_update_presence(v_probe, true);
    RESET ROLE;
    RAISE EXCEPTION 'probe-ok';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'probe-ok' THEN RAISE; END IF;
  END;
  RESET ROLE;
END
$post$;

NOTIFY pgrst, 'reload schema';
