# The arena nav is a painted plate, not a CSS button

Dan, 2026-09-10, on the gunmetal .btn-secondary that removed the white glass:
"now its a boring basic button, instead of a dynamic one smh."

He is right, and #ClubArenaConsole says why: you do not style a button, you
rebuild it on the approved master art. A CSS gradient is a flat box however it
is shaded. The Poker Arena / Choose Arena nav on every club lobby now sits on
the club-nav-shell frame that already ships in this repo - bevelled gunmetal
rails, blue LED corners, a black well - with only the label as live DOM.

## What changed

- `PokerArenaNavigation.tsx`: drops `btn btn-secondary` (so nothing paints a
  fill behind the art) and wraps the label in a span for the chrome type.
- `PokerArenaNavigation.module.css`: the button is the club-nav-shell webp at
  its own 1829 x 313 ratio; the label is Roboto Condensed caps (the chrome face
  used across Club Arena), engraved silver by a solid colour plus a bevel
  shadow - never background-clip: text, which reads as a cheap sticker - sized
  in cqw and capped at 78% of the plate so it stays clear of the mitred rim at
  every width. The centre dot is lit blue to match the LEDs in the art.

The gunmetal .btn-secondary from earlier today stays as the no-white baseline
for small secondary buttons (Cancel, Filters); this is the dynamic treatment
for the prominent nav Dan pointed at.

## Verification

Rendered at 393px on the real frame: label fits the well with margin
(232px in a 264px box), centred, clear of the rim; responsive down to 320px
because the label scales with the plate. tsc clean, copy gates OK,
classNamesResolve and no-hover green.
