# 2026-09-04 - Every member is discoverable in the cashier

Branch: `fix/cashier-roster-everyone-discoverable`. Reported by Dan, with a
screenshot of Deep Stack Society's Distribution Desk: "KING" found eight
horses whose handles end in "kingsley" and not the owner (alias KingFish).

## Root cause

Not the search, and not the server. `fn_club_cashier_members_page_v3` was run
with Dan's claims against Deep Stack Society: 417 rows, Dan's own row among
them, 385 of them with no `agents` wallet row and still returned, no wallet
join anywhere in the chain (`fn_club_cashier_members` is `club_members` with
`status in ('active','approved')`, `chip_balance` coalesced to 0, `profiles`
left-joined; scope from `fn_club_cashier_scope`: staff see all, agents their
downline, players nobody).

`CashierTradePage.mapCashierRoster` then deleted the viewer's row the moment
the page landed - `.filter((row) => String(row.user_id) !== viewerId)` -
before search, sort, grouping or counting ever saw it. The intent was "never
offer a recipient the server will refuse" (`fn_agent_wallet_send`: "You
Cannot Send Chips To Yourself"). The implementation chose deletion over
listing-but-not-sendable, which is exactly the behaviour Dan called a bug.

Two smaller gaps found on the way: the row prints `ID: <player_number>` but
the search never looked at it, so a profile-less member (rendered as "Player"
with no handle) could not be found by the only thing shown about them; and
`display_name` is deliberately not returned (the arena name is the alias, per
`20260903121000_ten_club_arena_rpcs_stop_answering_with_real_names`), so a
member whose legal-name display contains "King" is correctly NOT a hit.

## Fix

- `src/lib/cashierRoster.ts` (new, pure): `mapCashierRoster` keeps every row
  and stamps `isSelf`; `rosterRowMatches` searches the arena name, the
  @handle and the printed member ID.
- `CashierTradePage`: the self row is listed with a "You" tag, has no
  checkbox, `aria-disabled`, and `toggleSelect` refuses it. "N Available",
  Downline Holdings and the selection all use `recipients` (roster minus
  self). Nothing else about who is shown changed - that is the server's
  decision and it was already right.

## Law

`tests/every-member-is-discoverable-in-the-cashier.law.test.ts` (registered
in `docs/LAWS.md`): maps everyone, finds the owner with the same search that
finds the horses, finds a member by printed ID, and pins that the page never
filters the roster by user id before the search. The old pin in
`tests/cashier-ui-role-scoping.test.ts` that REQUIRED the deletion is replaced
by pins on the listed-but-unselectable row.

## Left alone

`CashierPage` (the `cashier-classic` route) still drops the viewer from its
recipient picker; it is a legacy surface, and a picker whose only purpose is
choosing a payee is a different question from a roster.
