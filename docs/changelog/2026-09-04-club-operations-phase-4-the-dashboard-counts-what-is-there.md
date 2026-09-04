# Club Operations Phase 4: the dashboard counts what is there

Phase 4 of 8 of Dan's Club Operations upgrade
(`docs/club-operations/OPERATIONS-UPGRADE-PLAN.md`). The page is
`/clubs/:id/dashboard-full`. Every defect below was confirmed in the phase 4
audit on 2026-09-03 and re-measured against Deep Stack Society (2a1132b9) on
2026-09-04 before a line changed. Every write path was probed as the real
owner, then as a plain member, then anonymously, inside a transaction that was
rolled back, before the migration was applied.

## What was wrong, with the numbers

**The Tables tab hid the floor.** It fetched the 50 newest tables by
`created_at` and computed "N Live, M Seated" over those 50. The club had 4,954
tables and 319 live. On 2026-09-03 zero of the then-226 live tables were in the
newest 50; on 2026-09-04 all 50 of the newest happened to be live, so the tab
showed 50 of 319 under a header that said 319. The header and the rows were
never computed over the same set. `tables.current_players`, which the rows
printed, disagreed with the seat rows on 28 of the 319 live tables (449
against 477).

**"Seated Now" counted seat rows and called them people.** 479 seat rows for
243 people. Phase 1's overview already counted people, which is why this page
and `/operations` never agreed at the same instant.

**The leaderboard sorted a pre-truncated set.** `ca_club_top_players` ordered
by profit and took 100; the page re-sorted those 100 by Hands or Win Rate.
Over this week's 678 players, the ten shown under "Hands" shared zero members
with the true top ten by hands; "Win Rate" shared three.

**`ca_club_tournaments` ignored `p_limit`.** The `LIMIT` sat after
`jsonb_agg`, a single row. Asked for 25 it returned 3,534 finished tournaments
in 879,696 bytes. Its 30-day window was hardcoded beneath a Time Range filter
that did nothing to it.

**Revenue was readable by every member.** `ca_club_revenue` gated on
`ca_can_view_club`, which any non-banned member satisfies. Every other finance
read on the estate uses `ca_can_view_club_finances`.

**The metric cards were read twice per mount.** `ClubStatsCards` treated the
parent's not-yet-loaded `null` as "no parent", fetched for itself, and was then
overwritten. And each `ca_club_dashboard_stats` call cost 132,855 buffers and
~910 ms, because `club_daily_stats` is not a table: it is a view that
re-aggregates every `rake_records` row the club has ever written (163,585) and
sequentially scans `rake_history` (1.37M rows), and the function referenced it
five times as a fallback for dates the rollup has covered since 2026-07-22.

**The insurance gate never fired.** `ca_club_revenue` always returns an
insurance object, so `revenue.insurance ?` was always true and a club that has
never sold a policy got two zero cards and a report link.

**The Time Range filter was half wired.** Six metric cards it does not drive
sat under it; the Revenue heading said "all time" for a 90-day cap.

**The member panel could destroy a wallet.** `ClubMemberManagement`'s remove
button hard-DELETEd the `club_members` row, and that row is the member's club
wallet (`chip_balance`, `held_chips`, `locked_chips`, `promo_balance`,
`credit_used`); the phase 3 probe's first pick held 10,067.64. No confirmation,
no row-count check after the ban write (the 204-no-rows-no-error pattern from
phases 2 and 3), a failed read rendered as an empty roster, the avatar URL was
printed as text, and rows were staggered by an index into the unfiltered array
so a search left survivors at `opacity: 0`.

**The "Humans Only" toggle and CLAUDE.md 10.5.** The phase 4 audit called this
a violation. `scripts/ci/check-horses-are-players.mjs` on `origin/main`
disagrees: its register sanctions an operator viewing filter on the club data
page and on this leaderboard, on two written conditions: it defaults to
showing horses, and every figure it scopes relabels itself so a filtered
number can never be read as the club's. Two rulings in the repo, and 10.8 says
neither side is deleted on an agent's authority. This phase makes the
dashboard satisfy the register's conditions, which is also what closes the
audit's specific complaints: the tick was persisted in localStorage (so the
horse-less board became that operator's default without the box on screen),
it was offered to viewers for whom the server masks the flag (a control wired
to nothing), and the CSV and the "See All N" count did not say they were
filtered. Dan can reverse the toggle itself; it is one `useState` now.

## What changed

Migration `20260904100000_the_dashboard_counts_what_is_there.sql`, one
transaction, applied and recorded:

- **`ca_club_tables(p_club_id, p_limit)`**, new. Every live table (union scope
  applied, fullest first, seats counted from `table_seats`, capped at 500 with
  `live_truncated` saying so) plus the 25 most recently closed, with
  `live_count`, `total_count`, `seated_people` and `seat_rows` for the whole
  floor. Membership-gated, revoked from anon. 319 rows in 124 KB, 138 ms.
- **`ca_club_dashboard_stats`**: `seated_now` is `count(DISTINCT user_id)`;
  the 14-day window is read once from `club_hand_daily` into a CTE and the
  `club_daily_stats` fallback is gone. 132,855 buffers and ~910 ms became
  12,495 buffers and 31 ms.
- **`ca_club_top_players`** gains `p_sort` (profit | hands | winrate |
  biggest, defaulting to profit) and orders by it before the limit. Old
  signature dropped so PostgREST sees one candidate; the three-argument named
  call still resolves.
- **`ca_club_tournaments`** gains `p_days` (1..365, default 30); the limit
  applies inside each subquery; the summary carries `window_days`,
  `completed_in_window`, `prize_pool_in_window` and, for one release, the old
  `completed_30d` / `prize_pool_30d` keys (exact for the bundle that still
  reads them, since it never passes `p_days`). 25 rows in 6,460 bytes.
- **`ca_club_revenue`** gates on `ca_can_view_club_finances`. A plain member
  is refused with 42501 (probed).

Client:

- `ClubDashboard` reads the floor through `ca_club_tables`; the Tables tab is
  "Live Now (N)" and "Recently Closed (25)" with the header from the
  floor-wide figures, and says "Showing The Fullest 500" when capped. The sort
  goes to the server and re-reads on change. The Revenue tab is on the strip
  for finance roles only (the club's `owner_id` outranks the membership row,
  as it does in `fn_club_bank_role`), and a refusal is named rather than shown
  as "No Revenue Data Available". Insurance cards appear when
  `contracts > 0`. Tournaments read the range and print the window they got.
  The filter bar says what it reaches. The Revenue heading says "Last 90
  Days" when the range is All.
- The horse toggle is `useState(false)`, offered only when a row carries the
  flag, labelled "Hide Horses", and relabels the CSV filename, the "See All"
  count and the attribution caption while on. The old localStorage key is
  tombstoned.
- `ClubStatsCards` self-loads only when `stats === undefined`.
- `ClubMemberManagement`: a failed read is an error state with a retry; the
  remove control refuses while the member holds any chips or sits at a table,
  confirms otherwise, and checks the deleted row count; the ban write checks
  its row count; the avatar is an image; rows stagger by id.

## Verified

- `tsc`, lint (0 errors), 50 new unit pins and 16 new component cases
  (`tests/unit/theDashboardCountsWhatIsThere.test.ts`,
  `tests/components/club-dashboard.test.tsx`), the existing dashboard and
  horse-naming laws, all green.
- Live, rolled back, as the owner: seated 242 people (477 seat rows), 319
  live tables listed with the true count, top-3 by hands descending
  (11,388 / 10,984 / 10,832), 25 tournament rows for a request of 25,
  revenue readable. As a plain member: revenue refused 42501, tables
  readable, no horse flag visible. Anonymous: `ca_club_tables` refused,
  permission denied.
- All 16 DB/CI gates green.

## Still open after this phase

- The old `completed_30d` / `prize_pool_30d` keys and the payables estimate
  from phase 3 both come down in the first commit after this publishes.
- "Win Rate" ordering will rank a 6-hand sample above a 40-hand one; the row
  prints its sample size beside it. A floor is a product call.
- `ClubMemberManagement` still loads the whole roster unpaged; it is a second
  copy of the Players page and phase 5 decides its future.
- No page in phases 1-4 has been opened in a browser yet (handoff D-05).

## Verification walk (2026-09-04, after Dan's per-phase gate)

Every Phase 1-3 page was opened in a browser on production, signed in as the
owner, at 404 px: `/operations`, `/finance`, `/control`, `/anti-cheat`,
`/reports`, `/disputes`, `/blacklist`, `/agents` (every tab). No horizontal
scroll on any page; no failed request but one, below.

**Found: the Payouts tab could not be read, then took 8,870 ms.**
`fn_ca_agent_payables` (phase 3) summed every unsettled `agent_commissions`
row on each open. The set had doubled in a day (259,135 to 499,933): the
estate writes 622,976 commission rows a day and nothing has ever settled
one. Fixed by migration
`20260904170000_what_the_club_owes_is_kept_not_recounted`: a
trigger-maintained `agent_commission_unsettled_rollup` (statement-level,
transition tables), backfilled and asserted equal to the ledger inside the
transaction, with `fn_ca_agent_payables` reading it. Probed rolled back:
insert, settle, unsettle, delete and a notes-only update each moved the
rollup exactly as the ledger moved. Live after apply: rollup equals ledger
(970,282.21 across 239 pairs), triggers firing on real inserts, and the same
tab answered in 107 ms.

Also found in the re-read of phase 4's own diff: a failed stats read held
the metric-card skeleton forever; a failed tables read held "Loading
Tables..."; native `window.confirm`; "Holds N Chips" when N included credit;
"All 100 Players" under a 678-player club; a 25-second row stagger. All
fixed in the same push.

**Published dashboard walked at 396 px and 1280 px** after PR #2953 shipped
(`638a22521`): Tables "302 Live, 219 People Seated (430 Seats)" over a
5,138-table club with "Live Now (302)" listed; Revenue with no insurance card
for a club with no contracts; Tournaments "3,819 Finished In Last 7D" and
"Newest 25 Of 3,819"; Hide Horses offered to the owner; the Revenue tab on
the strip. One failed request, and it was real: `club_chat?club_id=eq.
deep-stack-society-11192` answered 400. `ClubChat` was mounted with the
route slug and uses it to read, subscribe and insert against a uuid column,
so club chat on this page could neither load nor send. It is mounted with
`resolvedClubId` now. The remaining 401 on `HEAD /rest/v1/` is the
connection watchdog's own probe, which documents that answer as expected.
