-- Dan 2026-08-21 (second batch, item 1): "RAKE IS EXCEEDING 10% ON THIS
-- TOURNAMENT."
--
-- It was. `splitBuyIn` (src/utils/buyIn.ts + its server mirror) computed the
-- fee as `min(total, max(1, round(total * 0.10)))`, and BOTH of those guards
-- pushed it above the ceiling:
--
--   round()  -> a 15 total became 13 + 2 = 13.33%   (the one Dan screenshotted)
--   max(1,)  -> a 5 total became  4 +  1 = 20.00%   (every Pre-Dawn Mystery
--               Bounty today), a 3 became 33%, a 1 became 100%
--
-- Both are fixed in code — the fee now FLOORS and has no minimum, so a buy-in
-- under 10 takes no rake at all. That reverses the "every buy-in pays a fee"
-- rule from earlier the same day, deliberately: it cannot coexist with a hard
-- 10% cap while fees are whole numbers, and a breached cap is the more serious
-- of the two failures.
--
-- This is the backstop for any writer that does not go through those helpers:
-- owner-created tournaments come through a form, and the recurring generator
-- has its own configs.
--
-- NOT VALID on purpose. 9,946 historical rows (CANCELLED/COMPLETED) breach it
-- and they are settled financial history — rewriting them would falsify what
-- players were actually charged. The constraint governs every INSERT and UPDATE
-- from here on, which is what is needed; the old rows stay readable.
--
-- The four REGISTERING tournaments that were over cap are corrected below. The
-- player pays the same TOTAL either way — only the split moves, so the excess
-- lands in the prize pool rather than the house. The two RUNNING ones are
-- deliberately left alone: their prize pools are published and partly paid, and
-- re-cutting money mid-flight is worse than letting them finish on the terms
-- they started under. Their next scheduled run comes from the fixed generator.
--
-- Applied to production via Supabase MCP apply_migration on 2026-08-21.
-- ROLLBACK:
--   alter table tournaments drop constraint tournaments_rake_within_10_pct;

alter table public.tournaments
  drop constraint if exists tournaments_rake_within_10_pct;

alter table public.tournaments
  add constraint tournaments_rake_within_10_pct
  check (
    coalesce(buy_in_fee, 0) <= floor((coalesce(buy_in_amount, 0) + coalesce(buy_in_fee, 0)) * 0.1 + 1e-9)
  )
  not valid;

comment on constraint tournaments_rake_within_10_pct on public.tournaments is
  'Dan 2026-08-21: the house never takes more than 10% of a tournament buy-in. Whole-number fee, floored. NOT VALID so pre-existing settled rows stay as charged.';

update public.tournaments t
   set buy_in_amount = (buy_in_amount + buy_in_fee) - floor((buy_in_amount + buy_in_fee) * 0.1 + 1e-9),
       buy_in_fee    = floor((buy_in_amount + buy_in_fee) * 0.1 + 1e-9),
       updated_at    = now()
 where t.status = 'REGISTERING'
   and t.buy_in_fee > floor((t.buy_in_amount + t.buy_in_fee) * 0.1 + 1e-9);
