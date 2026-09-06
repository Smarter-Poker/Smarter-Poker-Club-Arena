# Realtime Phase 5 deep audit - the third socket, and the eleven callers

2026-09-06. Branch `audit/phase-5-deep-dive`, off `d3c1855ed`.

Phase 5 shipped three things: one server clock, sockets that re-earn their
trust, and a cap. This is the pass that went back over all three looking for
the half that was not built, and it found two defects of the same shape as the
ones the programme has been fixing since Phase 1 - a mechanism that is correct
where you look at it and absent where you do not.

---

## Defect 1: re-auth and the cap reached two of the three sockets

`/ws/channel` had neither. Phase 5 gave both to `EngineWebSocketServer`, which
serves `/ws/table/:id` and `/ws/multi`, and `ChannelWebSocketServer` was left
authenticated once at the upgrade and trusted for as long as the tab stayed
open.

**Phase 4 wrote the warning for this exact failure** - "a version on two of the
three sockets is worse than none" - and Phase 5 committed it one phase later.

It is the worst of the three to have missed. `/ws/channel` carries club
presence, the lobby, hand replay and `FINANCIAL_UPDATE`: with a seven-day
Supabase token, a player who signed out - or whose session was revoked, which
is the 2026-09-03 outage's own mechanism - kept receiving their wallet balance
and ledger entries indefinitely, on a socket nothing would ever close.

### The fix, and why it is one implementation

Copying the sweep into the second server would have produced two copies of a
security mechanism, drifting from the first tuning. The mechanism moved into
`server/src/transport/wsHelpers.ts` instead:

- `runReauthSweep(opts)` - takes the connection map, a `path(conn)` label, a
  verifier, a close function and the three numbers. Every rule that used to be
  inline is now here once: the per-sweep bound, the next slot claimed BEFORE
  the await, the vanished-socket check, only a definitive `invalid` closing,
  the counters, and the `catch` that makes an unreachable auth service a
  non-event.
- `socketsHeldBy(connections, userId)` - counts, and only counts. The caller
  refuses the ARRIVING socket; nothing in here can close one.
- `staggeredReauthAt(intervalMs)` - takes the period rather than reading a
  module constant, so the two servers cannot stagger over different periods.

`EngineWebSocketServer` now exports `REAUTH_INTERVAL_MS`,
`REAUTH_MAX_PER_SWEEP` and `MAX_SOCKETS_PER_USER`, and `ChannelWebSocketServer`
imports them. Three sockets, one set of numbers, one implementation.

### And the law now runs the code, not only reads it

`trustIsRenewedAndBounded.law.test.ts` was entirely source pins. That is the
right tool for "the slot is claimed before the await" and "this file imports
the shared numbers", and it is blind to a body that still says the right words.
The mutation run proved it: replacing

```ts
if (c.userId === userId) held++;   ->   held++;
```

turns the cap into "refuse everybody once any ten sockets exist anywhere" and
left **all twenty-one pins green**. A behavioural `LAW 8` was added that drives
the real helpers, and a second mutation - a sweep that ignores each socket's
due time - survived the first version of that too, because the not-yet-due
socket sat last in a map the per-sweep bound never reached. It sits first now.

**Mutations, all red:** the cap removed from the channel socket; the shared
sweep removed from its heartbeat; the slot claimed after the await; an
`unavailable` verdict closing a socket; the vanished-socket check dropped; the
per-sweep bound dropped; the `catch` dropped; the stagger made constant; the
due-time check dropped; `socketsHeldBy` counting the room.

---

## Defect 2: the clock was unified and its callers were not

Phase 5 folded two `serverNow()` implementations into one and pinned five
consumers. It did not ask which OTHER code measures a server-stamped instant,
and eleven places were still subtracting `Date.now()` from a time the engine or
Postgres had stamped.

A device clock that is three seconds fast is exactly the error the whole
mechanism exists to remove; below, it was being added back.

| where | what it measures | why it matters |
| --- | --- | --- |
| `MultiTablePage` `nowMs` | `turnDeadlineMs`, `sitOutDeadlineMs`, the decision deadline | **the worst one.** The table's own ring has read `serverNow()` since Phase 5, and the tab strip - the surface a multi-tabler actually watches - did not. Two clocks on one screen, disagreeing, and the player believes the one they are looking at |
| `EngineStateClient.inAnnouncedRestart()` | `resume_expected_at` + grace | the Phase 4 window itself. A fast phone leaves it early and escalates its ladder INTO the restart - the spin this programme exists to end |
| `InsuranceModal`, `TablePage` | the engine's `deadlineAt` | a timed decision that spends chips. Its comment promised "the seconds shown are the seconds the server will actually wait" |
| `DisconnectToast` | `graceDeadlineMs` | its comment read "no drift under clock skew" |
| `useMaintenanceBreak`, its banner and both break screens | `break_ends_at` | and the hook's fallback built `Date.now() + remaining_ms`, so ONE field held a server instant on one path and a device instant on the other, and no reader downstream could tell which |
| `TournamentClock` | level end, `break_ends_at` | |
| `sitOutDeadline` | `sit_out_at` | it carries a two-minute skew tolerance written to survive this exact problem; the tolerance stays as a backstop |

All eleven now read `serverNow()`. Where a fallback stamps a fresh instant
(`+ insSecs * 1000`, `+ remaining_ms`) it stamps it on the server clock too, so
the field carries one clock whichever branch produced it.

### The law that keeps them

`there-is-one-server-clock.law.test.ts` gained a `LAW 5` that scans every file
under `src/` for a known server stamp (`turnDeadlineMs`, `deadlineAt`,
`graceDeadlineMs`, `breakEndsAtMs`, `break_ends_at`, `restartWindowUntil`,
`resume_expected_at`, `sit_out_at`, and the rest) sitting on either side of a
`Date.now()`, and pins each fixed caller by name. It strips comments before
scanning, because comments are where three of these bugs were described as
already fixed.

**Mutations, all red:** each of the ten fixed sites reverted one at a time.

---

## Also corrected in the same commit (CLAUDE.md 5.8)

- `a-scheduled-restart-is-not-a-failure.law.test.ts` pinned
  `Date.now() < this.restartWindowUntil`; it pins `serverNow()` now.
- `the-break-clocks-agree.law.test.ts` pinned the stagger's expression inside
  `EngineWebSocketServer`; it follows it to `wsHelpers` and pins that the table
  server passes its own period in.
- `TournamentFixes.guard` caught the new law test importing `./wsHelpers`
  without the `.js` extension Node resolves literally.

---

## What Phase 5 got right, checked and left alone

- Only a definitive rejection closes a socket; "could not ask" does not. An
  auth blip signing every player out would be a worse outage than the one this
  programme started from.
- The cap refuses the arriving socket rather than evicting an existing one,
  before the connection is registered, on every upgrade path.
- Both refusals are counters on the always-on exposition.
- The estimator still takes the window minimum rather than the average -
  Cristian's algorithm, and the 2026-08-28 finding it came from.

## Suites

Client `14459` tests, server `6085` tests, and the entry-chunk budget gate.
