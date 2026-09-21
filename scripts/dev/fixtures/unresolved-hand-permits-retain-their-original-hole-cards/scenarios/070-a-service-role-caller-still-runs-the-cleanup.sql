-- KEPT. public.cleanup_old_hole_cards() is SECURITY INVOKER and service_role
-- holds EXECUTE on it, while smarter_private.f06_hand_permits is readable by
-- postgres alone. A retention predicate that read the permit table directly
-- from this invoker body would raise 'permission denied for table
-- f06_hand_permits' for that caller - a failure mode the repair must not add.
-- The definer helper is what keeps this scenario green.
\set ON_ERROR_STOP on
DO $s$
DECLARE t uuid := probe.table_of('svc');
BEGIN
  PERFORM probe.deal(t, 4242, interval '25 hours', 2);
  PERFORM probe.permit(t, 4242, 'reserved');
END $s$;

SET ROLE service_role;
SELECT public.cleanup_old_hole_cards();
RESET ROLE;

DO $s$
DECLARE t uuid := md5('table:svc')::uuid;
BEGIN
  -- RLS policy block_hole_cards_delete already made this caller's delete a
  -- no-op before the repair; what matters is that it still does not raise.
  PERFORM probe.check(probe.cards(t, 4242) = 2,
    'a service_role caller runs the cleanup without raising, and deletes nothing under RLS');
END $s$;
