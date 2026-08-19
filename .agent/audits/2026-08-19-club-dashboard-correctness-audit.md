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
