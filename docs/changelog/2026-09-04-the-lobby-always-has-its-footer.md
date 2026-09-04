# 2026-09-04 - The lobby always has its footer

Branch: `fix/lobby-tab-keeps-its-footer`. Reported by Dan.

## What Dan hit

On a live table, "+" opens the club lobby - and the footer menu (Settings /
Players / Cashier / Market / Data / Stats) is not there. The same lobby
reached by URL has it.

## Root cause

The "+" does not navigate. By design (2026-08-15) it opens the club lobby as
a TAB inside the multi-table container so the running games are never torn
down; the URL stays `/table/<id>`. The one global footer is mounted at the
app root behind `shouldShowClubFooter(location.pathname)`, and `/table/*` is
on that denylist - correctly, because a footer over a live felt covers the
action buttons. A pathname cannot tell a lobby tab from a table tab, so the
lobby a player reached from a game was footerless.

Two artifacts show it used to work: `MultiTablePage.css` still carries a
sticky rule for `nav[class*='bottomNav']` INSIDE the lobby tab (written when
`ClubHomePage` mounted its own footer), and the lobby-link interceptor's
comment lists "bottom nav" among the controls it passes through. Centralising
the footer at the app root (`tests/footer-clearance.test.ts`) dropped it from
the one lobby surface that has no lobby URL.

## Fix

- `src/components/club/inTabLobbySurface.ts`: a tiny external store.
  `MultiTablePage` publishes `!hidden && activeTab is a lobby` on every tab
  change and `false` on unmount.
- `shouldShowClubFooterFor(pathname, inTabLobbyActive)`: route OR in-tab
  lobby. `App.tsx` reads both. A lobby tab parked behind a live table
  publishes false, so the footer never floats over a game - the concern the
  old CSS comment raised about a body-level bar.

## Law

`tests/the-lobby-always-has-its-footer.law.test.ts` (registered in
`docs/LAWS.md`) pins the gate, the app-root wiring, the container's publish
and clear, and the hook contract. `tests/footer-clearance.test.ts` now pins
the two-input gate instead of the pathname-only one.
