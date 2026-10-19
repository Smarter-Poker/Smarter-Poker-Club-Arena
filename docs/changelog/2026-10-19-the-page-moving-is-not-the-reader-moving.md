# The page moving is not the reader moving

Post-deploy run 39245711984 failed the Chromium case "the filter row locks
under Find Your Game when the lobby scrolls": after the test's upward
`scrollBy(0, -64)` the Find Your Game filters stayed `data-filters-hidden="true"`
for the whole 5 second wait. The retained trace shows it was not the test.
Right after the upward scroll the filters and footer were shown, scrollY was
31527 and the root published `--ca-bottom-chrome-h: 61px`. About two seconds
later, with no input and scrollY still 31527, both the filters and the footer
had left (`data-filters-hidden="true"`, `data-footer-hidden="true"`,
`--ca-bottom-chrome-h: 0px`). A `table_seats` refresh for the lobby cards had
just landed. Run 39232506260 caught the same signature on WebKit: the footer
hid at an unchanged scrollY of 31147.

The cause is in `useHideFooterOnScroll`, which also gives the lobby filters
their direction. When content above the viewport changes height (a live card
re-rendering shorter, then back), the browser's scroll anchoring moves scrollY
by exactly that change to keep the reader's place, and fires a scroll event.
The hook counted those programmatic moves as the reader travelling. A shrink
and restore is an up-then-down pair, and its down leg cleared the 24px
threshold, so the chrome left while the player sat still. That is the
"leaving when nobody travelled" Dan reported on 2026-09-05. Reproduced in
Chromium: with no input, a 300px card above the viewport shrinking and being
restored hid the bar.

The hook now treats a scroll whose distance equals the scroller's own change
in content height as the page keeping its place. It rebases its travel anchor
on that scroll and decides nothing, except that the bottom still brings the
bar back. Reader travel is unchanged: the same 24px down hides, the same 24px
up reveals, and the top and the bottom always show the bar.
`tests/unit/footerIgnoresScrollAnchoring.test.tsx` pins the cause; without the
change two of its cases fail.
