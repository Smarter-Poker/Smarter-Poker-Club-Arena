# tests/a-lightning-hand-earns-for-the-club-that-funded-the-chair.law.test.ts

A union-hosted Lightning hand credits each player's rake to the member club
whose wallet funded the anchor chair, not to the hosting union. From
2026-10-23 22:49 UTC the Lightning branch of `fn_cash_earning_club` returned
`cash_player_session.club_id`, which `fn_cash_session_open` stamps with the
table's club (Midway Union), so about 61.7k Lightning rake records were
refused by the settler with `accounting_terms_not_observed`. Migration
20261025022551 makes the branch read the original pool session's anchor
chair first, then that chair's immutable buy-in receipt, both under the
unchanged union validation, and fall back to the session reader only when no
unambiguous funding chair exists. The law pins the migration's pre-image and
post-image, its anchors, and that the Classic branches are untouched.
