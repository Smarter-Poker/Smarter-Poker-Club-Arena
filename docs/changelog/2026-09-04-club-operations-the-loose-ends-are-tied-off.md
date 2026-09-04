# Club Operations: the loose ends from phases 1-5 are tied off

Before phase 6, every item any earlier phase left "for one release" or "for
the next batch", closed together on 2026-09-04. Deep Stack Society (2a1132b9)
for every figure.

## What came down

- **The payables estimate** (`fn_ca_agent_payables`, phase 3). The weekly
  rake times commission rate rode beside the ledger figure so an operator
  reconciling against the old number would see both. Phase 3 published
  2026-09-03; it is off the function and the page. The cap rises 200 to 500:
  the read comes off the rollup and costs the same at any size.
- **The legacy payload keys**: `completed_30d` / `prize_pool_30d` on
  `ca_club_tournaments` (phase 4, published `63046772a`) and `total_games` /
  `total_hands` / `wins` / `winner` on `ca_club_member_statistics` (phase 5,
  published `18fc9a062`). The service fallbacks went with them.

## What was fixed

- **The roster summary counted a different set from the directory.**
  `ca_club_members_summary` counted `cm.club_id = ANY(v_scope)`;
  `ca_club_roster_rows` was patched to `= p_club_id` on 2026-09-01. On a union
  page "Total Members" and "N Results" disagreed. The summary counts this club
  now (417 = 417, probed); the viewer's own role is still resolved across the
  scope.
- **The engine maintained a rollup nothing reads.** Since 2026-08-23
  `server/src/index.ts` folded every hand into `member_fee_rollup` on a 30 s
  tick for the roster's Fees column, Member Management and Player
  Statistics. All three were rebuilt to read `ca_hand_facts`; by 2026-09-04
  the only functions mentioning the rollup were its own refresh and backfill
  (`pg_proc`), and no cron touched it. ~5.7 ms of database time per hand,
  ~21 minutes a day, for 80,705 rows nobody opened. The loop is retired; the
  table and its three functions come down in the phase 6 DDL batch, after
  this engine build has deployed, so the old build never calls a function
  that is gone. `ClubRosterService.touchFeeRollup` and
  `shouldTouchFeeRollup` went with it.
- **The agent console's exclusion had no reason and no expiry** (handoff
  D-07, D-08). `fn_ca_ban_club_player` records both; the page sent a fixed
  sentence and `null`. A dialog now asks for the reason (required, it is
  written to the exclusion record) and Never / 7 / 30 / 90 days.
- **The agent dashboard's ledgers stopped at 100 and 50.** Transactions were
  fetched once (100) and paged in the browser, so "Load More" could never
  reach row 101; commissions stopped at 50 with no notice. Both page from
  the server now and say when the list is complete. The SWR cache truncated
  players to 30 and commissions to 20, and the stat cards summed the slices
  on every revisit; it stores the whole arrays. `isRefreshing` was set and
  never read; the header now says "Refreshing..." during a bus-driven
  reload.
- **`AgentRakeService.subscribeToRake` opened a new realtime channel per
  call** (random suffix). One channel per club now, reference counted.
- **Three dead `AgentService` methods** (`promoteToAgent`,
  `assignPlayerToAgent`, `selfTransfer`): zero callers; the second UPDATEd
  `agents`, a table with no UPDATE policy for authenticated, and returned
  true regardless. Deleted, with their tests.
- **Empty icon wrappers** left when emoji were stripped (summary cards, role
  picker, wallet rows). Removed; the three wallet balances are labelled
  Agent / Player / Promo, two of which had no name before.
- **The agent list cap** (`QUERY_LIMITS.MODERATE`, 500) is announced when
  hit.
- **`all-gates.sh` now runs `entry-chunk-delta`** after the build. It was the
  one gate missing from the local set, and it caught a real first-paint
  regression after a push on 2026-09-03.

Migration `20260904200000_the_estimates_and_the_old_keys_come_down.sql`,
one transaction, applied and recorded; probed rolled back first (payables
32 agents / cap 500 / no estimate keys; tournaments and statistics without
the legacy keys; summary total 417 = directory total 417).

## Still open, and why

- `member_fee_rollup`, `member_fee_rollup_state` and the three functions:
  DROP in the phase 6 migration, after this engine build deploys.
- Union-page disagreement between summary and directory was reasoned from
  the two bodies, not measured: no union exists to measure against today.
