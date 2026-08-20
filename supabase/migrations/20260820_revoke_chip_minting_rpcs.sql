-- Applied to production via Supabase MCP on 2026-08-20. Mirrored as applied.
--
-- ANY LOGGED-IN USER COULD MINT CHIPS.
--
-- fn_pay_player_chips(p_user_id uuid, p_amount numeric, p_category text,
--                     p_description text, p_club_hint uuid, p_related_id uuid)
-- is SECURITY DEFINER, was EXECUTE-able by `authenticated`, and contains no
-- authorisation check of any kind. Its body does:
--
--     UPDATE club_members
--        SET chip_balance = COALESCE(chip_balance,0) + p_amount
--      WHERE user_id = p_user_id AND club_id = v_club;
--
-- Chips are ADDED. Nothing is debited anywhere -- this is issuance, not a
-- transfer. Caller picks the recipient and the amount.
--
-- Confirmed reachable with an ordinary user's JWT via PostgREST. Probed with
-- p_amount = 0 so that no money moved: the call returned HTTP 200 and
-- {"paid": false, "reason": "non_positive"}, i.e. it executed and was stopped
-- only by the amount guard. A positive amount would have credited the wallet.
--
-- No client in either repo calls it. Its legitimate callers are other
-- SECURITY DEFINER functions -- atomic_pay_player_rakeback,
-- atomic_pay_agent_settlement, credit_player_rakeback -- and those run as the
-- definer, which keeps EXECUTE. So revoking breaks no real path.
--
-- Same treatment for the two settlement entry points, which likewise move
-- money, check no identity, and have no client caller.
--
-- Verified after: the same authenticated call now returns 403 / 42501
-- "permission denied for function", while postgres and service_role retain
-- EXECUTE so the internal rakeback and settlement chains are untouched.

REVOKE EXECUTE ON FUNCTION public.fn_pay_player_chips(uuid, numeric, text, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_settle_round2_club_to_agents(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_settle_round3_agents_to_players(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;

-- STILL OPEN, deliberately not changed here: fn_apply_credit_payment and
-- fn_generate_credit_invoice also mutate money and check no identity, but
-- CreditService calls them directly from the client (CreditService.ts:374,
-- :525). Revoking would break credit invoicing. They need an authorisation
-- check INSIDE the function -- caller must be club owner/admin for that
-- agent's club, the same test fn_admin_update_agent already applies -- which
-- is a behavioural change that wants review rather than a silent revoke.
