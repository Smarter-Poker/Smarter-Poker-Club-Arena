# 2026-09-29 - One ask on screen at a time

Found on the first on-device walkthrough (Android emulator, a fresh account).
A player signing in met every first-run question at once:

- the notifications sheet ("Never Miss A Seat") armed its twenty-second timer
  at sign-in, so it rose while the terms were still being read, and again
  underneath the age gate;
- the analytics question rose 2.5 seconds after sign-in, also underneath the
  age gate;
- the moment the gate closed, the two sheets sat stacked on top of each other
  at the bottom of the screen;
- after an under-18 answer signed the account out, both sheets were still
  there on the sign-in form.

Every prompt had its own timer and none of them knew the others existed. The
same stacking happens on the website for the notifications sheet, which could
rise over the terms and over the first-run welcome.

## The rule, in one place: `src/lib/promptLane.ts`

- **Gates hold the lane** while an answer is owed: the terms (`TOSGuard`,
  while checking or unanswered), the app's age gate (while checking, asking or
  showing a refusal, on every route), the first-run welcome and the profile
  gate (`AppLayout`, while up). Each gate renders exactly as before; holding
  the lane only tells everything else to wait.
- **Soft asks take turns** in a fixed order, only while no gate holds: the
  daily bonus sheet, then the analytics question, then notifications. One at a
  time. The one on screen keeps its turn until it is answered - a later ask
  never pushes it off - and a gate that appears mid-way hides it until the
  gate is answered.
- **Delays count only on a clear lane.** "Let the player land before asking"
  used to count from sign-in; it now counts from the moment nothing else is
  asking, so a sheet never lands the instant the previous one closes.
- **A sign-out takes the sheets with it**, and a different account starts
  over (the notifications sheet used to keep the first account's decision for
  the rest of the visit).

## What changed per prompt

- `ConsentPrompt`: rises 2.5s after the lane clears, only while it holds the
  turn, and only while signed in.
- `FirstRunPushPrompt`: its arming effect also waits for a clear lane; it
  renders only while signed in and holding the turn; a new account resets it.
  Its one-ask-per-account rules (the route deferral, only an answer spends the
  ask) are untouched.
- `DailyBonusEntry`: treats a held lane or another sheet on screen like its
  existing `suspended` - it does not ask, so a held day is not spent - and it
  is first in the soft-ask order.
- `TOSGuard`, `AgeGate`, `AppLayout`: hold the lane; nothing they render
  changed.

`src/lib/promptLane.ts` joins the entry chunk (TOSGuard wraps the router);
declared in `scripts/ci/entry-chunk.d/fix-one-ask-on-screen-at-a-time.json`.

## Tests

- `tests/unit/promptLane.test.tsx` (6): nothing soft under a gate; exactly one
  ask when it lets go, first in order; turns pass in order; the ask on screen
  keeps its turn; a mid-way gate hides it and it comes back; unmount releases.
- `tests/components/firstRunPrompts.oneAtATime.test.tsx` (3) renders the REAL
  `ConsentPrompt` and `FirstRunPushPrompt` beside a gate on fake timers and
  walks the device sequence: nothing under a 90-second gate; after it, the
  question alone, notifications only after a fresh twenty seconds; a sign-out
  takes every sheet. All three fail against the old components, each for the
  reason seen on the device.
- The push pin in `tests/club-arena-can-subscribe-to-push.test.ts` still
  requires `suppressed` in the arming effect's dependencies, and now allows the
  lane beside it.
