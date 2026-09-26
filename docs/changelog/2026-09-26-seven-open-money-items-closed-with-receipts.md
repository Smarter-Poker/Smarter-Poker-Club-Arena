# Seven Open Money Items, Closed With Receipts

2026-09-26. Every decision below was made under CLAUDE.md 10.9, delegated by
Dan for these items on 2026-09-26. Each migration re-proves its facts against
production before it writes, was run first as a rolled-back probe
(`ca.money7_probe = on`), and was then applied once.

| # | Item | Outcome | Chips moved |
|---|------|---------|-------------|
| 1 | Mystery-bounty make-good (ruling 2026-09-11) | Paid, 7 obligations, 5 horse players | 76.90, DSS treasury to players |
| 2 | PKO 3f19bd70 structure shortfall 1,355.00 | Closed by disposition, not paid | 0 |
| 3 | Satellite seat into a PKO | No path exists since #4296; pinned by a PG17 probe | 0 |
| 4 | Ledger replay drift -234.10 | Detector defect, fixed; 4 alerts explained to the cent | 0 |
| 5 | Rakeback week of 2026-09-14 | Closed by disposition, not paid | 0 |
| 6 | 32 prize obligations paid twice | Real, 1,001.00, all horses; recovered | 1,001.00, players to union bank |
| 7 | Confirmed-noise alert classes | Re-proved and closed | 0 |

## 1. The Mystery-Bounty Make-Good

`20260926085132_the_house_pays_the_mystery_bounty_make_good_the_ruling_owed`

The ruling retired seven obligations owed-and-unfunded and said the make-good
is house-funded "through a separate audited door". The event door cannot be
that door: both escrows are terminally closed, a wallet row naming a completed
tournament is refused, and a bounty credit outside the settlement door is
refused by R3. The club bank doors need a signed-in owner (10.10 rule 2). So
the door is assembled from the platform's own parts, one credit per
obligation: an approved `ca_manual_adjustments` row carrying the paragraph,
`fn_ca_declare_ledger` naming the Deep Stack Society treasury with the clubs
trigger skipped (the `fn_club_bank_send` shape), the treasury debit, and
`fn_credit_and_log` under the key `ruling-make-good:<obligation id>`.

| Player | Obligations | Paid | Journal legs |
|--------|-------------|------|--------------|
| reedyarrow `fb7da841` | 2 | 27.50 | `152393ee` 19.00, `9002b227` 8.50 |
| thornemontrose `bc43a03f` | 1 | 26.00 | `a637fad4` |
| sageivorson `5e35105f` | 2 | 12.00 | `c3dc1550`, `c7b7e9c1` |
| oakesoakhurst `2b36fe05` | 1 | 6.00 | `c03f9ddf` |
| thorneziegler `86e42f5e` | 1 | 5.40 | `f21b789c` |

Treasury 964,496.98 to 964,420.08 (-76.90). Seven journal legs,
`club_treasury -> player_wallet`, category `settlement`, totalling 76.90, and
no other leg on the treasury. Each alert now carries `funded: true` and its
adjustment, wallet key, ledger and wallet-transaction ids.

## 2. The Bot-Only PKO Shortfall

`20260926092142_a_bot_only_pko_shortfall_and_confirmed_noise_are_closed_with`

All 66 entrants of `3f19bd70` and all 155 of `a21c0cb6` were horses. The hand
history of both is pruned (0 rows) and no knockout was ever recorded, so the
1,355.00 cannot be attributed to any player. It is closed with a recorded
disposition and nothing paid; `a21c0cb6` paid exactly its advertised total.
The six related alerts carry the disposition object.

## 3. Recurrence

No function handles a satellite award into a bounty or PKO event today: since
`20260911110907` (#4296) a satellite cannot be created into or re-pointed at
one, and `fn_settle_satellite_tournament` refuses such a target before any
money moves. The seven weeks of seat rows without `entry_split_version` all
target plain events. `scripts/ci/test-satellite-bounty-seat-split.py`
reproduces the 09-04 mis-split with production's own
`fn_tournament_entry_split` (66 entrants short by exactly 1,355.00, 155 by
0.00) and proves every refusal on production's exact definitions (17 checks).

## 4. The Ledger Replay

`20260926084812_the_ledger_replay_keys_a_union_wallet_by_its_union`

The replay runs nightly at 06:40 and has succeeded every night since 09-20
(it failed 09-17 to 09-19); on 09-26 it checked 877 accounts with 0
disagreeing. The -109.14 and -234.10 on the Midway promo wallet were exactly
the Diamond game prizes it paid, journaled under the wallet's row id by the
autoledger and so keyed into an account the replay could never read. The same
split hid every autoledgered union wallet movement, the 3.1M rake wallet
among them, from the replay. Both leg readers now key union wallet legs by
their union. The -2,624.78 / +2,624.78 pair was the journal-only repair leg of
`20260921005621`, netting 0.00.

## 5. Rakeback, Week of 2026-09-14

`20260926093159_the_week_of_2026_09_14_horse_rakeback_is_closed_by_dispositi`

Closed without payment. All 612 recipients in the surviving per-player records
are horses; 142 of the 144 active agents who would fund it are horses; the
week's commission is itself unpaid; and the platform's calculator refuses the
week. The hand-history pruner deleted the week's pre-cutover
`rake_attributions` before its 2026-09-25 fix, so 103,614.58 of the week's
615,843.40 cash rake no longer has a per-player record. Derivable today from
the immutable earning contracts: basis 441,623.03, rakeback 97,577.72. That
figure is recorded on both obligation rows and the alert.

## 6. The Double-Paid Obligations

`20260926092115_the_bots_paid_twice_on_2026_09_02_return_the_duplicate`

`20260909090022` concluded no chip was paid twice, counting only credits that
spent an idempotency key. The 01:19:57 back-fund migration spent none, but it
moved every balance and the journal recorded it; the 03:54:19 reconcile paid
the same shortfall again. Four events were overpaid by exactly 460.00, 350.00,
175.00 and 16.00. All 32 recipients are horses, so each duplicate was returned
from the wallet that received it to the Midway Union bank that funded the
top-up: 32 `reversal` legs totalling 1,001.00, union bank 6,552.07 to 7,553.07.
No human was paid twice in this class.

## 7. Alert Noise

Re-proved in the same migration as item 2: 32 finish retry receipts on
completed tournaments, 3 stale guarantee and bounty alerts, 11 conservation
alerts whose true residual is 0.00, and 10 rake-repair receipts. The retry,
`bounty_head_not_attributed` and `Satellite.seat_outcome_unconfirmed` bulk
classes had already been closed on 2026-09-25 and have 0 open alerts.
