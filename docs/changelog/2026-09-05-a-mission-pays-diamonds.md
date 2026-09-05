# A mission pays diamonds, and the 425.8M chip button is gone

2026-09-05

Dan, verbatim: **"NOTHING EVER 'EARNS CHIPS' ONLY EVER DIAMONDS. MAKE SURE
THATS THE CASE GLOBALLY!"** The referral paths were corrected earlier the same
day. This is the other reward surface, and it turned out to be much larger than
a copy problem.

## What was sitting there

Three RPCs credited chips through `atomic_credit_wallet_and_log`, which settles
into `club_members.chip_balance`:

| function                            | what it paid                                 |
| ----------------------------------- | -------------------------------------------- |
| `claim_daily_challenge`             | one mission's `chip_reward_snapshot`         |
| `claim_daily_challenges`            | the whole vault page, up to 100 rows at once |
| `fn_award_daily_mission_milestones` | the five streak circuits                     |

Every mission already paid diamonds as well, so the chips were an EXTRA payout
on top of a reward that existed. Measured on production before touching
anything:

```
daily_challenge_catalog      57 of 58 rows carry chip_reward       1,564,050
daily_challenge_catalog      58 of 58 rows carry diamond_reward     8 .. 800
user_daily_challenges        32,793 rows carry a chip snapshot
user_daily_challenges        total chip snapshot                 695,783,800
  ...of which completed and unclaimed                            425,819,000
daily_challenge_milestones   5 rows, reward_chips                     72,000
```

`fn_club_chip_circulation()` puts every chip in every member wallet at roughly
**121 million**. So one player finding the "Claim All" button would have minted
several times the platform's entire chip supply, in one call, from a vault that
had been filling since 2026-03-23 and was still growing that morning.

## Why it was safe to correct rather than escalate

Nothing has ever been paid on this surface. Measured, not assumed:

```
user_daily_challenges WHERE claimed              0
daily_challenge_claim_batches                    0
daily_challenge_milestone_claims                 0
wallet_transactions naming the surface           1  -- "Test commission",
                                                    -- system account, March
```

The claim RPC has never been invoked by anyone, in five and a half months. No
past payout to reconcile, nobody paid twice, nothing taken back from a player
(CLAUDE.md 10.9). The migration opens with a guard that re-reads all three
zeroes and aborts if any of them moved between the probe and the apply.

## The mistake the probe caught

The first draft zeroed `user_daily_challenges.chip_reward_snapshot` on all
32,793 rows. Run inside a rolled-back transaction (CLAUDE.md 11.5), it was
refused:

```
ERROR:  Assigned daily challenge contracts are immutable
CONTEXT:  fn_snapshot_daily_challenge_contract() line 57
```

That trigger is right and the edit was wrong. A snapshot exists precisely so a
contract already handed to a player cannot change underneath them. **The
liability never needed one player row touched**: 425.8M was not a balance, it
was a number three functions would have paid. Remove the paying and a stale
snapshot is inert. The old snapshots stay on disk, unread, as the record of what
was assigned.

## What changed

- `daily_challenge_catalog.chip_reward` -> 0 on all 57 rows. Every row keeps its
  `diamond_reward` (8 to 800, mean 103).
- All three crediting functions rewritten with no chip credit at all - removed,
  not guarded on a zeroed column, so a stale snapshot arriving from anywhere
  cannot mint a chip.
- `get_daily_challenge_dashboard` rewritten too: it read `reward_chips` in two
  places, so the rename below would have 42703'd every load of the page.
- `daily_challenge_milestones.reward_chips` -> `reward_diamonds` (and the same
  on `..._claims`), renamed rather than added because nothing had been claimed.
  Denominated in the diamond economy rather than relabelled, since 50,000
  diamonds is not 50,000 chips:

  | circuit  | was          | now            |
  | -------- | ------------ | -------------- |
  | 7 days   | 500 chips    | 150 diamonds   |
  | 14 days  | 1,500 chips  | 400 diamonds   |
  | 30 days  | 5,000 chips  | 1,000 diamonds |
  | 60 days  | 15,000 chips | 2,500 diamonds |
  | 100 days | 50,000 chips | 6,000 diamonds |

  **These five numbers are Dan's to set** (10.9: what players are owed in FUTURE
  events is his). They sit in one `VALUES` list so changing them is a one-line
  edit. What the migration asserts is the mechanism - diamonds, idempotent,
  audited - not the price.

- `chipReward` is deleted from `DailyChallenge` and from all 54 pool rows,
  rather than set to 0, so no card can promise one again. `chips`,
  `totalChipsEarned` and `vault.chips` are gone from the claim receipts.
- The page leads with the diamond figure, the celebration has no chip tile, the
  hero says "Real Diamond Rewards", and the milestone tile says Bonus Diamonds.
- A `financial_alerts` row records the whole thing, resolved with what was
  accepted and why.

## What is NOT touched

Chips are still chips where chips are the SUBJECT. `chips_won` challenges, the
`big_pots` thresholds, "Win 2,500 Chips In Pots Today" - those are things a
player DOES. `reroll_daily_challenge` SPENDS rather than earns. The law guards
the crediting, not the felt.

## Enforcement

`tests/a-reward-is-paid-in-diamonds.law.test.ts`, registered in
`docs/laws.d/a-reward-is-paid-in-diamonds.md`. It pins the absence of
`atomic_credit_wallet_and_log` from the migration, the absence of `chipReward`
from every pool row, the absence of a chip figure from the service and the page,
and - deliberately - that the migration does NOT rewrite an assigned snapshot.

## Still open

`club_challenges.reward_chips` (read by `ClubsService`) is a separate surface
and was not in scope here. It is the next place to look under the same ruling.
