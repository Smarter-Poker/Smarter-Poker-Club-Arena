# A turn handed back, proved in a browser and bound to the engine (2026-10-04)

Tests only. No client or engine code changes. Follows
`2026-10-04-a-turn-handed-back-is-a-turn.md` (#6116), which fixed the page
showing no action bar to the seat that closes a street and opens the next.

## Why

That fix shipped with its rule tested on frames written out by hand and its
TablePage wiring pinned by reading source. Its own changelog said so: "Not
exercised in a browser or on a device." And the defect had come from two
changes a month apart that nothing connected: the engine's street beat was cut
to 500ms (2026-09-07), and the page extended a 1500ms refusal to
`turn_change` (2026-09-09). Either alone was fine.

So three things were missing: the page under a real browser, the engine's
frames as the engine really sends them, and something that fails when one side
moves without the other.

## What is here

1. **The engine's wire, recorded.** `tests/live-turn/wire/same-seat-street-boundary.jsonl`
   is one heads-up hand as one subscriber received it from the real
   `ServerTableEngine`, `HandController` and `TableStateHub`: the SNAPSHOT,
   every DELTA and EVENT, with their sequence numbers and spacing. Seat 2 is
   the big blind. It calls to close preflop and opens the flop, calls to close
   the flop and opens the turn (the hand from the report), and opens the river
   after the other seat closes the turn (the case that always worked).

2. **The engine is held to it.**
   `server/src/engine/aSeatThatClosesAStreetIsHandedTheNext.test.ts` plays that
   hand on the real engine on every run and checks two things. First, the
   facts the page's rule reads: after a seat's own action closes a street the
   engine goes on naming that seat on the clock it already had, arms the next
   street with a later frame on a newer clock, and follows it with a
   `turn_change` carrying that turn's decision context. Second, that the
   committed recording is still, frame for frame, what the engine sends. If
   the engine's frames change shape the test fails and says how to record them
   again (`WRITE_LIVE_TURN_WIRE=1`).

3. **The page's rule is held to the recording.**
   `tests/unit/aSeatThatClosesAStreetIsShownItsTurn.test.ts` feeds the
   recording through the real `mapEngineSnapshot` and the real fence functions
   in the order TablePage calls them. Every turn the engine gave the seat shows
   the action bar, with the decision context the engine was waiting on; the
   bar comes up when the engine arms the street and not when a timer runs out;
   and it never comes up while the engine is between turns. The rule as it
   stood until 2026-10-04 is run on the same wire as a witness: no action bar
   on either street the seat had closed.

4. **The built app, in a browser.** `tests/live-turn/` mounts a production
   build at a table, signed in as that seat (the stale-client suite's mock
   backend), and plays it the recording over the engine socket the page opens
   (`replay-engine.ts`, speaking the multiplexed protocol). The hand advances
   only when the page's own buttons are tapped, and an action is accepted only
   if it is the recorded action carrying the decision context the real engine
   was waiting on.

## What the browser showed

Chromium, 390x844, three builds:

| Build                         | After calling to close a street                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `5ffbeeae`, before the fix    | No action bar for the six seconds watched. Engine had sent the armed frame and `turn_change` 500ms after the call. |
| `cac4a707`, the fix's branch  | Action bar back 568ms and 583ms after the tap                                                                      |
| `005ca564`, main with the fix | Action bar back 581 to 706ms after the tap, over three runs                                                        |

Measured on the page's own clock, from the tap to the bar reappearing. The
engine arms the street 500ms after the action reaches it, so the bar is back
as soon as there is a turn to show. On the fixed builds all four actions of
the hand were accepted with the engine's contexts, and no time bank was
requested. A second test stretches the gap after a check, as a slow link
would, and the bar stays down until the engine arms the next turn.

## How to run the browser suite

It runs in no CI job. Items 2 and 3 do, in the engine and client suites.

```
VITE_SUPABASE_URL=https://example.supabase.co \
VITE_SUPABASE_ANON_KEY=live-turn-build npx vite build --outDir <dir>
LIVE_TURN_DIST=<dir> npx playwright test -c playwright.live-turn.config.ts
```

`LIVE_TURN_EXPECT_DEFECT=1` asserts the defect instead, for a build that
predates the fix. `LIVE_TURN_CHROMIUM=<path>` names a Chromium binary where
Playwright's own is not installed.

## Found while building it, and not changed here

- **A notice covers the action bar on a phone and takes the taps.** The
  toast container is `position: fixed; bottom: 16px` at widths up to 480px,
  above everything, and a toast takes pointer events for its four seconds. The
  action bar is `position: fixed; bottom: 0`. Measured at 390x844 with one
  toast up: toast 768 to 828px, action bar 792 to 846px. A tap on the middle
  of Call landed on the toast (Playwright refused the click until the toast
  left). About the bottom 15px of each button stays reachable, and the toast
  has a Dismiss button. In the two days of telemetry on hand, 20 error toasts
  were shown on table routes, 17 of them the pre-action messages that #6116
  stopped. Where a notice should sit on a table is a design choice (Dan,
  2026-09-04, moved the connection messages onto the felt), so it is reported
  rather than moved.
- The stale-client suite's table fixture has no embedded `arena` relation. A
  fixture without it showed the table's "cannot reach it" overlay here; that
  suite asserts only that the page is there. The live-turn fixture carries the
  relation.

## Not verified

- A phone. The browser is desktop Chromium at a phone's viewport with touch.
- Production. The live site serves the fix (see the first changelog's
  delivery); nobody has played a same-seat street boundary on it yet, so the
  platform measure (median 37.7s, 67% forced by the engine) has not been read
  again.
