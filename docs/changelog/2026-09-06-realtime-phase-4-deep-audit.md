# Realtime Phase 4 - the deep audit before Phase 5 (2026-09-06)

Dan, before Phase 5: "do a deep dive and verify that everything you've built in
the previous phase is 100% fully built, coded, wired in and tested. CHECK FOR
ANY AND ALL BUGS, GAPS, STUBS, ERRORS, REGRESSIONS OR WIRING ISSUES ANYWHERE
AND EVERYWHERE."

Phase 4 is live on both halves (see the programme doc). This pass found three
defects in it, one of which meant the phase did nothing at all for the players
most likely to need it.

---

## Defect 1: the frame reaches only the sockets that were already there

**The most serious, because it silently halved the phase.**

Phase 4 taught the transport to read the break announcement off the
`maintenance_break` frame. That frame is broadcast twice - once at :53, once at
:55 - and `TableStateHub.emitEvent` delivers to CURRENT subscribers. It retains
an event for a late joiner only if the event asks (`replay_until`), and never
for longer than `HUB_MAX_EVENT_REPLAY_MS`, which is **sixty seconds** - it
cannot span a seven-minute break.

So a player who sat down at **:54** received nothing. Their window stayed shut,
their ladder escalated exactly as it did before Phase 4, they asked GoTrue, and
their page was a candidate for the reload. That happens every hour, to whoever
joined in the last two minutes before a break - which is precisely the
population the phase was written for.

**Why not just add `replay_until` to the frame.** It was the first thing I
reached for and it is the wrong fix: the hub would clamp it to sixty seconds, so
it would cover a sliver of the window and read as if it covered all of it - a
mechanism that looks armed and is not, which is the disease this whole programme
keeps finding.

**The fix.** The break is a row in the database - CLAUDE.md 13 rule 3: "The
break is the single row in `engine_maintenance_break`" - and
`useMaintenanceBreak` already reads it on mount, for exactly the reader a socket
cannot reach. This adds the wire from that reading into the ladder:
`EngineStateClient.noteScheduledRestart()`, fed by the hook, fed by TablePage.

Three properties that make it one mechanism rather than two:

- **The frame goes through the same door.** The socket path now calls
  `noteScheduledRestart` too, so a frame and a database read cannot disagree
  about which wins.
- **Monotonic.** It takes the later of what it holds and what it is told, so a
  stale read cannot shorten a window the engine has already extended.
- **Seeded before `connect()`.** A client mounting mid-break must not spend its
  first retries escalating while an effect waits for its turn.

`useMaintenanceBreak()` moved above `useEngineTableState()` in TablePage to make
this possible. It takes no arguments and depends on nothing in between, so it is
a pure move - and the law pins the ordering, because the whole thing is useless
if the break is read after the socket that consumes it.

## Defect 2: a protocol refusal was not a number

The auth counter sitting two functions away exists because twenty-two hours of
refusals were not a number anywhere. The protocol gate shipped with exactly that
defect: `refuseProtocol` closed the socket and recorded nothing.

The day `MIN_CLIENT_PROTOCOL` is raised is the one day that number matters -
the wave of stale tabs being turned away tells you whether it is **draining**
(tabs fetching a new bundle, as designed) or **flat** (tabs reloading into the
same refusal, which would be a loop). It would have been invisible.

`poker_ws_protocol_refused_total{path}` now, on the always-on exposition beside
the auth counter, all three paths present at zero from the first scrape.

## Defect 3: two copies of one refusal

`ChannelWebSocketServer` inlined its own four-line 4426 close rather than using
the table server's. Two implementations of one refusal, one of which would have
been the one nobody updated - and it is what would have kept the new counter off
the channel socket. `refuseProtocol` is exported and shared; the law pins that
exactly one place writes a 4426 close.

## Defect 4 (minor): four facades, four hard reloads

The multiplexed socket carries every table, so one 4426 closes four facades at
once and each client answered it - four concurrent service-worker
unregistrations and Cache Storage purges racing on a page that is leaving
anyway. Single-flight now, latched rather than debounced: there is no second
attempt to make.

---

## What was checked and found correct

- **The mux fan-out delivers EVENT frames to every facade's `handleMessage`**
  (`facades.get(tableId)?._message(raw)`), so the maintenance branch is reached
  on the default transport, not only on the kill-switch one.
- **A 4426 on the mux propagates the real close code** to every facade through
  `failAll(e.code, e.reason)`, so each client sees 4426 rather than a generic
  close.
- **`adopt()` announces to a table engine created during a break**, so a table
  that comes up at :58 is parked and announced rather than dealing alone.
- **`restart_in_ms` arithmetic** is correct at both phases: two minutes at
  `last_hand`, clamped to zero once `counting_down` has fixed `breakEndsAt`.
- **No stubs, TODOs, `@ts-ignore` or `as any`** anywhere in Phase 4.

## Mutation-tested, again

Every fix was checked by breaking it and confirming the law goes red:

| mutation                                   | result     |
| ------------------------------------------ | ---------- |
| the late joiner loses the database wire    | 1 failed ✓ |
| the window setter stops being monotonic    | 1 failed ✓ |
| the hook seeds the window after connecting | 1 failed ✓ |
| the protocol refusal stops being counted   | 1 failed ✓ |
| the counter stops being exposed            | 1 failed ✓ |
| the reload stops being single-flight       | 1 failed ✓ |

All green on restore.
