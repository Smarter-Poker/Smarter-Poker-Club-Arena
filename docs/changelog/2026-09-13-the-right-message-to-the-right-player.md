# The right message to the right player

2026-09-13. Phase 4 of the ticker programme. Three things the rail said to
everybody that it should have said to somebody.

## 1. A player who had already paid read the sales pitch

`isRegistered` has been computed on every poll since the bar was built, and
consumed by nothing except the two personal toasts. So a player who had bought
into Sunday Slam read the same line as a stranger:

```
Sunday Slam Starts In 3:30 · Buy-In 11 · 24 Entered
```

The price is the one field certainly irrelevant to someone who has paid it, and
the field size is the one that is not. They now get:

```
You Are In Sunday Slam · Starts In 3:30 · 24 Entered
```

and the chip reads `YOU ARE IN` rather than `STARTING SOON`, so the news is
legible before the line is.

**Not changed, deliberately:** ordering. An event you are in and an event you
are not still sort by urgency alone. Preferring the unregistered one - on the
grounds that the bar sells and the toast reminds - is a defensible rule and a
product decision, not an implementation detail. It would also mean a registered
event thirty seconds from the gun losing the bar to an unregistered one four
minutes out, which is worse. Urgency still wins.

## 2. An announcement could be about another club, with nothing saying so

The feed is scoped to every club the player belongs to. The rail's colours and
its source switches come from the club they are standing in. So club B's
tournament could appear on club A's table, painted in club A's brand, with no
way for the reader to tell.

The line names the other club now, right after the event and before the price,
because a marquee gives about a second of attention and WHERE matters before
what it costs:

```
Sunday Slam · At Midnight Club · Starts In 3:30 · Buy-In 11 · 24 Entered
```

A club the player is already standing in is never named - that would be noise
on every line.

**This does not settle the governance question**, and it is not trying to.
Club A's operator controls the colours and the switches for announcements that
can be about club B; switching a source off silences club B's advertising to
that player, and club A's brand paints club B's news. Whether cross-club
selling should happen at all is Dan's call. Naming the club is the smallest
honest fix: it stops the player being unable to tell, whatever the answer.

Names cost one extra read per scope - inside the existing five-minute
membership cache, not on the thirty-second poll - and a failed name read is not
fatal: the line simply does not say where, which is what it did before.

## 3. Every event got five minutes

A 2-chip turbo and a 500-chip Sunday major had the same last call. No room
calls a tournament that way: the bigger the event, the earlier the call,
because the decision is bigger and the seat is worth more to fill.

| total buy-in | last call  |
| ------------ | ---------- |
| 0 - 24       | 5 minutes  |
| 25 - 99      | 10 minutes |
| 100+         | 15 minutes |

Five minutes is the floor, so what Dan asked for is what the cheapest event
still gets and nothing that used to be announced stops being announced.

The principle is already in this codebase - `tournamentScheduleWindow` shows a
200+ buy-in on the lobby board for six days and everything else for seventy-two
hours. The ladder is deliberately NOT shared with that helper: a lobby window is
measured in days and a last call in minutes, and one constant serving both would
be a coincidence rather than a rule.

The query horizon is the longest rung so one read still serves every stake, and
each event is then held to its own window - otherwise a 2-chip turbo would ride
the major's horizon. The drain under the strip reads the same number, so a
fifteen-minute call drains across fifteen minutes instead of emptying in its
first third.

**What this costs:** a club running many large events will see a busier rail.
That is the intended trade, and it is a real change in how much the strip talks,
which is why the ladder is three lines in one file rather than a constant buried
in a query.

## Verified

- `tsc --noEmit` clean; eslint 0 errors; title-case and painted-text OK
- 192 assertions across the 11 ticker-touching files, 18 of them new
- Shard 1 of the full suite: 5,637 passed
- `tickerRefreshRecovery` - which mocks the feed this pass changed - still green
  on all 16 of its assertions, so the extra `clubs` read did not break the
  harness that guards the recovery path
