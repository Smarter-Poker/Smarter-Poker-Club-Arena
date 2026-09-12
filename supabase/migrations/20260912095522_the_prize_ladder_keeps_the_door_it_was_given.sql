-- ============================================================================
-- THE PRIZE LADDER KEEPS THE DOOR IT WAS GIVEN
-- ============================================================================
--
-- Migration 20260912090000 replaced fn_tournament_place_prize_exact, and a
-- replacement is not a repair: the old function had to be DROPPED because it
-- gained a parameter, and what came back was a NEW object with NEW default
-- privileges. In this project those defaults grant EXECUTE to anon,
-- authenticated and service_role on every function created in public.
--
-- The old function's ACL was {postgres=X/postgres}. Nobody but the owner could
-- call it. The new one came back reachable by anon, and it is SECURITY
-- DEFINER, so it ran as the owner past RLS for a caller with no account.
--
-- THE REVOKE IN THAT MIGRATION WAS REAL AND IT WAS NOT ENOUGH. It revoked from
-- PUBLIC, which removed the `=X/postgres` entry, and the assertion that
-- followed checked exactly that one thing: grantee 0. The anon, authenticated
-- and service_role grants are separate entries and neither the REVOKE nor the
-- assertion touched them, so the migration proved the part it had thought of
-- and stayed silent about the part it had not. A narrow assertion that passes
-- is more dangerous than no assertion at all, because it reads as a guarantee.
--
-- The pre-push hook check-definer-authorization caught it before the branch
-- left the machine. This migration restores the door to exactly where it was
-- and asserts the whole ACL rather than one entry of it.
--
-- The three helpers introduced by the same migration are closed here too.
-- fn_ca_prize_ladder and fn_ca_prize_entries are pure arithmetic and
-- fn_ca_tournament_unit_cents is SECURITY INVOKER, so none of them is the
-- hazard the hook names. They are closed anyway, because every one of them is
-- called only from inside a SECURITY DEFINER function owned by postgres, which
-- can execute them regardless, and because the money functions in this estate
-- are postgres-only. A helper reachable by anon is a door nobody opened on
-- purpose.
--
-- No function body changes here. Privileges only.
--
-- THE REVOKES ARE WRITTEN OUT ONE STATEMENT AT A TIME rather than looped over
-- an array of signatures, and that is deliberate. check-definer-authorization
-- models what a browser can reach by reading the migrations themselves and
-- applying every GRANT and REVOKE to the roles it actually NAMES. A revoke
-- issued through EXECUTE format(...) names nothing it can see, so a loop would
-- close the door in the database while leaving the gate certain it was open.
-- The gate is not being satisfied here at the expense of the truth: these are
-- the same four functions and the same four roles either way.
--
-- Each one names PUBLIC as well as the roles, because anon inherits whatever
-- PUBLIC holds and revoking anon alone reads as a fix and does nothing.
--
-- Applied once to kuklfnapbkmacvwxktbh. Never reapply.
-- ============================================================================

REVOKE ALL ON FUNCTION
  public.fn_tournament_place_prize_exact(numeric, text, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION
  public.fn_ca_prize_ladder(bigint, jsonb, integer)
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION
  public.fn_ca_prize_entries(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION
  public.fn_ca_tournament_unit_cents(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

DO $do$
DECLARE
  c_fns constant text[] := ARRAY[
    'public.fn_tournament_place_prize_exact(numeric,text,integer,integer)',
    'public.fn_ca_prize_ladder(bigint,jsonb,integer)',
    'public.fn_ca_prize_entries(jsonb)',
    'public.fn_ca_tournament_unit_cents(uuid)'
  ];
  v_fn text;
  v_open text := '';
  v_owner oid;
BEGIN
  -- THE WHOLE ACL, not one entry of it. Grantee 0 is PUBLIC; anything that is
  -- not the owner is a door, whatever it is called.
  --
  -- A NULL proacl IS NOT AN EMPTY ACL. It means the object still carries the
  -- built-in defaults, and the built-in default for a function is EXECUTE to
  -- PUBLIC. aclexplode(NULL) returns no rows, so an EXISTS over it reports
  -- "no grants" for the most open state there is. That is the same shape of
  -- mistake this migration exists to repair, so it is spelled out rather than
  -- left to the reader.
  FOREACH v_fn IN ARRAY c_fns LOOP
    SELECT proowner INTO v_owner FROM pg_proc WHERE oid = v_fn::regprocedure;
    IF (SELECT proacl IS NULL FROM pg_proc WHERE oid = v_fn::regprocedure) THEN
      v_open := v_open || ' ' || v_fn || '(default-open)';
    ELSIF EXISTS (
      SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
       WHERE p.oid = v_fn::regprocedure AND a.grantee IS DISTINCT FROM v_owner
    ) THEN
      v_open := v_open || ' ' || v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn::regprocedure, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE') THEN
      v_open := v_open || ' ' || v_fn || '(reachable)';
    END IF;
  END LOOP;

  IF v_open <> '' THEN
    RAISE EXCEPTION 'these prize ladder functions are still reachable by someone other than their owner:%', v_open;
  END IF;

  -- The one that regressed is restored to the exact ACL it carried before
  -- 20260912090000 dropped and recreated it.
  IF (SELECT proacl::text FROM pg_proc
       WHERE oid = 'public.fn_tournament_place_prize_exact(numeric,text,integer,integer)'::regprocedure)
     <> '{postgres=X/postgres}' THEN
    RAISE EXCEPTION 'fn_tournament_place_prize_exact ACL is %, expected the {postgres=X/postgres} it had before',
      (SELECT proacl::text FROM pg_proc
        WHERE oid = 'public.fn_tournament_place_prize_exact(numeric,text,integer,integer)'::regprocedure);
  END IF;

  -- It is still the function the ladder migration made it.
  IF (SELECT prosecdef FROM pg_proc
       WHERE oid = 'public.fn_tournament_place_prize_exact(numeric,text,integer,integer)'::regprocedure) IS NOT TRUE
     OR (SELECT provolatile FROM pg_proc
          WHERE oid = 'public.fn_tournament_place_prize_exact(numeric,text,integer,integer)'::regprocedure) <> 'i' THEN
    RAISE EXCEPTION 'fn_tournament_place_prize_exact lost IMMUTABLE or SECURITY DEFINER';
  END IF;

  RAISE NOTICE 'prize ladder: all four functions are owner-only again';
END;
$do$;
