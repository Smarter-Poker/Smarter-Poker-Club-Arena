-- "Review the change, then this notice self-clears" - except you cannot.
--
-- fn_ca_guard_defs_watch keeps one md5 per guard in ca_guard_defs. On a change
-- it raises an INFO notice and, in the same breath, OVERWRITES the baseline
-- with the new hash. So by the time anyone reads the notice the previous
-- definition is gone: the incident carries an old_hash and a new_hash and
-- there is no way to see what actually changed. And the notice does not
-- self-clear - it never re-raises for the same change, but it stays open until
-- a human resolves it, which is why three of them were sitting on the
-- dashboard this afternoon.
--
-- A guard notice nobody can act on is worse than no notice: it trains people
-- to resolve alarms they have not read.
--
-- This keeps the text. ca_guard_def_history is append-only and holds every
-- definition the watcher has ever seen, and the incident now carries the
-- history ids of both sides, so reviewing a change is a diff of two rows
-- rather than a comparison of two hashes.
--
-- The watcher is itself on its own watchlist, so changing it would raise a
-- notice about the change that fixes notices. Its baseline is re-set in this
-- same migration instead - which is the habit every guard change should copy:
-- CHANGE THE GUARD AND RE-BASELINE IT IN THE SAME MIGRATION, so the only
-- notices that ever reach the board are the ones nobody meant to cause.

CREATE TABLE IF NOT EXISTS public.ca_guard_def_history (
  id          bigserial PRIMARY KEY,
  proname     text        NOT NULL,
  def_hash    text        NOT NULL,
  def_text    text        NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ca_guard_def_history_proname_hash_idx
  ON public.ca_guard_def_history (proname, def_hash);

COMMENT ON TABLE public.ca_guard_def_history IS
  'Every definition fn_ca_guard_defs_watch has ever seen for a watched guard. '
  'Append-only: it exists so a guard-drift notice can be reviewed by diffing '
  'the two definitions instead of comparing two md5s.';

REVOKE ALL ON TABLE public.ca_guard_def_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.ca_guard_def_history TO service_role;

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
END $function$;

-- Seed history with what every watched guard looks like right now, so the next
-- change to any of them has a left-hand side to diff against.
INSERT INTO public.ca_guard_def_history (proname, def_hash, def_text)
SELECT g.name,
       md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)),
       string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)
  FROM unnest(public.fn_ca_guard_watchlist()) AS g(name)
  JOIN pg_proc p ON p.proname = g.name
  JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
 GROUP BY g.name
ON CONFLICT (proname, def_hash) DO NOTHING;

-- Re-baseline the watcher itself, in the same migration that changed it, so it
-- does not raise a notice about its own fix.
UPDATE public.ca_guard_defs d
   SET def_hash = (SELECT md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid))
                     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'fn_ca_guard_defs_watch'),
       updated_at = now()
 WHERE d.proname = 'fn_ca_guard_defs_watch';

DO $$
DECLARE v_seeded int; v_self int;
BEGIN
  SELECT count(*) INTO v_seeded FROM public.ca_guard_def_history;
  IF v_seeded < 20 THEN
    RAISE EXCEPTION 'guard history seeded only % rows - the watchlist has more guards than that', v_seeded;
  END IF;

  SELECT count(*) INTO v_self
    FROM public.ca_guard_defs d
   WHERE d.proname = 'fn_ca_guard_defs_watch'
     AND d.def_hash = (SELECT md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid))
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND p.proname = 'fn_ca_guard_defs_watch');
  IF v_self <> 1 THEN
    RAISE EXCEPTION 'the watcher did not re-baseline itself and will raise a notice about its own fix';
  END IF;
END $$;
