-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825232610; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

DO $migrate$
DECLARE
  v_def text; v_new text; v_anchor text; v_replacement text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_agent_wallet_send';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fn_agent_wallet_send not found - refusing to guess';
  END IF;

  v_anchor :=
    '  if v_dest = ''agent_wallet''' || E'\n' ||
    '     and v_to_role not in (''owner'', ''co_owner'', ''admin'', ''super_agent'', ''agent'', ''sub_agent'') then' || E'\n' ||
    '    return jsonb_build_object(''success'', false,' || E'\n' ||
    '      ''error'', ''Only Staff Or Agents Hold An Agent Wallet'');' || E'\n' ||
    '  end if;';

  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'destination guard not found in fn_agent_wallet_send - refusing to patch blind';
  END IF;

  v_replacement := v_anchor || E'\n\n' ||
    '  -- AGENT TO AGENT ALWAYS CREDITS THE AGENT WALLET (Dan 2026-08-25).' || E'\n' ||
    '  -- Derived from the recipient, never trusted from the caller.' || E'\n' ||
    '  if v_to_role in (''owner'', ''co_owner'', ''admin'', ''super_agent'', ''agent'', ''sub_agent'') then' || E'\n' ||
    '    v_dest := ''agent_wallet'';' || E'\n' ||
    '  end if;';

  v_new := replace(v_def, v_anchor, v_replacement);
  IF v_new = v_def THEN
    RAISE EXCEPTION 'replacement was a no-op - refusing to ship an unchanged function';
  END IF;
  EXECUTE v_new;
END
$migrate$;

DO $verify$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_agent_wallet_send';
  IF position('v_dest := ''agent_wallet'';' IN v_def) = 0 THEN
    RAISE EXCEPTION 'coercion did not take: an agent can still be paid into their player balance';
  END IF;
  IF position('Only Staff Or Agents Hold An Agent Wallet' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the non-agent guard was lost';
  END IF;
END
$verify$;
