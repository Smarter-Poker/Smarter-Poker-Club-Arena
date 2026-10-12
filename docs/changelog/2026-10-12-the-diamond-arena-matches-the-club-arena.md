# 2026-10-12 - The Diamond Arena matches the Club Arena (phase 1: look and table fixes)

Dan, 2026-10-12, with screenshots of the Diamond Arena lobby and a 9-max
Diamond Arena table on a phone:

1. "ALL OF THE WHITE OF THE DIAMOND ARENA BACKGROUND SHOULD BE BLACK AND LOOK
   JUST LIKE THE CLUB ARENA."
2. "THE FOOTER NEEDS THE IMAGES LIKE THE CLUB ARENA, NOT JUST WORDS."
3. "THE BUTTON IS NOT CORRECT OR IN THE RIGHT LOCATION ON THE TABLE" and
   "BUTTON JUST RANDOMLY IN THE MIDDLE OF THE TABLE".
4. "THERE IS NO 'I'M BACK' BUTTON TO CLICK FOR THE DIAMOND ARENA WHEN YOU ARE
   SITTING OUT."
5. "'DIAMOND ARENA' AND HAND NUMBER SHOULD BE LARGER AS WELL."

Must-move games and BBJ / Mini BBJ for the Diamond Arena are later phases of
the same request and are not in this change.

## 1. The light room is retired

2026-09-11's "DIAMOND ARENA SHOULD BE WHITE, OR LIGHT SCHEMA" was implemented
as a third `<html>` attribute, `data-arena-scheme="light"`, written by
`src/lib/arenaScheme.ts` from `App.tsx` and selected by a token block in
`club-engine.css` and a surface block in `ClubHomePage.css`. The latest owner
instruction reverses it, so all of it is removed: the module, the effect, both
CSS blocks and the law that pinned the light room
(`tests/diamond-arena-is-the-light-room.law.test.ts`). The body's black ground
is now the only ground. `tests/the-diamond-arena-is-black-like-the-club-arena.law.test.ts`
refuses the attribute, its writer or a keyed block coming back from a stale
branch. The Diamond route and stale-client specs now assert the attribute is
absent.

## 2. The Diamond footer has painted doors

`public/images/club-footer/diamond-arena-footer-v2.webp` is the v1 derived
well with six doors painted into it, icon over word, in six equal cells (311
of the frame's 1866 master pixels each), in the chip master's own white Roboto
caps (Roboto 400 at 28px reproduces the master's PLAYERS label exactly: 117 x
20px). Sources:

- Players, Stats: the chip footer master's own icons, cut with their alpha.
- Lobby: the master's Cashier chip with its word lifted off the face (rim
  rebuilt by a 45-degree rotation of the chip onto the band the word crossed,
  face re-synthesised from its own radial profile, the spade re-seated in the
  centre).
- Hand History: two fanned cards (K and A of spades) in the brushed silver
  and gunmetal of the footer's icons, built from the app's own card faces.
- Messages: the header's silver chat bubble with blue lights, keyed off black.
- Wallet: the approved silver wallet (header v4).

`DiamondBottomNav` no longer prints its labels; like `ClubBottomNav` it lays
six full-cell targets over the art with visually hidden names. v1 stays in
`public/` for clients still holding the previous bundle.

## 3. The dealer button stays beside its own seat

Reproduced exactly: on a phone, the 9-max ring's middle side seats (x 8 and
x 92, y 58) put the puck at x 44 / x 56, y 51 - the middle of the felt.
`dealerButtonPositionClearOfSeat` first retreats the puck toward the centre to
clear the seat's plate, and that retreat could walk 30% of the table. On a
phone those seats sit level with the felt printing, so every step stood in the
masthead keep-out until the puck had climbed past it. The upper side seats on
both rings did the same thing more mildly (x 30 / x 70). The retreat is now
capped at 8% (`RETREAT_MAX_WIDTH_PCT`); when that cannot clear the plate the
existing bounded swing moves the puck along its own rail. Every ring from 2-
to 9-max at 375, 430 and desktop widths now lands within a short nudge of its
rail position and nearer its own player than any other, pinned by
`tests/the-dealer-button-stays-beside-its-seat.law.test.ts` (which fails on
the old 30% walk). This geometry serves both arenas.

## 4. I'm Back is never shadowed

A hero who is sitting out is not in the current hand's player list. The footer
chain checks "hero not in the player list" for its Seat Reserved bar BEFORE it
checks the sitting-out bar, so the player read "Seat Reserved, You'll Be Dealt
In Next Hand" while their seat read SITTING OUT, with no way back. The
reserved branch now stands aside when the hero's seat row says they are
sitting out (`heroIsSittingOut`), and the sitting-out bar with I'm Back
renders. The placeholder seat drawn for a hero outside the hand list printed
0.00 over a seat holding 3,632; the seat poll now reads `stack` and the
placeholder prints it. `tests/im-back-is-never-shadowed.law.test.ts`.

## 5. The club line and hand number are larger

On every table (both arenas share the masthead): the club line 0.48rem to
0.66rem (0.6rem at 380px and below), the hand number 0.44rem to 0.58rem (0.54rem)
and brighter. `FELT_TEXT_BAND.lineHeightPx` grew from 11 to 14 so the dealer
button keeps clear of the taller printing; the chip-rail and seat-plate
geometry tests still pass.
