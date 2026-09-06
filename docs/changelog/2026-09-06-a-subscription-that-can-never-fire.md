# A subscription that can never fire (2026-09-06)

## The check

`postgres_changes` is silent about the one thing that stops it working. A
client subscribes to a table, the channel joins, the status is `SUBSCRIBED` -
and if the table is not in the `supabase_realtime` publication, no event is
ever decoded for it. No error, no warning, forever. That is how the hole-card
push stayed dead for four hours on 2026-08-31 before anyone noticed.

`scripts/ci/check-realtime-publication.mjs` reads every table this repo names
in a `postgres_changes` subscription, asks the live database which tables the
publication carries, and fails on any subscription that can never fire.
Anything deliberately unpublished goes on a baseline **with the reason**, so
the next person reads a decision rather than guessing at a gap. It exits 2 -
never 0 - when it cannot reach the database or the publication comes back
empty (CLAUDE.md 10.86: a signal that answers when it does not know is the
failure mode this estate keeps paying for).

Read today: 49 subscribed in this repo, 111 published, 40 on the baseline,
zero that can never fire.

## The near-miss this check was written during

Chasing the realtime cost, I found `table_hole_cards` subscribed in
`TablePage.tsx`, absent from the publication, with `REPLICA IDENTITY`
DEFAULT - and its restore migration
(`20260901000200_restore_table_hole_cards_realtime_publication`) **recorded in
`schema_migrations` with neither effect present**. Every reading said: a
migration was stamped as applied and never ran, and the hole-card push has
been dead ever since.

I wrote the migration to put it back. Then the guard I was building disagreed
with me - it scanned the worktree and found no such subscription.

**`main` had moved under me.** The commit that removed the subscription
(`1621bf4113`) landed at 10:53 CDT, part-way through this session, and the
copy of `TablePage.tsx` I had read was from before it. The worktree I cut
later carried it. On current `main` the subscription is gone, deliberately,
and the reasoning is in the file I had been reading an earlier version of:

> `table_hole_cards` was 716 of the 1,643 published row changes in a measured
> 15-second window - 44% of everything Supabase Realtime had to decode - and
> it was delivered to NOBODY: every one of those changes cost a wal2json
> decode plus an `apply_rls` pass and reached zero subscribers, because the
> socket had already delivered the cards.

PR #3032 moved hole cards onto the engine socket **first**, then dropped the
table from the publication. Three independent paths deliver them now (the deal
frame, the resync on every subscribe, the bounded recovery poll). The old
restore migration reads as "applied with no effect" because a later, better
change undid it on purpose.

Had I shipped that migration I would have reverted the single largest realtime
optimisation on this project, on the day it landed, and called it a bug fix.
`table_hole_cards` is now on the baseline as a **decision**, with that
reasoning and an explicit "do not re-add without removing the socket path
first".

Two lessons worth the file. **A tree you read is a snapshot with a
timestamp, not a fact.** `main` takes twenty-odd merges a day here; the file I
based a migration on was correct when I read it and wrong when I acted on it,
which is CLAUDE.md 10.82's shape ("merged is not landed") pointed the other
way - _landed is not what you read_. The cheap defence is the one 10.82
already prescribes for merges: ask the current tree for the file, not your
memory of it.

And **a guard is worth building even when you are sure**, because the guard is
what read the current tree. I was one `psql -f` from reverting the largest
realtime optimisation on this project and filing it as a fix.

## What the check reports but does not fail on

73 published tables this repo does not subscribe to. That number is **not a
delete list**: the World Hub is a separate repo against the same database and
subscribes to many of them. It is where to start asking, and the question is
worth asking - `realtime.apply_rls` is the single largest consumer of database
time on this project at roughly 62 hours of the sample, 833k calls at 270 ms
mean. The worked example of doing it right is #3032: ship the alternative
delivery path, prove nobody is left listening, then trim.
