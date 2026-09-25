# Economic Model: What Operators Pay And What The Offer Costs

This file answers R2 lines 1643-1645 (Phase 9: "Model typical and high-load configurations ... union coverage, report usage, package bonuses, support incidents, trial costs and comparison adjustments. No invented per-table certification, margin, conversion rate or customer revenue").

**Inputs.** Every figure is arithmetic on two things:

- The published catalog v1 (M1:464-473).
- The diamond package list recorded in R2 P2-F02 (line 383).

**Nothing here is a demand, adoption, conversion or revenue forecast.** Where a scenario is shown, it is labelled **Illustrative**, and its assumptions are stated beside it.

**What was not measured.** Infrastructure, storage, support and payment-acquisition costs are not measured anywhere in the repository. R2 line 1643 asks for them. They are **Unknown**, and this model does not estimate them.

Nominal value: 1 diamond = US$0.01 (`nominal_cents_per_diamond = 1`, M1:782). This is a catalog valuation, not net cash proceeds and not a redemption right (R2 line 149).

## 1. What a club pays per 30 days (720 hours)

| Capacity SKU    | Up to members | Diamonds                                                                                                 | Nominal USD | Diamonds per member at full roster | With club insurance module (+200) |
| --------------- | ------------- | -------------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------- | --------------------------------- |
| `capacity_60`   | 60            | 500                                                                                                      | $5.00       | 8.33                               | 700 ($7.00)                       |
| `capacity_100`  | 100           | 700                                                                                                      | $7.00       | 7.00                               | 900 ($9.00)                       |
| `capacity_250`  | 250           | 1,500                                                                                                    | $15.00      | 6.00                               | 1,700 ($17.00)                    |
| `capacity_500`  | 500           | 2,500                                                                                                    | $25.00      | 5.00                               | 2,700 ($27.00)                    |
| `capacity_1000` | 1,000         | 4,000                                                                                                    | $40.00      | 4.00                               | 4,200 ($42.00)                    |
| `capacity_2500` | 2,500         | 7,500                                                                                                    | $75.00      | 3.00                               | 7,700 ($77.00)                    |
| Above 2,500     | none          | **No price.** The quote refuses `roster_exceeds_capacity` (M2:383-386). R2 3.1 asks for a written quote. |             |                                    |                                   |

**Rules that shape the bill**

- A club can buy only a tier at or above its approved roster (M2:383-386).
- The roster counts each approved account once, horses included (M1:520-525; RA `s_horse_counts`).
- Nothing is charged per hand, per table, per table-hour or per member action. The debit happens only at purchase or renewal (M2:618).
- There is no per-agent toll.

**Upgrade proration**

The formula is: credit = floor(value basis × remaining / period); new line = ceil(new list price × remaining / 720 h). The source is M2:346-353.

Worked example: going from 700 to 1,500 at half the period gives a credit of 350 against a new line of 750, so the owner pays **400** (RM `D11 a 700 -> 1,500 upgrade at half period credits the unused 350 against 750 for the remainder: ...`).

A downgrade applies at the next period and is never refunded mid-period (M2:336-339).

## 2. Union configurations per 30 days

The union products are:

- **Union back office:** 1,000 diamonds per covered club (`per_unit`, M1:471).
- **Union insurance module:** min(200 × clubs, 1,000) (M1:473).

Both are bought by the union owner for a quantity they declare (1 to 500). **The quantity is not checked against the union's actual covered-club count.** Club capacity is separate. Either each club owner pays for it, or the union owner sponsors it from their own session (M2:572-590).

### 2.1 Every covered club at `capacity_100` (700)

| Covered clubs N | Club capacity (700 × N) | Union back office (1,000 × N) | Union insurance | Union owner's own lines | Configuration total | Nominal USD |
| --------------- | ----------------------- | ----------------------------- | --------------- | ----------------------- | ------------------- | ----------- |
| 1               | 700                     | 1,000                         | 200             | 1,200                   | 1,900               | $19.00      |
| 2               | 1,400                   | 2,000                         | 400             | 2,400                   | 3,800               | $38.00      |
| 5               | 3,500                   | 5,000                         | 1,000           | 6,000                   | 9,500               | $95.00      |
| 10              | 7,000                   | 10,000                        | 1,000           | 11,000                  | 18,000              | $180.00     |
| 25              | 17,500                  | 25,000                        | 1,000           | 26,000                  | 43,500              | $435.00     |
| 50              | 35,000                  | 50,000                        | 1,000           | 51,000                  | 86,000              | $860.00     |
| 100             | 70,000                  | 100,000                       | 1,000           | 101,000                 | 171,000             | $1,710.00   |

### 2.2 Every covered club at `capacity_250` (1,500)

| Covered clubs N | Club capacity | Union owner's own lines | Configuration total | Nominal USD |
| --------------- | ------------- | ----------------------- | ------------------- | ----------- |
| 1               | 1,500         | 1,200                   | 2,700               | $27.00      |
| 5               | 7,500         | 6,000                   | 13,500              | $135.00     |
| 10              | 15,000        | 11,000                  | 26,000              | $260.00     |
| 50              | 75,000        | 51,000                  | 126,000             | $1,260.00   |
| 100             | 150,000       | 101,000                 | 251,000             | $2,510.00   |

Reminder from `d80-installed-path-map.md`: today, union back office and union insurance **grant no enforced right**. A union paying the "union owner's own lines" column buys nothing it does not already have.

## 3. Cash needed to hold those diamonds (package granularity)

Packages recorded in R2 P2-F02:

| Diamonds             | Price |
| -------------------- | ----- |
| 100                  | $1    |
| 500                  | $5    |
| 1,000                | $10   |
| 2,500                | $25   |
| 5,000                | $50   |
| 10,000 + 500 bonus   | $100  |
| 25,000 + 1,250 bonus | $250  |
| 50,000 + 2,500 bonus | $500  |

Every catalog price is a multiple of 100, so **any amount up to 10,000 can be bought for exactly its nominal value.** Above that, the bonus packs make the minimum cash lower than nominal.

The figures below are the smallest package combination whose total diamonds (base plus bonus) reach the amount. **Assumption:** bonus diamonds are spendable through `deduct_diamonds` like any other balance. FIFO consumes purchased lots before promotional balance (R2-A06), which changes provenance but not spendability. This was not re-verified against the live wallet.

| Diamonds needed                    | Nominal          | Minimum package cash |
| ---------------------------------- | ---------------- | -------------------- |
| 500 to 10,000 (any catalog amount) | $5.00 to $100.00 | Equal to nominal     |
| 17,000                             | $170.00          | $165.00              |
| 18,000                             | $180.00          | $175.00              |
| 20,000                             | $200.00          | $195.00              |
| 43,500                             | $435.00          | $415.00              |
| 50,000                             | $500.00          | $478.00              |
| 86,000                             | $860.00          | $820.00              |
| 171,000                            | $1,710.00        | $1,630.00            |

These are **gross consumer prices**. Net proceeds after Apple, Google or Stripe fees, taxes and refunds are not recorded here and are Unknown (R2 line 935: cash proceeds and diamond consumption are different events).

## 4. What the free month costs the platform, at most

**Mechanism.**

- The trial is a fee waiver. No diamond moves and no Mint row is written: the trial right has `net_paid = 0` (M1:699-700), and RM `D20 ... waivers move nothing` confirms it.
- A purchase with `net > 0` is refused while the trial runs (M2:562-564).
- The waiver therefore has **no diamond or supply cost**. Its cost is forgone catalog revenue, plus unmeasured hosting and support.

**Forgone catalog revenue, as an upper bound for one operator's 30 days:**

- Club: up to the tier their roster needs, plus club insurance. That is at most **7,700 diamonds ($77.00)** for a club of 2,500 members or fewer.
- A club above 2,500 members has **no catalog price**, so the forgone amount is undefined (a written quote, R2 3.1).
- Union: up to **1,000 × N + min(200 × N, 1,000)** diamonds.
- One trial covers every scope of an operator, with a common end (M1:170, M1:689-690). The bound for an operator is the sum over their scopes, for one period of 720 hours only. A later scope never extends the end (RM `D47 ...`).

**No capacity limit applies inside the trial.** Admission answers `trial` whatever the roster is (M4:185-186), so a club may grow past any tier during its free month. After the month, it must buy the tier that fits its roster (M2:383-386).

**Launch cohort, compared with today.** Club and union operation is uncharged today (P2-F01). Enrolling every existing operator (M3:1100-1105) forgoes **zero** diamonds relative to current collections. Relative to a hypothetical "charge from launch day", it forgoes one period's list price per enrolled scope. The number of scopes was not read (no production access), so no total is given.

**Illustrative only.** Assume one operator with two 100-member clubs, each wanting club insurance. Their free month forgoes at most 2 × 900 = **1,800 diamonds ($18.00)** of list price. That describes the arithmetic, not an expectation.

## 5. What the refund policy costs the platform, at most

**Ceiling.** A refund can never return more than the line's net debit, less earlier refunds and less value already credited into an upgrade:

- `fn_ca_commerce_refundable` (M3:290-304)
- The core's check (M2:1042-1044)
- RM `D40 cumulative returns stay within the net paid allocation`
- RM `D40 / R2 6.4 unused value credited into an upgrade cannot also come back as a refund`

**At most 100% of what was paid, never more:** RM `D17 the refund is registered as one exact issuance, no excess diamonds`.

**Policy v1** (M3:119-125):

- **Purchase in error, within 24 hours and not replaced:** up to 100% of the line (M3:338-348).
- **Pro rata unused whole days** when the scope closed, the service was unavailable or staff find a platform defect: floor(net × unused whole days ÷ period days) (M3:358-362). For a prepaid period that has not started, all 30 days are unused, so this can also reach 100%. Example: 19 unused days of a 500 line gives **316** (RR `refund policy: the unused whole days of the period, pro rata: 19 of 30 days of 500 is 316`).
- **The free month:** nothing to refund (M3:326-327).

**What a refund actually costs.**

- It is an exact-value re-issuance of diamonds that were burned at purchase: a `refund` journal row and one Mint issuance equal to the gross (M2:1053-1068).
- Net supply after purchase and full refund is unchanged (RM `D20 ...`).
- **It is not a cash refund** of any diamond pack (R2 6.4).
- Part of the gross may settle existing debt instead of becoming spendable (RM `D36 / D38 ...`).
- A sponsored refund also releases sponsor budget (M2:1092-1094). That is budget headroom, not diamonds.

**Upper bound over any window.** Total refunds ≤ total net diamonds debited by commerce in that window. It is readable exactly with the query in `operational-metrics.md` section 5.

## 6. Comparison adjustments and package bonuses (R2 line 1645)

- **Comparison adjustment:** always 0 (M2:398, M2:428). No verified comparator exists. The competitor evidence finds the `capacity_60` and `capacity_100` tiers matched by ClubGG's $0 Free level (`../competitor-evidence-2026-09-24.md` section 7). The whole-basket check "ten 100-member clubs" costs 7,000 diamonds against Poker Now Platinum's $48.38 per 30 days, 44.7% more (section 6.1 there). These are pricing risks recorded for the owner. The model applies no adjustment.
- **Package bonuses** lower the cash per diamond above 10,000 (section 3). They do not change the nominal catalog value of a debit (D30 N/A: packages unchanged).

## 7. Not modelled, and why

| Item R2 asks for                                                      | Why it is absent                                                                             |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Infrastructure, storage, report generation and support cost per scope | Not measured anywhere in the repository. Unknown.                                            |
| Roster-to-concurrency ratios and table certification                  | No certified concurrent-table figure is recorded. Inventing one is forbidden (R2 line 1645). |
| Report usage                                                          | No report product is sold (`unsupported-offerings.md`).                                      |
| Conversion rate, adoption and revenue                                 | Forbidden to invent (R2 line 1645, C.3). Real receipts: 0 at the last readback.              |
| Settled-earnings coverage                                             | No commerce read of Spins settlement exists (`traceability-register.md` section 4, item 3).  |
