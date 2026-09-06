# Previous Hand and Video Replayer - Build Plan

Dan, 2026-09-05: "TAKE EVERYTHING YOU JUST SUGGESTED, AND CREATE COMPREHENSIVE
BUILD PLAN AND BREAK IT DOWN INTO PHASES. DO ONE PHASE AT A TIME, AND INSURE
THAT EACH ONE IS FULLY BUILT OUT, CODED AND WIRED IN, AND THAT EVERYTHING WAS
PUBLISHED BEFORE CLAIMING SUCCESS."

Baseline: PR #3089 (`fix/rit-and-previous-hand-second-sweep`) - one
reconstruction (`HandRecord.replay`) rendered by the panel, the modal, the
archive and the replayer; your own folded cards; hi-lo halves; casino-realism
styling; Leave Table in real time; share link v3. Every phase below builds on
that model. Nothing re-walks the action log.

A phase is DONE when: built, wired, tests green, pushed, merged by autopilot,
`build-info.json` shows the squash SHA, and the change is seen on the live page.
The changelog for each phase lives in `docs/changelog/2026-09-05-previous-hand-phase-N.md`.

## Phase 1 of 7 - Live, instant and honest at the table

LIVE 2026-09-05 (squash `42a2dc9fd`); `docs/changelog/2026-09-05-previous-hand-phase-1.md`.

- Live refresh: the panel and the modal prepend a hand the moment the engine
  emits `hand_history_saved`, without close-and-reopen.
- Instant reopen: the built models stay in memory per table; a reopen is free
  and the stats strip does not blink. Refetch only on first open, on a failed
  fetch, or when the list is stale (missed events).
- Observer copy: a spectator is told they are watching, not that the table has
  no hands.
- Copy hand number and copy link on the modal header.
- Deep link: `/hand-history?hand=<id>` opens the archive on that hand, fetched
  by id if it is not on the first page.

## Phase 2 of 7 - Equity and EV on the rundown

LIVE 2026-09-05 (squash `de22f5f88`, review `736831960`);
`docs/changelog/2026-09-05-previous-hand-phase-2.md`.

- `ca_hand_facts` already stores `all_in_equity`, `all_in_street`,
  `all_in_at_risk`, `ev_returned`, `ev_net` per hand. Read them beside the
  private cards (same RLS read) and show an "All-In" block: your equity when
  the money went in, what you got back, what you were owed.
- Hero hand strength per street on the rundown ("Top Pair" on the flop, "Two
  Pair" on the turn) from the shared evaluator.
- Showdown equity per street where every hand is known (enumeration on the
  client; hold'em exact, Omaha sampled with the count shown).

## Phase 3 of 7 - The replayer moves

BUILT 2026-09-05 (`feat/previous-hand-phase-3`); see
`docs/changelog/2026-09-05-previous-hand-phase-3.md`.

- Motion between frames: bets slide to the pot, the board deals, a show flips,
  the winner's stack grows - scaled by Animation Speed, collapsing to meaning
  under reduced motion (animation law).
- Sound cues from the table's own service (deal, chip, check, fold, win).
- Dealer button, per-street hero hand label, pot odds on the acting seat.
- Replayer speed control (half, normal, double) and street jumps, independent
  of the table setting.

## Phase 4 of 7 - One replayer everywhere

BUILT 2026-09-05 (`feat/previous-hand-phase-4`); see
`docs/changelog/2026-09-05-previous-hand-phase-4.md`.

- `SharedHandReplayPage` (what a share link opens) renders the felt replayer:
  `ShareableHand` -> `replayFromShareable` -> `buildReplay`, with no database
  read, so a recipient who never played the hand can watch it.
- `HandReplayerPage` (`/share/hand/:handId`) renders the same replayer.
  `HandReplay3D`, `components/hand-replayer/**` and `types/engine/handReplay`
  are RETIRED - nothing else rendered them, and gsap left the app with them.
- Share link v4: run-it-twice and bomb-pot boards, per-board and per-half
  awards, rake and jackpot fee, the hand number, the discard street, dead
  money, and a bomb-pot mark so no reconstruction invents blinds. Amounts are
  the model's own increments; v1-v3 still decode as raise-TO levels
  (`wireVersion` says which), so no link rots.
- Found on the way, in code this phase did not write: the live table shared
  four of the seven variants as hold'em and every blind as an all-in;
  `reportError` threw on any DOMException, from inside the catch that called
  it; and a showdown row's `net` is not a pot share unless the record carried
  per-board awards (now published as `ReplayModel.perBoardAwards`).

## Phase 5 of 7 - Find it, keep it, take it with you

- Search and filters in the panel and the archive: hand number, opponent,
  won / lost / showdown / all-in / big pots, variant, date range.
- Notes and tags per hand (own rows, RLS), shown on the card and searchable.
- Tracker-grade export: a true PokerStars-format writer off the model, so PT4
  and Hand2Note import it; CSV keeps the current columns plus equity.

## Phase 6 of 7 - Disputes and the operator's lookup

- Flag a hand: one button files the hand id and a note with the club's
  operators; the player sees its status.
- Operator hand lookup in the club operations console: any hand at the club's
  tables by number, all hole cards, under an audited godmode read with the
  reader, the hand and the reason logged.

## Phase 7 of 7 - Accessibility, devices, performance

- Every card announces itself ("Ace Of Spades"); the rundown, the panel, the
  modal and the replayer pass a keyboard-only walk.
- Real-device pass at 375px: panel, modal Summary rows, 9-max replayer felt.
- Measure and trim: model build time per page, list render, replayer frame
  build; virtualise the archive list past 100 hands.

## Recorded, outside this plan

- New unions get no house club row (World Hub `manage-union.js`). Product
  decision, Dan's.
- `the-media-optimizer` law fails locally for the `sharp` env reason;
  `a-union-lead-needs-no-club` flakes under full-suite load. Neither is in
  this work.
