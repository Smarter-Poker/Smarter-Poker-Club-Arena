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
