# Club Operations: the full upgrade programme

Owner: Dan (directive 2026-09-03 - "verify, audit and upgrade every single
page" of `/hub/club-arena/clubs/:club/operations` and every sub page).
Author of this plan: Cowork/Claude session `feat/club-operations-full-upgrade`.
Status: **Phases 1, 2 and 3 of 8 built, tested, merged (`c22a3bb00`) and published. Phases 4 to 8 specified below.**

**This document is the map. The live state is
[`docs/HANDOFF-2026-09-03-club-operations-upgrade.md`](../HANDOFF-2026-09-03-club-operations-upgrade.md)** -
what is merged, what is published, what is blocked, every defect with its
evidence, and the exact first actions for whoever picks this up next. Read that
first, then come back here for the per-phase detail.

Every finding in this document was produced by reading the page source end to
end and, where it concerns data, by querying production
(`kuklfnapbkmacvwxktbh`) and reading the function bodies. Findings are labelled
**CONFIRMED** (the code path was read end to end, or the query was run) or
**SUSPECTED** (the shape is there, the reproduction is not). Sample club
throughout: Deep Stack Society `2a1132b9-5ba2-42e6-9f01-30a7fcffebe3`, 417
members, 226 live tables.

---

## 1. The inventory: every page and sub page in the workspace

Twenty-four routes reach the operator workspace. Twenty-one are advertised in
the registry as of Phase 1; three more are reachable and deliberately not
advertised (`cashier-classic`, the two member detail routes are children of
Players).

| #   | Tool              | Route                         | Component                  | Lines  | Group / access        |
| --- | ----------------- | ----------------------------- | -------------------------- | ------ | --------------------- |
| 1   | Overview          | `/operations`                 | `ClubOperationsPage`       | 260    | overview / staff      |
| 2   | Dashboard         | `/dashboard-full`             | `ClubDashboard`            | 1838   | people / staff        |
| 3   | Players           | `/members`                    | `ClubMembersPage`          | 1149   | people / staff        |
| 4   | Player record     | `/members/:userId`            | `MemberManagementPage`     | 1265   | child of Players      |
| 5   | Player statistics | `/members/:userId/statistics` | `PlayerStatisticsPage`     | 348    | child of Players      |
| 6   | Agent Team        | `/agents`                     | `AgentManagementPage`      | 1547   | people / staff        |
| 7   | Agent Network     | `/agent-dashboard`            | `SuperAgentDashboard`      | 549    | people / staff        |
| 8   | Reports           | `/reports`                    | `ReportReviewPage`         | 383    | people / staff        |
| 9   | Disputes          | `/disputes`                   | `DisputeManagementPage`    | 508    | people / staff        |
| 10  | Anti-Cheat        | `/anti-cheat`                 | `AntiCheatPage`            | 1185   | people / staff        |
| 11  | Blacklist         | `/blacklist`                  | `BlacklistManagerPage`     | 318    | people / control      |
| 12  | Finance Overview  | `/finance`                    | `ClubFinanceWorkspacePage` | shared | finance / finance     |
| 13  | Club Data         | `/data`                       | `ClubDataPage`             | 2773   | finance / finance     |
| 14  | Financials        | `/financials`                 | `ClubFinancialsPage`       | 629    | finance / finance     |
| 15  | Cashier           | `/cashier`                    | `CashierTradePage`         | 3396   | finance / finance     |
| 16  | Cashier (classic) | `/cashier-classic`            | `CashierPage`              | 2878   | unadvertised fallback |
| 17  | Settlement        | `/settlement`                 | `SettlementPage`           | 1197   | finance / finance     |
| 18  | Insurance Report  | `/insurance-report`           | `ClubInsuranceReportPage`  | 296    | finance / finance     |
| 19  | Bomb Pot Report   | `/bomb-pot-report`            | `ClubBombPotReportPage`    | 296    | finance / control     |
| 20  | Control Overview  | `/control`                    | `ClubControlWorkspacePage` | shared | control / control     |
| 21  | Announcements     | `/announcements`              | `ClubAnnouncementsPage`    | 448    | control / staff       |
| 22  | Player Offers     | `/promotions`                 | `PromotionsPage`           | 529    | control / staff       |
| 23  | Promo Vault       | `/promo-vault`                | `PromoVaultPage`           | 1050   | control / control     |
| 24  | Table Management  | `/table-management`           | `GameManagementPage`       | shared | control / control     |
| 25  | Club Rules        | `/rules`                      | `ClubRulesPage`            | 339    | control / control     |
| 26  | Settings          | `/settings`                   | `ClubSettingsPage`         | 2100   | control / control     |

Adjacent club routes that are NOT part of the operator workspace and stay out
of it: `/`, `/lobby`, `/tournaments`, `/messages`, `/jackpot`,
`/create-table`, `/tables/:tableId/bomb-settings` (a per-table config opened
from Table Management).

---

## 2. The build order, and why

Eight phases. The ordering is by **how badly the page lies to the operator**,
not by how much code it needs:

1. **The shell** - the page Dan linked, the doors, the permission truth. DONE.
2. **Integrity and safety** - four pages where a button says "done" and
   nothing was written. The worst class of defect on the estate: the operator
   believes they acted.
3. **The agent network** - a Ban button that is a `toast.success` and nothing
   else, a transfer that preselects a nonexistent recipient, a payouts table
   computed in the browser.
4. **The dashboard** - six numbers that are wrong or truncated on the page
   most operators open first.
5. **Players and player records** - a 1.05s roster query, a leaderboard sorted
   over a truncated set, two identical statistics rows.
6. **Finance truth** - the reporting pages, where one headline number is 4.6%
   of the real figure and two pages disagree about rake by 6.2%.
7. **Money movement** - the cashier pair and settlement. The write paths are
   already safe; the reporting around them is not.
8. **Club control** - three settings nothing reads, a rules save that reports
   success after RLS refused it, and a vault grant that delivers nothing.

Phases 2 through 8 each end the way this one did: built, wired, tested, every
local gate green, one changelog, one branch pushed.

---

## 3. Phase 1 - The Operations Shell. **DONE**

Shipped: `ca_club_operations_overview` (one staff-gated read: live floor, money
for finance roles only, eleven queues, alerts carrying severity and the
registry tool id); live reading strip, "Waiting For You" panel, per-tool and
per-group queue badges and an honest freshness line on `/operations`; the same
badges plus headline readings on `/finance` and `/control`; rail badges
including the workspace total on the identity plate.

Fixed: `anti-cheat` was advertised but absent from `OPERATION_SUFFIXES`, so the
route had **no capability check at all** and the rail vanished on it; three
built server-gated tools had no door (`promo-vault`, `bomb-pot-report`,
`table-management`); the Promotions tile promised a campaign manager and opened
the player offer feed; two `<main>` landmarks on six pages; three rail rewrites
that could never select anything; group art bypassing `mediaUrl`; a 460px
mobile hero.

Tests added: 157 cases across registry integrity, the first mounted render test
for the workspace, and an SQL/client payload contract.

Detail: `docs/changelog/2026-09-03-club-operations-phase-1-the-shell.md`.

---

## 4. Phase 2 - Integrity and safety: the buttons that write nothing. **DONE**

Shipped 2026-09-03 (migration `20260903170000_an_integrity_decision_is_written_down`):
one shared gate `fn_ca_can_review_integrity` behind five functions;
`fn_club_anti_cheat_flags` + `fn_review_anti_cheat_flag` (a flag review is
written down for the first time, and a zero-row write is a failure);
`get_anti_cheat_stats` rewritten to the shape the page reads and gated;
`detect_collusion_pairs` rescoped to the club's own hands and split into the two
detectors that were being shown as one; `fn_ca_dismiss_collusion_pair`;
`fn_dispute_start_review` + `fn_dispute_escalate`; two indexes on a 169,530-row
table that had only a primary key.

Client: the Anti-Cheat console resolves its club before reading (it had been
sending the slug into every uuid argument since it shipped); the kick goes
through the engine's own `POST /admin/kick` instead of stamping `left_at` onto
a seat; the anomalies tab says what its query measures; the reports queue polls
instead of subscribing to a table that is not published, and states its 100-row
ceiling; the blacklist form picks a person out of the roster, names them in the
ledger, warns when an excluded player is still seated, and offers a broom for
the expired rows nothing sweeps. `anti-cheat` moved from `staff` to `control`.

Corrected the same day, in the phase 2 verification pass (migration
`20260903180000_a_cleared_pair_stays_cleared`): `fn_ca_dismiss_collusion_pair`
wrote `status = 'dismissed'`, a value `collusion_tracking_status_check` forbids,
so the Clear button could only ever have thrown at the operator. Fixing the word
exposed the larger fault - 169,519 of the table's 169,530 rows were auto-cleared
on 2026-08-18 when the horse-versus-horse detector bug was fixed at the source,
and the old `status <> 'dismissed'` filter (true for every row, since no row can
hold that value) let all of them back in. The screen now reads the rows the
detector left **open**, reports `closed_pairs` beside them so an empty queue
reads as "the screen ran and closed itself", labels the non-dump group
`screening` with each row naming its own pattern, and counts the window off
`club_hand_daily`. The call went from ~1,400ms to 397ms.

Detail: `docs/changelog/2026-09-03-club-operations-phase-1-the-shell.md` and
`docs/changelog/2026-09-03-club-operations-phase-2-an-integrity-decision-is-written-down.md`.

Everything below is what the phase found, kept as the record.

**Anti-Cheat (`/anti-cheat`)**

- **CONFIRMED - the page never resolves the club slug.** `AntiCheatPage.tsx:403`
  does `setClubId(targetClub)` with the raw route param, so every query sends
  `deep-stack-society-11192` to a `uuid` argument and to `.eq('club_id', ...)`.
  Postgres answers `22P02 invalid input syntax for type uuid`; all four catch
  blocks are a `console.warn` and an empty state. **The entire page renders
  zeros and "Club Is Clean" on every slug URL.** The same file already calls
  `resolveClubUUID` for its realtime filter, which proves the param needs it.
- **CONFIRMED - `get_anti_cheat_stats` returns a different shape than the page
  reads, and is mostly literal zeros.** It returns `total_hands_analyzed`,
  `flagged_players: 0`, `active_investigations: 0`, `collusion_alerts: 0`,
  `bot_suspicions: 0`, `chip_dumping_alerts: 0`, `last_scan`. The page reads
  `open_flags`, `blocks_24h`, `active_sessions`, `by_severity`, `by_type`. No
  key matches. It is also the only one of the three detectors that is NOT
  `SECURITY DEFINER` and carries no authorization check.
- **CONFIRMED - the Flags tab can never show a flag.** All 14 rows in
  `anti_cheat_flags` have `club_id IS NULL`, and RLS grants `authenticated`
  only `player_id = auth.uid()` - there is no staff read policy.
- **CONFIRMED - "Submit Review" writes nothing and reports success.** A client
  `.update()` with no UPDATE policy returns 204 / zero rows / no error, then
  `toast.success('Flag reviewed successfully')`.
- **CONFIRMED - Kick is half-wired and its audit row never lands.**
  `kickPlayer(f.player_id)` is called with no `tableId`, so the `table_seats`
  update is skipped entirely; the compensating `anti_cheat_events` insert is
  service-role only and fails into a `console.warn`. The operator is told
  "Player removed."
- **CONFIRMED - horses are filtered out of collusion detection.**
  `detect_collusion_pairs` requires BOTH players to have a `club_members` row,
  which yields **0 pairs from 38,267 tracking rows** for a club where 556 of
  557 tracked players are horses. Direct violation of CLAUDE.md 10.5; scope it
  by the club's own tables/hands, which is how `analyzed_hands` in the same
  function is already computed.
- **CONFIRMED - the Anomalies tab is mislabelled.** `detect_suspicious_plays`
  returns the winners of big pots (`pot_size >= 40 * big_blind`); the UI titles
  it "Players Who Folded Strong Hands On The River" and stamps every row with
  that badge. Its "Critical" tile can never be non-zero.
- **CONFIRMED - collusion "Net Chips" is always 0**: the RPC reads
  `evidence->>'net_chips_transferred'` and zero of 169,530 `collusion_tracking`
  rows carry that key. The CSV exports the same constant.

Work: resolve the UUID before any query; rewrite `get_anti_cheat_stats` to the
keys the page reads, `SECURITY DEFINER` with the club-admin check its siblings
use; backfill `anti_cheat_flags.club_id` from `table_id -> tables.club_id`, add
`NOT NULL`, fix the writer; add a staff SELECT policy and
`fn_review_anti_cheat_flag(...)`; route the kick through a definer RPC that
carries the table and writes the event; rescope collusion detection to the
club's own hands so horses count; relabel the anomalies tab to what the SQL
computes; populate or drop `net_chips_transferred`; give the page an error
state so "clean" and "could not read" stop looking identical.

**Disputes (`/disputes`)**

- **CONFIRMED - two of the three actions write nothing.** `disputes` has
  exactly one policy, `disputes_party_or_admin_select`. `startReview` and
  `escalateDispute` are direct table UPDATEs, match zero rows, and surface as
  "Failed to start review". The `open -> under_review` transition is
  unreachable, so the `under_review` filter tab can never populate. Only
  Resolve works (it goes through `fn_resolve_dispute`).
- **CONFIRMED - the 72h SLA is a client constant.** Nothing escalates or alerts
  on breach. `disputes.assigned_to` exists and is only ever written by the
  broken `startReview`, so it is always NULL.

Work: `fn_dispute_start_review` and `fn_dispute_escalate` as definer RPCs with
the club-admin check; surface `assigned_to`; an SLA-breach watcher that raises a
`financial_alerts` row at 72h (the Phase 1 overview already reads
`disputes_aged` and paints it critical).

**Reports (`/reports`)**

- **CONFIRMED - the realtime subscription is dead.** `user_reports` is not in
  the `supabase_realtime` publication, and its RLS SELECT policy is
  reporter/reported/service_role only, so a moderator matches nothing. No
  polling fallback.
- **CONFIRMED - no assignment, no aging, no priority.** Two moderators can work
  the same case. `fn_list_player_reports` caps at 100 with no cursor and no
  "there are more" indicator.
- Note: `user_reports` has no `club_id` at all. Phase 1's badge scopes a report
  to a club by the reported player's membership; a `club_id` column would make
  that exact.

**Blacklist (`/blacklist`)**

- **CONFIRMED - expiry is honoured at the buy-in gate but nothing sweeps it.**
  `atomic_table_buyin`, `atomic_tournament_register` and `atomic_table_rebuy`
  all check `expires_at`, so an expired ban stops blocking; no cron touches the
  table, so expired rows accumulate forever and the "Active" figure drifts.
  Phase 1 surfaces `blacklist_expired` as an info alert; Phase 2 archives them.
- **CONFIRMED - banning does not evict.** Inserting a row does not remove the
  membership, clear `table_seats`, or close a session. The player stays seated
  until they try to re-buy.
- **CONFIRMED - the form takes a raw UUID typed by hand**, with no player
  picker and no existence check. Removal is a hard DELETE with no un-ban audit
  beyond the `fn_blacklists_audit` trigger.

**Route-level gap for the whole group: CONFIRMED.** All four pages carry
`AuthGuard + ClubMemberGuard` only. After Phase 1 the _capability_ layer covers
them (`anti-cheat` is now in the suffix set), and the server checks are real for
the detectors and `fn_action_player_report`, but `agents`, `disputes` and
`blacklist` still rely on RLS for the write side only. Phase 2 adds the
server-side read gate to match what the registry advertises.

---

## 5. Phase 3 - The agent network. **DONE**

Shipped 2026-09-03 (migrations `20260903200000_an_agent_payout_is_a_record` and
`20260903210000_the_payables_read_is_index_only`). Four controls could not do
what their labels said, each for a different reason: Ban Player was a success
toast and no write at all; Clawback was dead three times over (a list filtered
on three transaction types with zero rows estate-wide, a claim step UPDATEing a
table with no UPDATE policy, and an RPC that is SECURITY INVOKER with no
EXECUTE for `authenticated`); Add Prepaid Balance sent `fn_admin_update_agent`
the one pair it refuses, so no positive amount could ever succeed; and Revoke
Credit called an ungranted invoker function that, had it run, would have moved
player-wallet chips and left the credit line untouched.

"Upcoming Agent Payouts" was `weekly_rake_generated * commission_rate` with a
hardcoded "Pending" and no ledger read anywhere - 36,657 printed against 65,790
genuinely owed across 259,135 unsettled commission rows. `fn_ca_agent_payables`
reads the ledger behind a new `fn_ca_can_manage_agents` gate (owner, co-owner,
admin), because `agent_commissions` grants `authenticated` only their own rows.
`fn_ca_ban_club_player` writes the exclusion that `atomic_table_buyin`,
`atomic_table_rebuy` and `atomic_tournament_register` all read, and
deliberately does NOT delete the membership row: it carries the player's chips,
and the first member the probe picked was holding 10,067.64 of them.

The clawback panel was pointed at `fn_agent_wallet_reversible` and
`fn_agent_wallet_claim_back`, which the wallet cashier has been using correctly
all along - the dead parallel copy was deleted and no new money code written.
Also fixed: the hierarchy Transfer sent the agents primary key where a user id
was needed; Credit Limits labelled every super agent "Sub-Agent"; the agent
dashboard read `invited_by` as the downline while every write path uses
`agent_id` (1,575 memberships against 417); `getAgentPlayers` had no club
filter; `fn_create_agent` got an unresolved club param; the notes both forms
collected were discarded; a Cancel button had no content.

The payables aggregate went from 5,198ms cold to 1,731ms by carrying `amount`
and `created_at` into the partial index, making the scan index-only.

Detail: `docs/changelog/2026-09-03-club-operations-phase-3-the-agent-network.md`.

Everything below is what the phase found, kept as the record.

- **CONFIRMED - the Ban Player action is a lie.** `AgentManagementPage.tsx:505`:
  `else if (type === 'ban') { toast.success('Player banned'); }`. No write of
  any kind; the ConfirmModal collects the player id and discards it.
- **CONFIRMED - the hierarchy tab's Transfer sends the wrong id**: `agent.id`
  (the `agents` PK) where the agent card correctly sends `agent.userId`, so the
  modal preselects a recipient that does not exist.
- **CONFIRMED - "Upcoming Agent Payouts" is computed in the browser and
  hardcodes its status.** `weeklyRakeGenerated * commissionRate` with
  `<span>Pending</span>`; no payout or settlement table is read. The
  "Settlement Schedule" block above it is static copy.
- **CONFIRMED - Credit Limits mislabels a `super_agent` as "Sub-Agent"** (a
  two-branch ternary on three roles).
- **CONFIRMED - four emoji in user-facing strings** across
  `AgentManagementPage` and `SuperAgentDashboard`, and raw numbers rendered
  without `toLocaleString` on both.
- No pagination, search or filter on an agent list capped at 500.

Work: delete or wire the ban branch (a real `blacklists` insert plus membership
removal); fix the id and the role label; replace the fabricated payouts table
with a read of the real settlement rows, or label it "Projected" and say what
it is projecting; strip the emoji; format the numbers; paginate.

---

## 6. Phase 4 - The club dashboard. **DONE**

Shipped 2026-09-04 (migration `20260904100000_the_dashboard_counts_what_is_there`,
changelog `docs/changelog/2026-09-04-club-operations-phase-4-the-dashboard-counts-what-is-there.md`).
Re-measured before the fix: 4,954 tables, 319 live, the tab showing 50; 479
seat rows for 243 people; the "Hands" top ten sharing zero members with the
true top ten by hands over 678 players; 3,534 tournament rows / 879,696 bytes
for a request of 25; `ca_club_dashboard_stats` at 132,855 buffers and ~910 ms
because `club_daily_stats` is a view over the whole rake ledger, referenced
five times.

What shipped: a new `ca_club_tables` (every live table, seats counted from
`table_seats`, floor-wide counts, union scope); `seated_now` counts people;
`ca_club_top_players` takes `p_sort` and orders before the limit;
`ca_club_tournaments` takes `p_days` and its limit limits (old summary keys
kept one release); `ca_club_revenue` gated on `ca_can_view_club_finances`;
the stats read is one rollup pass (31 ms). Client: Tables tab split into Live
Now / Recently Closed with the header from the floor-wide figures; sort sent
to the server; Revenue tab offered to finance roles only and a refusal named;
insurance cards gated on `contracts > 0`; the filter bar says what it reaches;
`ClubStatsCards` fetches once; `ClubMemberManagement` refuses to delete a
membership row that holds chips or a seat, confirms, checks row counts, shows
a failed read, renders the avatar, staggers by id.

The "Humans Only" item below was reconciled rather than removed: the register
in `scripts/ci/check-horses-are-players.mjs` sanctions the toggle on two
written conditions (defaults to showing horses; every scoped figure relabels
itself), and the dashboard now meets both. It is no longer persisted, is
offered only when the viewer can see the flag, and relabels the CSV, the
"See All" count and the attribution caption. Dan can remove it outright; it is
one `useState`.

Verification walk on production (signed in, 404 px) found a phase 3 defect:
the Payouts tab's `fn_ca_agent_payables` scanned every unsettled commission
row (499,933, doubling daily) and took 8,870 ms, or failed. Replaced by a
trigger-maintained rollup (`20260904170000`), 107 ms after. Phase 3's
D-04 in the handoff is closed by this.

Still open from this list: the Time Range filter still does not reach the six
metric cards (they are labelled Today / This Week and the bar now says so);
Tournaments remains member-visible by design (the same information is on the
public tournament lobby).

Original audit, kept for the record:

- **CONFIRMED - the Tables tab hides every live table.** It fetches 50 tables
  ordered `created_at DESC`. Deep Stack Society has 1,567 tables, 226 live, and
  **zero of the 226 are in the newest 50**. The header says "227 Active Tables"
  above 50 dead rows, and `liveTableCount` / `seatedAcrossTables` are computed
  over that wrong 50.
- **CONFIRMED - "Humans Only" strips 416 of 417 players from the leaderboard,
  the attribution denominator and the CSV export.** A persisted localStorage
  toggle that filters horses out of a total is exactly what CLAUDE.md 10.5
  forbids. It is also a silent no-op below owner/co_owner/admin, because
  `fn_can_see_horse_flag` masks the flag for those roles.
- **CONFIRMED - the leaderboard sorts a pre-truncated set.** `ca_club_top_players`
  orders by profit and takes 100; choosing Hands or Win Rate re-sorts those 100.
- **CONFIRMED - `ca_club_tournaments` ignores `p_limit`** (the LIMIT sits after
  `jsonb_agg`), so the tab renders 439 unvirtualized rows / 97KB when it asked
  for 25.
- **CONFIRMED - the Time Range filter is half-wired.** `ca_club_dashboard_stats`
  takes no date argument, so six metric cards and the 14-day chart never
  change; Tournaments is fixed at 30 days; Revenue caps at 90 while the heading
  says "all time".
- **CONFIRMED - "Seated Now" counts seat rows, not people** (698 against 221),
  which is why this page and Players disagree at the same instant. Phase 1's
  overview already counts people; this is where the old number lives.
- **CONFIRMED - the insurance gate never fires** (`ca_club_revenue` always
  returns an object, so `revenue.insurance ?` is always truthy).
- **CONFIRMED - `ClubMemberManagement` swallows a failed read** into an empty
  list with no error, and offers an unconfirmed hard DELETE of a membership
  behind a bare glyph; it also prints an avatar URL as text and staggers row
  visibility by an index into the unfiltered array, so searching leaves rows at
  `opacity: 0`.
- **CONFIRMED - `ca_club_dashboard_stats` is called twice on every mount**
  (`ClubStatsCards` self-loads while the parent prop is still null).
- **CONFIRMED - Revenue and Tournaments are visible to every plain member**:
  `ca_can_view_club` is satisfied by any non-banned membership and neither tab
  has a client gate.

---

## 7. Phase 5 - Players and player records. **DONE**

Shipped 2026-09-04 (migration `20260904180000_a_player_record_says_what_it_measured`,
changelog `docs/changelog/2026-09-04-club-operations-phase-5-a-player-record-says-what-it-measured.md`).
The audit below predates a rebuild of these pages, so it was redone against
`origin/main`. Confirmed and fixed: 3-Bet% divided by the fold-to-3-bet
denominator (316.7% for one player); three labels on two numbers in Volume
and two labels on one wallet; the transfer modal defaulting `p_destination`
to `player_wallet` while the recipient was still loading (fn_club_bank_send
honours it) and defaulting the sender's role on a failed read;
`ca_can_view_club` / `ca_can_view_club_finances` admitting a caller with no
account (the latent item below); dead `!resolved` guards so a bad slug read
as an outage and "Not Found" was unreachable; the roster resetting a
deep-linked financial filter when the page RPC beat the summary; unbounded
realtime recovery; the dead fee-rollup nudge on every open; bus events with
the slug; upline "None" shown to viewers it is hidden from; the downline cap
with no way to row 51; notes stuck "Not Saved Yet" after a trim.

Of the original list: the per-page recomputation in `ca_club_members_page`
measures 520-577 ms per page of 80 for 417 members today and was left as is;
`fn_can_see_horse_flag` per row and `cm.last_active_at` no longer apply to
the rebuilt roster; the duplicated-roster item was closed in phase 4.

Original audit, kept for the record:

- **CONFIRMED - `ca_club_members_page` takes 1.05s for 417 members** and does
  it on every page of the infinite scroll: it rebuilds the whole recursive agent
  closure, aggregates all of `ca_hand_facts` for the club, computes
  `filtered_total` over every row, then discards everything before the cursor.
  **`ca_hand_facts` has no index on `club_id`.**
- **CONFIRMED - `fn_can_see_horse_flag(p_club_id)` is evaluated per row** inside
  the projection - 400+ identical club-scoped EXISTS per request.
- **CONFIRMED - the roster's `mine` / `inactive_*` / `high_fees` filters read
  `cm.last_active_at`, which is populated for 0 of 417 rows** (the live column
  is `cm.last_active`), so they run entirely off `profiles.last_login`.
- **CONFIRMED - the downline list is hard-capped at 50 with no "load more"**, so
  a 300-strong super agent's tree is unreachable from the member record.
- **CONFIRMED - Player Statistics shows the same number twice.**
  `ca_club_member_statistics` sets both `total_games` and `total_hands` to
  `a.hands`, and `winner` is a copy of `wins`; `mtt_hands` is fetched, typed and
  never rendered.
- **CONFIRMED - the dashboard renders the roster twice for staff** (the paged
  list, then `ClubMemberManagement` re-fetching all 417 rows below it).
- **SUSPECTED - 3-Bet% may be wrong**: it divides by `faced_three_bet`, which
  may mean "faced a 3-bet" rather than "had the opportunity to 3-bet".
- **CONFIRMED, latent - `ca_can_view_club` returns TRUE when `auth.uid()` is
  NULL.** Not exploitable today (anon has no EXECUTE), but it is one grant away
  from publishing a club's roster. Phase 1's new function shows the shape the
  fix should take.

---

## 7b. Loose ends from phases 1-5. **DONE**

Closed 2026-09-04 before phase 6 (changelog
`docs/changelog/2026-09-04-club-operations-the-loose-ends-are-tied-off.md`,
migration `20260904200000`): the payables estimate and the phase 4 / 5
legacy payload keys are off the live functions; the roster summary counts
the club the directory lists; the engine's dead fee-rollup loop is retired
(the table was NOT dropped in phase 6: `member_fee_lifetime` hangs off it by
trigger and "no reader in this repo" is not "no reader anywhere" - see that
changelog's Still Open);
the agent console's exclusion takes a reason and an expiry; the agent
dashboard pages its ledgers from the server and its cache no longer
truncates what the cards sum; the rake channel is shared; three dead
AgentService methods and the empty icon wrappers are gone; the agent list
cap is announced; all-gates.sh runs entry-chunk-delta.

## 8. Phase 6 - Finance truth. **DONE**

Shipped 2026-09-04 (migration `20260904220000_the_money_is_read_from_the_ledger`,
changelog
`docs/changelog/2026-09-04-club-operations-phase-6-the-money-is-read-from-the-ledger.md`).
Every item below was proved against production before it was changed, and the
audit found five more the plan had not: `club_hand_daily.pot_total` mixes
tournament chips into cash pots (118,254,757 against 5,239,484 on one day), so
the dashboard's Average Pot was twenty times out; per-player CASH results were
never written at all for a club outside a union (415 players, not one non-zero
row), which is what the unexplained sign disagreement at the end of this
section actually was; table add-ons (713,968.61 chips in seven days), rebuys
and refunds were money to nobody; `club_table_daily` silently dropped every
raked hand whose contributions were not recorded; and the "Club Chip Audit
Trail" showed the viewer their own movements, not the club's.

The money now has one source - `rake_records`, kept as an exact per-day rollup
by statement-level triggers and reconciled hourly - and each page one gated
read. Verified end to end through PostgREST with a real session: the owner's
club 200, a club he is not a member of 403/42501, anon 401.

- **CONFIRMED - four headline numbers on Financials are computed from the
  OLDEST 5,000 rows.** `.order('created_at', {ascending:true}).limit(5000)`,
  then reduced in the browser. Measured over 7 days on the sample club: Rake
  Collected reads **5,822.26 against a true 126,041.44 (4.6%)**; Total Pot
  Volume 162,524.67 against 3,375,710.17; Hands Played 5,000 against 63,288.
  Net Revenue inherits all of it. No truncation warning anywhere.
- **CONFIRMED - per-player Rake is always 0.00 for a club not in a union.** The
  rake CTE joins `u.union_id = v_union`; with a NULL union that is never true.
  413 players, `total_rake = 0.00`, and the "Most Rake" sort is dead - while the
  UI presents 0.00 as a real figure.
- **CONFIRMED - two pages, two irreconcilable rake numbers for the same window**:
  `rake_records` 126,218.91 (Financials) against `club_table_daily.rake`
  118,348.87 (Club Data) - a 6.2% gap, neither page naming its source.
- **CONFIRMED - "Hands" means two different things across two tabs of one page**
  (59,321 table hands against 649,997 player-hands, both labelled "Hands"), and
  **tournament hands are structurally 0** in the game summary.
- **CONFIRMED - `union_fees` reads `invoice_type='union_to_club'` while Club
  Data reads `union_weekly_squareup`**; the sample club has zero of either, so
  the line silently contributes 0 to Net Revenue.
- **CONFIRMED - the insurance report's "Bank In (Fees + Redirects)" is premiums
  only**, its funnel and money windows use different date bases (a rolling
  timestamp against UTC day buckets, so the day rows can never sum to the
  headline), and its Take Rate double-counts cash-outs and can exceed 100%.
- **CONFIRMED - the union invoice card computes `overdue`, `paid_total` and
  `outstanding` and renders none of them.** No pay action, no dispute action.
- **CONFIRMED - Club Data's Hide Horses recomputes the player totals over
  non-horse rows** - another 10.5 violation, mitigated by an honest label and an
  unfiltered export.
- **CONFIRMED - `SNG` is labelled "Heads Up"** in the game filter.
- **CONFIRMED - Financials is gated only in the component**: it reads
  `rake_records`, `chip_transactions` and `settlement_invoices` as direct table
  selects, and renders `RakeReports` and `TransactionLedgerView` with no role
  check at all.
- **CONFIRMED, latent - `ca_can_view_club_finances` also opens with
  `auth.uid() IS NULL`.**
- Sign convention unproven: cash "Total Winnings" is +89,166.07 while the
  aggregate player net over the same window is -11,763.83. Opposite signs,
  different magnitudes, no documentation of whose perspective either is.

---

## 9. Phase 7 - Money movement

**FIRST, AND MEASURED BY THE PHASE 6 GATE (2026-09-04): two reads on the
finance pages are still too slow to answer, and one of them is not yet
explained.**

**(a) The bomb pot report. Half fixed, and the half that remains is a
mystery worth solving before anything is built on it.** The missing index is
in (`idx_hand_history_bomb_pot_created`, applied inside the freeze) and it did
what it should: the report's core scan went from **46 seconds to 489ms**, and
the whole function runs in **684ms** when called as `postgres`. Called as
`authenticated` - same session, same data, same warm cache - the same function
takes **9.7 and 17.3 seconds**, and through PostgREST it still times out at
8.2s, so the page still says "Could Not Load The Bomb Pot Report".

Ruled out by measurement, not by reasoning: it is not the missing index (added,
and the scan is fast); not RLS inside the function (`SET row_security TO 'off'`
on the function changed nothing); not a second overload (there is one); not the
`safeupdate` preload (absent in the psql test that was still slow). What is
left is something role-dependent about how this function is planned or
executed, and the honest position is that I do not yet know what. It needs a
plan captured from inside the function as the real caller (`auto_explain`, or
an `EXPLAIN` executed inside the body), not another guess.

**DONE, 2026-09-05** - `20260905051000_the_bomb_pot_report_remembers_and_stops_reading_the_hands.sql`.
**The paragraph above is wrong and the way it is wrong is worth keeping.** It
was never role-dependent: the 684ms baseline was the function REFUSING. Its
first statement raises `not_authenticated` when `auth.uid()` is NULL, and a
psql session as `postgres` carries no `request.jwt.claims` - so that figure was
the timing of an error, not of a report. Holding the role constant and changing
only the claims: no claims, `ERROR not_authenticated` in 88ms; the owner's
claims, 50 rows in **31,715ms**; the same call again, **384ms**. It is a cold
cache. Across sessions the same call has measured 0.4s, 1.8s, 3.5s, 5.1s and
31.7s depending only on what was resident, and the 8s PostgREST timeout meant
the read that would have warmed it could never finish.

A second defect turned up while measuring: the report reads `hand_history`, and
`sp_prune_hand_history` removes horse-only hands after seven days, so **asking
for 365 days returned seven** - silently, as a number rather than a gap.

Both are fixed by one rollup, `ca_club_bomb_pot_daily` plus a
`ca_club_bomb_pot_complete` marker, grouped exactly as the report already
grouped, storing sums rather than averages, sealed fifteen minutes after a day
ends (an award unit can land late and a sealed day is never recomputed), and
caught up lazily from inside the report - no trigger on `hand_history`, no new
scheduler. Proved equivalent before applying: the report's fifty rows captured
before and after inside one rolled-back transaction, `EXCEPT` both ways, zero
rows. Measured through PostgREST as the owner after: **200 in 1.2-1.9s** where
it was 500 after 8.2s, and 365 days now costs what 30 days costs.

THE LESSON THAT GENERALISES: a probe run as `postgres` against a
`SECURITY DEFINER` function that gates on `auth.uid()` is not a faster version
of the real call, it is a DIFFERENT call - usually a refusal. Set
`request.jwt.claims` and hold the role constant before concluding anything is
role-dependent.

**(b) The rake-by-agent breakdown cannot be read at this club's volume, and
the page retried it into the ground.** Opening `/clubs/<slug>/data` in a browser:

```
ca_club_data_snapshot   200 in  300-1,000ms
ca_rake_snapshot        500 in  ~8,200ms   (57014 statement timeout)  x7 in 14s
```

The tiles sit on dashes and "Reading Rollups" for ever. Inside
`ca_rake_snapshot`, `fn_ca_rake_window` is 0.6s and `fn_ca_rake_series` 0.13s;
**`fn_ca_rake_by_agent` is 29.7 seconds**. Its `from_live` CTE recomputes
per-player rake for every day not yet in `club_rake_rollup_complete` - which is
always today - by calling `fn_rake_shares_for_record` once per raked hand:
61,156 hands today, each doing an indexed lookup into `rake_attributions` plus
a NOT EXISTS. Expanding the same rows set-based instead of per-hand still costs
11.5 seconds, so this is not a query to tune: **the per-player live edge has to
stop being recomputed on every page load**, exactly as the club-level figure
did in phase 6 (`ca_club_rake_daily`).

The shape that fits: `rake_attributions` already carries the per-player credit
the engine wrote at hand time, and `club_rake_daily_user` (the completed-day
rollup) is built from it - so one grouped read of `rake_attributions` over the
incomplete days, behind an index on `(club_id, created_at)`, replaces 61,156
lookups with one range scan AND makes the live edge agree with the rolled-up
days by construction. It belongs here rather than in phase 6 because it is the
agent breakdown, and because it needs an index build on a hot table inside a
maintenance freeze.

The retry storm itself is already fixed (`RakeSnapshotPanel` no longer lets the
money-event firehose re-issue a read that is failing), so the page now fails
once a minute instead of seven times in fourteen seconds - but it still fails.

**DONE, 2026-09-05** - `20260905042100_the_agent_breakdown_reads_the_attributions.sql`.
`from_live` is one grouped read of `rake_attributions` for the days not yet
complete. Measured through PostgREST as the club owner, with the function
changed and the index NOT yet built: `ca_rake_snapshot` 200 in 2,128ms and
2,577ms for the page's default month range, 2,554ms and 2,362ms for the year -
where it was 500 after 8,200ms. The panel renders 5 daily series points, 34
agent rows, 351,310.13 of direct rake and 183,266.92 of commission.

The index is a second migration, `20260905042500_and_an_index_for_the_range_it_reads.sql`,
QUEUED FOR THE NEXT `:55` FREEZE and not yet applied. It is the only statement
of the two that takes a lock (1,131,048 rows / 456 MB, written on every raked
hand), and the function change needed none - holding the fix back until the
freeze would have left the panel failing for no reason. With the index, the
remaining serial scan in `from_live` (573,468 heap rows to keep 14,091, 2.8s of
what is left) becomes an index-only read of the same range.

The first apply FAILED and the reason is worth carrying forward: the migration
asserted the new body no longer names `fn_rake_shares_for_record`, and the new
body names it in the comment explaining what it replaced. It strips `--` lines
from `prosrc` before the check now. Third occurrence of that class in this
programme.

It also shipped behind the WRONG GRANT for twelve minutes:
`20260905042100` granted `fn_ca_rake_by_agent` to `authenticated`, and that
helper is ungated - its gate is `ca_rake_snapshot`, one level up, which is why
all four of its siblings are `service_role` only. Any signed-in user could have
read any club's per-agent rake and commission totals in that window. Caught by
`the-rake-snapshot-denominator-is-not-double-counted.law.test.ts` in the
full-suite run before the commit, closed against production at once, and
re-issued correctly in `20260905043000`. Verified after: 403/42501 calling the
helper directly as a signed-in user, 200 through `ca_rake_snapshot`.

One thing measured on the way and deliberately left: `agent_commissions` has no
`(club_id, created_at)` index either, and its CTE bitmap-scans 694,941 rows for
a seven-day window at 1.14s. That is a second index on a second hot table; it
belongs in a freeze of its own, after the first one has been observed landing.

The write paths are the best-defended code in the workspace and this phase must
not "improve" them: `fn_agent_wallet_send` and its claim-back take a mandatory
`p_op_id`, take an advisory lock, replay on the op id, and refuse a retry key
that belongs to a different intent; `fn_cashier_batch_transfer` validates the
whole envelope before the first item moves and wraps each item in its own
subtransaction. What is wrong is the reporting around them.

- **CONFIRMED - `fn_respond_chip_request` (approve) is not retry-safe**: it
  calls `fn_agent_wallet_send` with a fresh `gen_random_uuid()`, so a lost
  response leaves the chips moved and the request approved while the operator's
  retry is told the request was already approved and the UI reports failure.
  Money moved; operator told it did not.
- **CONFIRMED - the settlement freeze is advisory and half-applied.**
  `checkSettlementLock` fails open by design and is called only from the classic
  cashier; the Trade cashier never checks it and no send/claim RPC reads
  `clubs.settlement_locked`. Chips move freely during a declared freeze.
- **CONFIRMED - the settlement page writes with the raw route param.** The
  auto-settlement toggle does `.eq('id', clubId)` with a club code, and its
  matching read is in a swallowing try/catch, so a club with auto-settlement ON
  renders "Auto: OFF". The UPDATE has no `.select()`, so an RLS-denied write
  affects zero rows, returns no error, and toasts "Auto-settlement enabled".
- **CONFIRMED - the period on the settlement page is not this club's.**
  `get_current_settlement_period()` takes no club argument and returns the
  newest platform-wide open row; `SettlementService` then hardcodes
  `periodNumber: 1` and zeroes BBJ, hands and players. The header permanently
  reads "Period 1/2026" over a grid of zeros.
- **CONFIRMED - the receipt hardcodes `status="paid"`** for any period marked
  settled, without reading any invoice's payment state. The page can and does
  show a period as paid when the ledger has not said so.
- **ALREADY FIXED, verified 2026-09-05 - "Execute Settlement" calls a
  documented no-op.** The button now says so plainly ("Nothing To Pay Out
  Here. Agent Commissions Settle Through Credit Invoices, And Player Rakeback
  Through The Engine Settler"), and the success branch is kept as a tripwire
  for the day a real implementation returns numbers. Left as it is.
- **CONFIRMED - `disputed` is missing from the page's own period type**, so a
  disputed period renders an unstyled badge with no countdown, no action and
  nothing saying why.
- **CONFIRMED - the two cashiers disagree about what a chip is**:
  `parseChipAmount` in the classic page rejects any fraction, citing an integer
  column, while `club_members.chip_balance` is `numeric(20,2)` and the Trade
  page sends 2dp happily.
- **CONFIRMED - the classic cashier reports every outcome through
  `setMessage` in sentence case** rather than the Toast layer, and its
  high-value confirmation says "This Action Cannot Be Undone" on a send the
  same page advertises as claimable back for ten minutes.
- **MEASURED AND LEFT ALONE - `fn_club_cashier_members_page_v3` re-runs the
  full recursive downline walk on every page** (it selects from v2, which
  selects from v1). The nesting is real, and the cost is not: 241ms cold and
  121ms warm for page one of 417 members on the busiest club. Rewriting a
  working money-adjacent read to save 100ms is not worth the risk it carries;
  if a club ever reaches a size where this bites, the fix is to page inside v1
  rather than to wrap it a third time.

---

## 10. Phase 8 - Club control

- **CONFIRMED - three settings are consumed by nothing.**
  `clubs.bbj_rake_enabled` has a visible ON/OFF switch and no reader anywhere in
  `src/` or `server/` (the BBJ engine reads the separate `bbj_enabled`).
  `spins_preseed_amount` and `spins_wallet_funding` have **no control at all**
  and are still blind-rewritten on every save, and nothing reads either.
  `spins_enabled` is read by the lobby but likewise has no control here, so a
  save rewrites whatever was loaded. `tests/settings-only-write-what-they-offer.test.ts`
  already codifies this law for `SettingsPage` and does not cover this page.
- **CONFIRMED - the rules save reports success when RLS refused it.** The
  `clubs` UPDATE policy is `owner_id = auth.uid()`; the page grants the button
  to any staff role and the UPDATE has no `.select()`, so a co-owner or admin
  sees "Club rules updated!" and the new text painted, and nothing was written.
- **CONFIRMED - the rules save is a lost-update read-modify-write of the whole
  `clubs.settings` jsonb**, which also carries rake cap, min buy-in, straddle
  and time bank defaults.
- **CONFIRMED - rules are write-and-display-on-one-page.** No lobby surface, no
  join flow, no table and no acknowledgement gate reads `settings->>'rules_text'`,
  and the audit trigger's watched set does not include `settings`, `tagline` or
  `lobby_message` - so a rules rewrite leaves zero trace.
- **CONFIRMED - vault grants deliver nothing to the recipient.**
  `ca_promo_vault_grant` decrements `promo_vault_inventory` and inserts a
  `promo_vault_records` row; there is no player-side entitlement table in the
  schema and no trigger on the records table. The owner spends diamonds, the
  shelf decrements, the player receives nothing, and the toast says it was sent.
  There is also no revoke path, though the UI has a label for one.
- **CONFIRMED - `ca_promo_vault_buy` has no idempotency key and its own body
  records the unjournaled-diamond-debit incident**; a retry after a timed-out
  but committed call debits twice with nothing to reconcile against.
- **CONFIRMED - the Claim button on the offer feed pays nothing.**
  `claimPromotion` inserts a `promotion_claims` row and increments a counter;
  nothing reads `bonus_amount` to credit a wallet, yet the page emits
  `BALANCE_UPDATED` and says "Promotion claimed!". `bonus_amount` is also
  client-supplied under a policy that only checks `user_id`.
- **CONFIRMED - there is no operator surface to create, edit, schedule or
  unpublish a promotion at all**: `promotions` writes are service-role only.
- **CONFIRMED - announcements have no expiry, targeting, scheduling, edit path
  or read receipts**, although `club_announcements` already carries
  `expires_at`, `priority`, `type` and `is_active` and the composer writes none
  of them and the list filters on none of them.
- **CONFIRMED - `WATCHED_COLUMNS` for the settings realtime refresh lists five
  columns the page no longer renders and omits `tagline`, `lobby_message`,
  `bbj_rake_enabled` and all three `spins_*`.**
- **CONFIRMED - `inUnion` is dead state** (`setInUnion` is never called), so a
  club inside a union is still shown club-level rake controls its union governs.
- Deletion and ownership transfer are the best-defended paths in the group;
  the only gap is TOCTOU between the impact read and the DELETE.

---

## 11. The standard every phase is held to

1. Read the page end to end before changing it; read the SQL body of every RPC
   it calls.
2. Prove the defect against production with a query, or say plainly that it is
   reasoned rather than reproduced.
3. Fix forward. Never delete the other side of a contradiction on your own
   authority (CLAUDE.md 10.8).
4. A number a page prints must be the number the SQL computes, under the label
   the operator reads.
5. Horses count everywhere (CLAUDE.md 10.5). A filter that removes them from a
   total is a bug, not a preference.
6. Every mutation reports honestly: a write that matched zero rows is a failure,
   never a `toast.success`.
7. `bash scripts/ci/all-gates.sh` green before the push, plus the DB gates
   (`check-migrations-applied`, `check-definer-authorization`,
   `check-phantom-*`).
8. One changelog per phase under `docs/changelog/`, and this file updated with
   what actually shipped.
