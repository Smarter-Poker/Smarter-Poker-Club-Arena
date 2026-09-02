# The overlay was a publication-lead bug, not a capacity problem

**2026-09-02** - `fix/mtt-publish-lead-overlay`

## The wrong diagnosis this replaces

The 2026-09-01 horse audit reported the overlay finding as "the club is
guaranteeing more capacity than the fleet fills", and paired it with
`fleet_seat_starvation` as though they were one story. Dan rejected that
outright, and he was right: the union has **392 tournament-lane horses**
(`events` + `both`, out of 584 distinct horses across Club JAQK and SHARK
CLUB), each able to play four games. That is ~1,568 tournament slots. The
largest guarantee on the recurring board needs 56 entrants.

Capacity was never the constraint. The horses were idle.

## The actual cause

`mttPrestartHorseTarget` builds a field over `MTT_PRESTART_RAMP_MS` (72 hours),
adding at most `MTT_PRESTART_MAX_STEP` (6) entrants per tick, no oftener than
every 45 seconds (`GameServer.lastMttRampAt`). Both recurring creators were
publishing their events moments before the gun:

| creator            | lead       | ticks available | entrant ceiling |
| ------------------ | ---------- | --------------- | --------------- |
| `createTournament` | 60 seconds | 1               | 6               |
| `createXMTT`       | 5 minutes  | ~7              | ~42             |

A 72-hour ramp was being given 60 seconds. No number of free horses can lift a
ceiling set by ticks.

## The evidence

Completed guaranteed events, 5 days to 2026-09-02:

| published             | events | overlaid | total overlay | avg pool | avg guarantee |
| --------------------- | ------ | -------- | ------------- | -------- | ------------- |
| < 10 min before start | 299    | 58.5%    | 24,495.40     | 368.10   | 295.74        |
| > 24 h before start   | 38     | 10.5%    | 420.00        | 1,920.77 | 1,060.53      |

Same ramp, same fleet, same horses. The group with time to run **overshoots**
its guarantees; the group without it pays overlay 58.5% of the time.

Registration timestamps on the worst single event (Union Grand Championship,
2026-08-30, 910.00 overlay) show the mechanism directly: created 19:06:28,
start 19:11:16, and the **first entrant arrives 74 seconds before the gun**.
Fifty-two arrive in that last minute. The ramp was working perfectly and simply
ran out of clock.

## The change

`MTT_PUBLISH_LEAD_MS = 30 minutes`, used by both creators.

Thirty minutes rather than the ramp's full 72-hour window, because the window
is a ceiling and not a target: the squared curve leaves an event published days
out sitting at one entrant for most of that time, and the recurring duplicate
guard keys on "an instance of this name is already REGISTERING", so a long lead
would hold the next instance of every recurring event behind the current one and
thin the board. Thirty minutes is 40 ticks = 240 entrants of headroom against a
largest current requirement of 56.

It also makes the lobby honest. An event that appears 60 seconds before it
starts cannot be joined by a human who is not already staring at the board -
which is the same rule the 72-hour window was widened for on 2026-08-26.

## What was tried and rejected

The first draft ALSO let a guaranteed event step past `MTT_PRESTART_MAX_STEP`
once the clock ran short, on the reasoning that pacing matters less than
covering a promise the club has already made.

The existing pin `one tick is a STEP, never a jump to the goal` refused it, and
it was right to. `registerHorses` buys in one horse per sequential RPC inside
the same 5-second loop that decides when every other tournament starts; at T-1s
a 20,000 guarantee wants 107 entrants, and firing 107 round trips in one pass is
the platform stall that cap was added to prevent. A short clock is not something
to out-run in the ramp. It is something not to create.

That rejection is now pinned in its own right
(`the step cap survives a guarantee`) so the shortcut is not re-derived from the
overlay numbers in this commit message.

## Verification

- `npx tsc --noEmit` clean.
- `npx vitest run` - 324 files, 3,603 tests, all pass.
- New pins in `MttPrestartRamp.test.ts` replay the ramp tick by tick: the
  guarantee is covered inside `MTT_PUBLISH_LEAD_MS`, is NOT covered at the 60
  second lead this replaces, and the per-tick pacing is unchanged when there is
  time.

## Not fixed here

`Deep Stack Society` (416 horses, 2.43M treasury) has `union_id = NULL` and no
`union_clubs` row, which is deliberate - Dan, 2026-09-01: "THIS CLUB IS NOT
SUPPOSED TO BE ATTACHED TO THE UNION". Its 17 guaranteed events in the window
drew 16 registrations total, 13 of them zero. Its events are subject to the same
publication-lead bug and should improve with this change, but its near-total
absence of entrants is a larger gap than the lead alone explains and wants its
own investigation.
