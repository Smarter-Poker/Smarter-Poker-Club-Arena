-- Dan, 2026-09-07: "THERE SHOULDN'T BE A PLATFORM LIMIT, JUST A USER LIMIT."
--
-- The per-player limits stay exactly as the standard sets them (110 / 150 a
-- day, 3,300 / 4,500 a month, 3,750 a month from this family, 125 a claim).
-- The club_arena_daily line in diamond_reward_budgets stops being a ceiling:
-- fn_ca_diamond_earn_ledger still counts every diamond the bonus pays into
-- spent_diamonds (the operator panel reads it), but with the budget set to
-- the largest value the column holds the DR7 over-budget warning can never
-- fire for this engine. New periods inherit the budget of the latest prior
-- period, so this carries forward without a cron.
UPDATE public.diamond_reward_budgets
   SET budget_diamonds = 9223372036854775807, updated_at = now()
 WHERE engine = 'club_arena_daily';
