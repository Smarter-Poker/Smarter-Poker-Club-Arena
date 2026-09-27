-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821182551 "tournament_rake_cap_10_percent"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 2151435fbfe7256d95b3e3562607890f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

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
-- Both are fixed in code — the fee now FLOORS and has no minimum. This is the
-- backstop for any writer that does not go through those helpers: owner-created
-- tournaments come through a form, and the recurring generator has its own
-- configs.
--
-- NOT VALID on purpose. 9,946 historical rows (CANCELLED/COMPLETED) breach it,
-- and they are settled financial history — rewriting them would falsify what
-- players were actually charged. The constraint applies to every INSERT and
-- UPDATE from here on, which is what we need; the old rows stay readable and
-- untouched.
--
-- The four REGISTERING tournaments that were over cap are corrected in the same
-- migration. The player pays the same TOTAL either way — only the split moves,
-- so the excess lands in the prize pool rather than the house. The two RUNNING
-- ones are deliberately left alone: their prize pools are already published and
-- partly paid, and quietly re-cutting money mid-flight is worse than letting
-- them finish on the terms they started under. Their next scheduled run is
-- created by the fixed generator.
--
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

-- Correct the not-yet-started games. Total paid is unchanged; the excess moves
-- from the fee to the prize side.
update public.tournaments t
   set buy_in_amount = (buy_in_amount + buy_in_fee) - floor((buy_in_amount + buy_in_fee) * 0.1 + 1e-9),
       buy_in_fee    = floor((buy_in_amount + buy_in_fee) * 0.1 + 1e-9),
       updated_at    = now()
 where t.status = 'REGISTERING'
   and t.buy_in_fee > floor((t.buy_in_amount + t.buy_in_fee) * 0.1 + 1e-9);
