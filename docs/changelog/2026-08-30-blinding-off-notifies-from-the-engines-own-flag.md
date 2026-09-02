# 2026-08-30 — Blinding off: the last of the eight

The eighth and final dead call site from #1498.

`TournamentAutoSeat.tsx` watched `table_seats` for `is_sitting_out` / `is_away`
on a tournament seat, showed an in-app banner, and fired
`pushNotificationService.notifyBlindingOff()` at a transport OneSignal's
retirement had killed on 2026-08-19. It had delivered nothing for eleven days.

## I was wrong about this one

I closed the previous pass saying blinding off was "a client-observed tournament
condition with no DB transition to hang a trigger on, so it belongs to the
engine, not to a migration."

The client's own comment, three lines above the dead call, said otherwise:

> The engine flags a seat `is_sitting_out` after consecutive timeouts and
> `is_away` on a disconnect, and it keeps taking that player's blinds and antes
> either way. **That flag on a TOURNAMENT seat is the server's own statement
> that this player is paying to not be there.**

It is a column transition on a table. That is exactly a trigger, and I had read
that comment already.

## Why server-side is not just tidier here

Somebody being blinded off is, by definition, **not looking at the app**. A push
that only fires while a React component is mounted is the one that matters
least. `trg_notify_blinding_off` reaches them whether or not Club Arena is open;
the banner is now only the half for when they are looking.

## Care taken

**Volume.** `table_seats` is a hot table with ten existing triggers. Measured
before adding an eleventh: **2 sit-outs in 24 hours** platform-wide, 1 of them
on a tournament seat. Rare event, not a firehose.

**Fires once, on the transition only.** Not when they come back, not repeatedly
while they stay away, not on a seat they have already left, and never on a cash
table — a cash seat that sits out simply stops being dealt in; it is not paying
blinds to be absent.

**Horses are players (CLAUDE.md 10.5).** There is deliberately no `is_horse`
filter, and the migration's own assertion fails if one ever appears. A horse
blinding off is a seat paying blinds to not be there exactly like anyone else.
It has no browser, so `/api/cron/push-dispatch` skips it at the consent gate
with `no_subscription` — the same way it would a human who never enrolled. That
is the gate's decision, not this trigger's.

**Never interferes with the engine.** The body is wrapped in its own
`BEGIN/EXCEPTION`; a failed notification must never affect the engine writing a
seat.

## Proof

Probed inside a rolled-back transaction against a **live** tournament seat and a
live cash seat:

```
tournament seat -> away        1 notification, 1 outbox row
already away -> more away      silent
away -> back                   silent
cash seat -> sitting out       silent
```

Rollback verified immediately afterwards: 0 notifications, 0 outbox rows.

One seat did carry a fresh `sit_out_at` inside the probe window, which needed
ruling out: it was a **cash** seat belonging to a horse, written by the engine
concurrently. It cannot have been mine — the seat write and the notification
were in the same transaction, and the notification count is zero. Usefully, it
is also a real-world confirmation that cash sit-outs happen and the trigger
correctly ignores them.

## Urgency (World Hub side)

`tournament_blinding_off` maps to `tournament_starting`, which is in
`URGENT_TYPES`, so it pierces quiet hours and the daily cap. A player bleeding
chips at 3am needs telling at 3am — that is the entire value of the
notification, and an unmapped event can never be urgent. The trade is that
muting "Tournament Starting" also mutes this; both say "your tournament needs
you now", and the alternative is a new toggle that is quiet by default at the
one hour it matters.

**All eight call sites from #1498 are now closed.**
