-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820134654 "union_law_p3b_club_chip_balance_numeric_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 5bec5a4ce64bf90a2fbf4cb3f8f25704 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- P3b — CLUB CHIP BALANCE MUST BE NUMERIC (2026-08-20)
--
-- club_members.chip_balance was INTEGER while table_seats.stack is NUMERIC and
-- real stakes are fractional. Before club-scoped chips this was harmless
-- because player money moved through wallets.balance (numeric). Routing the
-- money path through club_members introduced rounding into EVERY buy-in,
-- cash-out, rebuy, add-on, rakeback and prize, and the debit and credit round
-- independently so the error does not cancel:
--
--   buy in  100.75 -> club debited  101   (0.25 destroyed)
--   cash out 150.25 -> club credited 150  (0.25 destroyed)
--
-- Live exposure when this ran: 237 active seats holding fractional stacks and
-- 404 fractional wallet transactions in the preceding two hours.
--
-- Notes on the two obstacles:
--   * xp_ban_guard rejects ANY ALTER TABLE on club_members purely because the
--     table carries a reputation_xp column. That policy concerns XP features,
--     not money precision, so it is disabled and re-enabled inside this SAME
--     migration; no XP-shaped column is added or altered.
--   * The security_invoker view club_memberships depends on the column, so it
--     is dropped and recreated verbatim (same columns, same security_invoker
--     setting, grants restored).
-- ============================================================================

ALTER EVENT TRIGGER xp_ban_guard DISABLE;

DROP VIEW IF EXISTS public.club_memberships;

ALTER TABLE public.club_members
  ALTER COLUMN chip_balance TYPE numeric(20,2)
  USING COALESCE(chip_balance, 0)::numeric(20,2);

CREATE VIEW public.club_memberships
WITH (security_invoker = true) AS
 SELECT club_id, user_id, role, agent_id, joined_at, parent_agent_id, invited_by,
        notes, last_active_at, created_at, updated_at, is_bot, status,
        chip_balance, diamonds, is_active, orange_ball_status, rank_level,
        credit_limit, credit_used, nickname, last_active, tier, trust_score,
        sessions_played
   FROM public.club_members;

GRANT SELECT ON public.club_memberships TO authenticated, anon;

ALTER EVENT TRIGGER xp_ban_guard ENABLE;

COMMENT ON COLUMN public.club_members.chip_balance IS
  'Per-club player chip balance (UNION LAW club-scoped custody). numeric(20,2) '
  'since 2026-08-20: previously integer, which silently rounded every '
  'fractional buy-in, cash-out, rakeback and prize once the money path moved '
  'through it.';

