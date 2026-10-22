-- 20261022032422_union_bank_reads_its_club_balances.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, 2026-10-21: "WHEN I AM IN THE UNION BANK AND I SELECT A CLUB, I NEED TO
-- BE ABLE TO SEE THE CLUBS BALANCES. THEY ARE CURRENTLY BLANK."
--
-- clubs.chip_treasury and clubs.promo_balance are withheld from browser reads
-- (column-level grants), and fn_club_money_panel shows club money only to that
-- club's own owner, co-owner or admin. So the union lead pulling chips back
-- from a club bank could not see what was in it, or how much of it the opening
-- grant floor leaves pullable.
--
-- fn_union_club_bank_balances answers exactly that, for exactly the people who
-- may already move that money: the union owner or a union_lead, the same test
-- fn_union_clawback_from_club and fn_union_clawback_promo_from_club apply. It
-- returns one row per club in the union: the Club Bank, the club Promo Wallet,
-- and the opening-grant floor a clawback may not cross (100,000 when the club
-- received the opening grant, else 0, read exactly as the clawback reads it).
--
-- Read-only. No money moves, no table, grant or policy changes. Anyone who is
-- not the union owner or a union_lead is refused before anything is read.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION public.fn_union_club_bank_balances(p_union_id uuid)
RETURNS TABLE(club_id uuid, club_bank numeric, club_promo numeric, pull_floor numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT (
    EXISTS (SELECT 1 FROM public.unions u WHERE u.id = p_union_id AND u.owner_id = v_uid)
    OR EXISTS (
      SELECT 1 FROM public.union_admins ua
       WHERE ua.union_id = p_union_id AND ua.user_id = v_uid AND ua.role = 'union_lead'
    )
  ) THEN
    RAISE EXCEPTION 'union lead access required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT uc.club_id,
         round(COALESCE(c.chip_treasury, 0), 2),
         round(COALESCE(c.promo_balance, 0), 2),
         CASE WHEN EXISTS (
                SELECT 1 FROM public.chip_transactions t
                 WHERE t.club_id = uc.club_id AND t.transaction_type = 'club_opening_grant'
              ) THEN 100000::numeric ELSE 0::numeric END
    FROM public.union_clubs uc
    JOIN public.clubs c ON c.id = uc.club_id
   WHERE uc.union_id = p_union_id;
END
$fn$;

COMMENT ON FUNCTION public.fn_union_club_bank_balances(uuid) IS
  'Union Bank club directory balances: Club Bank, club Promo Wallet and opening-grant pull floor per club in the union. Union owner or union_lead only, matching fn_union_clawback_from_club. Read-only.';

REVOKE ALL ON FUNCTION public.fn_union_club_bank_balances(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_club_bank_balances(uuid) TO authenticated, service_role;

COMMIT;
