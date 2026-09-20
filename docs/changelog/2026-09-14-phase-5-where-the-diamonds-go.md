# Phase 5 of 8: where the diamonds go (2026-09-14)

**THE DIAMOND ARENA IS DIAMONDS ONLY. NO CHIPS, EVER.** (Dan, 2026-09-13.)

The wallet's Earn tab printed one Spent figure and one Earned figure. The
ledger knows what every diamond went on and where every diamond came from,
and with the Diamond Arena the intended sink, the player needs the split -
and so do we. This phase prints it.

## What shipped

### `fn_diamond_kind_bucket(type, transaction_type, source, amount)` - ONE place a ledger kind is named

`diamond_transactions` carries three kind columns. Read on 2026-09-14 across
every row: `type` is always set but is sometimes a wrapper (`spend`, `earn`,
`credit`); `transaction_type` is the specific kind and is null on older rows;
`source` is set by a few writers (`phase41_audit`, `handle_new_user`,
`feature_unlock`). Wherever two are set they agree. So the resolution is
`transaction_type` first, then `source` when `type` is a wrapper, then `type`.

The map is exact kinds first, patterns second, Other last, so no row vanishes
and a kind added tomorrow lands somewhere sensible until it is named. Spent
buckets: Diamond Arena Seats, Gifts To Friends, VIP Membership, Club Chip
Purchases, Games And Arcade, Store Items And Perks, Adjustments, Other.
Earned buckets: Diamond Arena Cash-Outs, Gifts From Friends, Diamonds You
Bought, Daily Rewards And Challenges, Tournament And PvP Winnings, VIP
Bonuses, Social And Community, Refunds, Adjustments, Other.

Measured against the whole production ledger after applying: every one of
the 41 kind-and-direction combinations lands in a named bucket; only `test`, `test_ref_id`,
`test_verify` and one bare `credit` of 20 land in Other. `IMMUTABLE PARALLEL
SAFE`, `sql`, no table reads - it is a pure map, and it lives in the database
so the Club Arena wallet and the World Hub wallet (phase 7) cannot bucket the
same row two ways.

### `fn_diamond_flow_by_kind(p_user_id default null)` - the ledger by bucket, in SQL

Sums a player's whole ledger by bucket, spent and earned, lifetime and the
last 30 days, and returns one jsonb: `spent[]`, `earned[]` (each line
`{bucket,label,lifetime,lifetime_count,last30,last30_count}`, largest
lifetime first), `spent_total`, `earned_total`, `spent_last30`,
`earned_last30`, `read_at`. `STABLE SECURITY DEFINER`, own-user only unless
`service_role` (`diamond_flow_is_own_only`, 42501), revoked from `anon`.
Probed as the player with the most ledger rows, in a rolled-back DO
block: 8.4 ms, and the bucketed totals equal `fn_diamond_lifetime_totals` for
the same player exactly (512,640 earned / 20,030 spent) - the split conserves
the headline. The own-only guard fires for another player's id.

Applied as `20260914111215 where_the_diamonds_go` (file
`20260914110559_where_the_diamonds_go.sql`), outside the :50-:03 window.

### `DiamondService.getDiamondFlow()` and `DiamondFlowPanel`

The service parses the RPC strictly (every figure numeric, every line named)
and returns `null` on any failure, never zeros (10.86). The panel is the
third phase-4-shaped component: three outcomes - reading, Unavailable with
Retry, known - plus an honest empty state ("No Diamond Movements Yet"). A
Lifetime / Last 30 Days toggle (`aria-pressed`) swaps every figure; a bucket
that carried nothing in the window is not listed rather than drawn as a zero
bar; a side with nothing in the window says so. Each line prints its label,
its diamonds, its entry count, and a bar sized as its share of its own side,
so the longest bar on each side is always the biggest sink or source. It
re-reads on `BALANCE_UPDATED` while open, like the summary and the arena
statement. It renders on the Earn tab under "Where Your Diamonds Go", after
Lifetime Diamonds and before More Ways To Earn.

The panel has no chip vocabulary at all: every figure is diamonds, the arena
lines are "Diamond Arena Seats" and "Diamond Arena Cash-Outs", and the one
chip bucket - diamonds spent buying chips in a member club - is named "Club
Chip Purchases" and can never receive an arena kind. The diamonds-only law
(`tests/the-diamond-arena-is-diamonds-only.law.test.ts`) now pins all of
that, in the migration's map and in the component source.

## Tests

- `tests/components/DiamondFlowPanel.test.tsx` (5): reading then both sides
  with a bar per bucket and the arena line at 80% of Spent; Last 30 Days
  swaps figures and hides empty buckets, aria-pressed follows; a side with
  nothing in the window says so; a failed read is Unavailable + Retry with
  no zeros and no bars; no read without a user.
- `tests/unit/whereTheDiamondsGo.test.ts` (9): RPC name and argument-free
  call, every line mapped, array-wrapped result, null on error, null on a
  missing bucket list / unnamed bucket / non-numeric total / empty payload;
  `linesFor` ordering and windowing; `shareOf` bounds; the Earn-tab wiring;
  the migration's guard, STABLE read-only shape, single transaction and
  anon revoke; the manifest fragment.
- The diamonds-only law gained a phase-5 case (arena buckets, no arena kind
  into club_chips, Title Case labels with no em dash, no chip word in the
  panel or its math).

## Gates run

`tsc --noEmit` clean; eslint and prettier clean on every touched file;
check-title-case, check-ui-text (no em dashes), check-no-emoji,
check-painted-text-case, check-nav-title-case, check-route-targets,
check-no-skip-markers, check-no-orphaned-work all OK; 18 suites / 579 tests
green including classNamesResolve, law-registry, wallet-casino-realism,
migrationVersionUniqueness, definer-authorization-gate,
security-definer-functions-do-not-trust-the-caller and the phase 1-4 suites.

## Not done here, on purpose

The World Hub modal's Stats pane still sums its breakdowns client-side over
the rows it fetched; phase 7 points it at `fn_diamond_flow_by_kind` so both
wallets read the one map. Nothing repairs or rewrites a ledger row: this
phase reads.
