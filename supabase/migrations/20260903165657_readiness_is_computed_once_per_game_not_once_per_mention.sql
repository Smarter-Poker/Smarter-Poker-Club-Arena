-- The board computed each tournament's readiness five times to render it once.
--
-- fn_list_managed_games builds every row's contract with two stacked LATERALs:
-- `rr` calls fn_tournament_management_readiness(p.id), and `r` reads rr twice
-- (the payload, and ->> 'contract_locked'). Those references are then read
-- again by the enclosing jsonb_build_object. The LATERALs look like they pin
-- the call down to one evaluation. They do not: the planner flattens both
-- subqueries, and a flattened subquery's expression is re-evaluated at EVERY
-- reference. Measured on Midway Union, 50 rows:
--
--   readiness alone, 50 tournaments .............  40.9 ms   7,401 buffers
--   the same 50 rows through the contract .......  214.5 ms  13,824 buffers
--                                                  4.204 ms per row
--
-- 0.8ms of work billed at 4.2ms. OFFSET 0 is the standard optimisation fence:
-- it is a no-op semantically and it makes the subquery un-flattenable, so the
-- function is evaluated once and its result carried. Same plan shape, same
-- output, one call:
--
--   with the fences ............................. 32.5 ms  7,122 buffers
--                                                 0.640 ms per row
--
-- 6.6x on the row half of every page the board draws, and the buffer count
-- lands on top of the standalone measurement, which is how we know the extra
-- calls are gone rather than merely cheaper.
--
-- WHY THIS IS A PATCH AND NOT A REWRITTEN FUNCTION BODY. The change is two
-- lines inside a 12KB function. Retyping the other 12KB to add them is the
-- larger risk: a dropped line in the counts block or the cursor logic would be
-- silent, and this function decides what an operator sees about live money.
-- So the migration reads the deployed definition, refuses to touch anything it
-- does not recognise, applies the two fences by exact text, and asserts the
-- result. Nothing outside the two anchors can change.
DO $$
DECLARE
  v_src     text;
  v_patched text;
  v_oid     oid;
  -- The revision this migration was written against and measured on.
  c_expected_md5 constant text := '1b37ecec89cd9442736c72ec5cb43c6b';
BEGIN
  SELECT p.oid INTO v_oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_list_managed_games';

  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'fn_list_managed_games does not exist';
  END IF;

  v_src := pg_get_functiondef(v_oid);

  -- Already fenced (re-run, or applied by hand). Nothing to do, and NOT an
  -- error: a migration that cannot be replayed is a migration that blocks a
  -- rebuild.
  IF position('OFFSET 0' in v_src) > 0 THEN
    RAISE NOTICE 'fn_list_managed_games already carries the fences; skipping.';
    RETURN;
  END IF;

  IF md5(v_src) <> c_expected_md5 THEN
    RAISE EXCEPTION
      'fn_list_managed_games is not the revision this migration was written against. Expected md5 %, found %. Re-read the deployed definition and re-derive the anchors before applying.',
      c_expected_md5, md5(v_src);
  END IF;

  v_patched := replace(
    v_src,
    E'                  END AS readiness\n         ) rr',
    E'                  END AS readiness\n           OFFSET 0\n         ) rr'
  );
  v_patched := replace(
    v_patched,
    E'                  COALESCE((rr.readiness ->> ''contract_locked'')::boolean,false) AS locked\n         ) r',
    E'                  COALESCE((rr.readiness ->> ''contract_locked'')::boolean,false) AS locked\n           OFFSET 0\n         ) r'
  );

  -- Both anchors, or neither. A single fence would leave the second LATERAL
  -- flattened and quietly keep most of the cost.
  IF (length(v_patched) - length(v_src)) <> (2 * length(E'           OFFSET 0\n')) THEN
    RAISE EXCEPTION
      'expected exactly two fences to be inserted, got % bytes of change',
      length(v_patched) - length(v_src);
  END IF;

  EXECUTE v_patched;

  IF position('OFFSET 0' in pg_get_functiondef(v_oid)) = 0 THEN
    RAISE EXCEPTION 'the fences did not survive the replace';
  END IF;
END $$;