# A streak milestone never takes the daily reward down

2026-09-30. Migration `20260930233000_a_streak_milestone_never_takes_the_daily_reward_down`.
Decided by Claude on Dan's delegation of 2026-09-30 ("these are all for you to
decide not me ... FIX AND FINISH ALL OF THESE"), recorded under ruling 18 in
`docs/DIAMOND-RULINGS.md`.

## What was wrong

Claiming a daily reward also paid any streak milestone that had come due (30
days 1,000 Diamonds, 60 days 2,500, 100 days and every 30 after 6,000), inside
the same step, on the `daily_missions` line whose per-player daily cap is 500
(ruling 18). Since 2026-09-26 that cap refuses instead of warning. So from the
thirtieth day of a streak every milestone was refused, and because it ran
inside the claim, the ordinary 9-45 Diamond reward was rolled back with it -
every claim, every day, for as long as the streak lasted.

160 horses reached thirty days on 2026-09-29 and 2026-09-30. The horse claim
sweep (`fn_ca_horse_claim_due`, every minute) retried their refused rows,
counted them as ordinary cap refusals, and because it takes the oldest 500
first, those rows filled its whole window: no horse was paid after
2026-09-30 00:54 UTC. By 23:47, 3,053 horse rewards worth 98,921 Diamonds were
owed and the hourly health watch had filed 46 critical `horse claims` rows.
Nothing was forfeited: all 160 horses were still on the streak that earned the
milestone.

## What changed

1. **Milestones have their own line.** `daily_mission_milestones`, 6,000 a day
   (the largest milestone), identical for horses, humans and VIP. Ruling 18's
   500 on ordinary daily-mission rewards is unchanged; no amount changes.
2. **The milestone is paid apart from the claim.** The claimed-row trigger runs
   it in its own subtransaction and never raises, so it cannot take the
   ordinary reward down.
3. **A refused milestone stays owed.** It is written down the moment the streak
   reaches it, paid one credit per milestone under its own reference, and the
   player's next daily claim tries again until one pays it. Paid means its own
   credit is in the journal.
4. **The sweep never queues behind a refusal.** A capped reward waits for the
   America/Chicago midnight its cap resets, a failed one ten minutes
   (`ca_horse_claim_deferrals`), and the window skips both. A milestone refusal
   is filed as `CH3:milestone_refused` and counted in the sweep's new
   `milestones_refused` column, never as `capped`.

Every credit still goes through `add_diamonds_to_balance`, and the register
follows the journal as before: players + house + custody = register.

Rehearsal, apply and the production watch are in
`docs/evidence/diamond-phase-11/a-streak-milestone-never-takes-the-daily-reward-down.md`.
