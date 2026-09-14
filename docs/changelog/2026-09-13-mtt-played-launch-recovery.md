# A played MTT can finish recording its launch

Discovery offered finalized events for recovery, but TournamentManagerBase
stopped a multi-table event with fewer than three survivors at its fresh-field
gate. The database completion authority already has a proof for an event that
actually dealt; the engine never reached it. The proof was also unavailable to
the engine service because it had only been used inside database functions.

The September8 Breakfast Turbo illustrates both problems: at20:14UTC it was
still REGISTERING, without a launch receipt or started_at, despite199hands,
34dealt entrants,32eliminations and two surviving seated players. Its level
was21 and finalized pool153.00. The read-only database proof accepted the
original first-hand time,2026-09-08T14:01:44.798851Z. A millisecond-only timestamp
would fail that proof.

Before fresh setup, the engine now asks the existing authority for the first
hand and then proves that exact timestamp and field. It proposes the launch
through the existing generation-bound begin/complete functions, whose
completion rechecks the durable roster and seats. Only a confirmed receipt
enters the normal resume path in the same lifecycle. It does not re-buy,
re-seat, reset levels/stacks, recalculate a funded pool or declare a winner.
Fresh short fields keep their minimum-player rule. Spin and seat-first formats
keep their separate launch contracts. A failed proof or lost ownership cannot
admit a dealer. Lost begin/complete responses retain the original receipt.

## Evidence and release boundary

- Actual engine start/recovery/begin/complete methods, plus existing launch and
  first-hand tests:48tests in3files. Full tournament suite:1,926tests in154files.
  Server TypeScript passes.
- Native PostgreSQL17:12groups, evidence`/tmp/ca-pm-dzsvga5g/results.json`.
  The fixture uses real captured proof/launch functions and receipt immutability,
  synthetic played rows, a maintenance boolean and an excluded-Spin refusal
  stand-in. It does not certify all production triggers, HTTP, real financial
  funding, dealer play or terminal payouts.
- Source-guarded migration20260913201839 applied at20:24UTC, history20260913202413.
  It grants only engine-service execution of the existing read-only proof.
  Its body MD5 remains27037b1d61898aef22fd476a44667cc9, ownerpostgres and search
  pathpublic/pg_temp. Live readback confirms service access and denies both
  browser roles. The begin/complete financial/lifecycle authorities are unchanged.

Engine publication and the actual live event's completion remain OPEN. No
production status, launch receipt, roster, stack, payout or winner was manually
changed for this repair.
