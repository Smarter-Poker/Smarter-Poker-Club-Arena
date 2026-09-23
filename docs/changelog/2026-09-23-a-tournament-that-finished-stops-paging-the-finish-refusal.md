# A tournament that finished stops paging the finish refusal

Production Alerts Fleet, PRIMARY lane. Board: `Smarter-Poker/Smarter-Poker-Club-Arena#5070`.

## What was wrong

`operational_alert_events` id=8, `MoneyAlertsGoingUnread`, open since 2026-09-13 and
firing at roughly 30x its threshold. `public.financial_alerts` held 46,366
unresolved critical rows. Read live before writing the fix:

| source | unresolved rows | distinct tournaments |
| --- | ---: | ---: |
| `Tournament.atomic_finish_refused` | 15,426 | 1,003 |
| `Tournament.atomic_finish_outcome_unknown` | 39 | 35 |

One tournament, `f670ca7c-5134-4a22-9426-eea2601c300a`, alone carried 224 of
these rows between 2026-09-14 and 2026-09-21.

`TournamentManagerEliminations.ts` raises this alert every time
`atomic_finish` is refused mid-retry (`noteFinishRefusal` /
`alertFinishRefusalOnce`) and keeps retrying with a backoff
(`finishRetryDelayMs`). That retry loop is correct and untouched here — it
already eventually succeeds. What never happened is anyone going back to
close the alert rows the failed attempts left behind.

`fn_resolve_settled_financial_alerts` already runs every 20 minutes
(`ca-resolve-settled-alerts-20m`) and already resolves a structurally
identical case — CLASS 1 closes `fn_payout_guarantee_check`'s
`earner_not_paid` alert once a `wallet_transactions` prize credit proves the
player was paid. `Tournament.atomic_finish_refused` and its
`outcome_unknown` sibling were simply never added to it, so the same true
fact (the player got paid) could resolve one alert shape and not the other.

## Proof, not inference

For every one of the 1,003 distinct tournaments behind an unresolved
`Tournament.atomic_finish_refused` alert, and 30 of the 35 behind
`Tournament.atomic_finish_outcome_unknown`, a `wallet_transactions` row
exists crediting the exact `winner_id` named in the alert's own `context`,
for that exact `tournament_id`, `type=credit category=prize`. That is the
same proof CLASS 1 already trusts, for the same reason: the prize path is
the one authoritative payer, so a credit from it is settlement — independent
of the tournament's own later `status` (which the same manager sets itself
and so is not independent proof) and independent of elapsed time.

`tournament_finish_receipts` (5,707 rows) was checked first as a candidate
proof source and rejected: zero of the 1,084 affected tournaments have a row
there. It certifies a narrower path, not the general finish, and using it
here would have left the backlog unresolved again while looking fixed.

## The fix

`supabase/migrations/20260923184855_a_tournament_that_finished_stops_paging_the_finish_refusal.sql`
adds CLASS 5 to `fn_resolve_settled_financial_alerts`: it resolves
`Tournament.atomic_finish_refused` / `Tournament.atomic_finish_outcome_unknown`
alerts whose named `tournament_id` + `winner_id` has a matching prize credit,
the same way CLASS 1 already does. No new function, no new cron job, no new
alert, no compensating write — the existing 20-minute resolver just gained a
class it was structurally missing.

## Scope

This closes the two non-satellite finish sources only.
`Tournament.atomic_satellite_finish_refused` (469 rows, 39 tournaments) and
its `outcome_unknown` sibling (7 rows) were **not** verified this run: a
satellite's payout is seats awarded, not necessarily a single wallet prize
credit, so CLASS 1's proof shape does not automatically transfer. Claiming it
does without checking would repeat the exact mistake this migration fixes.
Left open for a follow-up that reads the satellite award path on its own
terms. `Satellite.stuck_completing_unawarded` (533 rows) and the weekly club
/ union accounting sources (358 rows combined) are likewise untouched.

## Hardening (CLAUDE.md 10.11/10.12)

- **Cause fixed at the root**: the missing class in the resolver, not a new
  sweep.
- **Damage settled**: through the resolver's own existing idempotent
  `UPDATE ... WHERE resolved IS NOT TRUE` path, on its existing cron.
- **Regression test**:
  `server/src/tournament/AFinishedTournamentStopsPagingTheRefusal.guard.test.ts`
  pins the exact SQL added — the source list, the proof join, the exclusion
  of the unverified satellite sources, the restated grant, and the in-migration
  assertion that CLASS 5 landed.
- **Detection**: none needed — `MoneyAlertsGoingUnread` already measures the
  backlog this closes roughly a third of.

## Not done here

The remaining ~31,000 unresolved critical rows (satellite finish refusals,
`Satellite.stuck_completing_unawarded`, weekly accounting, and whatever is
behind the other ~44,000 `new`/`investigating` rows not attributed to a
finish refusal at all) are not addressed by this migration and remain open
on the board.
