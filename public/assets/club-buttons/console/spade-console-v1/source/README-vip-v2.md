# Crown Crest V2

`crest-vip-v2.png` supersedes `crest-vip.png`. The original source and
`top-vip.png` remain untouched because their bytes are sealed for open clients.
The new crown was painted with the built-in image generator using `top.png`
and `crest-diamond.png` as references, then seated with:

    python3 scripts/art/seat-console-crest.py public/assets/club-buttons/console/spade-console-v1/source/crest-vip-v2.png vip-v2 142 12 204

Three candidates were compared in the real result card at 393px. The chosen
keystone has a thin polished rim, a dimensional crown with bright upper chrome
bevels and a dark quilted body, and a blue LED at the base of the well. The
seating step re-mitres the master rails into this housing. The console and
the tournament share painter both load `top-vip-v2.png`.

Source generated with the built-in imagegen tool, 1440 x 1088 RGBA.
Prompt: compact keystone, thin polished rim, solid sculpted three-point chrome
crown with dark quilted faces, bright upper bevels, blue LED at the base;
front elevation, black/silver/blue only, isolated transparent background.
