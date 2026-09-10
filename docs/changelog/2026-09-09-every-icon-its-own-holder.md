# Every Icon, Its Own Holder

Dan, 2026-09-09, on the console heads: "LOOK HOW THE SPADE HAS A CUSTOM
FRAME AROUND IT, YOU ARE USING THE SAME 'SPADE FRAME HOLDER' FOR THE OTHER
DYNAMIC ICONS. EVERY ICON NEEDS ITS OWN CUSTOM 'HOLDER' LIKE THE SPADE HAS.
ANYTIME YOU USE A CUSTOM ICON, OR ADD A CUSTOM ICON, YOU MUST BUILD A NEW
FRAME HOLDER AND COMPLETELY REDESIGN THE TOP FRAME (NEVER JUST COPY AND
PASTE)." Then, on a procedural attempt: "you need to use your image
generator to create dynamic images ... the spade is your anchor, if it
doesn't have the same quality, then you fail." And on the candidates: thin
clean borders are allowed; thick borders are not.

## What changed

The spade's shield is the spade's alone. Each other crest is a painted
object of its own, made with the image model from the master crest as the
style reference and the approved hexagon as the border-weight reference,
then seated in the master head:

    diamond  a hexagonal bezel, thin chrome border, chrome diamond, LED base
    vip      a wide keystone, thin chrome border, chrome crown, LED base
    club     a round medallion, thin chrome ring, chrome club, LED base
    flat     no crest: the rails bridged straight across
    spade    the master, untouched

Seating is `scripts/art/seat-console-crest.py`: the crest is scaled to the
master's crest height, centred, and the rails are re-mitred into it row by
row - the master's own chrome mitre carried to wherever this crest's edge is,
a hairline off it - then it throws a soft shadow on the glass. Outside the
crest window every head is pixel-identical to `top.png`. The painted
sources, the prompt and the seat parameters are in
`public/assets/club-buttons/console/spade-console-v1/source/README.md`, so
every head is re-derivable and the next icon follows the same recipe.

## Where they go

    diamond  wallet, daily bonus, transaction history
    club     marketplace, the union pages
    vip      the VIP deck, tournament lobby and results
    flat     rakeback, promotions
    spade    achievements, bonuses, hand and session history (the default)

`ConsoleCrest` is `'spade' | 'flat' | 'diamond' | 'vip' | 'club'`; the old
`chip` head and its asset are gone.

## Verified

tsc clean, eslint 0 errors, check-title-case and check-painted-text OK, the
full unit suite green. Every URL in SpadeConsole.css resolves to a file in
the kit. Each head has nothing painted on row 0 and nothing outside the
frame's sides, and is pixel-identical to the master outside the crest
window. The seating script reproduces each shipped head bit for bit from
its source.
