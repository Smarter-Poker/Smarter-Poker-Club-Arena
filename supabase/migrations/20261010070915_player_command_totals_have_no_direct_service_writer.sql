-- Supabase defaults can grant service_role ALL on new tables. The projection
-- is owned exclusively by the source-fact transaction, never a direct writer.
BEGIN;
SET LOCAL lock_timeout = '2s';
REVOKE ALL ON public.club_roster_hand_totals, public.club_roster_hand_totals_state FROM service_role;
GRANT SELECT ON public.club_roster_hand_totals, public.club_roster_hand_totals_state TO service_role;
REVOKE ALL ON FUNCTION public.fn_club_roster_hand_totals_insert(), public.fn_club_roster_hand_totals_update(), public.fn_club_roster_hand_totals_delete() FROM service_role;
COMMIT;
