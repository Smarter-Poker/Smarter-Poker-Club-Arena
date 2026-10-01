# tests/a-streak-milestone-never-takes-the-daily-reward-down.law.test.ts

Claiming a daily reward also pays any Daily Missions streak milestone that has
come due: 30 days 1,000 Diamonds, 60 days 2,500, 100 days and every 30 after
6,000. That milestone used to be paid inside the claim and counted on the
`daily_missions` line, whose per-player daily cap is 500 (ruling 18). Once the
cap refused rather than warned, on 2026-09-26, every milestone of 1,000 or more
was refused and took the ordinary daily reward down with it, for as long as
the streak lasted; the horse claim sweep, which retries the oldest owed rows
first, 500 a minute, then paid nobody behind them. On 2026-09-30 3,053 horse
rewards were owed and the Diamond health watch had filed 46 critical rows.

Decided by Claude on Dan's delegation of 2026-09-30 and recorded under ruling
18 in `docs/DIAMOND-RULINGS.md`: the milestones are paid as promised. They have
their own line, `daily_mission_milestones`, 6,000 a day for everyone, the
largest milestone, while ruling 18's 500 stays as it is. The milestone step
runs in its own subtransaction, so it can never roll the claim back. A
milestone is written down the moment the streak reaches it, paid one credit
per milestone under its own reference, and a refused one stays owed and is
paid by the player's next daily claim: it is never forfeited. The sweep skips
a reward it cannot pay yet (a capped one until the America/Chicago midnight
its cap resets, a failed one for ten minutes), keeps the 2026-09-24 lock order,
and names a milestone refusal as one, in its own column and as
`CH3:milestone_refused`.

The law pins those mechanics in migration 20260930233000: the four live bodies
it changes are pinned by md5, the engine map is edited by asserted substitution
with its reverse proved, nothing touches another cap, the trigger catches the
whole milestone step and never raises, the award records before it pays and
never deletes an unpaid milestone, the sweep's window excludes a deferred
reward while its lock order and guards stay, no job is scheduled or
unscheduled, nothing is reachable from a browser, and the decision is recorded
under ruling 18.
