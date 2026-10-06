# Top Up opens the club cashier

2026-10-05. Launch audit, new-player funding path. Client only.

## What was wrong

When a player does not have enough chips to buy in, the buy-in dialog offers
"Top Up". On a chip table that navigated to `/cashier?club=...`, the classic
cashier. For a plain player that page opens on its Buy-In tab, which needs a
table and can only answer "No table selected for buy-in". The one player the
button exists for reached a dead end.

## What changed

`src/utils/topUpCashierPath.ts`: Top Up goes to the club's Trade cashier,
`/clubs/:clubId/cashier`, which is the cashier's front door (2026-08-21) and
where a chip request is made. With no club resolved yet it goes to `/cashier`
with no club, which already finds the player's club and redirects to its Trade
cashier. Diamond tables are unchanged (they open the Diamond wallet).

## Not changed here

A chip request still notifies nobody; that is a database change to
`fn_request_chips_core_20261004` and is not in this pull request.

## Proof

`tests/unit/topUpCashierPath.test.ts`, 6 cases, including a pin that
`TablePage` uses the helper and that the route exists. `tsc --noEmit` clean.
Not exercised in a browser here.
