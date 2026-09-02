# A bounty pool belongs to a player too

2026-09-01. The gap my own payout audit had, found by not trusting it.

## The blind spot

`fn_payout_guarantee_check` reconciles the **prize** pool and reported, across
150 days, that every player who earned a payout received it. That was true, and
it was half the money. A bounty event funds a **second** pool out of the same
buy-in, and nothing on this platform ever asked whether that one was paid out.

It was not. **38 completed bounty events held 1,931.24 chips that reached no
player**, and it was still happening daily — two events on 2026-09-01, three on
2026-08-31.

The check that found it was somebody else's: `fn_tournament_money_conservation`
had 116 open warnings saying "Tournament retained money it never paid out", and
they had been sitting there while my own check said everything was fine. Two
instruments disagreeing is information, and it was worth chasing rather than
explaining away.

## One cause, and the evidence is unambiguous

`finishTournament` settles whatever is left in a funded bounty pool to the
champion — their own uncollected head plus any residue the draw leaves. That is
the platform's own rule and `fn_finalize_bounty_pool` is the code for it.

|        | events | with a champion bounty payment | winner's head still unzeroed |
| ------ | -----: | -----------------------------: | ---------------------------: |
| square |    673 |                        **650** |                           55 |
| short  |     38 |                          **0** |                           37 |

Not one of the 38 has the payment. And **34 of the 38 were completed by
`recoverStuckCompletingTournaments`** — the watchdog pays the prize structure,
settles the rake, and never touched the bounty pool. The winner of Union PKO
Afternoon `d2625870` was owed 121.57 and still carried an uncollected 41.25 head
to prove the settlement never ran.

## What shipped

**The hole is closed at source.** `recoverStuckCompletingTournaments` now
finalises the bounty pool, in the same place and the same shape as the rake
settlement that was already there, and _before_ it flips the event to COMPLETED.
The champion comes from the recorded `status = 'winner'` row, never a guess. A
positive residual that paid nobody is reported rather than logged only on the
happy path — that silence is how this ran unseen.

**`fn_backpay_unfinalised_bounty_pools(p_apply, p_limit)`** is the net under it,
driven hourly. It re-drives `fn_finalize_bounty_pool`, which is idempotent on
`tourney:{id}:ownbounty:{winner}` and pays only what the ledger still shows
unpaid — so re-driving cannot double-pay, it can only finish what stopped
halfway. It does not credit anything itself; a hand-rolled credit here would
have had none of that safety.

**`fn_payout_guarantee_check` reconciles the bounty pool too**, as a fourth
independent failure (`bounty_pool_retained`), so this cannot hide again.

## Paid

```
fn_backpay_unfinalised_bounty_pools(apply)
  events_settled              37
  chips_settled          1907.24
  events_without_a_champion    1   (24.00 chips, alerted)
second dry run:  0 events, 0 chips
```

**1,907.24 chips reached the 37 champions who earned them.** The one event with
no champion recorded is alerted and left alone: a residual with no recipient is
a question, not a payment.

## Where it stands

```
fn_payout_guarantee_check(150 days)
  vacant_paid_place_events      0
  earners_not_paid              0
  bounty_pool_retained_events   1   (the 24.00 with no champion)
  paid_but_unrecorded_events    0
```

## Evidence

- `tsc --noEmit` clean; 10 new pins in `ABountyPoolBelongsToAPlayer.law.test.ts`,
  one more in `EveryEarnerIsPaid.law.test.ts`, registered in `docs/LAWS.md`.
- `fn_payout_guarantee_check`'s body verified byte-identical against production
  by md5 of `pg_proc.prosrc` (`9d06324a…`, 11,379 bytes), recorded in its
  migration header alongside the two earlier values so a reader can tell drift
  from a deliberate change.
- The repair was dry-run first, applied, then dry-run again to prove it had
  nothing left to do.
