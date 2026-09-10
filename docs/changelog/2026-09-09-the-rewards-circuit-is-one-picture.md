# The Rewards Circuit Is One Picture

Dan, 2026-09-09, on the promotions page and the shared rewards header:
"upgrade these using #ClubArenaConsole, these pages are still generic ...
NONE OF THOSE FOLLOW the Painted-Chassis Standard."

They did not. The header drew its own chassis - a gradient panel, a lit
spine, a conduit, scanlines - and a rebuild earlier that day had only
swapped one drawn frame for a nine-sliced one, which the standard forbids
just as plainly ("never stretch, never 9-slice across a feature"). The
promotions page underneath it was rounded cards, a green banner and a
pill row, each drawn in CSS.

## What changed

The header is now the spade console. Its eyebrow, title and status word
print into zones measured on Dan's approved master; the description, the
metrics and whatever the page passes as children print on the black glass
between the rails; a page with two actions gets them on the painted
plates in the foot. It draws nothing: no frame, no fill, no pill. Because
nineteen pages render this sheet - wallet, VIP, rakeback, promotions,
bonuses, achievements, marketplace, transactions, session history, the
union pages and the tournament pages - all nineteen inherit the master.

The promotions page prints on that same console. The view words are lit
words on the glass, each offer is a row (its type's 3D render beside the
words, the dates, prize and time left on one line, CLAIM a lit word at
the end), and the two doors - Invite Friends, Daily Bonus - are the
painted plates. The green referral banner is gone; so is every card,
chip and drawn pill.

## Details worth keeping

- `compactChips` lands in `src/utils/format.ts`: whole numbers under
  1,000, one decimal above, always rounded DOWN so a prize is never
  overstated, `.0` stripped. The felt is untouched - `formatTableChips`
  is law there, and chips on the felt are never abbreviated.
- `LeaderboardCard` gains a `glass` variant that paints no box of its
  own, so a leaderboard promotion's standings print on the console rather
  than inside a second card on top of the first.
- The marketplace's two ghost buttons became its console's plates.
- `RewardsCircuitSurfaces.css` stops repainting `.promotions-page
.promo-card`: there are no cards left, and its `border` shorthand would
  have reset the master's frame.
- A long status word ("SYNCHRONIZED") filled the painted pill to the rim
  and its glow spilled onto the chrome. Long states are said shorter
  ("Synced") rather than shrunk to nothing.

Nothing about the data moved: the club-scoped realtime filter, the
retryFetch load, the claim guard, the player_number referral link and
every reported error are the code that was already there.

## The dress varies; the structure does not

Dan, on the first cut of this: "ALL FRAMES SHOULD NOT BE EXACTLY 100% THE
SAME WITH THE SPADE AT THE TOP ... SOME SHOULD BE FLAT AT THE TOP AND JUST
A DYNAMIC FRAME, SOME SHOULD HAVE OTHER ICONS THAT ARE RELEVANT TO THE CARD
OR POP UP."

The console head now comes in five dresses, every one derived from the
approved master by surgery rather than assembled:

- `spade` the master as approved.
- `flat` the crest lifted out and the rails bridged with their own median
  cross-section. The well behind it is filled from the same rows of the
  glass beside it and then ramped to meet the tone at BOTH seams, because a
  fill that is lighter (or darker) than the glass beside it is the defect
  Dan named first.
- `diamond`, `chip`, `vip` an emblem seated in THE MASTER'S OWN CRADLE.
  A first attempt lifted a housing from another chassis and set it on the
  bridged rail; Dan: "IT LOOKS LIKE SHIT ... COMPARE THAT TO WHERE THE SPADE
  IS BUILT INTO THE FRAME." He was right, and the reason is structural: the
  spade's cradle is part of the frame's silhouette, with the rails running
  into its shoulders, while a housing dropped on an unbroken rail can only
  ever read as a badge glued on. So the spade is masked out of its own
  cradle and the cradle's face rebuilt from its own face pixels; the rim,
  the shoulders and the lit base are the master's, untouched. The shark is
  never used anywhere: it belongs to one club.

Two defects found and fixed along the way, both mine. Clamping each variant's
alpha to the master's silhouette carved the cradle's transparent shoulders
back into the flat top's bridged rails as a dark notch - a flat top's
silhouette is by definition NOT the master's there. And the well's donor
block was lifted from the well's left edge, carrying its corner chamfer into
the middle of the glass; it comes from plain glass now.

Structure never varies: same slice, same ratio, same zones, same rails.
Only the picture changes. Pages pick their own: the wallet and the daily
bonus wear the diamond they pay in, the ledger and the marketplace wear the
chip, VIP wears its crest, achievements keep the spade, and rakeback and
promotions are flat.
