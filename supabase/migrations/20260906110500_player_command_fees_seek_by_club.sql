-- PLAYER COMMAND: THE CLUB-SCOPED FEE READ MUST SEEK BY CLUB.
--
-- ca_club_roster_rows correctly derives fee totals from ca_hand_facts for the
-- selected club. The fact table only had user-first and time-first indexes,
-- however, so opening a staff roster could scan the full retained fact set
-- before grouping the selected club's members. Production E2E runs
-- 34023330596 and 34026631034 both observed that cold path exceed 45 seconds.
--
-- This covering index matches the roster aggregate exactly. CONCURRENTLY is
-- load-bearing: ca_hand_facts is written at hand settlement and its writes
-- must not queue behind an index build.

CREATE INDEX CONCURRENTLY IF NOT EXISTS ca_hand_facts_club_user_roster_idx
  ON public.ca_hand_facts (club_id, user_id)
  INCLUDE (hand_id, rake_paid)
  WHERE club_id IS NOT NULL;

ANALYZE public.ca_hand_facts;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relname = 'ca_hand_facts_club_user_roster_idx'
       AND i.indisvalid
       AND i.indisready
  ) THEN
    RAISE EXCEPTION 'ca_hand_facts_club_user_roster_idx is missing or invalid';
  END IF;
END
$verify$;

COMMENT ON INDEX public.ca_hand_facts_club_user_roster_idx IS
  'Covering seek for current-club Player Command fee and hand totals; avoids scanning other clubs or account-lifetime facts.';

-- ROLLBACK (outside a transaction on production):
-- DROP INDEX CONCURRENTLY IF EXISTS public.ca_hand_facts_club_user_roster_idx;
