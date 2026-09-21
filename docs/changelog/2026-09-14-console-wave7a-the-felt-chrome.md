# 2026-09-14: console wave 7a, the felt's chrome

Part of the #ClubArenaConsole sweep. The felt itself - seat ring, community
cards, the squeeze, the dealing pipeline, the transport - is untouched. So are
the three action buttons and the raise sizing overlay: `ActionPanel.tsx` is
byte-for-byte unchanged, because `tests/gameplay-wears-the-house-colours.test.ts`
pins those gradients as a written law (Dan art-directed them by screenshot on
2026-08-26) and `tests/unit/actionBarSliderAndFooter.test.tsx` pins the rail's
arithmetic.

What moved is the chrome around the game. Post Or Wait and the seat-first
buy-in sheet are consoles with two plates (the buy-in sheet uses rows on the
glass, not the four-bay deck: that deck belongs to the buy-in family's own
sheet). MultiTablePage's empty, crashed, session-ledger and quick-join panels
are consoles. The floating felt controls - the post-BB button, the footer
action bar, the insurance waiting bar, the spin heads-up note, take-seat, the
hub tile, the loading state, the stale-connection note - are inked to the
schema rather than framed: no master art holds a shape for them, and inventing
art is out of scope.

Defects fixed on the way: Quick Join names were hard-clipped because
`text-overflow: ellipsis` sat on a flex box where it does nothing, so the
longest name lost six characters and pushed its tag out of view; the quick-join
tag rules were declared three times over with three different colour sets; the
stale-connection note ran off both edges of a 393px phone; condensed caps
turned the bare `s` in "8s" into a letter on the two clocks a player races; a
dead `--notice` modifier was deleted; and eleven off-schema colours went (cyan,
teal, mauve, orange, amber, purple, emerald and three blues).

Two `metallic-popups.css` traps were live here and are switched off longhand by
longhand: it named three of these surfaces in its shell list and painted a
bevelled frame around the console, and its `:where(...) button` rule bevelled
every lit word.

Two label pins moved with their renders: the seat-held countdown is a row plus
a header pill now (the test gained two assertions rather than losing one), and
the seat-first e2e names the painted plates instead of the old button classes -
the rule it exists for, that CONFIRM is asserted and never clicked, is
unchanged.

Reported, not done: `.table-header` in TablePage is `display: none !important`
and has been for some time - about 65 lines of JSX and 160 of CSS render
nothing; and the side menu is unreachable, because `toggleSideMenu` is wired
only to its own close handler and no opener exists. Neither was repainted and
neither was deleted: an e2e locator still names a header class, and deleting
the menu would orphan dozens of handlers.
