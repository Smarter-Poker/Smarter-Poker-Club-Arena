# A snapshot-excluded chair without a card does not hold an abandoned hand

## What happened

Sunday Funday Main Event Satellite `fe93d011-d3f3-4e41-82e4-f7b5ca98547b`
remained `RUNNING`, with nine players on table
`0edaf9c7-c686-4546-90d0-ec2094c3f788`, while every dealer admission failed.
The dead generation `20219a73-eddf-48ae-af9d-91b9f56165ab` left permit
`3204cdf7-144f-478b-97d2-ae5b8e9d156f` reserved for hand `21894277`,
lifecycle `651913`. A single production self-aborting probe rolled back as
required and named the guard: `F06_ABORT_SAVED_STACKS_CHANGED`.

Read-only rows isolate the false refusal. Snapshot
`feae1dc4-14cc-4f4d-9f68-62fce5fd5709` is one incomplete preflop snapshot
containing five players. Its pot `26224` equals their total investment; each
of those five players has an exact-hand hole-card row and each current stack
equals snapshot stack plus investment. Four balancing chairs, seats 3, 6, 8
and 9, joined only 0.49 to 3.53 seconds before the snapshot. They are absent
from both the snapshot and the exact hand's hole cards, and each chair stack
exactly equals its playing registration chips. No commit, history or private
state exists at or after the hand.

The old door admitted a snapshot-excluded live chair only when
`joined_at > snapshot.created_at`. It therefore treated a chair committed
milliseconds before the dead dealer wrote its snapshot as part of that saved
hand, even when the dealer wrote no card or snapshot player for it.

## The fix

Migration
`20261004010539_a_snapshot_excluded_chair_without_a_card_does_not_hold_an_ab.sql`
adds one alternative proof: a snapshot-excluded live chair is outside the
saved hand when no `table_hole_cards` row exists for that exact table, hand
and user. The existing late-chair proof remains. A before-snapshot excluded
chair with any exact-hand card still refuses.

Every other safeguard is unchanged. The prior roster clause still requires
one live chair and one playing registration at the exact table and seat, a
nonnegative chair stack, and chair stack equal to registration chips.
Snapshot members still must conserve snapshot stack plus total investment;
the pot must equal total investment; preflop/incomplete, commit, history,
private-state, custody and receipt checks remain. The door credits zero,
writes no chair, registration, ledger or wallet row, and remains callable
only by `service_role`.

The manager's existing causal admission retry asks this door again, so the
correction adds no sweep, watcher, timer or manual production repair.

Regression:
`tests/a-snapshot-excluded-chair-without-a-card-does-not-hold-an-abandoned-hand.law.test.ts`.

## Qualification

At `2026-10-04T01:13Z`, one bounded prospective call installed the exact
candidate body only as a `pg_temp` function inside a single live transaction.
Against the incident identities it reached `aborted_unsettled`, proved one
hand aborted and zero credit, and observed the permit and snapshot transitions
inside that transaction. The probe then deliberately raised
`F06_PROSPECTIVE_ROLLBACK_OK`; a separate read at
`2026-10-04T01:13:50.025697Z` proved the rollback: the public function remained
at pre-image `06d5804f17044e8a2b98c827bc251f0c`, the permit remained `reserved`,
the snapshot remained incomplete, and both the probe receipt and generation
abort counts remained zero. No candidate definition or data change was
installed in production by this qualification.
