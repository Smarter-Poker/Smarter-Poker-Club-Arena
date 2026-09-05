# Six things wrong with Card Slide, from one screen recording

2026-09-05. Dan recorded `SLIDE BUGS.MOV` on his phone against the live build
and opened with "SO MANY BUGS!". Pulled apart at 3fps, it shows four distinct
defects; two more items are things he asked for that were never built. Every
section below says what the frames showed, what caused it, and what now stops
it coming back.

---

## 1. The peel was running backwards, and it is my fault twice over

**"THE CARDS ARE 'PEELING BACKWARDS' TOP TO BOTTOM INSTEAD OF THE WAY I SHOWED
YOU IN THE PREVIOUS VIDEO."** Frames 4.6-6.5s: the K and Q indices appear along
the TOP edge and the face fills in downward.

That is exactly what I shipped this morning, and it is wrong. The history
matters because the same mistake is available to the next person:

| version | what it did                                            | verdict               |
| ------- | ------------------------------------------------------ | --------------------- |
| v1      | diagonal CORNER curl with a dog-ear flap               | rejected              |
| v2      | horizontal boundary, face revealed **bottom-up**       | never actually judged |
| v3      | I re-read the video and "corrected" v2 to **top-down** | rejected today        |
| v4      | back to bottom-up                                      | this                  |

**The specific error.** Dan said "the cards are still backwards" while
PRODUCTION was still serving v1's corner curl - so that sentence was a verdict
on v1, not on v2, which he had never seen. I treated it as a verdict on v2,
went looking for a different answer in the frames, and found one, because a
bent card at 220x480 supports either reading. Then I wrote the top-down
direction into the code, the CSS, and both test files, complete with a
confident explanation of the physics.

**The rule this leaves behind**, now in `cardPeel.ts`'s header and in the test
file: _a direction Dan has watched and named beats a direction derived from
footage._ If a future frame-by-frame pass seems to show the face arriving from
the top, it is the pass that is wrong.

The unit test now pins the bottom-up clips by exact string **and asserts v3's
clips are absent by name**. A structural check does not catch this: v3
satisfied "the two clips partition the card with no gap or overlap" perfectly,
every time, while running backwards.

## 2. The cards flashed face up before you could peel them

**"CARDS ARE 'FLASHED' BEFORE YOU CAN 'PEEL THEM', THAT KINDA DEFEATS THE
PURPOSE OF THE PEEL."** Frames 4.6-5.2s: K-diamond / Q-heart face up with the
"King High" label, then the backs.

`squeezeRevealed` was `useState(false)` reset by two effects. **A passive effect
runs after the commit it belongs to**, so the first render of a new hand still
carried the previous hand's `true`: the fresh hole cards painted face up and
flipped down one commit later.

It stores WHICH hand is open now (`squeezeOpenForHand`), and the flag is derived
during render. A hand the latch does not name is face down in its first painted
frame; there is no window to flash in.

**The test for this had to be built twice.** The first version used RTL's
`rerender` inside `act()` — and passed against the broken code, because `act()`
flushes exactly the effect that hid the bug. It uses `createRoot` +
`flushSync` now, which commits synchronously and leaves passive effects
pending, so it reads the frame the player actually saw. Verified red against
`origin/main`, green here.

## 3. Show one / show two: four defects under one sentence

**"IT ONLY ALLOWS YOU TO SHOW 1, NEVER BOTH, AND THE EYE BALL STAYS 'LOCKED'
YOU CAN NEVER UNLOCK IT OR 'UNSHOW' AND IT STAYS LOCKED FOR FUTURE HANDS."**

Four independent causes, none of which is the state array — that part was
always correct.

**a. The index was into the wrong array.** The click gives an index into what
SeatSlot _rendered_; `cards_pre_sort` (default true, in the hook and in the
column) re-orders the hero's hand for display; the engine applies the index to
`player.cards` in _dealt_ order. So clicking the ace queued the deuce.

This repo has already fixed this exact bug once — `handlePineappleDiscard` and
`tests/pineapple-discard-picks-the-right-card.test.ts`: _"Two different arrays,
one index. Clicking the six threw away the ace."_ The translation ref it
introduced was never wired to the second caller. It is now.

**b. The network call lived inside the state updater.** A `setState` reducer
must be pure; React may call it more than once per click and does under
StrictMode. Two unordered POSTs, and the engine _replaces_ its stored set on
each — so `[0]` landing after `[0,1]` shows one card out of two. The selection
is computed from a ref and sent exactly once.

**c. There was no clear verb, so the last pick was unrevokable.** Un-picking
your last card means sending `[]`, which the engine answered with "no valid
card indexes". The client had been taught to swallow the empty case locally —
so the badge came off while the engine kept the card and turned it face up at
hand end. The engine now distinguishes an EMPTY list (a deliberate "show
nothing", which clears) from a NON-EMPTY list with nothing valid in it (still
an error).

**d. The reset hung off an event clients demonstrably miss.**
`setShownCardIndexes([])` existed only inside `case 'HAND_STARTED'`. This file
has been burned by that shape twice already and written it down both times —
`heroHandRef` (2026-09-01: _"every client that never receives that event - a
mid-hand join, a reload, a dropped frame, the websocket sequence gap that fires
GAME_START - sat on 0 for the rest of the hand"_) and DealAnimation's re-key.
Both moved onto `tableState.handNumber`; this one was left behind. It is keyed
there now, the same signal SeatSlot's own squeeze latch already used — which is
why the cards went face down for the new hand while the pick did not clear.

And the badge itself: `.seat__card-pick--marked` draws a gold eye with no
reference to squeeze state, while both of its handlers early-return on
`squeezeDown`. A stale pick therefore sat visibly on the back of a face-down
card and did nothing when tapped. **If you cannot click it, it does not claim to
be clickable.**

## 4. Peel all the way open, or double tap for a look

**"YOU SHOULD ALSO BE ABLE TO 'PEEL THEM ALL THE WAY OPEN' WHEN THAT HAPPENS
THEY STAY UP AND LIVE ... OR DOUBLE TAP, THAT LIFTS THEM SLIGHTLY."**

The commit threshold was **0.45** — a glance committed the hand, so you could
not look without also turning your cards over, which is the opposite of what a
peek is for. Four gestures now divide cleanly:

| gesture           | result                                      |
| ----------------- | ------------------------------------------- |
| drag and hold     | look, for as long as you hold               |
| release under 0.9 | back down on the felt, still face down      |
| peel all the way  | open and live for the rest of the hand      |
| double tap        | a small lift that stays until you tap again |

A drag that starts while the lift is held continues _from_ it rather than
dropping the cards flat under the finger, and a release under the line settles
back to the held lift rather than to the felt.

## Also fixed on the way past

`--peel-bend` was computed and written on every frame and **read by nothing**:
the comment beside the flip box described a tip toward the player that the
transform did not contain, because `perspective` as a property applies to an
element's children, never to the element. It is `perspective(600px) ...
rotateX(...)` inside the transform now.

## Verification

- `npx tsc --noEmit` clean, client and server
- client: **1014 files, 14018 tests**, 0 failures
- server: **400 files, 5750 tests**, 0 failures
- every new test verified RED against `origin/main` first: the flash, the
  double-tap hold, the badge on a face-down card, the empty-list clear, and the
  empty POST
- the bottom-up direction driven in a real browser at 375px, mid-drag: back on
  the top half, face revealed on the bottom half
