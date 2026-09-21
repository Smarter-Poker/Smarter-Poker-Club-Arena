# 2026-09-15: the side menu nobody could open, and the straddle switch inside it

`TablePage` carried a full side menu - 241 lines of JSX, its own stylesheet
section, eleven rows - that no player could reach. The only reference to
`toggleSideMenu` anywhere in the file was the overlay's own close handler,
written INSIDE the block that the overlay itself rendered, so nothing could
ever set `isSideMenuOpen` true. The felt's menu is `TableMenu` in the HUD, the
trigger `approvedHamburgerGearGuard` pins; this was its superseded predecessor,
left behind when the HUD menu arrived.

Deleting it is not the interesting part. **Two controls were living in there.**

`StraddleToggle` was rendered only in that menu. Its own file says why it was
put there on 2026-08-20: "StraddleToggle was imported by TablePage and never
rendered, so a player had no way to turn straddling on at all." That fix was
correct on the day and then quietly undone by the menu losing its opener, so
turning straddling on has been impossible for as long as that was true. It is a
row in `TableMenu` now, shaped exactly like Stand Up Next Big Blind beside it -
an ON badge, the same `handleToggleStraddle`, offered only when the host
enabled straddles, because the engine refuses the toggle outright otherwise.
`StraddleToggle.tsx` and its stylesheet are deleted: with the behaviour in the
menu, keeping the component would leave a second implementation nobody renders.

The second was a Cashier row, and that one was already covered - the HUD menu
and the seat control both open the cashier and both read
`seatCanAddFunds`. `tests/unit/aDiamondSeatTopsUp.test.tsx` pinned the number
of `canTopUpSeat` references at four; it is three now, and the comment beside
it says which one went and why. Every remaining `setShowCashier(true)` still
sits behind that one decision.

Removed with the menu: `.menu-overlay`, `.side-menu`, `.menu-item` and its
modifiers, `.menu-item-icon/-label/-arrow`, `.menu-item-toggle`, `.menu-footer`,
the `fadeIn` and `tableSlideIn` keyframes that only it used, and the
`--z-side-menu` token TablePage redeclared. 276 lines of TSX and 126 of CSS.

The hamburger is untouched (CLAUDE.md 10.7): what went is a menu no player
could open, not a menu.
