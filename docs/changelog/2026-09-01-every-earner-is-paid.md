# Every earner is paid

2026-09-01. A full reconciliation of every MTT, Spin and Heads-Up payout on the
platform, against the money rather than against the paperwork, and the checks
and guards that came out of it.

Dan, verbatim: "IT IS AN ABSOLUTE MUST THAT PLAYERS ALWAYS 100% GET PAID OUT OF
EVERY SINGLE MTT, SPIN OR HEADS UP THEY PLAY (IF THEY EARNED A PAYOUT)."

## What the reconciliation says

49,044 completed events with a prize pool in the 120 days to 2026-09-01,
measured against `wallet_transactions`:

| format         | events | underpaid | chips short |
| -------------- | -----: | --------: | ----------: |
| SPIN           | 32,433 |         0 |        0.00 |
| SNG (heads-up) | 15,010 |         0 |        0.00 |
| MTT            |  1,601 |        12 |       76.70 |

Asked player by player rather than event by event, across 150 days: of every
player holding a place their event's structure pays, **exactly one** received
less than that place is worth, and the amount is **0.02 chips**. Rounding.

That is the headline and it is a good one. The rest of this document is the
twelve, and the two ways the machinery could have failed the rule quietly.

## The defect behind all twelve: a paid place with nobody in it

Late Night Grind (PLO4), 2026-06-07, ten players, 50.00 pool. Finishing places
recorded: 1, 2, then 6, 7, 8, 9, 10, 11, 12, 13. Places 3, 4 and 5 pay 18, 10
and 7 percent. Nobody held them. 17.50 chips were therefore paid to nobody, and
three players who genuinely finished third, fourth and fifth were labelled
sixth, seventh and eighth and paid nothing.

Fifteen events carry nineteen such vacancies, worth 193.10 chips, every one of
them between 2026-05-08 and 2026-07-19. **There are none after 2026-07-19** -
the distinct-finishing-places work of that day, and the payout-integrity passes
through August, fixed the cause.

Nothing fixed the blindness. No check on this platform asked whether a place the
structure pays has anybody in it, which is why the defect ran for ten weeks in
the open. Every existing check compares totals - pool against disbursed,
conservation in against out - and a vacant place is invisible to all of them,
because the money simply never leaves.

## The second finding: the record is not the money

61 events hold **5,515.91 chips** of prizes that reached player wallets and were
never written to `tournament_payouts`. The record only became authoritative on
2026-08-31 and the historical backfill did not reach them.

On its own that is paperwork. It is not on its own:
`fn_tournament_payout_reconcile` computes "already paid" FROM
`tournament_payouts` - deliberately, because counting ledger rows instead caused
two real double-pays (88a6aced and b687e4aa). On an event with an incomplete
record it therefore concludes money is still owed, and today it concludes
exactly that for 5,315.41 chips. The only thing that has stopped the platform
paying them a second time is that those pools cannot back the payment. That is
luck, not a safety property.

## What shipped

**`fn_payout_guarantee_check(p_since_days)`** - the one place that asks whether
every player who earned a payout actually received it. Three independent
failures, all measured against `wallet_transactions` so that a paperwork gap can
never invent a debt and a complete-looking record can never hide one:

1. **a paid place with no holder** - critical, per event;
2. **an earner whose wallet never saw it** - critical, per player;
3. **prizes paid with no payout record** - warning, because nobody is short but
   it is what arms a double-pay.

It moves no money. Wired hourly into `GameServer` on its own timer, per the
lesson already recorded on the overpay charge that a repair gated on another
job's clock runs once at boot and then effectively never.

Run live against 150 days, twice: 15 vacant-place events (193.10 chips), 1
underpaid earner (0.02), 61 unrecorded-payout events (5,515.91). 17 alerts on
the first pass, **0 on the second**, 17 rows in total.

**`fn_pay_backed_payout_shortfalls`** - three corrections, none of which change
what it pays today, all of which change what it can never do again:

- **Withholding is never silent.** The branch that declines to pay an event
  whose pool cannot back what it owes used to increment a counter that reached a
  console line and nothing else. Money owed to a player and not paid left no
  durable record anywhere. It raises a deduped critical now, per event, naming
  the amount owed, what the pool holds, and the funding gap.
- **Conservation refuses before the pool does.** An event whose wallet credits
  already cover its pool owes nobody, whatever the paperwork says. It is refused
  and reported as a missing record rather than paid a second time. This is the
  latch on the 5,515.91 chips above.
- **The backfill log is a receipt, not a tombstone.** `NOT EXISTS (...
backfill_log ...)` meant one inspection excluded an event from every future
  pass, for good - so a shortfall that became payable later, when a guarantee is
  funded or a baseline acknowledged, would never be looked at again. "Nothing is
  owed" is the only correct exclusion. Measured before the change: no logged
  event is payable today, so this unlocks no payment and closes a door.

## Evidence

- Server suite green, `tsc --noEmit` clean, 13 new pins in
  `EveryEarnerIsPaid.law.test.ts`.
- Both function bodies verified byte-identical against production by md5 of
  `pg_proc.prosrc`, recorded in the migration header.
- The detector was run twice against production and is idempotent (above). No
  money path was executed.

## Both repairs, applied

Dan approved both on the day. Migrations `20260901133441` and `20260901134250`.

**The players who finished third are paid third.** 15 events, 38 finishing places
corrected, 32 players paid 161.30 chips. The compaction is dense rank over the
recorded positions, which in all fifteen are present, distinct and exactly as
many as the field, so it preserves the engine's own order and can only move a
player up; place 1 was already occupied everywhere, so no champion changed. The
migration refuses any event that fails those preconditions rather than ranking
on `eliminated_at`, which for these events is a mass-sweep timestamp and would
have reordered 114 of 170 rows on a guess.

`trg_tournament_place_collision` refused the first attempt, correctly: a
set-based UPDATE puts two players on the same place mid-statement, and a
contested place is paid twice. The rows move one at a time in ascending target
order now, so the place is always empty by the time it is filled. Nothing was
written on the refused attempt.

91.10 chips had already gone to players whose corrected place is worth less. No
clawback, per Dan's ruling of 2026-08-28 on the duplicate-place overpays. 76.70
came out of what the pools still held and the hosting clubs absorb **84.60**
across 10 events, written to `tournament_conservation_baseline` as deliberate
minting so those events do not alert forever on a difference somebody chose.

The before picture is kept in `tournament_players_position_repair_20260901`.

**The record catches up with the money.** 102 rows, 5,677.21 chips, 73 events.
It moves no money; it writes down payments that already happened. Source
`structure`, because the reconciler's source filter is a closed list and a row
under a name it does not know would have left the phantom debt exactly where it
was; `recorded_by = 'ledger_backfill_20260901'` carries the provenance.

**After both, across 150 days:**

```
vacant_paid_place_events   0
earners_not_paid           0
paid_but_unrecorded_events 0
fn_pay_backed_payout_shortfalls dry run: 0 owed, 0 withheld, 0 refused
```

One correction to this document's own check, found by running it: the first pass
reported the ninth place of a $100 Freeroll as 0.02 short. It was not. The check
compared against a flat pool-times-percentage while the engine allocates in whole
cents with the last place absorbing the remainder. The tolerance is five cents
now, and the reason is written where the comparison happens. A player paid
nothing still trips it at any tolerance.

## Previously open, now closed

The 193.10 chips on those fifteen events are **not** paid, and the standings are
not corrected. Every affected player is a horse; no human was short.

The repair is well defined and I did not apply it. Each event's recorded
positions are strictly increasing with gaps and number exactly as many as the
field, so compacting them to a dense rank preserves the engine's own recorded
order exactly - the player recorded sixth in a ten-handed event whose places run
1, 2, 6..13 finished third - and the payment is then the difference between what
each place is worth and what that player already received. It is arithmetic, not
a guess.

It is still two things a sweep should not decide by itself: it moves money on
settled events, and it rewrites `position` on rows that leaderboards,
achievements and VIP attribution all read. Say the word and it goes in as a
dry-runnable, idempotent repair that refuses any event whose pool cannot back
it.
