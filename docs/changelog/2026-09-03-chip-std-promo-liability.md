# Chip Accounting Standard - promo chips: the liability review, and the meter fix

2026-09-03. Dan's ruling 3: "PROMO CHIPS ARE A PART OF THE BBJ RAKE, PART GOES
INTO THE MAIN BBJ, PART GOES INTO THE BACK UP BBJ WALLET AND PART GOES INTO THE
PROMO WALLET. WHAT LIABILITY OR ISSUES DO WE HAVE TO ADDRESS WITH IT?"

## Where the promo chips are, right now

Read-only, 2026-09-03 21:45-22:00 UTC.

| store                       | balance   |
| --------------------------- | --------- |
| union_wallets.promo_wallet  | 40,023.08 |
| clubs.promo_balance         | 6,166.18  |
| bbj_pools.promo_balance     | 18.78     |
| club_members.promo_balance  | 0.00      |
| agents.promo_wallet_balance | 0.00      |
| total                       | 46,208.04 |

Lifetime swept from the BBJ into the union promo wallet: 60,023.71
(unions.promo_funded_from_bbj). BBJ drop over the last 7 days: 67,299.88, split
main 33,644.62 / backup 16,829.42 / promo 16,825.84.

Promo paid to a player, ever: **0.00**. `chip_transactions` holds zero rows of
`bbj_promo_payout`, zero of `promo_wallet_send`, zero of `promo_released`.

## The seven findings

1. **The promo pot has never paid out.** 46,208 chips of players' rake sit in
   promo wallets and not one chip has reached a player. `fn_bbj_promo_payout_atomic`
   pays from `bbj_pools.promo_balance`, but the sweep empties that balance to the
   union (or club) promo wallet continuously - 18.78 left across all pools - so
   the one function built to pay promo out can almost never find a balance to pay
   from. The promo slice accrues; nothing spends it. That is the liability: it is
   money taken from the felt for a promotion that does not exist yet.

2. **Promo is an unrecorded liability.** Nothing in the schema says what the
   promo float is owed against - no campaign, no accrual, no expiry, no
   forfeiture rule. It is not in `ca_supply_snapshots.tournament_liability` or
   `leaderboard_liability`; it is just a balance. If it is meant to be players'
   money, it needs a liability account and a policy; if it is house money once
   swept, that needs saying, because it was cut from the rake as a promo slice.

3. **The chip meter could not see a third of it. (FIXED, see below.)**
   `clubs.promo_balance` was in no snapshot column at all, so every sweep into a
   standalone club's promo wallet - about 220 chips an hour, 5,010.18 over the
   last 7 days - read to the supply meter as chips leaving the world. This is a
   large part of the negative unexplained drift the hourly snapshot has been
   reporting (-4,866.94 over 24h against 4,799.77 of club promo sweeps) and of
   the 58 supply incidents raised this week. `clubs.insurance_balance` was
   unmeasured for the same reason (0.00 everywhere today).

4. **The trial balance watched a third of it. (FIXED, see below.)** The ledger
   writes one account name, `promo_wallet`, from three balances -
   `club_members.promo_balance`, `clubs.promo_balance`,
   `agents.promo_wallet_balance` - while `fn_ca_trial_balance` measured it as
   member promo alone. The promo row read balance 0.00 against ledger 5,955.77
   over seven days: a -5,955.77 phantom that was never a leak. Agent promo was
   worse: journalled as `promo_wallet`, measured inside `agent_wallets`.

5. **Promo becomes cashable chips on send, with no playthrough. (NOT FIXED -
   Dan's call.)** `fn_promo_wallet_send(..., 'player_wallet')` credits
   `club_members.chip_balance` - cashable - not `promo_balance`, and sets no
   `promo_playthrough_required`. `redeem_promo_to_chips` converts promo to cash
   1:1 with no playthrough check at all and no ledger declaration.
   `promo_apply_playthrough`, which exists and is engine-gated correctly, is
   therefore never reached on those routes. A promo chip is meant to be earned
   before it is cashable; today it can walk straight out as cash. Whether that
   is a bug or the intended generosity is a business decision, which is why it
   is written down here rather than changed.

6. **Union promo can cross club lines.** `fn_union_distribute_promo` sends from
   the union promo wallet into any member club's `promo_balance`, and
   `fn_union_send_to_member_zd3core` can pay a member from the union promo
   wallet. That is legitimate for a union-wide promotion, but it sits next to
   the Mint ruling that a club's chips stay in that club, so the rule for promo
   needs stating explicitly: promo raised at club A's tables may be spent at
   club B.

7. **Historical suspense residue.** 298 rows, 1,156.00 chips, dated
   2026-09-01 17:25 to 2026-09-02 22:05, journalled `settlement_suspense ->
promo_wallet` because the club sweep did not declare its counterparty. Phase
   1.3 fixed the writer; the rows since 09-02 22:05 are properly
   `bbj_pool -> promo_wallet`. Nothing further to do beyond knowing what they are.

## What was built (telemetry only)

`supabase/migrations/20260903215830_the_promo_wallets_are_on_the_chip_meter.sql`

- `ca_supply_snapshots` gains `club_promo`, `club_insurance`, `agent_promo`.
- `fn_ca_supply_snapshot` counts `clubs.promo_balance` and
  `clubs.insurance_balance` in the supply total and records all three columns.
- `fn_ca_trial_balance` measures `promo_wallet` against member + club + agent
  promo, removes agent promo from `agent_wallets`, and adds the club insurance
  float to `union_banks` (which already carried `insurance_bank`).
- The latest snapshot is rebaselined in the same transaction - the club stores
  as they stood at its `taken_at`, reconstructed by unwinding the ledger rows
  written since - so the first snapshot on the new basis does not report 6,183.05
  as a one-time swing and raise a false drift incident.
- Both functions stay `service_role` only; both are re-revoked from PUBLIC,
  anon and authenticated.
- The migration proves itself: it takes a real snapshot on the new basis inside
  a subtransaction, checks the swing is not the club promo float itself, and
  rolls it back (`PROMO_METER_SELFCHECK_OK`).

This moves no chips, changes no money path, and touches no function any player,
club or union action calls.

### Verified in production

- Applied as version `20260903215830`; self-check passed.
- Rebaselined snapshot 21:05:01Z now carries `club_promo` 6,183.05,
  `club_insurance` 0.00, `agent_promo` 0.00, with its total raised to match.
- `fn_ca_trial_balance(now() - 24h)` promo row now reads balance 6,183.05
  against ledger 4,818.40. The +1,364.65 residual is the transition: the older
  endpoint of the window predates the column and reads its club promo as 0. It
  self-heals once both endpoints carry the column, within 24 hours.
- `total_supply` difference for the same window: 1,242.92 against 200,000.00 of
  ledgered issuance.

### Correction, 22:08 UTC (migration 20260903220846)

The rebaseline in 20260903215830 reconstructed the club promo float at the
21:05 snapshot by unwinding `chip_ledger` rows labelled `clubs.promo_balance`.
There are none: `fn_sweep_bbj_promo` declares its counterparty and autoskips the
clubs trigger, so the sweep is journalled by the bbj_pools trigger as
`bbj_pool -> promo_wallet` with `from_label` `bbj_pools.promo_balance` and
`to_label` NULL. Only the pre-1.3 undeclared rows ever carried the label the
reconstruction looked for.

The baseline was therefore stamped with the balance as at migration time,
6,183.05, onto a snapshot taken 53 minutes earlier when the float was 5,955.77 -
227.28 too high - and the 22:05 interval computed against it reported +344.72 as
+117.44. `20260903220846_the_promo_meters_baseline_is_the_balance_not_a_label_search.sql`
corrects both rows from the sweep transactions (which carry `balance_after`),
cross-checking the first sweep after the baseline against the reconstruction and
refusing to guess if they disagree by more than a cent. Baseline 21:05 club promo
now 5,955.77; the 22:05 interval now reads 344.72. Both snapshots from 22:05 on
measure the live balance at both endpoints, so no further baselines are involved.

## Still Dan's decisions

- 7a: does the promo float owe players anything, and if so under what policy
  (campaign, expiry, forfeiture)? Nothing pays it out today.
- 7b: should promo become cashable on send, or must it clear playthrough
  (finding 5)?
- 7c: may promo raised at one club's tables be spent at another (finding 6)?
