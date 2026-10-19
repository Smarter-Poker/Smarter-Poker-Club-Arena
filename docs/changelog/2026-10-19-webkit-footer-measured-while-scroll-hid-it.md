# The hosted footer check measured the bar while scroll had hidden it

Post-deploy run 39232506260 (live client 1a5dcb3c8) failed one WebKit case,
`production-mobile-lobby-chrome.spec.ts` "the footer frame sits on the bottom
edge with nothing under it", with a 60.67px strip. The same case had passed on
WebKit in every earlier run since PR #7399, and the only client change since
the previous passing run was the Members page.

The retained trace shows what was measured. At the moment of measurement the
footer was `position: fixed; bottom: 0` as required, but carried
`data-footer-hidden="true"` and `transform: translateY(100%)`, and the root
published `--ca-bottom-chrome-h: 0px` (61px a moment earlier). The strip was
the bar's own height: useHideFooterOnScroll had slid it off the edge, which is
Dan's 2026-09-04 behaviour, not a floating footer. The lobby refetched
`get_club_home` immediately after the test's single `scrollTo`, the game count
moved 487 -> 485 -> 484, and the document scroll position moved from 31147 to
31086 while the test was measuring: the page's end moved under a test that
scrolled once and waited a fixed 300ms. The failure screenshot, taken a moment
later, shows the bar back on the bottom edge.

The case now re-scrolls until the page is at its true end and requires the bar
to have come back there (`data-footer-hidden="false"`, the 2026-09-05 "at the
bottom it comes back" rule) before measuring. That adds an assertion rather than
removing one: a bar stuck hidden at the end of the page fails, and the
less-than-one-pixel painted-edge requirement, fixed positioning and
role-qualified frame checks are unchanged.
