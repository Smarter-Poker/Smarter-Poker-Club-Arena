-- Version reserved by scripts/new-migration.mjs against protected main and remote branches.
-- 20261015222121 counted every dealt player but omitted zero payers from the
-- contribution map. The unchanged accepted-hand door binds num_players to
-- that map's key count; raked hands with zero payers refused and rolled back.
-- Mirror the physical engine's complete dealt map. Promo stays positive-only.
-- Fees, eligibility, stacks and historical records remain unchanged.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure)) = '0670ed75762f05e7ad3346a1c95e84dc')
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '20s';
DO $patch$
DECLARE
  sig constant regprocedure := 'public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure;
  before text := pg_get_functiondef(sig);
  after text;
  security_before jsonb;
  a text[] := ARRAY[$a$    SELECT coalesce(jsonb_object_agg(x ->> 'player_id', (x ->> 'contributed')::numeric)
                      FILTER (WHERE (x ->> 'contributed')::numeric > 0), '{}'::jsonb)$a$, $a$      INTO v_promo FROM jsonb_each(v_contrib) e;$a$];
  b text[] := ARRAY[$b$    -- The accepted-hand envelope counts every dealt player, including zero payers.
    -- Promo playthrough below remains restricted to positive contributions.
    SELECT coalesce(jsonb_object_agg(x ->> 'player_id', (x ->> 'contributed')::numeric), '{}'::jsonb)$b$, $b$      INTO v_promo FROM jsonb_each(v_contrib) e WHERE (e.value::text)::numeric > 0;$b$];
  k integer;
BEGIN
  IF current_user <> 'postgres' OR session_user <> 'postgres'
     OR NULLIF(current_setting('request.jwt.claims', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'lightning_settlement_operator_refused';
  END IF;
  IF NULLIF(current_setting('ca.break_window_migration_override', true), '') IS NOT NULL
     OR public.fn_platform_frozen() IS DISTINCT FROM false
     OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN
    RAISE EXCEPTION 'lightning_settlement_freeze_or_override_refused';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261018230728') THEN
    RAISE EXCEPTION 'lightning_settlement_migration_replay_refused';
  END IF;
  IF md5(before) <> '0432654c1fd742eeedb2920140cda3b5' THEN
    RAISE EXCEPTION 'lightning_settlement_preimage_refused: %', md5(before);
  END IF;
  SELECT jsonb_build_array(proowner, prosecdef, provolatile, proconfig, proacl)
    INTO security_before FROM pg_proc WHERE oid = sig;
  after := before;
  FOR k IN 1..array_length(a, 1) LOOP
    IF (length(after) - length(replace(after, a[k], ''))) / length(a[k]) <> 1 THEN
      RAISE EXCEPTION 'lightning_settlement_anchor_refused: %', k;
    END IF;
    after := replace(after, a[k], b[k]);
  END LOOP;
  IF md5(after) <> '0670ed75762f05e7ad3346a1c95e84dc' THEN
    RAISE EXCEPTION 'lightning_settlement_derived_postimage_refused: %', md5(after);
  END IF;
  EXECUTE after;
  IF md5(pg_get_functiondef(sig)) <> '0670ed75762f05e7ad3346a1c95e84dc'
     OR (SELECT jsonb_build_array(proowner, prosecdef, provolatile, proconfig, proacl)
           FROM pg_proc WHERE oid = sig) IS DISTINCT FROM security_before THEN
    RAISE EXCEPTION 'lightning_settlement_postimage_or_security_refused';
  END IF;
END $patch$;
COMMIT;
