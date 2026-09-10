# 2026-09-10 - Active means who is on the floor

Dan, 2026-09-09: "why are the club lobby tables not displaying the same numbers
as how many players are actually playing?! each club shows 300-549 active
players, but only showing a handful of cash games open and players sitting..."

## One definition, both cards

A player is active when he holds a live seat (not away) on an open table of the
floor. A club's floor is its own tables plus its union's; a union's floor is its
own tables plus every member club's own tables. Every count is DISTINCT users.

`fn_batch_club_realtime_active_counts` and `fn_batch_union_realtime_active_counts`
now return `active_count`, `cash_count` and `event_count` (migration
`20260910181549_active_means_who_is_on_the_floor_cash_and_events_counted_apa`).
A player at a cash table and in an MTT at once is one active player, one cash
player and one event player. The old column keeps its name and meaning, so a
bundle from before this migration still renders.

The union counter used to SUM the member clubs' counts - and a union's members
sit at the union's tables, so a horse in two member clubs was two active
players. Midway Union read 1,094 while 554 distinct people were on its floor.
Its members figure (1,179) is still the sum of member-club rosters, because a
union is measured by the players under it; its active figure is who is playing.

## The card prints the split

`ClubCardPanel` keeps MEMBERS / LEVEL / ACTIVE and prints, under the green
total, `94 CASH · 544 EVENTS` in the card's own label ink (`.club-card-stat-split`,
sized in cqw like the rest of the rail). Under 230px of card the split stacks -
CASH above, EVENTS below - so nothing crosses the frame on a phone card. The
figures ride the same last-known-numbers cache as the other three (Dan
2026-09-02: zeros until the card loads, never "unavailable"). `ClubStats` carries
`activeCash` / `activeEvents`; HomePage reads them from both RPCs.

Rendered headless (real component, real CSS, real fonts) at 300, 260, 210 and
165px and shown to Dan before this was pushed. Pinned by
`tests/components/clubCardActiveSplit.test.tsx`.

## Not done, on purpose: re-minting the legacy ids

62 horses (and, per another agent's `20260910124023`, 33 humans) carry ids
minted before the v4 generator. They live in `auth.users`; 393 foreign-key
columns reference `profiles`; 61,031 `chip_ledger` rows name the horses alone,
and that journal is append-only and hash-chained. Rewriting those ids is
rewriting the financial record, which CLAUDE.md forbids. The shared uuid shape
(`server/src/lib/uuidShape.ts`, `src/utils/uuidShape.ts`) is the fix; the ids
stay what they are.
