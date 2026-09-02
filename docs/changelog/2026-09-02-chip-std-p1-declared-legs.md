# 2026-09-02 - chip standard Phase 1.2 + 1.3: every entry and prize leg names its counterparty

Branch `fix/chip-std-p1-declared-legs`, worktree `chipstd-p1-declare`. Roadmap
`docs/CHIP-ACCOUNTING-ROADMAP.md` 1.2 (registration debits declare themselves) and 1.3
(suspense to zero, standard R9). Evidence base: `docs/audits/2026-09-02-chip-standard-round2/`
lane1 A + D (D2, D3), lane4 C.

THE LANE IS DECLARATION ONLY. No amount, recipient or order of operations changed; no
refusal added; no CHECK grown; no money moved by migration. Every edit is a live body
(`pg_get_functiondef`) plus added lines around one balance write.

## 0. What this lane found on arrival (22:28 UTC)

The entry-leg half of this lane had already been built, applied and committed by the
`chipstd-p1-ledger` worktree (branch `fix/chip-std-p1-ledger-declarations`, commit
`97c3fd1e2`, changelog `docs/changelog/2026-09-02-chip-std-p1-ledger-declarations.md`),
but never pushed and with no PR. Its two migrations were live:

| migration                                                    | applied (UTC) | declares                                                                                                |
| ------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------- |
| `20260902220500_the_undeclared_legs_name_their_counterparty` | 22:05:33      | fn_register_for_tournament, rebuy core, fn_spin_settle_game, fn_sweep_bbj_promo, fn_sweep_bbj_promo_all |
| `20260902221500_the_horse_door_declares_the_same_way`        | 22:08:19      | fn_register_horse_for_tournament (R11: the horse door declares exactly as the human door)               |

Rather than re-apply the same DDL under a second name (rule 1: applied once), this branch
carries that commit as-is (author preserved) so the repo mirrors what is live, replaces its
whole-table reflow of `docs/LAWS.md` with two one-line rows (a reflow conflicts with every
other lane's row), and adds the half that was still missing: the PAYOUT side.

## 1. Measured before anything (24h to 22:28 UTC, `chip_ledger`)

Suspense legs, grouped by shape (the lane's first instruction):

| leg                                  | category   | description shape                                                             | rows  | amount     |
| ------------------------------------ | ---------- | ----------------------------------------------------------------------------- | ----- | ---------- |
| spin_reserve -> settlement_suspense  | spin_prize | auto-ledgered spin_bonus_pools.balance delta N                                | 3,553 | 199,878.00 |
| bbj_pool -> settlement_suspense      | adjustment | auto-ledgered bbj_pools.promo_balance delta N                                 | 499   | 1,484.62   |
| settlement_suspense -> promo_wallet  | adjustment | auto-ledgered clubs.promo_balance delta N                                     | 251   | 1,108.75   |
| settlement_suspense -> union_wallet  | adjustment | auto-ledgered union_wallets.promo_wallet delta N                              | 248   | 375.87     |
| settlement_suspense -> bbj_pool      | adjustment | bbj_pools.main_balance (category bbj_contribution or cp table_stack rejected) | 4     | 0.54       |
| club_treasury -> settlement_suspense | adjustment | clubs.chip_treasury (the overpay debit, lane1 C #14)                          | 1     | 246.82     |
| settlement_suspense -> spin_reserve  | adjustment | spin_bonus_pools.balance                                                      | 1     | 8.00       |
| settlement_suspense -> union_wallet  | adjustment | union_wallets.rake_wallet (category rake or cp prize_liability rejected)      | 1     | 0.72       |
| union_bank -> settlement_suspense    | adjustment | union_wallets.chip_balance (tournament_overlay / tournament_pool rejected)    | 1     | 100.00     |

All rows `performed_by` the autoledger actor `2d1cd6c3`. Every leg over 100 rows/day is a
spin prize draw or a BBJ promo sweep; both were already declared by 22:08 (section 0).

Phantom `table_stack` legs (not suspense, but a counterparty that never held the chips):

| leg                          | category         | rows   | amount     | tournament_id | writer                                                            |
| ---------------------------- | ---------------- | ------ | ---------- | ------------- | ----------------------------------------------------------------- |
| player_wallet -> table_stack | adjustment       | 21,450 | 448,469.00 | none          | registration doors + rebuy core (declared at 22:05/22:08)         |
| table_stack -> player_wallet | tournament_prize | 8,419  | 423,911.80 | all           | fn_settle_tournament_obligation -> fn_credit_and_log              |
| table_stack -> player_wallet | refund           | 381    | 8,732.00   | all           | same funnel                                                       |
| table_stack -> player_wallet | bounty           | 85     | 728.74     | all           | same funnel                                                       |
| table_stack -> player_wallet | adjustment       | 622    | 6,797.27   | 4             | not this lane (undeclared credits; 4 are CHECK-rejected re-files) |

Horse treasury-to-felt funding: `horse_funding club_treasury -> table_stack`, 1,175 rows /
137,611.00 in 24h, both entities set, 0 through suspense. Already declared since 08-31
(`fn_horse_fund_from_treasury`, `fn_horse_seat_from_treasury`; there is no `fn_horse_seat`).
Nothing to do; the roadmap's "973 rows / 107,232" was this leg, measured earlier in the day.

## 2. What this branch adds: the payout funnel declares (roadmap 1.2 + 1.3, R9)

Migration `supabase/migrations/20260902224000_every_entry_and_prize_leg_names_its_counterparty.sql`
(one transaction; `schema_migrations` version `20260902223519`, applied 22:35:19 UTC).

`fn_credit_and_log` is the one funnel every tournament credit passes through: the obligation
settle calls it for places (`prize`), bounties (`bounty`) and refunds (`refund`); its only other
caller is `fn_payout_leaderboard`. It already declared `app.ledger_category` and
`app.ledger_tournament`; it did not declare `app.ledger_counterparty`, so
`fn_club_members_ledger_writer` used its `table_stack` default for 8,885 rows / 433,372.54 a day.

Added around the one wallet credit: save the caller's `app.ledger_counterparty` and
`_entity`; when `p_related_entity_id` is set AND the category is one of
`tournament_prize | bounty | refund | tournament_refund`, `set_config` counterparty
`prize_liability`, entity = the tournament; credit; restore both. `set_config`, not the raising
primitive, so a payout can never be refused by a ledger word (rule 13). Declared in the funnel,
not in `fn_settle_tournament_obligation` (Phase 1.1's function, PR #2721, not touched), and the
Phase 1.1 adopters inherit it.

Why `prize_liability` for bounties and refunds too: the entry legs book the WHOLE charge
(prize + bounty + fee) into `prize_liability`, because one wallet write is one trigger row and
`fee_liability` is not a vocabulary word (and adding one would also need `fn_ca_trial_balance`
and `fn_settle_tournament_rake` re-pointed: three functions for a split the escrow shadow
already computes). Paying every kind against the same account keeps `prize_liability` at zero
per tournament over its life. `bounty_liability` / `refund_payable` are in the same
trial-balance group (`tournament_liability`) so the trial balance would not notice either way,
but per-account they would leave `prize_liability` over-credited forever. When Phase 5 gives the
escrow three real columns the words split with it.

Byte proof: live `prosrc` before md5 `320090dd647b849719b960ab8d025f5f` / 5,904 bytes; after
`10a635b1da46913bd0a1afe511902b19` / 7,982 bytes = md5 of the body in the migration file;
`diff live new` additions only; `RAISE EXCEPTION` 1 -> 1; ACL `{postgres=X,service_role=X}`
before and after (asserted in the post-apply DO block, which ran green).

## 3. Probes (BEGIN ... ROLLBACK; nothing kept)

Tournament `fe8eac13` (Night Owl Special NLH, REGISTERING, 22 entrants), member `56315bf9`.
One real `fn_settle_tournament_obligation(kind='refund', 18.00)` and one direct
`fn_credit_and_log(7.00, 'prize', place 3)`.

BEFORE (22:33 UTC): wallet 29,414.90 -> 29,439.90 (+25.00); settle `{"ok": true, "paid": 18.00}`;
funnel `t`; 0 suspense rows.

```
     category     |  from_type  | from_ent |    to_type    |  to_ent  | amount |   tid    | description
------------------+-------------+----------+---------------+----------+--------+----------+-----------------------------------------------------
 refund           | table_stack |          | player_wallet | 56315bf9 |  18.00 | fe8eac13 | auto-audited club_members.chip_balance delta 18.00
 tournament_prize | table_stack |          | player_wallet | 56315bf9 |   7.00 | fe8eac13 | auto-audited club_members.chip_balance delta 7.00
```

AFTER (22:35 UTC): wallet 29,414.90 -> 29,439.90 (+25.00, identical); settle `{"ok": true, "paid": 18.00}`;
funnel `t`; 0 suspense rows.

```
     category     |    from_type    | from_ent |    to_type    |  to_ent  | amount |   tid    | description
------------------+-----------------+----------+---------------+----------+--------+----------+-----------------------------------------------------
 refund           | prize_liability | fe8eac13 | player_wallet | 56315bf9 |  18.00 | fe8eac13 | auto-audited club_members.chip_balance delta 18.00
 tournament_prize | prize_liability | fe8eac13 | player_wallet | 56315bf9 |   7.00 | fe8eac13 | auto-audited club_members.chip_balance delta 7.00
```

Restore probe (AFTER): with a stale caller declaration `app.ledger_counterparty = 'bbj_pool'`
set before the call, the row still reads `prize_liability(fe8eac13) -> player_wallet` and the
setting reads `bbj_pool` again after the call. (BEFORE, the same stale setting leaked into the
row as `bbj_pool -> player_wallet`: the funnel inherited whatever the session had.)

The entry-leg probes (registration BEFORE/AFTER, spin settle BEFORE/AFTER, BBJ sweep
BEFORE/AFTER) are in `docs/changelog/2026-09-02-chip-std-p1-ledger-declarations.md` section 5.

## 4. Suspense and phantom flow, 30-minute windows (`chip_ledger`)

| window (UTC)                                          | into suspense  | out of suspense | net flow  | undeclared adjustment rows on table_stack | payout rows on phantom table_stack | payout rows declared prize_liability |
| ----------------------------------------------------- | -------------- | --------------- | --------- | ----------------------------------------- | ---------------------------------- | ------------------------------------ |
| 21:35-22:05, before the entry-leg apply               | 160 / 9,075.11 | 12 / 144.11     | 8,931.00  | 898                                       | 366                                | 0                                    |
| 22:05-22:35, entry legs live, before the payout apply | 4 / 191.56     | 2 / 26.56       | 165.00    | 116 (all before 22:09)                    | 459                                | 0                                    |
| 22:09-22:39, entry legs live (both doors)             | 0 / 0.00       | 0 / 0.00        | 0.00      | 0                                         | 414                                | 22 (from 22:35)                      |
| 22:35-23:05, everything live                          | AFTER_SUSPENSE | AFTER_OUT       | AFTER_NET | AFTER_ADJ                                 | AFTER_PHANTOM                      | AFTER_DECLARED                       |

Reference: the 24h before the lane was net +185,526.56 into suspense (lane1 D3).

AFTER_TRIAL_BALANCE

## 5. Tests

- `tests/law/EntryMoneyIsDeclared.law.test.ts` (new, row in `docs/LAWS.md`): across all three
  migrations every defined function names a category AND a counterparty; the funnel declares
  `prize_liability` + tournament entity for tournament categories only, restores after the
  credit, uses `set_config` never the primitive, keeps exactly one RAISE; none of the three
  redefines `fn_settle_tournament_obligation`, `atomic_deduct_wallet_and_log` or alters
  `chip_ledger`; one BEGIN/COMMIT each. Negative control: stripping the
  `prize_liability` line from the migration -> 1 failed / 10 passed; restored (md5 equal).
- `tests/law/MoneyLegsDeclareTheirCounterparty.law.test.ts` (from the p1-ledger commit, row
  in `docs/LAWS.md`).
- `npx vitest run` on both plus `tests/law-registry.law.test.ts`: 3 files, 81 passed.
- No TypeScript touched; `tsc` not run.
- `docs/LAWS.md`: two rows, prettier-clean, two-line diff against main.

## 6. Left undeclared, and why

- `table_stack -> player_wallet adjustment` (622 rows / 6,797.27 per 24h, no category at all):
  undeclared wallet CREDITS from writers outside this lane's list (4 of them are
  `tournament_prize` rows a chip_ledger CHECK rejected on first insert, which the writer
  trigger re-filed as `adjustment`). Not measured to a function tonight; they are not suspense and are under the
  100-rows-per-writer bar once split.
- `fn_payout_leaderboard` credits (`leaderboard_payout`, entity = program id) still default to
  `table_stack`; the right word is `leaderboard_round` or `opening_setup` and which one is a
  leaderboard-lane question, not a tournament one.
- The fee share of an entry is not a separate ledger row (no `fee_liability` word; one wallet
  write is one row). `fn_settle_tournament_rake` already journals `prize_liability -> club_treasury
| union_wallet (rake)` at completion, so the fee leaves the same account it entered.
- The one `club_treasury -> suspense` row (246.82) is `fn_charge_place_overpays` (lane1 C #14),
  a Phase 1.1 / obligations path.
- Hierarchy sends (Phase 2), `fn_settle_tournament_obligation`, `fn_collect_bounty`, the
  bounty/refund functions (Phase 1.1) and `atomic_deduct_wallet_and_log` were not touched.

## 7. Log-only / not built

Nothing in this lane can refuse: every declaration is `set_config` (player-facing doors and the
payout funnel) or the primitive on service_role-only paths where a vocabulary miss would be a
deploy error, not a live refusal. The suspense watcher stays a tracker; flipping it to an alarm
(roadmap 1.3 last sentence) is Dan's call once a full day reads zero.

## 8. Decisions that are Dan's

1. Whether bounties and refunds should be journaled against `bounty_liability` /
   `refund_payable` instead of the single `prize_liability` the entry leg fills (this lane chose
   the account that nets to zero per tournament; the trial balance is indifferent).
2. Whether the suspense watcher becomes an alarm after 24h at zero.
3. The `fee_liability` word: add it (and re-point the entry split, the rake settle and the trial
   balance together) or wait for Phase 5's three-column escrow.
