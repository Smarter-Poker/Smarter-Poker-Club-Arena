# 2026-10-26: the screen between Lightning hands (Lightning transition, phase 1 of 5)

Client only. No engine (`server/`) change and no database change. Nothing here
runs at a Classic table: every new branch is gated on the room being a
Lightning pool session.

## What a player saw, and why

A read-only review of `main` (around 05:00 UTC) traced eight faults in what a
Lightning player looks at between folding and being dealt the next hand.

1. **"Next Hand...", "Lightning Is Ending" and the ended notice could never
   show between hands.** The footer chooses the empty `lightning-between-hands`
   bar first whenever the hero is not in the roster, and the notices lived in a
   later branch of the same chain that also needed a hand in progress. Even
   when reached, `.lightning-next-hand` centred itself inside the fixed bottom
   bar, not the felt. The ended notice's VIEW GAME was therefore unreachable
   for exactly the player who had just folded.
2. **On a phone the table resized on every fold and back on every deal.**
   `data-hero` (and the seat taper) asked "is the hero in the roster", and the
   roster is empty between hands, which turned on the phone spectator layout
   (about 26px taller) and turned off the taper read by DealerButton and
   useProtectedCardLayout.
3. **The folded hand's board stayed on the felt for the whole wait.** The
   engine's idle snapshot repeats the folded hand's number, so the client's
   never-shrink-the-board rule kept the old cards until the next deal.
4. **Every open chair showed an EMPTY coin for the whole wait**, in a room
   where nobody can sit.
5. **The hero's waiting chair dropped their table alias, frame and aura**; the
   stand-in used the bare username with no cosmetics.
6. **Lightning tab urgency outlines were amber and red**, outside the palette.
7. **"Next Hand..." waited 2.5 s** and appeared and vanished in one frame.
8. **"Lightning Is Ending" could stick.** Cluster status is a module-level map
   cleared only by an explicit null frame. Its words also promised "After This
   Hand" while measured endings take 21 to 80 seconds.

## What changed

1. The two felt lines are one felt-level layer (`.lightning-felt-notices`)
   inside `.table-surface`, in the band above the wordmark the connection
   banner uses, so they read the same in a hand and between hands. The two
   ended notices (MUST MOVE reversion and session ended) are mounted over the
   table area, after the chip layer, outside the footer chain; their content
   is padded clear of the fixed action bar. VIEW GAME is still the only way
   the room moves the player (CLAUDE.md 10.6); the two return navigations are
   unchanged.
2. `heroIsAtTable` (src/lightning/lightningWaitingHero.ts): the roster, or, in
   a Lightning room only, the chair the hero holds (`heroSeat > 0`). It now
   feeds the seat taper, `data-hero` and the keyboard's spectator flag.
3. `lightningSnapshotClearsBoard` (src/lightning/lightningHand.ts): in a
   Lightning room an idle snapshot lifts the never-shrink rule and sets the
   board to the end-of-hand reset's own shape (empty boards, stage preflop), so
   the board goes down the existing clear path and the next flop deals in with
   its full animation. The board has no exit animation anywhere in the app
   (the hand-complete reset clears it the same way), so none is skipped.
4. `SeatSlot` gained `hideEmptyChair`. TablePage passes it only in a Lightning
   room. An empty chair then draws nothing but keeps its `data-seat-num`; the
   hero's own reserved chair is never hidden. Classic keeps EMPTY.
5. `lightningStandInIdentity`: the waiting chair wears the table alias (when
   "use alias" is on), else the poker name, else the last roster row's name,
   and the frame and aura from the hero's last roster row.
6. Urgency is blue, then teal (`--info-cyan`) at 3px, then bright silver
   (`#e4e7ec`) at 4px with a teal inner glow. The queue chips follow.
7. `LIGHTNING_NEXT_HAND_NOTICE_MS` 2500 to 1200. The line fades in and, when
   the next deal starts, stays mounted marked `data-leaving` to fade out, for
   `LIGHTNING_NEXT_HAND_FADE_MS` (240) times Animation Speed. Both keyframes
   scale with `--animation-speed`; reduced motion is the global collapse. The
   text is still exactly "Next Hand...".
8. `clearLightningClusterStatus(clusterId)`: called when a Lightning room
   closes (MUST MOVE reversion or session ended, both confirmed after a 4404)
   and when a new pool-session room for that Cluster is registered before it
   connects (a room first learned from its own, already connected snapshot
   keeps the status its resync delivered: `keepClusterStatus`). The text is
   now "Lightning Is Ending. Your Seat Is Kept." The engine re-sending the
   status on resync is a later phase.

## Tests

- New: `tests/lightning/lightning-between-hands-screen.test.tsx`, one block per
  fault, rendering SeatSlot, LightningNextHand, LightningEndingNotice and
  LightningEndedNotice and calling the new pure rules.
- Updated, because the pinned behaviour was deliberately replaced:
  `tests/lightning/lightning-phase-13-app.test.tsx` (ending words; mount is now
  the felt layer), `tests/lightning/lightning-tablepage-pool-session.test.tsx`
  (Next Hand mount), `tests/unit/mobileTableBehaviours.test.tsx` (the
  `data-hero` expression it anchors on).
