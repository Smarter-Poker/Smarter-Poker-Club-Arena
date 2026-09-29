# A blind level is not spent on a hand that was never dealt

2026-09-23

## What I was asked, and what was actually there

The brief said six RUNNING tournaments had been frozen for one to five days
with 97 players still seated, and it said to verify every line of that from
rows. Three of its lines did not survive the check, and one of the three is
the whole case.

**The population is larger than six.** 434 tournaments are RUNNING. 433 of
them hold at least one open seat. Taking "frozen" to mean _RUNNING, still
holding seats, and no tournament manager has renewed its lease for an hour_,
the population is **54 tournaments holding 807 open seats and 32,482,000
tournament chips**. The six named in the brief are inside it.

**Every one of those 807 seats is a horse.** So are all 4,029
`tournament_players` rows across the 54. Zero humans, corroborated by
`/health.humansSeatedTotal: 0`. That changes nothing about what is owed
(CLAUDE.md 10.5 - a horse pays the same buy-in out of the same club wallet and
is owed the same game), and no `is_horse` filter appears anywhere in the
repair. It does mean no human is sitting at a frozen table right now.

**The blind-level claim was attached to the wrong tournament, and was true of
twelve others.** The brief said `$100 Freeroll 12:00 PM` "has advanced to
blind level 162 while its tables dealt no hands at all". It did not: its last
eight hands, ending 2026-09-18 22:10:25, were all dealt at 43,875/87,750,
which is exactly the blinds its stored `blind_level_state` carries at index 162. That tournament reached level 162 by being played for twenty-nine hours,
not by being frozen.

But twelve _other_ events did precisely what the brief described, and that is
the defect.

## The defect

A blind level is a wall-clock deadline a player loses to. CLAUDE.md section 13
invariant 4 says such a deadline is thawed, never burned, and
`advanceBlindLevel` already carried that rule twice:

- a level that comes due **during a break** is owed, not spent;
- a level that comes due **inside the maintenance freeze** is owed, not spent.

Both are the same sentence: the field could not play, so the level was not
played. There is a third way a field cannot play and it was not covered - **the
tournament's own tables stop dealing.** The level clock is a local `setTimeout`
chain and it keeps its own time perfectly well with every table under it dead.

Measured on production today, on an engine that has been unable to restart
since 2026-09-18 (release `8825af51`, leader since 21:56 UTC that day):

| event                                      | last hand      | blinds then  | avg stack then | blinds now                      | avg stack now |
| ------------------------------------------ | -------------- | ------------ | -------------- | ------------------------------- | ------------- |
| Evening Mystery Bounty (PLO5) `95a31bb1`   | 09-22 13:28:45 | 2,000/4,000  | **7.50 BB**    | 500,000/1,000,000, ante 150,000 | **0.03 BB**   |
| $100 Freeroll 6:00 AM `6915596c`           | 09-22 13:36:18 | 2,500/5,000  | 12.83 BB       | 200,000/400,000                 | **0.16 BB**   |
| Breakfast Turbo `019b6263`                 | 09-22 14:40:01 | 7,500/15,000 | 5.80 BB        | 300,000/600,000                 | **0.15 BB**   |
| $100 Freeroll 12:00 AM `37f7d04b`          | 09-18 06:29:58 | 250/500      | 30.00 BB       | 2,625/5,250                     | 2.86 BB       |
| DSS Thursday $11 Mystery Bounty `6b9e2253` | 09-18 03:47:52 | 2,000/4,000  | 11.72 BB       | 9,375/18,750                    | 2.50 BB       |

Eight more moved by smaller margins. `$100 Freeroll 12:00 AM` ran its clock on
for **111 hours** after its last hand, from level 9 to level 141.

The two remaining players in Evening Mystery Bounty hold 30,000 chips each
against a 150,000 ante. Resuming that event as it stands is not the game they
were playing: the first hand posts every chip either of them owns before a
card is read, and the finishing order is decided by our outage rather than by
poker.

It is still running. `level_started_at` on that event moved from 16:56:06 to
17:02:50 between two reads six minutes apart while I was measuring.

## The fix, at the root

`server/src/tournament/TournamentManagerBase.ts`. A third guard in
`advanceBlindLevel`, in the same shape as the two beside it and after both:

```ts
if (this.lastObservedHandCompletedAtMs < this.blindTimerStartedAt) {
  // ... announced once per level ...
  deferredWakeMs = TournamentManagerBase.STALLED_LEVEL_RECHECK_MS;
  return;
}
```

The witness is recorded in the `onHandComplete` callback that already fires on
every hand - one assignment, no wake, no query, and deliberately outside the
zero-stack gate that keeps the elimination scheduler's fan-out small, because
a level is spent by play and most hands eliminate nobody.

The witness is **seeded to zero, not `Date.now()`**. Seeding it to now is the
trap one level up (10.86 rule 4): a replacement manager adopting a
long-stalled event would inherit a clean witness, find its overdue level due at
once, and spend it on a table that has still dealt nothing - the very first
thing a recovery did would be the burn the guard exists to stop. Zero costs a
healthy restart at most one 15-second recheck, because its tables deal within
seconds of adoption.

The hold is announced once per level, so a tournament whose blinds simply
stopped is a line somebody can read rather than a new silence (10.83).

This is the hard-coded fix (10.11, 10.12). It prevents the outcome. There is
no sweep, no cron, no back-pay job and no reconciler behind it.

Pinned by
`tests/a-blind-level-is-not-spent-on-a-hand-that-was-never-dealt.law.test.ts`,
which strips comments before every match (a law satisfied by the prose
describing it is not a law) and was verified to go red against two mutations:
removing the guard, and re-seeding the witness to `Date.now()`.

## The settlement

`supabase/migrations/20260923165845_restore_blind_levels_burned_by_a_stalled_tournament_clock.sql`

**No money was owed and none moved.** All 54 stalled events are mid-flight
with their prize money intact and unpaid: `tournament_escrow` across them
reads `gross_in` 8,453.00, `prize_out` **0.00**, `prize_balance` 14,949.25,
`bounty_balance` 662.41, `fee_balance` 710.22, and not one escrow is closed.
`fn_unaccounted_seat_exits()` returns **zero rows**, so no chips left a wallet
and landed nowhere. There is no unpaid prize, no wrong finishing position and
no refund owed, because no event has finished. 10.9 condition 1 is what
settles this: an outcome that has not happened cannot be read, and I will not
pay one I would have had to invent.

The damage was to the **stacks**, and that is what the migration repairs. Each
of the twelve events is put back to the level in force at its last dealt hand,
and its level anchor is put back to that hand's instant. Nothing in it is a
number I chose: the blinds come out of `hand_history` - the witness that was
there - and the level index is the one row of that tournament's own published
ladder carrying exactly that pair. Matching both blinds is what makes it
unique, and all twelve matched exactly one row.

The level therefore resumes overdue by the whole stall, which is correct: the
engine clamps an overdue level to one second, the new guard holds it until the
tournament deals again, and the level that was in progress when play stopped
finishes when play restarts. Picks back up exactly as it was.

Assertions abort the migration rather than guess: nothing derived, more than
the 54 measured stalled events, any ambiguous ladder match, or **any level that
would not move down**. A restore may only ever lower a blind level; raising one
would take chips off a player for our defect, which 10.9 forbids.

Proved first in a rolled-back transaction (11.5: one call, one `DO` block
ending in `RAISE EXCEPTION`, an error is the success case). The probe returned
`PROBE OK rows=12 updated=12 alerts=1` with every before/after named, and it
found two real defects in the migration before production did - a PL/pgSQL
`record r` shadowing a SQL alias `r(row, ord)`, and `severity = 'high'`, which
`financial_alerts_severity_check` does not allow. Nothing committed:
`financial_alerts` holds zero rows for this source.

A resolved `financial_alerts` row is written by the migration itself, carrying
the measurement and the reasoning.

## The paragraph

Fifty-four RUNNING tournaments on this platform have been unable to deal since
their tournament managers stopped renewing their leases, the oldest since
2026-09-21 and the rest since 2026-09-22, because the engine has been unable
to restart since 2026-09-18. They hold 807 open seats, 560 distinct accounts
and 32,482,000 tournament chips, and every one of those seats belongs to a
horse - which under 10.5 entitles each of them to exactly what a human in that
seat would get. Nobody was paid and nobody was owed a payment: every one of
those events is mid-flight, its prize money is sitting intact and undistributed
in `tournament_escrow`, 14,949.25 of prize balance against 0.00 paid out, and
`fn_unaccounted_seat_exits()` finds no chips that left a wallet and landed
nowhere, so nothing was stranded and nothing was destroyed in the ledger. What
_was_ destroyed was the stacks in twelve of those events, because the blind
clock went on charging blinds and antes for hours - 111 hours in the case of
`$100 Freeroll 12:00 AM` - against tables that dealt no hand at all, taking
Evening Mystery Bounty's last two players from seven and a half big blinds
each to three hundredths of one, and taking four other events below a single
big blind or close to it. Those twelve are put back, each to the exact level
its own last dealt hand was played at, read out of `hand_history` and matched
to the single row of its own published blind ladder carrying those blinds; no
event's level was raised, no chips changed hands, and every one of the other
forty-two stalled events is left exactly as play left it, because their blinds
never moved after their last hand and they need the engine to come back, not a
correction from me.

## What I could not settle

**The engine restart itself.** These tournaments resume when the engine
restarts and a fresh process re-adopts them; that restart is blocked on
`auto-deploy-hetzner`'s doors gate and is owned by another task. My engine
change queues behind the same gate.

**The ordering between this migration and that restart.** The outgoing engine
is still advancing levels on these dead tables right now. If the migration
applies before the cutover, some of the twelve can be partially re-burned by
the process that is still running, bounded by their ladder ends. The migration
re-derives from live rows at apply time, so it is correct for whatever state it
finds; the durable guarantee arrives with the cutover, when the new process
holds every level until its tournament deals. I have deliberately **not** built
anything that re-applies it (10.12).

**Whether the 2026-09-21 quarantine pass fixes the dead-manager half.** The
brief asked for the line that lets a dead holder keep a lease. What the rows
say is narrower than "a dead holder": all 427 lease rows, including the 48
whose heartbeat is over an hour old, are held by `1-3846b8bb`, which is the
**live current leader**. `activeTournaments` is 434 - a manager object for
every RUNNING tournament - while 48 of their leases have not been renewed for
up to two days. That is the shape `settleQuarantinedTournamentManagers`
(2026-09-21, `GameServer.ts`) was written for, and it is already on
`origin/main`. It is **not in production**: the serving engine is `8825af51`
from 2026-09-18, and `/health` carries none of the fields that pass publishes
(`tournamentManagersQuarantined`, `quarantinedTournamentManagers`). So I cannot
tell from this evidence whether that fix is sufficient, and I am not going to
write a second, competing lease mechanism to find out (10.8: never invent a
third rule). The next agent to see a restarted engine can read those fields and
answer it in one call. The database side is not the problem:
`claim_tournament_lease_v2` treats a 30-second-stale lease as claimable by
anyone, including the same instance.
