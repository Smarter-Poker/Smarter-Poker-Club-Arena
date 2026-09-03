# 2026-09-03 - Mobile lobby cards: every family on its approved master

Dan reviewed eight side-by-side sheets (current vs proposed) and approved all
of them, with one correction (the table-name line sits lower, off the title).

## NLH family (spade card, `spade-nlh-premium-v1`)

- The status pill now reads **Running** (approved bitmap), **Empty**, **Full**,
  **Waitlist N** or **Paused** - lit DOM text in the pill's own colour instead
  of a dark empty pill for anything not running. `premiumStatus.ts` is the one
  place that decides the word and the colour.
- "Weird lines" through the numbers: the silver fill was a four-stop gradient
  with a hard drop to `#aaa` at 69% plus a text-stroke on a transparent fill
  (WebKit paints the stroke inside the glyph). One smooth ramp, no stroke.
- Long names shrink to fit (`useFitText`, writes `--fit`): "NLH Straddle" no
  longer clips.
- "Pineapple 1" prints as "Pineapple"; a subtitle that only repeats the title
  ("Short Deck" under "Short Deck", "Crazy Pineapple" under "Pineapple") is
  dropped. `cashCardTitle()` in the adapter.
- Subtitle moved from y 174 to y 186 on the 945px master.

## PLO / PLO5 / PLO6 / PLO8 (`shark-plo-four-bay-v1`, new default)

The shark-crest four-bay console (clean shell already in the pack, green dot
lifted into its own layer). Title is variant + stakes ("PLO5 25/50"), table
name under it. Labels, values, status and BOTH button labels are live DOM.

## Spins (`shark-spins-premium-v1`, new default) and Heads-Up (`shark-headsup-premium-v1`, new default)

The approved masters (Dan's attached images) with every dynamic word lifted
out of the bitmap (title, status plaque, values, payout chamber, button
label); permanent labels stay painted. Coordinates in the card files.

## Shared

`layeredCard.tsx` + `LayeredCard.css`: chassis, coordinate zones, fit-text,
status pill, live-label action buttons. The V2 CSS machines remain registered
for desktop and as fallbacks; `tests/arena-game-card-system.test.ts` pins the
new mobile defaults.

Not done (Dan withdrew it): per-club crest swap (shark vs poker chip).
