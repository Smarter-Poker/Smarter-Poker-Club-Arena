# 2026-08-19 — Club Dashboard: line-by-line audit, correctness + security

Follow-up to `2026-08-19-club-dashboard-rebuild.md`. That pass made the page
show data; this pass proved the data was WRONG and fixed it.

## 1. The profit numbers were fabricated (critical)

The first pass computed a player's profit as
`sum(winners[].amount) - sum(actions[].amount)`. Measured against production:

- blinds/antes are never in `actions[]` — hand 1231033: pot 20.00,
  `sum(actions[].amount)` = 0.00 (folded round);
- `actions[].amount` is a cumulative "raise TO" figure, not incremental chips —
  hand 1230924: pot 2658, `sum(actions[].amount)` 6141 (2.3x the pot);
- neither `sum(amount)` nor `max(amount)`-per-street reconciles to `pot_size`.

Every leaderboard figure shipped in the first pass was therefore wrong.

### Ground truth

`hand_history.players[].stack` is written from `postHandTasks` in
`ServerTableEngineSettlement.ts` — it is the POST-hand stack. So for a player
at a table, per-hand result = `stack(N) - stack(N-1)`. Verified by chip
conservation on production: for sampled hands, the seated players' deltas sum
to exactly `-(rake_amount + bbj_amount)`, residual 0.00.

### Three corruptions, three gates

1. **Session breaks** — if a hand ran at the table without the player they may
   have left and rebought (500 out, 100 back in reads as a 400 loss).
   Gate: strict adjacency. This error alone put the club residual at
   -14,411.68 when it must be 0.00.
2. **Between-hand top-ups** — Gate A (per player): `delta <= won`, since you
   cannot finish a hand up more than you won. Precise (1 false positive in
   8,189 hands) but 60% recall. Gate B (per hand): a fully-covered hand is a
   closed system, so deltas must sum to `-(rake+bbj)` — 100% recall but only
   evaluable when every seat is adjacent. Both applied, each where valid.
3. **Malformed rows** — non-uuid userId / missing stack skipped.

Failing a gate costs profit attribution, not the hand: `hands_played` still
counts, injected chips land in `topup_total`, and `hands_attributed` records
the honest denominator. Nothing is invented.

**Verification (table 68c94447, 13.7k hands / 48k player-hands):**
`fully_attributed_hands` 7958, `non_reconciling` **0**,
sum(deltas) -1111.27 == -(sum rake+bbj) -1111.27, exact.
Club-wide attribution coverage 83.0%.

## 2. Any logged-in user could read any club's numbers (security)

The RPCs were SECURITY DEFINER, granted to `authenticated`, and took a club_id
with no authorization check — member counts, rake, and the full per-player
profit leaderboard of any club were readable by any account. Added
`ca_can_view_club()` (club member, or platform admin, or service_role) and
enforced it in all four RPCs. Verified: outsider is BLOCKED on all three
original RPCs, a genuine member is allowed.

## 3. Rebuild driver never touched live tables

`ca_rebuild_club_member_stats` decided "already rebuilt" by checking whether
the table had any stats rows. The live trigger creates rows for an active
table within seconds, so every actively-dealing table was permanently skipped
— table 68c94447 had 48 rows recorded against 47,944 real player-hands.
Rebuild state moved to `club_stats_rebuild_log`.

## 4. Frontend bugs found and fixed

- **Time Range silently ignored.** `if (loadingRef.current) return` dropped the
  request, so changing range mid-load left the filter highlighted and the data
  on the old range. Now sets a rerun flag and re-fires; a monotonic request id
  stops a slow older response overwriting a newer one.
- **Activity filter blanked the feed.** Stagger visibility was keyed by index
  into the UNFILTERED array while the FILTERED array was rendered, so choosing
  a filter left rows at opacity 0. Now keyed by activity id.
- **Non-uuid club code → opaque 22P02.** `resolveClubUUID` returns its input
  when it cannot resolve; that was passed straight into uuid-typed RPCs. All
  three components now guard with `isUUID`.
- **No non-member state.** With authorization enforced, a non-member got a
  generic "Failed to load". Now a distinct Members Only view.
- **Players tab was not a members list.** Headed "Club Members (327)" but
  rendered the leaderboard, so members who had not played were invisible and
  there was no search. New `ca_club_members` RPC: paged, searchable roster
  with role/status/balance joined to range performance.

## 5. Enhancements

Leaderboard sort (profit/hands/win rate/biggest pot), humans-only toggle via
`is_horse`, CSV export, per-player win rate and hands, rank badges, 14-day
hands/rake sparklines on the metric cards, week totals and seated-now, and an
explicit caption stating how profit is measured.

## 6. Tests

`tests/unit/clubDashboard.test.ts` — 21 tests over the extracted pure helpers
(range maths incl. UTC-midnight boundary, rank-after-filter contiguity,
truncation never rounding a loss into a win, no "-0.00", CSV quote escaping,
authz-error detection, live-table status). Full suite: 1976 passed.
`TournamentRecurringService.test.ts` fails to load on a missing `@sentry/node`
server dep — pre-existing, unrelated to this work.

## 7. Addendum — hand_number is not a per-table total order

While building a resumable backfill for the largest legacy tables it turned
out `hand_history.hand_number` is unique only above 1,000,000 (partial index
`uq_hand_history_global_hand_number`). Legacy tables carry both the old
per-table 1..N numbering and the newer global numbering: table `d421a6df` has
75,211 rows spanning hand_number 1..1,223,543 with 62,906 distinct values.

- The verified rebuild path is unaffected — it orders by
  `row_number() OVER (ORDER BY hand_number, created_at)` and tests adjacency
  on that row ordinal, never on hand_number itself. Re-verified after every
  change: 8,052 fully-attributed hands, **0 non-reconciling**,
  sum(deltas) -1138.13 == -(rake+bbj) -1138.13.
- The chunked function keyed on hand_number and was therefore wrong; it was
  dropped and its partial rows reverted rather than left in production.
- The live trigger is unaffected for all new hands: hand_number is global and
  increasing above 1,000,000, which is every hand being dealt now.

**Known limitation.** Tables above roughly 20k hands cannot be rebuilt in a
single statement within the admin connector's time ceiling; they are logged
with `rows_written = -1` and skipped. This is historical backfill only, on the
two largest horse clubs. All new hands, on every club, are attributed by the
trigger as they land. Midway Union — the club this work was raised against —
is fully rebuilt and verified.

## 8. Production verification

- Club Arena `main`: 48ba2e2f7, 5477f1c71 (both confirmed ancestors of main).
- World Hub sync commits: 93e8bfa6d0, ff798c13ad.
- Production `/api/health` served SHA `ff798c13`.
- Deployed `ClubDashboard-D1IWPXSI-v6.js` contains `ca_club_members`,
  `hands_attributed`, `Members Only`, `Humans only`, `Export CSV`.
- Authorization re-probed post-deploy: outsider BLOCKED on ca_club_top_players
  and ca_club_members; member gets rows from top_players, members and activity.
- Suite: 1976 passing, 22 of them new (`tests/unit/clubDashboard.test.ts`).
  `TournamentRecurringService.test.ts` fails to load on a missing
  `@sentry/node` server dep — pre-existing, unrelated.

## 9. Second audit pass — findings and upgrades

Publish state re-verified first: all five source files byte-identical to
origin/main, all seven dashboard migrations present, production bundle
carrying every feature. A second agent's `20260819g_leaderboard_real_profit_pipeline`
landed in parallel — checked, it creates its own trigger and functions and
touches none of these objects. hand_history now carries three AFTER INSERT
row triggers; the adjacency probe added here is an index-only scan costing
0.086ms / 3 buffers, so it is not a factor on the hot path.

### Bugs found and fixed

- **Leaderboard stagger keyed by list index.** Visibility was a Set of indices
  into the RAW players array while the rendered list is sorted and optionally
  horse-filtered — the identical bug already fixed in the activity feed. Now
  keyed by userId, and only the ten rendered rows are staggered instead of
  scheduling 100 timers for a 100-row payload.
- **Attribution caption ignored the filter.** With "Humans only" on, the
  "measured on N of M player-hands" line still counted the horses the user had
  just filtered out. Now derived from the ranked set actually on screen.
- **Stale "Members Only" across clubs.** `notAMember` persisted from a
  previously viewed club until the next load resolved, so navigating from a
  club you are not in to one you are briefly showed the refusal screen. Reset
  at the start of every load.
- **Silently swallowed read errors.** A failed `clubs` read rendered "Club Not
  Found" for a club that exists, and a failed `tables` read rendered an empty
  Tables tab — both indistinguishable from genuine emptiness. All three reads
  (club, tables, role) now report, and a failed club read surfaces the retry
  state instead of a false negative.
- **Member search had no out-of-order guard.** Typing fires overlapping
  requests; a slower earlier response could land last and show results for a
  query already moved past. Added a monotonic request id.
- **Redundant fetch on filter change.** The page-reset effect set page 0
  unconditionally, queueing a second request when already on page 1.

### Upgrades

- **Server-side member sorting and role filter** (`ca_club_members` v2). The
  roster is paged, so ordering had to move into SQL — sorting the 25 rows the
  client holds would present one page as the ranking of 327 members. Sort by
  hands / profit / name / joined / last active, filter by role, with a stable
  (joined_at, user_id) tiebreak so paging cannot repeat or drop rows.
- **Live presence** — `is_online` from live seats or 15-minute activity, using
  the same definition as the Online Now card so the two cannot disagree.
- **Player drill-down** — leaderboard rows and member rows link to
  `/profile/:userId`.
- **Freshness** — background refreshes are silent by design, so the page now
  states how old its numbers are and offers an explicit Refresh.
- **Accessibility** — real `tablist`/`tab`/`tabpanel` semantics with
  `aria-selected`, roving tabindex and arrow-key navigation; `aria-live` on the
  refresh status; labels on every control.
- **Members CSV export**, labelled by page so it is never mistaken for the
  whole roster.
- **"See all N ranked players"** when the leaderboard is truncated at ten.

### Verification

tsc clean; 25 dashboard unit tests (3 new for `formatAgo`, including the
clock-skew case); full suite 1980 assertions passing across 162 files, the one
failing file being the pre-existing `@sentry/node` server dep. Production build
green.

## 10. Conservation-first attribution (coverage upgrade)

Strict adjacency turned out to be too strict. It was only ever a PROXY for
"were chips injected between these two observations?". The real guarantee is
per-hand chip conservation: if every seat has a prior stack and the deltas sum
to -(rake + bbj), nothing entered or left the table during ANY of those gaps,
so every delta in that hand is exact regardless of how many hands a player sat
out. Adjacency was discarding provably-good data on exactly the tables where
players rotate seats — which is what the horse clubs do all day.

Measured on table 68c94447 (13,898 hands):

| set                             | hands  |
| ------------------------------- | ------ |
| fully adjacent                  | 8,361  |
| every seat has a prior stack    | 13,634 |
| ...of those, conserving exactly | 10,887 |

New rule: if every seat has a prior stack, conservation decides (all or
nothing); otherwise fall back to per-player adjacency AND delta <= won. The
delta <= won check is applied only on the unvalidated fallback path — where
conservation holds the deltas are proven, and applying it there would discard
split/side-pot rows whose winners[] entry under-reports.

Result on that table: fully-attributed hands 8,052 -> 10,894 (+35%),
non_reconciling still **0**, sum(deltas) -1415.71 == -(rake+bbj) -1415.71,
stored hands_attributed 41,384 == independent recompute 41,384. Coverage
69% -> 83.7%. Midway Union club coverage 89.1% -> **93.4%**.

Backfill state at time of writing: Midway Union fully rebuilt under the new
rule. Club JAQK and SHARK CLUB are being refreshed table by table (SHARK CLUB
39.9% -> 41.4% after 9 of 38); every NEW hand on every club already uses the
new rule via the trigger.

## 11. Third audit pass

Publish state re-verified: five source files byte-identical to origin/main,
nine dashboard migrations published, production bundle carrying every feature.

### Hands Today was under-reporting by 64%

The two most prominent metric cards read `club_daily_stats`, which lags.
Midway Union showed **10,195 hands today against a real 28,195**. The existing
coalesce fallback could never catch it: club_daily_stats HAS a row for today,
it is simply stale.

Counting `hand_history` live is not viable — measured 2.75s and ~30k buffers
for one club-day, because it fans out across every table of the club, and this
runs on page load.

Fixed by maintaining the rollup where the data arrives: the same AFTER INSERT
trigger that already resolves the club now upserts one row per (club, day)
into `club_hand_daily`. Exact by construction, O(1) per hand. The upsert sits
ahead of the player CTEs so a hand with a malformed players[] payload still
counts — it still happened and still paid rake. `club_daily_stats` is left
untouched for other surfaces and remains the fallback for dates predating the
rollup, so historical series still render.

Verified: hands_today 28,836 against a live truth count of 28,856, the 20-hand
gap being hands dealt between the two queries; observed climbing to 29,111
shortly after as the trigger kept pace.

### The activity feed could wedge permanently

`loadingRef.current = false` and `setLoading(false)` sat AFTER the try/catch
rather than in a `finally`. The uuid guard I added earlier returns from inside
the try, so both were skipped: `loadingRef` stayed true forever, every later
call bailed at the in-flight mutex, and the feed sat on "Loading activity..."
for the rest of the session. Moved into a `finally`. ClubDashboard was checked
for the same shape and is safe — all six of its early returns are covered.

### Membership rejection was being reported as a fault

Both child components reported the 42501 membership rejection to the error
reporter, so a single non-member visit generated error noise from two
components while the parent was already rendering its Members Only state.
Both now treat it as the expected outcome it is.

### Verification

tsc clean; 25 dashboard tests; full suite 1980 assertions across 162 files
(the one failing file remains the pre-existing `@sentry/node` server dep);
production build green.

### club_daily_stats is systematically short platform-wide

Once the rollup existed it could be compared against the old source directly.
`club_daily_stats` is not merely late — it is short on every club, every day:

| club         | day        | real hands | club_daily_stats | missed |
| ------------ | ---------- | ---------: | ---------------: | -----: |
| SHARK CLUB   | 2026-08-19 |    120,240 |           43,490 |  63.8% |
| Club JAQK    | 2026-08-19 |    118,083 |           38,899 |  67.1% |
| Midway Union | 2026-08-19 |     29,455 |           10,718 |  63.6% |
| SHARK CLUB   | 2026-08-18 |    185,573 |           75,441 |  59.3% |
| Club JAQK    | 2026-08-17 |    123,458 |           50,314 |  59.2% |
| Midway Union | 2026-08-18 |      2,131 |              531 |  75.1% |

The dashboard was reporting roughly a third of real activity. It now reads
club_hand_daily and is exact. Worth flagging beyond this page: any other
surface still reading club_daily_stats carries the same understatement.

### Backfill guard

ca_backfill_club_hand_daily writes an ABSOLUTE count from a snapshot, so hands
dealt during its own run are discarded together with the trigger increments
that already recorded them — a run left Midway Union exactly 20 short, and a
re-run during a quieter moment came back exact (29,905 = 29,905). Past days are
immutable and safe to rewrite; today is owned by the trigger and exact from the
first hand, so overwriting it can only lose data. The current day is now
guarded behind an explicit p_force. Verified: today refused, past day allowed.

## 12. Fourth pass — members heading, tables ordering, backfill completion

### Members heading lied on an empty search

`memberTotal || club.memberCount` fell back to the full roster whenever the
count was 0 — and 0 is exactly what a search matching nothing returns. The
heading read "Club Members (327)" directly above "No members matching X". The
same expression also labelled a filtered count as though it were the club
total. The heading now distinguishes filtered from unfiltered, and a
`membersReady` flag separates "not loaded yet" from a genuine zero.

### Tables tab buried live tables

The query orders by `created_at` alone, so a running table sat beneath dead
ones — the opposite of what a club owner opens the tab for. Extracted
`sortClubTables` (live first, then fullest, then newest) with tests, and added
a live/seated summary to the tab heading.

### Backfill completed

- `club_hand_daily` now covers the full 14-day sparkline window for all three
  clubs (Midway Union has 4 days because the club only started dealing on
  2026-08-16; the earlier days genuinely have no hands).
- Attribution coverage after further rebuild batches:
  Club JAQK 55.1% -> **69.2%**, SHARK CLUB 39.9% -> **66.9%**,
  Midway Union 89.1% -> **94.3%**.

### Verification

tsc clean; 29 dashboard unit tests (4 new for table ordering); full suite 1984
assertions across 162 files, the single failing file still the pre-existing
`@sentry/node` server dep; production build green.
