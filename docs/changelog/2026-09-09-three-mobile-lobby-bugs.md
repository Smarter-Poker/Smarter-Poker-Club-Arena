# Three mobile lobby bugs Dan photographed on 2026-09-09

His three reports, each with the cause read out of the code rather than guessed.

## 1. "MY WALLETS" printed "LOADING BALANC"

Dan: it "shouldn't say LOADING BALANC. It should just have 5 BALANCES or how
ever many wallets that user has only, and it centered inside that frame."

TWO faults stacked, and only the first is the one he could see.

**Clipped.** The count zone on the my-wallets-v1 master was x 900-1476 of a
2172-wide plate: `left: 41.4%; width: 26.5%`. That is 96.7px on a 393px phone.
"Loading Balances" measures 109.7px in Inter 700 at that size with 0.16em
tracking, so `overflow: hidden` took the last 13px off the right end. Measured
in a headless render at 393px, not estimated.

**Not centred, but only because it overflowed** (this paragraph was corrected
the same day; see `2026-09-09-the-wallets-line-was-clipped-not-misaligned.md`).
The first write-up here claimed `place-items: center` cannot centre a bare
text node and that even a short count would have sat left of the title. It
can, and it would not have: measured with the old zone and no `text-align`,
"5 Balances" sits at 54.65% of the plate, dead on the painted title. The
left-alignment Dan photographed is what an `overflow: hidden` grid cell does
with an item wider than itself: safe alignment snaps it to the start edge.
Clipped, and left-aligned because clipped.

Fixed by re-cutting the zone symmetric about the painted title's own optical
centre (54.65% of the plate, measured off the master art) with an explicit
`text-align: center`, and by never printing the word Loading at all:
DynamicWallet decides the row count from the viewer's ROLE, before any balance
loads, and it now publishes that count from a layout effect instead of an
ordinary one, so the real number is present on the first painted frame.

## 2. The filter row scrolled away

Dan: the filter row "should lock under the FIND YOUR GAME row when it scrolls
up, it should not be able to scroll past that."

The selector deck has been sticky under the global header since the mobile
find-your-game lock. The sort row never was, so travelling down the lobby slid
GAME / STAKES / VARIANT / PLAYERS / BUY-IN / STATUS up behind that deck and off
the page: the moment a player had enough games to need a sort, the sort control
was gone.

It sticks at the deck's bottom edge now. That offset cannot be a constant (the
deck's rows change with tab, club and role), so ClubLobbyCommandTop measures
its controls block and publishes `--ca-lobby-controls-h` on the document root,
exactly as GlobalHeader publishes `--ca-global-header-height`, and
LobbySortBar.css adds the two. z-index 29 keeps it under the deck's 30.

## 3. A strip of lobby showed under the footer

Dan: "THE FOOTER NEEDS TO BE LOCKED TO THE BOTTOM OF THE PAGE, THERE SHOULDN'T
BE A GAP BELOW IT WHERE YOU CAN SEE ANYTHING BELOW THE FOOTER."

`padding-bottom: env(safe-area-inset-bottom, 0px)` on `.bottomNav` reserved the
home-indicator strip INSIDE that box, below the artwork, and the box is
deliberately transparent (the 2026-09-04 clipping rule), so the lobby scrolled
through it. A desktop browser reports 0 for that inset and looked correct,
which is why it survived; Dan's iPad reports about 20px.

The padding is gone, so the frame reaches the edge. The box is a bottom-aligned
column as well, which closes the second, narrower version of the same gap:
below a 357px viewport the artwork's own aspect ratio is shorter than the 44px
touch floor, and that remainder used to sit below the frame too.

NOTHING IS PAINTED to achieve this. A black skirt under the frame was written
first and thrown away: `tests/footer-clearance.test.ts` asserts
`expect(css).not.toContain('background: #000')`, which is Dan's 2026-09-04 rule
that nothing opaque sits behind the frame. The strip is closed, not covered, so
that law is untouched.

## Verified

- `npx tsc --noEmit` exit 0.
- 13 test files covering these surfaces, 406 tests, all passing.
- `npm run build` exit 0.
- Headless Chromium render at 393px and at 732px (Dan's iPad width) against the
  real stylesheets and the real approved art, before and after. The before shot
  reproduces his screenshot exactly, including the clipped "LOADING BALANC".
