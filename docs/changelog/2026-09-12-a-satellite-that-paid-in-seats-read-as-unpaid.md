# A Satellite That Paid In Seats Read As A Tournament That Paid Nobody

**2026-09-12** · `fn_tournament_metrics`, `TournamentCompletedUnpaid`

## What Was Wrong

`TournamentCompletedUnpaid` is the strongest money alert on the platform.
Critical severity, SMS, and the words:

> Players bought in and nobody was paid.

It has never been right. Every firing in the entire visible history of the
metric was a satellite that had paid correctly.

| Window                 | Firings | Satellites | Genuinely unpaid |
| ---------------------- | ------- | ---------- | ---------------- |
| 14 days to 2026-09-12  | 12      | 12         | 0                |
| 120 days to 2026-09-12 | 18      | 18         | 0                |

The three firing at the time of the audit, checked by hand to the row:

| Tournament | Prize pool | How it paid        | Delivered                                   |
| ---------- | ---------- | ------------------ | ------------------------------------------- |
| `5bd4927b` | 200.00     | `satellite_seat`   | winner registered in the target event       |
| `f3acfe99` | 200.00     | `satellite_seat`   | winner registered in the target event       |
| `456963df` | 200.00     | `satellite_ticket` | ticket `eaaab20b`, $200, issued, entry-only |

Nobody was owed anything.

## Why

The gauge asked one question: is there a `wallet_transactions` row with
`category = 'prize'` against this tournament? That is the right question for a
tournament that pays in chips. A satellite does not pay in chips. It pays in a
seat at the target event, or a ticket to enter one later, and neither is a
wallet transaction.

So the one format that pays in something other than cash was unpaid by
construction, every single time, forever.

This was not an unknown rule. `aSatelliteSeatIsAPayout` has been law here since
2026-08-31, and the structure reconciler was taught the same lesson in the same
week, in a test that reads:

> A seat is funded by the satellite's pool buying a ticket, not by the
> satellite's prize_pool paying a place.

The reconciler learned it. This gauge never did.

## Why This Counted As A Defect Worth Fixing Tonight

An alert that is wrong every time it fires trains the on-call to close it
without reading it. This one was wrong every time it had ever fired, on the SMS
channel, saying nobody was paid. The day a tournament genuinely pays nobody,
that page will look exactly like the last twelve.

The cost was never the noise. It was the loss of the alert.

## The Fix

`fn_tournament_metrics` now counts a completed tournament as unpaid only when
nothing of value reached anybody: no cash prize **and** no satellite award.

```sql
AND NOT EXISTS (
  SELECT 1 FROM wallet_transactions w
   WHERE w.related_entity_id = t.id AND w.category = 'prize')
AND NOT EXISTS (
  SELECT 1 FROM tournament_satellite_awards a
   WHERE a.tournament_id = t.id)
```

`tournament_satellite_awards` is read and nothing weaker. A `tournament_payouts`
row marked `paid_at` is written by the payout code itself, so it evidences what
the code believed it had done. The awards table evidences delivery by
constraint:

| `delivery_kind` | Proof the row cannot exist without                                  |
| --------------- | ------------------------------------------------------------------- |
| `seat`          | `registration_id IS NOT NULL`                                       |
| `ticket`        | `ticket_id` → `tournament_tickets` (FK, ON DELETE RESTRICT)         |
| `cash`          | `obligation_id` → `tournament_obligations` (FK, ON DELETE RESTRICT) |

all three enforced by `tournament_satellite_awards_check`.

The cash half of the predicate is untouched, and `category = 'prize'` is
deliberately not widened to include `'bounty'`. A satellite that fails to settle
writes no award row and moves no cash, so it still counts as unpaid: that is the
true positive this alert was built for and has yet to find.

## Verified

Dry run against production inside a rolled-back transaction:

```
BEGIN
CREATE FUNCTION
REVOKE
GRANT
NOTICE:  fn_tournament_metrics OK: unpaid_completed 3 -> 0 (3 satellite payout(s) no longer read as unpaid)
DO
ROLLBACK
```

Day by day over 14 days, current expression against this one:

| Day        | Current | This |
| ---------- | ------- | ---- |
| 2026-09-12 | 3       | 0    |
| 2026-09-11 | 6       | 0    |
| 2026-09-10 | 3       | 0    |

The migration refuses to install itself if the number ever goes **up**, because
this change may only ever remove satellites that paid.

## How Not To Measure This

The first query run against this alert asked `tournament_payouts` whether a
payout existed, found a row for every recent tournament, and returned zero
unpaid. That looked like proof the alert was a false positive, and it was the
right conclusion reached by the wrong route: `tournament_payouts` is the ledger
of what the payout code intended, and the alert reads `wallet_transactions`,
which is where money actually moves. Two different questions.

Had the defect been the other way round, a payout row written with no money
behind it, that query would have reported everything healthy. The alert's own
expression has to be reproduced exactly before it can be called wrong.

## The Near Miss This Also Caught

The first version of this migration ended with the grant line copied forward
from the 2026-08-31 definition it was replacing:

```sql
GRANT EXECUTE ON FUNCTION public.fn_tournament_metrics(integer, integer, integer)
  TO service_role, authenticated;
```

That line was true when it was written and is not true now.
`the_operator_console_was_open_to_every_player` took `authenticated` off this
function and thirty-four others later the same day, after finding that every
logged-in player could read operator telemetry. Production today is
`{postgres=X/postgres,service_role=X/postgres}`.

Because `CREATE OR REPLACE` preserves grants, the only thing that would have
re-opened the function was the grant line itself, carried forward out of
politeness to the file it was copied from. The definer-authorization pre-push
gate blocked it. That gate exists for exactly this, and it earned its keep.

The migration now revokes from `PUBLIC, anon, authenticated` explicitly, grants
only `service_role`, and asserts in its own `DO` block that neither browser role
can execute it, so the next person to copy this file forward cannot reopen it
either. Checked before narrowing: no RLS policy references this function, so
nothing depends on the wider grant.

## Pins

Five cases added to `server/src/tournament/aSatelliteSeatIsAPayout.law.test.ts`,
under the law that already says a satellite seat is a payout. Proven to bite:
removing the awards clause fails
`does not count a satellite that delivered an award as unpaid`.
