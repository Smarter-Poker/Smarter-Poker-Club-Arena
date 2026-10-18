# 2026-10-18 - A union counts each member once

Dan's carousel screenshots: Midway Union 1,480 members / 665 active; Club JAQK
523 / 416; Deep Stack Society 419 / 239; Shark Club 538 / 421.

## What was measured

- 1,480 membership rows across the three member clubs, 954 distinct people.
  522 people (518 horses) are members of both Club JAQK and Shark Club, because
  Midway Union tables are bought into from either wallet.
- The union ACTIVE figure (`fn_batch_union_realtime_active_counts`) already
  counted distinct people on the union floor, and every one of them is a member
  of a member club. It was right.
- The club cards cannot be added together: JAQK and Shark each show the same
  ~520 dual members, at members, active and cash alike (both read 176 cash).
- `fn_batch_union_realtime_member_counts` counted membership rows, so a dual
  member was two members. That doubled count also set the union level.

## Fix

`count(DISTINCT cm.user_id)` in `fn_batch_union_realtime_member_counts`
(migration `20261018191523`). Pinned by
`tests/a-union-counts-each-member-once.test.ts`.

## Deep Stack Society shows 0 cash (diagnosed, not changed here)

The horse fleet still treats Deep Stack Society as its own table host
(`server/src/services/StableHand.ts`: `WALLETS_FOR_HOST`, `hostForWallet`).
A DSS horse may sit only at a table hosted by DSS itself. Since DSS joined
Midway Union on 2026-10-12 it owns no cash tables, so on the union floor its
416 horses only reach tournaments. Their cash play right now is at the Diamond
Arena and the Lightning pilot, neither of which is DSS's floor, so the card
reads 0 cash. Routing them onto Midway cash tables is an engine change held for
Dan's ruling, because it reverses the 2026-10-06 Diamond Arena assignment.
