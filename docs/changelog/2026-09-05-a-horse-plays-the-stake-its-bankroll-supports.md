# A horse plays the stake its bankroll supports

2026-09-05. The invented 1/2 phase clamp is gone, the stake ladder runs to
25/50, and the two band functions that disagreed with each other are one.

## Dan's ruling, verbatim

> "THERE ISN'T A 'CAP'. HORSES CAN ONLY PLAY ABOVE 1/2 IF THEY HAVE THE
> 'PROPER BANKROLL' TO PLAY A BIGGER STAKE."

## What was wrong, measured on production

`server/src/services/StableHand.ts` carried a hard clamp nobody asked for:

```ts
/** Section 8.3 phase clamp. NOTHING sits above 1/2 this phase, however rich
 *  the wallet. 10,000 chips would license 2/5 on the 20-buy-in rule; the
 *  clamp still forbids it, and the clamp wins. */
export const PHASE_MAX_BB = 2;
```

It was not one check. It was five, and it reached everything:

| Where                        | What it did                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `STAKE_LADDER`               | stopped at `{ sb: 1, bb: 2 }`, so no rung above 1/2 existed to be tagged for                                    |
| `stakeBandOf(bb)`            | returned `null` above 2, so a 2/5 table belonged to no band                                                     |
| `isLicensed(available, bb)`  | refused first on the clamp, before the money was even looked at                                                 |
| `mayStepUp`                  | refused a step up above 1/2 whatever the roll and however many qualifying days                                  |
| `evaluateSit`                | returned `stake_above_phase_cap` for every table above 1/2                                                      |
| `shapedTables` (the planner) | filtered every table above 1/2 OUT OF THE FLOOR, so their seats counted toward no bucket and no occupancy total |

The consequence, read from the database rather than assumed:

- `stable_hand_membership_tags.preferred_stakes` held **only 0.02, 0.05, 0.1,
  0.25, 0.5, 1 and 2** - across all 1,107 cash tags and all 1,000 horses.
  Nothing above 1/2 had ever been written, because `assignPreferredStakes`
  drew only from `STAKE_LADDER`.
- So `tagAllowsStake(tag, bb)` returned `false` at every 2/5, 5/10, 10/20 and
  25/50 game, the candidate filter in `HorseFleetManager` dropped every horse,
  and the fleet logged `No available horses for ... (need 9, band mid)` every
  cycle. 16 enabled 2/5 games (Classic, Action and Madness) were permanently
  unpopulated.
- The bankrolls were there the whole time. Of 1,000 horses, measured
  2026-09-05 as `max(club_members.chip_balance) >= 20 * 100 * bb` across the
  three funding wallets: **1,000 hold 20+ buy-ins for 1/2, 814 for 2/5, 592
  for 5/10, 446 for 10/20 and 289 for 25/50.** The minimum roll on the
  platform is 6,400 chips; the mean is 123,816.

## What changed

**1. The clamp is gone, every caller decided individually.**

- `isLicensed` is now the bankroll rule and nothing else: 20 buy-ins of the
  game, at every rung. This is the rule Dan named.
- `evaluateSit` keeps ONE ceiling, and it is the ladder's own top rung
  (`stakeIsWithinLadder`, rejection renamed `stake_above_ladder_top`). A table
  above 25/50 is not a stake a horse declines on bankroll grounds; it is a
  table that should not exist. 25/50 being the top matches the `DEFAULT_TABLES`
  comment in `HorseFleetManager`: 25/50 is the top by order and "anything above
  it is not added here and must not be".
- `mayStepUp` takes the same ladder-top check in place of the clamp.
- `shapedTables` in `StableHandController` dropped the check entirely.
  Occupancy is a fact about SEATS, and a seat at 2/5 is a body in a chair
  exactly as a seat at 0.25/0.50 is.
- `PHASE_MAX_BB` and `stakeIsLegalThisPhase` no longer exist.

**2. The ladder is the platform's real stakes**, read from `cash_games` on
2026-09-05 rather than guessed: 0.01/0.02, 0.02/0.05, 0.05/0.10, 0.10/0.25,
0.25/0.50, 0.50/1.00, 1.00/2.00, 2.00/5.00, 5.00/10.00, 10.00/20.00, 25.00/50.00.

Two live pairs are deliberately NOT on the canonical ladder, and both are
strays rather than rungs:

- **0.13/0.25** - one classic game, against 23 games at 0.10/0.25 on the same
  big blind. Every gate that matters keys on the BIG blind, so a horse tagged
  for 0.25 plays that game anyway; what the ladder decides is the blinds a NEW
  table opens at, and that has to be the canonical pair.
- **2.00/4.00** - one classic game, disabled, against 16 enabled at 2.00/5.00.
  Same reasoning, and nothing is dealing it.

**3. There is ONE band function.** `stakeBandOf` (micro / low / top, null above 2) is deleted; `StableHand` re-exports `stakeBandForBigBlind` from
`HorseBehavior` (micro <= 0.5, low <= 2, mid <= 6, high above), which is the
one the database writes through `fn_assign_horse_stake_bands`, the one
`stakeBandAllows` gates seats on, and the one Dan named. ('low' is the band Dan
calls small; the name is the one already stored in `profiles.horse_profile`, so
it stays.) `STAKE_MIX` and `neediestStakeBand` are four-band, and
`neediestStakeBand` now skips a band with a zero target - an empty band with a
zero target has a deficit of exactly 0, which would have beaten every
oversubscribed band's negative deficit.

`STAKE_MIX` is 22/52/15/11 (micro/low/mid/high) - the fleet's own proportions,
already measured and already written down in `HorseBehavior`. The old 40/35/25
could not be carried forward: all three of its bands sat at or below 1/2, so
mid and high would have had a target of zero seats forever.

**4. `assignPreferredStakes` reads the wallet.** Signature is now
`(horseId, { roll, buyInsToSit, seed })`. The band is still a deterministic
draw on `(horseId, seed)` - that is what keeps the floor spread across the
ladder and what makes a re-tag reproduce byte-identically - and the roll is
applied as a **CEILING, never a floor**. A horse drawn into a band it cannot
fund drops to the highest band it can; a horse drawn into micro stays in micro
however rich it is. Within the band only the rungs the roll supports are
eligible, and the "a stake and the one adjacent rung" rule (Section 8.7) is
untouched.

The affordability bar is the seat gate's own, so a tag can never name a stake
the gate would then refuse: `max(BUYINS_TO_LICENSE, policy.buyInsToSit)` buy-ins,
because a seat needs BOTH `isLicensed` (20) and `HorseBankroll.canSit` (nit 40,
standard 25, gambler 12) to say yes. `server/src/scripts/horsesTag.ts` now
selects `chip_balance` alongside the membership and passes it with
`bankrollPolicyFor(horseId).buyInsToSit`.

**5. Nothing about seat time was weakened.** `canSit`, the aggregate-exposure
ceiling in `HorseSitVerdict`, `evaluateSit`'s licence and commit caps, the
rejoin floor, the rest day and the daily cap all still decide every actual sit.
This change stops the TAG being an artificial ceiling; it does not hand anybody
a seat.

## The re-tag was blocked by a second defect, and it is fixed here too

`npm run horses:tag -- --force` died on its first 500-row upsert:

```
tag upsert failed: new row for relation "stable_hand_membership_tags"
violates check constraint "stable_hand_membership_tags_max_tables_check"
```

Production carried `CHECK (max_tables >= 2 AND max_tables <= 4)`. The repo's
own creating migration,
`20260904060838_stable_hand_tag_and_state_tables.sql`, declares
`CHECK (max_tables BETWEEN 0 AND 4)` plus
`sh_tourney_only_one_table CHECK (mode <> 'tourney' OR max_tables = 1)` - and
it never took effect, because that file creates the table with
`CREATE TABLE IF NOT EXISTS` and the table already existed. The file read as
applied and changed nothing.

So `MAX_TABLES_TOURNEY_ONLY = 1`, which `assignTags` writes for every
tourney-only horse, has been unwritable since it landed, and **no re-tag has
been possible at all**. The fingerprint was in the data: the 473 tourney rows
held `max_tables` 2, 3 and 4 - the persona values an older tagger wrote.

This is not two rules in conflict (CLAUDE.md 10.8). One side is written down
twice, in the migration file and in the engine constant, and the two agree.
The other is a constraint on the live table with nothing behind it in this
repo. Fixed forward in
`supabase/migrations/20260906003931_the_tourney_tag_can_hold_the_one_table_its_own_migration_dec.sql`
(one transaction, one schema reload): the range becomes 0 to 4, the 473
tourney rows are set to 1, `sh_tourney_only_one_table` is added, and a `DO`
block aborts the whole thing if either did not land. Rollback is pasted in the
header. The rows are fleet metadata, not money - `tagMaxTables` is read in
exactly one place, sizing the CASH table cap in `HorseSitVerdict`, and a
tourney-only horse never reaches it because `tagAllowsCash` has already
dropped it.

## The re-tag

`npm run horses:tag -- --club=all --force` (server/), dry run first.

Before, `preferred_stakes` across 1,107 cash tags:

```
0.02=293  0.05=277  0.1=349  0.25=405  0.5=321  1=265  2=144
```

After:

```
0.02=72  0.05=96  0.1=103  0.25=90  0.5=332  1=650  2=528
5=214  10=64  20=20  50=8
```

Band of the anchor (the top preferred stake), 1,107 cash tags:
micro 223, low 650, mid 162, high 72. The draw asked for 11% high (about 122);
the roll ceiling demoted roughly fifty of those to mid, which is the bankroll
rule doing exactly what it is for.

## How to verify

1. The fleet's `[HorseFleet] No available horses for "<name>" (need N, band mid)`
   lines stop for the 2/5 games. That message was printing every cycle for
   every game above 1/2.
2. Seats appear at 2/5. `select bb, count(*) from tables t join cash_games g
on ... where t.status <> 'closed' and g.bb >= 5` and `table_seats` rows on
   them.
3. `select unnest(preferred_stakes) s, count(*) from
stable_hand_membership_tags group by 1 order by 1` shows rungs above 2.
4. No horse is tagged for a stake it cannot fund:
   `stable_hand_membership_tags` joined to `club_members.chip_balance`,
   `max(preferred_stakes) * 100 * 20 <= chip_balance` for every row. Run
   against production immediately after the re-tag: **0 of 1,580 tags** name a
   stake the wallet does not cover.

## Deliberately NOT changed

- **`EXOTIC_MAX_BB = 2`.** That is a separate written rule (OPORD section 6)
  about how much Pineapple / Short Deck / PLO8o SUPPLY the floor carries, not
  about which stake a horse's bankroll licenses. NLHE, PLO and the limit games
  run the whole ladder; the exotics keep their own ceiling until Dan moves it.
- **`stakeBandAllows` and the merit bands.** A band is still earned in the
  database by `fn_assign_horse_stake_bands`. Nothing here promotes a horse.
- **`stakeForBand` picks the highest rung inside the band**, unchanged rule,
  now with four bands: micro opens 0.25/0.50, low 1/2, mid 2/5, high 25/50.
  The open path itself is still the most cautious thing in the fleet - one
  table per host per cycle, never at the occupancy cap, never at night, and
  only when the host has no game of that variant at that stake at all.
