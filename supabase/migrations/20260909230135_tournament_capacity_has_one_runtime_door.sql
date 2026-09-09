/*
 * The three service-only functions below were one-time incident tools. They
 * are not tournament runtime authorities: one searched for stranded stacks,
 * one cloned a table row, and one moved a seat for the search result. Keeping
 * them callable after the measured incident is closed would preserve a second
 * seat/capacity write path beside the manager's canonical database functions.
 *
 * Their applied source migrations stay in the repository as immutable
 * provenance. This later migration removes only the live callable surface.
 */
BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SET LOCAL transaction_timeout = '90s';

DO $preflight$
BEGIN
  IF to_regprocedure(
       'public.fn_ca_return_stranded_to_the_felt(uuid,boolean,integer)'
     ) IS NULL
     OR to_regprocedure(
       'public.fn_ca_restore_tournament_felt(uuid,boolean,integer)'
     ) IS NULL
     OR to_regprocedure(
       'public.fn_ca_move_tournament_seat(uuid,uuid,uuid,integer,text)'
     ) IS NULL THEN
    RAISE EXCEPTION 'one-time tournament capacity door is already absent';
  END IF;
END
$preflight$;

REVOKE ALL ON FUNCTION
  public.fn_ca_return_stranded_to_the_felt(uuid,boolean,integer)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION
  public.fn_ca_restore_tournament_felt(uuid,boolean,integer)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION
  public.fn_ca_move_tournament_seat(uuid,uuid,uuid,integer,text)
  FROM PUBLIC,anon,authenticated,service_role;

-- Dependency order: the batch helper called the mover. RESTRICT refuses to
-- hide any unmeasured database dependency.
DROP FUNCTION public.fn_ca_return_stranded_to_the_felt(uuid,boolean,integer) RESTRICT;
DROP FUNCTION public.fn_ca_restore_tournament_felt(uuid,boolean,integer) RESTRICT;
DROP FUNCTION public.fn_ca_move_tournament_seat(uuid,uuid,uuid,integer,text) RESTRICT;

DO $postcondition$
BEGIN
  IF to_regprocedure(
       'public.fn_ca_return_stranded_to_the_felt(uuid,boolean,integer)'
     ) IS NOT NULL
     OR to_regprocedure(
       'public.fn_ca_restore_tournament_felt(uuid,boolean,integer)'
     ) IS NOT NULL
     OR to_regprocedure(
       'public.fn_ca_move_tournament_seat(uuid,uuid,uuid,integer,text)'
     ) IS NOT NULL THEN
    RAISE EXCEPTION 'one-time tournament capacity door survived retirement';
  END IF;
END
$postcondition$;

COMMIT;
