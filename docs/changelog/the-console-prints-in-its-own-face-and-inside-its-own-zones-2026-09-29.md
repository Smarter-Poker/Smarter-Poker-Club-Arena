# The console prints in its own face, and inside its own zones

Four defects in the painted console kit, all of them in what the kit prints
rather than in what it paints. Every measurement below is from a headless
render at 375px with the real fonts and the real global stylesheets.

Every console title inside a dialog printed in Rajdhani. `metallic-popups.css`
gives any heading or any class containing "title" that face inside a dialog,
at zero specificity, and the kit set no face of its own, so `.sc__title`
inherited it while the master around it is Roboto Condensed. One class of
specificity is enough to take the console's own face back.

The plates were padded by a percentage. A plate is absolutely positioned, so
`padding: 0 4%` resolved against the whole foot and took 30px off a 123px
plate. In container units the same padding is 1cqw, and the riveted plates,
whose label well also stopped 30% short of the rivets rather than 16%, now
carry "Play It Out" at 15px where it was 10.9px and "Request Cashout" at
11.6px where it was 8px.

A label the frame cannot fit on one line takes two. `useFitText` gained an
opt-in `wrapBelow`: when the one-line fit would land under the caller's ratio
the hook marks the element and measures the wrapped block instead, keeping it
only when it renders larger. The stylesheet decides what a wrapped label looks
like. The riveted plates and the deck opt in; the ledger law and the tests pin
those labels, so they cannot be shortened instead. "Retry Original Buy-In"
printed at 7.5px and 11px wider than its plate, and now sets at 10.7px on two
lines inside it.

The deck's bay label strip was 44px where the free glass between the gem and
the window is 56px, so a wrapped label lost its second line. "Total Charged"
printed as "TOTAL CHARGE" at 5.5px and 5px wider than its strip; it now sets
at 10px on two lines inside it.

The spade head's eyebrow band ran 540 wide, to x 640, through the chrome that
holds the crest: the eyebrow rows are quiet glass out to x 419 and jump to
188-254 of 255 from x 440 to x 559. A long eyebrow printed over it. The band
now stops at the pocket beside the crest, so a long eyebrow sets smaller
rather than over chrome, and every eyebrow that already fitted is unchanged.
The title band below the crest's point is clear to x 619 and does not move.

No surface, no copy, no logic above the render changes; the arena's own laws,
the class-resolution ratchet and the cross-page CSS ceiling all hold at their
current numbers.
