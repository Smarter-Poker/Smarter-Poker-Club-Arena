CREATE OR REPLACE FUNCTION public.fn_ca_guard_defs_watch()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_name text; v_hash text; v_stored text; v_changes int := 0;
  v_def text; v_old_id bigint; v_new_id bigint;
BEGIN
  FOREACH v_name IN ARRAY public.fn_ca_guard_watchlist()
  LOOP
    SELECT md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)),
           string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)
      INTO v_hash, v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;

    IF v_hash IS NULL THEN
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_guard_defs_watch', 'unknown', 'warning',
        'guard-def-missing:' || v_name,
        0, NULL, NULL, 'reporting', 'pg_proc',
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'guard function ' || v_name || ' no longer exists - an alarm was deleted',
        true, jsonb_build_object('guard', v_name));
      v_changes := v_changes + 1;
      CONTINUE;
    END IF;

    -- Keep the text, always, so a later notice has something to diff against.
    INSERT INTO public.ca_guard_def_history (proname, def_hash, def_text)
    VALUES (v_name, v_hash, v_def)
    ON CONFLICT (proname, def_hash) DO NOTHING;

    SELECT def_hash INTO v_stored FROM public.ca_guard_defs WHERE proname = v_name;
    IF v_stored IS NULL THEN
      INSERT INTO public.ca_guard_defs (proname, def_hash) VALUES (v_name, v_hash)
      ON CONFLICT (proname) DO NOTHING;
    ELSIF v_stored <> v_hash THEN
      v_changes := v_changes + 1;

      SELECT id INTO v_old_id FROM public.ca_guard_def_history
       WHERE proname = v_name AND def_hash = v_stored;
      SELECT id INTO v_new_id FROM public.ca_guard_def_history
       WHERE proname = v_name AND def_hash = v_hash;

      /* A newer notice for the same guard supersedes the older one: the
         key carries the new hash, so an old notice can never be matched
         again and would sit open forever. */
      UPDATE public.ca_drift_incidents
         SET status = 'resolved', resolved_at = now(),
             resolution = 'superseded: ' || v_name || ' was redefined again, and the newer notice carries the current definition'
       WHERE source = 'fn_ca_guard_defs_watch'
         AND status <> 'resolved'
         AND dedupe_key LIKE 'guard-def-drift:' || v_name || ':%';

      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_guard_defs_watch', 'unknown', 'info',
        'guard-def-drift:' || v_name || ':' || left(v_hash, 12),
        0, NULL, NULL, 'reporting', 'pg_proc',
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'guard function ' || v_name || ' was redefined since its last baseline. '
          || CASE WHEN v_old_id IS NULL
                  THEN 'The previous text was never captured (it changed before this watcher kept history), so review the current definition on its own.'
                  ELSE 'Diff it: select def_text from ca_guard_def_history where id in ('
                       || v_old_id || ',' || v_new_id || ')'
             END
          || ' Then resolve this notice - it does not close itself.',
        true, jsonb_build_object('guard', v_name, 'old_hash', v_stored, 'new_hash', v_hash,
                                 'old_history_id', v_old_id, 'new_history_id', v_new_id));
      UPDATE public.ca_guard_defs
         SET def_hash = v_hash, updated_at = now() WHERE proname = v_name;
    END IF;
  END LOOP;
  RETURN v_changes;
END $function$
