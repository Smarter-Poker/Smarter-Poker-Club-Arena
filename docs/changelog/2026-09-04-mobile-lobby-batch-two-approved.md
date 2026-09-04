# 2026-09-04 - Mobile lobby, batch two (all approved by Dan 2026-09-03/04)

Every item below was shown to Dan as a rendered sheet and approved, with the
corrections he asked for folded in before shipping.

## Game cards

- Titles and values are SOLID silver with a bevel (text-shadow), never a
  clipped gradient: on his phone the clipped fill did not paint and the
  glyphs showed black ("any black font ... needs to be silver metallic").
  Applies to the NLH spade card, the layered PLO / Spins / Heads-Up cards and
  the My Wallets title.
- The card wrapper is transparent: the chassis PNGs are transparent outside
  their chrome, so the old `#000` wrapper drew a black box behind every
  chamfered corner ("remove the background of all game cards").
- Buy-in range prints as two centred lines, minimum over maximum, no dash
  (`splitBuyInRange`, `LayeredBuyIn`, NLH `NlhBuyIn`).
- The DOM status states (Empty / Full / Waitlist N) share the exact centre
  measured off the RUNNING artwork (555, 154.5 on the 729 x 945 master), and
  the same type size ("make sure all the pills are lined up right").
- No green live dot beside the title on any card ("remove the green dots").
- NLH subtitle sits lower (y 186), off the title.

## Club identity card

Logo centre 45% -> 49.5% (clear of the name band), alias 26% -> 31.5%, the two
ID lines 43.5%/20% (rows at 48.5% and 58.5%), Playing Now centred on the copy
icon (66.41%). The club/profile icons are lifted out of the shell into their
own layers (`club-identity-icon-*-v1.png`; shell v6 has quilt where they were)
so they move with the lines they label.

## Lobby header and wallets (unified mobile lobby)

`ClubHomeMobilePremium.css`: FIND YOUR GAME + LIVE CLUB SCHEDULE + N GAMES on
one line, as on desktop; the My Wallets trigger on the approved wallet-row
shell with a steel billfold mark, silver title and lit blue balance count.

## Variant selector, grouping, stakes, empty tables

- The Variant heading (phone bar and desktop table) opens a menu: All, then
  the tab's games in canonical order (No Limit, Pineapple, Short Deck; PLO,
  PLO5, PLO6, PLO8o), plus Sort By Variant. It reads and writes the saved
  Advanced Filters `games` value, so the two never disagree.
- On the cash tabs every ordering runs INSIDE variant groups in that fixed
  order - "game variations are never to be mixed together" - with the chosen
  column (default: Stakes, low to high) ordering each group.
- Empty cash tables sink to the bottom of their own group; unjoinable games
  still sink below that; featured still pins to the top.

## Game detail panel (Game Information / Seat Map / Rules)

Rebuilt from the four-bay console's own artwork (`lobby/shark-panel-v1/`):
crest cap (poker chip, not the shark), a seamless rail strip that repeats to
any height, the bottom rail; every fact and seat in the card's plaque; Back To
All Games on the JOIN TABLE face. The outer chassis bitmap is gone on phones
(it doubled the rails and stretched its chip into an oval); the scroller
leaves 124px so the footer never covers the last section.
