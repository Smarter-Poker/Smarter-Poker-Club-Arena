-- 20261022170611_mystery_bounty_seed_reports_the_whole_chip_pool_it_sealed.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- 20261022170421 seals every mystery chest on whole chips and records the
-- sealed total as tournaments.mystery_bounty_pool_cents. Its return value
-- still reported the pre-cut pool (proved in a rolled-back probe: a 1,000.37
-- pool sealed as 500 + 500 and returned pool_cents 100037). The engine
-- broadcasts that number as the chest pool, so the table would announce
-- 1,000.37 for chests that hold 1,000. The seed now returns the total it
-- sealed. Nothing else changes.

-- @live-proof: (SELECT position('''pool_cents'', v_sealed_cents' IN pg_get_functiondef('public.fn_mystery_bounty_seed(uuid,integer,jsonb)'::regprocedure)) > 0)

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $seed$
DECLARE
  sig constant regprocedure := 'public.fn_mystery_bounty_seed(uuid,integer,jsonb)'::regprocedure;
  d text;
  a0 constant text := E'  v_norm jsonb;\n';
  a1 constant text := E'''already_seeded'', false,\n    ''pool_cents'', v_pool_cents,';
BEGIN
  d := pg_get_functiondef(sig);
  IF position('v_sealed_cents' IN d) > 0 THEN RETURN; END IF;
  IF (length(d) - length(replace(d, a0, ''))) / length(a0) <> 1
     OR (length(d) - length(replace(d, a1, ''))) / length(a1) <> 1 THEN
    RAISE EXCEPTION 'fn_mystery_bounty_seed changed shape; sealed pool report not installed';
  END IF;
  d := replace(d, a0, a0 || E'  v_sealed_cents bigint;\n');
  d := replace(d, a1,
       E'''already_seeded'', false,\n'
    || E'    ''pool_cents'', v_sealed_cents,');
  d := replace(d, E'  RETURN jsonb_build_object(''ok'', true, ''already_seeded'', false,',
       E'  SELECT sum((x->>''amount_cents'')::bigint) INTO v_sealed_cents\n'
    || E'    FROM jsonb_array_elements(v_norm) x;\n\n'
    || E'  RETURN jsonb_build_object(''ok'', true, ''already_seeded'', false,');
  IF position('INTO v_sealed_cents' IN d) = 0 THEN
    RAISE EXCEPTION 'fn_mystery_bounty_seed return not found';
  END IF;
  EXECUTE d;
END
$seed$;

COMMIT;
