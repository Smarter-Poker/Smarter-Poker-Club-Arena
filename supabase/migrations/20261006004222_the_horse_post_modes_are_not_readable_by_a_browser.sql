-- Applied to production as version 20261006004222 (match by name).
--
-- THE HORSE POST MODES ARE NOT READABLE BY A BROWSER
--
-- horse_post_modes (the horse publishing programme's modes) had a SELECT policy
-- of `true` and a table-level grant to the browser roles. It names no player,
-- but it says the programme exists. Nothing a browser runs reads it (World Hub
-- and Club Arena checked 2026-10-06); the pipeline uses the service role.
--
-- @live-proof: (NOT has_table_privilege('anon', 'public.horse_post_modes', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.horse_post_modes', 'SELECT') AND has_table_privilege('service_role', 'public.horse_post_modes', 'SELECT'))

DO $pre$
DECLARE v text;
BEGIN
  SELECT string_agg(tablename||'.'||policyname, ', ') INTO v FROM pg_policies
   WHERE tablename <> 'horse_post_modes' AND (coalesce(qual,'')||' '||coalesce(with_check,'')) ~* 'horse_post_modes';
  IF v IS NOT NULL THEN RAISE EXCEPTION 'a policy on another table reads horse_post_modes: %', v; END IF;
  SELECT string_agg(c.relname, ', ') INTO v FROM pg_class c
   WHERE c.relkind IN ('v','m') AND pg_get_viewdef(c.oid) ~* 'horse_post_modes';
  IF v IS NOT NULL THEN RAISE EXCEPTION 'a view reads horse_post_modes: %', v; END IF;
END
$pre$;

REVOKE ALL ON TABLE public.horse_post_modes FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.horse_post_modes TO service_role;

DO $post$
BEGIN
  IF has_table_privilege('anon', 'public.horse_post_modes', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated', 'public.horse_post_modes', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'a browser role still reaches horse_post_modes';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.horse_post_modes', 'SELECT') THEN
    RAISE EXCEPTION 'the service role lost horse_post_modes';
  END IF;
END
$post$;
