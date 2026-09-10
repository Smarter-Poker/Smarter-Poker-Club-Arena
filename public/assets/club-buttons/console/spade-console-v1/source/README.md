# The console crests, and how each one is made

Dan, 2026-09-09: "EVERY ICON NEEDS ITS OWN CUSTOM HOLDER LIKE THE SPADE HAS.
ANYTIME YOU USE A CUSTOM ICON YOU MUST BUILD A NEW FRAME HOLDER AND COMPLETELY
REDESIGN THE TOP FRAME (NEVER JUST COPY AND PASTE)." And: "use your image
generator to create dynamic images"; "the spade is your anchor, if it doesn't
have the same quality, then you fail"; thin clean borders only, no thick
borders.

So a crest is PAINTED, never drawn, and never cut from another crest.

## Sources in this folder

    crest-diamond.png   hexagonal bezel, chrome diamond        (gpt-image-1)
    crest-vip.png       wide keystone, chrome crown             (gpt-image-1)
    crest-club.png      round medallion, chrome club            (gpt-image-1)

Each is a standalone object on a transparent field, 1024 x 1024. The master
spade crest (top.png) was the style reference for the diamond; the approved
diamond bezel joined it as the border-weight reference for the crown and club.

## Painting a new crest

`POST https://api.openai.com/v1/images/edits`, `model=gpt-image-1`,
`size=1024x1024`, `quality=high`, `background=transparent`, `n=3`, with
`image[]` = a crop of top.png's crest padded to 1024 square, and `image[]` =
crest-diamond.png. The prompt that produced the crown and club, with the
housing and icon swapped in:

> Two reference images from a poker app's console frame, painted in a
> high-definition photoreal casino style. The first is the original crest: a
> pointed chrome shield with a bevelled chrome spade emblem on a black quilted
> face and a blue LED glowing along its base. The second is an approved new
> crest: a hexagonal bezel with a THIN, clean polished-chrome border, a dark
> gunmetal face, a bevelled chrome diamond emblem and a blue LED at the base.
> Create another crest in exactly the same materials, lighting, finish,
> palette, scale and BORDER WEIGHT as the second image: {housing}, holding a
> chrome {icon} emblem rendered exactly like the spade and the diamond (a
> bevelled polished-chrome outline, a dark quilted body, blue light bouncing
> off its lower edge), with a blue LED glowing along the floor of the well.
> The border must be thin and clean like the hexagon's: no thick frame, no
> rivets, no brushed band, no knurling. One standalone object, centred, on a
> fully transparent background: no rails, no panel, no text.

Pick by eye at 393 px on black. Thick borders, rivets, knurling and brushed
bands are out; a border as thin as the hexagon's is in.

## Seating it

    python3 scripts/art/seat-console-crest.py <crest.png> <name> <height> <top> <max_w>

    crest-diamond.png  diamond  150  10  200
    crest-vip.png      vip      132  18  204
    crest-club.png     club     150  10  200

The script scales the crest to the master's crest height, centres it on the
head's axis, re-mitres the rails into it row by row (the master's own chrome
mitre, carried to wherever this crest's edge is), drops a soft shadow on the
glass, and writes `top-<name>.png`. Outside the crest window the result is
pixel-identical to top.png. Then add `.sc--crest-<name>` to SpadeConsole.css
and the name to `ConsoleCrest` in SpadeConsole.tsx.
