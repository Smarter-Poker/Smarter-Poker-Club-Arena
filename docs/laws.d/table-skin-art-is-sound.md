# tests/table-skin-art-is-sound.law.test.ts

`TablePage.css` positions everything that lands on the felt from one set of
constants — `.table-surface { left: 13.3%; top: 8.9%; width: 73.2%; height:
80.3% }` over `.table-art { object-fit: fill }` — so all fourteen skins have to
paint the table in the same place on their 605x1000 canvas, and none of them had
ever been measured. Five did not: arctic_white sat 19px right of centre and 42px
narrow, ocean_blue and neon_city 9px right, ice_cavern 7px low and 79px short,
crimson 5px right, so the seat ring, pot and board moved when a player changed
skin. Dan's screenshot of MADNESS NLH 2/5 showed the other half of it —
`skin_classic_green.png` has 36 rows, y=371 to y=406, with no racetrack line
painted at all, against a left side that is perfect. Centre is asserted at 4px
with no exemptions because every skin can satisfy it and it is what puts seats on
the rail; size at 8px with `final_table` (decorative wings outside the rail) and
`ice_cavern` (6% small, and rescaling it drives
`table-skin-must-not-paint-seats.law` from 21.0 to 47.5 against a limit of 35)
exempt by name; the line at 55% of its own median over a run of 6+ rows, which is
a hole rather than a highlight, so carbon_ion's deliberately segmented tube and
ice_cavern's mottled ice glow — both sides of both, checked by eye — stay in
`LINE_EXEMPT` instead of being repainted by a detector.
