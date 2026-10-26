# 2026-10-26: smoother motion between Lightning hands (Lightning transition, phase 3 of 5)

Client only. No engine (`server/`) change and no database change. Every new
branch is gated on the room being a Lightning pool session; Classic tables take
none of them.

## What a player saw, and why

1. **The fold was cut off.** The engine answers a Lightning fold with the fold,
   the table, then the idle snapshot (stage 'waiting', no players) one
   macrotask later. Applied verbatim, it removed the hero's cards one frame into
   their 435 ms flight to the muck, and every opponent and the board left the
   felt in the same frame.
2. **The hero sat in the wrong chair for a frame.** The chair layout follows
   `heroSeat`, which the seat invariant adopted only after the new roster had
   painted, so an opponent briefly sat in the hero's spot with hero styling and
   the dealer button set off across the table.
3. **LIGHTNING FOLD felt slower than Fold.** Its cue and its muck waited for the
   engine's reply; the panel's Fold answers the press.
4. **Cards showed before the deal, then blinked.** The hero's hole cards arrive
   before the 700 ms button beat ends. They painted face up with their slide
   cue, then the deal restarted them from invisible, and the cues ran slide,
   shuffle, chime, deal.
5. **The dealer button vanished between hands.** The idle snapshot carries
   dealer seat 0, so the button disappeared and the next hand's button beat had
   nothing to move.
6. **New faces popped in.** A new opponent's portrait was still downloading when
   its fade began (villain avatars load lazily), so an empty circle faded in and
   the face appeared after it; a player met before who was dealt in at a
   different chair got no fade at all. And hole cards that reached the room a
   moment before the hero's roster row were dropped, with the recovery poll off
   in Lightning.

## What changed

All rules are pure functions in `src/lightning/lightningTransitionMotion.ts`.

1. `lightningExitHoldMs`: in a Lightning room the idle snapshot waits one fold
   window (500 ms x Animation Speed, the same window SeatSlot gives the muck)
   when the felt holds a hand. During the wait `.table-page` carries
   `data-lightning-exit`, and LightningFoldBar.css fades the opponents and the
   board out over the same window (`--animation-speed` scaled; reduced motion
   is the global collapse). The hero's seat is left alone so its cards land. A
   snapshot that carries a hand ends the wait at once, so a fast next deal is
   never held. The apply effect re-runs on `lightningExitTick` when the wait
   ends, with the latest snapshot.
2. `lightningHeroSeatFromRoster`: the snapshot apply writes `heroSeat` (and
   `isHero`) in the same update as the roster. Never for an observer, a player
   leaving the seat, or a guest.
3. LIGHTNING FOLD plays the fold cue and starts the cards' muck flight
   (`applyOptimisticHeroAction('fold')`, the panel's own path) on the press. A
   refusal or a thrown request puts the hand back and says so. A press with no
   live hand changes nothing. The queued off-turn preflop fold is unchanged.
4. `lightningDealPending` hides the seats' cards (`seat__cards--deal-pending`)
   from the moment a Lightning hand's deal is scheduled until its button beat
   ends and the deal begins, with a ceiling of the beat plus 400 ms. The hero's
   card-slide cue is held (`lightningHoldsHeroDealSound`) and played when the
   deal lands (DealAnimation `onComplete`), or when the deal hold expires if the
   deal was interrupted. It is never dropped (CLAUDE.md 10.6).
5. `lightningParkedDealerSeat`: an idle snapshot keeps the button where it was,
   so the next hand's beat glides it to its new seat.
6. An arriving Lightning opponent's portrait loads eagerly and its fade waits,
   held at its first frame, until the image decodes, for at most
   300 ms x Animation Speed; then it plays in full. `nextSeatArrivals` also
   treats a known player dealt in at a different chair as an arrival. Hole cards
   that beat the hero's roster row are kept (`lightningEarlyHeroCards*`) and
   replayed through the same hole-card handler, with every guard on it, when
   the row arrives; a kept row for another hand is dropped.

## Tests

- New: `tests/lightning/lightning-smoother-motion.test.tsx`, one block per
  fault: the pure rules, SeatSlot's deal-pending rows, the portrait fade held
  for decode and released by the cap, the moved-chair arrival, and the source
  wiring in TablePage.
- Updated, because the pinned behaviour was deliberately replaced:
  `tests/lightning/lightning-phase-12-app.test.tsx` (the LIGHTNING FOLD cue is
  now played on the press, before the request) and
  `tests/lightning/lightning-tablepage-pool-session.test.tsx` (the fold
  handler's dependency list gained `applyOptimisticHeroAction`).
