# An unsequenced bust names no winner (2026-10-07)

## What happened

On 2026-10-06 at 15:33:04 UTC a platform retirement marked tournament
62a15104's two live players (a three-player PLO4 Spin) `eliminated` with no
`elimination_sequence`. The manager's finish stage then found no `playing` row
and no durable `winner`, and nominated "the last sequenced elimination":
ca905025, who was the FIRST player out (15:29, third place). The database
refused it (fn_settle_tournament_places voids the witness when any eliminated
row has a NULL or later sequence) and the refusal ran until 02:06 the next
morning (see 2026-10-07-a-refusal-that-cannot-change-is-not-a-serialization-failure.md).

## The cause

`server/src/tournament/TournamentManagerEliminations.ts`, finish stage, the
no-survivor branch: it filtered `elimination_sequence IS NOT NULL`, ordered by
it descending, and named the first row. "The last sequenced bust" is the last
bust only when every bust carries a sequence. A row without one could have
gone out before or after any sequenced row. A test
(`does not let an unsequenced legacy row precede the durable witness`) pinned
the wrong rule.

## The fix

Before naming a last bust the manager counts `eliminated` rows with a NULL
sequence. If there are any, it names nobody, reports
`Tournament.finish_elimination_witness_unsequenced`, and re-checks once a
minute (`UNSEQUENCED_WITNESS_RETRY_MS`), because that field only changes when a
recovery restores or sequences those rows. A count it cannot read is unknown,
not zero, and keeps the event pending on the ordinary 5 s cadence. This is
the same question the database asks, so the engine no longer submits a
nomination the database must refuse.

The old test now pins the opposite and says why; a new case reproduces the
62a15104 field (one sequenced first-out bust, two unsequenced retired players).

## What this does not fix

The retirement itself wrote those NULL-sequence rows. The retirement producer
was replaced on 2026-10-06 (2026-10-06-retirement-preserves-original-hand-custody.md);
rows it left behind in four running Spins and five registering events are
reported separately and are not settled here.

Engine release: activates in the :55 window.
