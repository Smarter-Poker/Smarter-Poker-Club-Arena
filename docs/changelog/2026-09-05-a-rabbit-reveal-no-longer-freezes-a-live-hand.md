# A rabbit reveal no longer freezes a live hand

2026-09-05. P1 of the card presentation programme (handoff
`docs/changelog/2026-09-05-*` and the 2026-09-05 continuation brief, section
16): "Rabbit reveal freezes the client snapshot for a blunt 3000ms."

## What was there

`handleRabbitReveal` set `rabbitHuntFreezeEnd = Date.now() + 3000`, and three
effects in TablePage then parked every engine snapshot and event for those
three seconds in `frozenEventQueueRef` and replayed them afterwards, 50ms
apart. The intent was sound: the reveal paints ghost cards into the undealt
slots of the finished board, and if the next hand started underneath, the
board it was painted on vanished with the hand boundary. Freezing the whole
pipeline kept the picture still.

The cost was everything else on the table. Seats, blinds, the deal, the
hero's own action prompt and its clock all stopped for the client - and the
engine's turn timer does not wait for a client. A player who clicked late
into the 1750ms inter-hand rest could be on the clock for up to three seconds
before their screen said so, and the replay afterwards fired a burst of
queued events nobody had designed for. The 2026-08-26 rabbit audit had
already patched two defects inside the freeze (a doubled queue, a latched
deadline); this removes the mechanism they lived in.

## What is there now

`src/components/table/retainedRabbitBoard.ts` - a pure module.

- The felt remembers the last non-empty board it showed and which hand it
  belonged to (`lastBoardOfHandRef`).
- A reveal keeps a copy of the board it was bought against - cards, stage,
  ghost cards, hand id (`boardForRabbitReveal`) - as `retainedRabbitBoard`,
  and lets it expire on its own after `RABBIT_REVEAL_MIN_VISIBLE_MS`
  (3000ms, the same guarantee the freeze bought).
- `retainedBoardShows(retained, live)` decides which board the felt paints:
  the retained copy whenever the live hand has nothing in the middle (the
  finished hand's board cleared, or the next hand still preflop) or the hand
  number has moved on; the LIVE board the instant a newer hand has cards of
  its own. On the finished hand with its board still up, the live path is
  used, so the switch never remounts a card.
- The `HAND_STARTED` event clears `rabbitRevealedCards` a render or two
  before the snapshot moves the hand number, which would blink the ghost
  cards off and on at the boundary; the live path borrows the retained
  copy's ghost cards for the same hand (`liveRabbitCards`).

`engineSnapshot` and `engineLastEvent` are now the raw socket values. The
hand-boundary clears of the live reveal (Dan 2026-08-26: "it can never ever
linger") are untouched, as is the 8-second backstop.

## Not changed

- The server. One stale comment in `ServerTableEngineDealing.ts` that
  described the freeze was corrected; no behaviour moved.
- `RABBIT_MIN_VISIBLE_MS` (the button's two-second floor) is a different
  guarantee about a different thing and is untouched.
- The hero's hole cards, seats, timers: they were never supposed to stop, and
  now they do not.

## Verification

- `tests/unit/rabbitRevealIsHandSafe.test.ts`: the board-selection rule across
  every boundary case, the painting rule for a preflop fold, and page pins
  that the freeze is gone and the retained copy is wired. Run against the
  pre-fix tree: the page pins fail (the freeze is still there), the helper
  pins fail (the module does not exist).
- tsc clean (app + engine), full client and engine suites green, build clean.
- Not done: a real-table reveal clicked late into the rest, watched on a
  phone. That is the moment this exists for.
