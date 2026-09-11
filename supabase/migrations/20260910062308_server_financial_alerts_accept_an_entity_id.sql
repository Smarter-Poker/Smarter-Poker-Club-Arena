-- 20260910062115_server_financial_alerts_accept_an_entity_id
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-10 06:21:15 UTC.
--
-- WHAT WAS WRONG
--
-- The engine has six call sites for fn_raise_server_financial_alert. Four of
-- them (HorseFleetManager.ts x2, StableHandExecutor.ts, financialAlerts.ts)
-- send a `p_entity_id` argument. The only signature in production was
--
--     (p_severity text, p_source text, p_message text,
--      p_context jsonb DEFAULT '{}', p_dedupe_key text DEFAULT NULL)
--
-- PostgREST resolves an RPC by the exact set of named arguments, so every one
-- of those four calls has been answered 404 PGRST202 and the alert was never
-- written. Found in the 2026-09-10 incident sweep of every /rest/v1/rpc 404
-- in the previous 24 h: after the two seat-move functions (fixed in
-- 20260910051125) this was the only other one. Both occurrences in that window
-- were "Stable Hand controller silent" warnings - exactly the kind of thing
-- that should reach the alerts table.
--
-- WHAT THIS DOES
--
-- Recreates the function with one extra trailing parameter,
-- `p_entity_id text DEFAULT NULL`. It cannot be an overload: Postgres
-- overloads by argument TYPES, and (text,text,text,jsonb,text) is already
-- taken by the existing signature; nor can CREATE OR REPLACE rename a
-- parameter. So the old five-argument function is dropped and the
-- six-argument one created in the same transaction. Nothing depends on the
-- old signature by OID (pg_depend checked before writing this); plpgsql
-- callers resolve by name at run time and positional callers with three to
-- five arguments still bind.
--
-- Behaviour for every existing call shape is unchanged. When p_entity_id is
-- given it is recorded in context.entity_id and, if no explicit dedupe key
-- was sent, it becomes the dedupe key - one open alert per entity per source,
-- which is what the callers mean by it. The body is otherwise the previous
-- body verbatim.

DROP FUNCTION public.fn_raise_server_financial_alert(text, text, text, jsonb, text);

CREATE FUNCTION public.fn_raise_server_financial_alert(
  p_severity text,
  p_source text,
  p_message text,
  p_context jsonb DEFAULT '{}'::jsonb,
  p_dedupe_key text DEFAULT NULL::text,
  p_entity_id text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id     uuid;
  v_sev    text;
  v_source text;
  v_key    text;
  v_entity text;
  v_recent integer;
BEGIN
  v_sev := lower(coalesce(p_severity, 'info'));
  IF v_sev NOT IN ('critical', 'warning', 'info') THEN
    v_sev := 'info';
  END IF;

  v_source := left(coalesce(nullif(p_source, ''), 'unknown'), 200);
  v_entity := left(nullif(btrim(coalesce(p_entity_id, '')), ''), 200);
  v_key    := left(nullif(btrim(coalesce(p_dedupe_key, '')), ''), 200);
  IF v_key IS NULL THEN
    v_key := v_entity;
  END IF;

  /* ONE OPEN ALERT PER THING THAT IS WRONG. Not per pass over it. */
  IF v_key IS NOT NULL THEN
    SELECT fa.id INTO v_id
      FROM public.financial_alerts fa
     WHERE fa.source = v_source
       AND fa.resolved IS NOT TRUE
       AND fa.context ->> 'dedupe_key' = v_key
     ORDER BY fa.created_at DESC
     LIMIT 1;
    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  SELECT count(*) INTO v_recent
    FROM public.financial_alerts
   WHERE created_at > now() - interval '1 minute'
     AND source = v_source
     AND context ->> 'channel' = 'server_rpc';

  IF v_recent >= 60 THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.financial_alerts (severity, source, message, context, resolved)
  VALUES (
    v_sev,
    v_source,
    left(coalesce(nullif(p_message, ''), '(no message)'), 4000),
    coalesce(p_context, '{}'::jsonb)
      || jsonb_build_object('channel', 'server_rpc')
      || CASE WHEN v_key IS NULL THEN '{}'::jsonb
              ELSE jsonb_build_object('dedupe_key', v_key) END
      || CASE WHEN v_entity IS NULL THEN '{}'::jsonb
              ELSE jsonb_build_object('entity_id', v_entity) END,
    false
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_raise_server_financial_alert(text, text, text, jsonb, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_raise_server_financial_alert(text, text, text, jsonb, text, text)
  TO service_role;

COMMENT ON FUNCTION public.fn_raise_server_financial_alert(text, text, text, jsonb, text, text) IS
  'Server-side financial alert. p_dedupe_key (or, failing that, p_entity_id) keeps one open alert per thing that is wrong; p_entity_id is also recorded in context.entity_id. Six-argument form since 2026-09-10 because four engine call sites send p_entity_id and were being answered 404.';

DO $verify$
BEGIN
  IF to_regprocedure('public.fn_raise_server_financial_alert(text,text,text,jsonb,text,text)') IS NULL THEN
    RAISE EXCEPTION 'six-argument fn_raise_server_financial_alert was not created';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'fn_raise_server_financial_alert') <> 1 THEN
    RAISE EXCEPTION 'expected exactly one fn_raise_server_financial_alert signature (PostgREST would report the call ambiguous)';
  END IF;
  IF has_function_privilege('anon', 'public.fn_raise_server_financial_alert(text,text,text,jsonb,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_raise_server_financial_alert(text,text,text,jsonb,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fn_raise_server_financial_alert(text,text,text,jsonb,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_raise_server_financial_alert grants are wrong';
  END IF;
END;
$verify$;
