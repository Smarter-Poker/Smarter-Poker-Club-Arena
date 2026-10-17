# The Diamond Arena is the lite version of the Midway schedule (2026-10-17)

Dan, verbatim: "MAKE A 'LITE VERSION' OF THIS SCHEDULE FOR THE DIAMOND ARENA
ALL TOURNAMENT BUY IN ARE 10% OF THE PRICE OF THE MIDWAY TOURNAMENTS (1
DIAMOND = 1 CENT) AND KEEP THE SAME FREE ROLLS GUARANTEE AND REBUY ADD ON AT
100 DIAMONDS."

## What it is now

- The Diamond Arena runs the same events at the same times as the Midway
  Union. A Midway chip is a dollar and a Diamond a cent, so the arena charges
  ten Diamonds for every chip the Midway occurrence charges:
  `DIAMOND_ARENA_DIAMONDS_PER_CHIP` in `server/src/services/diamondScheduledSpawn.ts`.
  The entry, guarantee, bounty, rebuy and add-on all scale. A 35-chip Nightly
  10K is a 350-Diamond event with 350-Diamond rebuys and add-on and a
  100,000-Diamond guarantee (1,000 dollars against the Midway's 10,000).
- Freerolls are not scaled. The five Free Buys and the Coffee Break Freeroll
  keep their guarantee as a Diamond count (500, and 1,000 for the 8:30 PM Free
  Buy), and their rebuy and add-on are 100 Diamonds.
- Before this the arena charged one Diamond per chip, 1% of the Midway price.

The scaling is in the one place every Diamond schedule passes through
(`diamondSpawnConfig`), so the board, the weekly events and the satellites all
follow it. Occurrences already created keep the price they were made with; new
prices start with the occurrences the engine creates after this release (up to
three days ahead).

## The Nightly 10K was going to cost 30, and is now 35

The scheduler snaps every configured buy-in onto `BUY_IN_LADDER`, and 35 was
not a rung, so the Nightly 10K Dan priced at 35 would have been charged 30.
35 is a rung now, in the engine and client copies of the ladder. The weekly
rows also carried 1.1x figures (5.5, 8.8, 11, 16.5, 22, 33, 44, 55, 77, 109,
3.3) that were charged as 5, 10, 10, 15, 20, 30, 50, 50, 75, 100 and 3.
`20261017173805_the_weekly_buy_ins_say_what_they_charge` restates all 140
(70 per club) as the price they are charged, so the 33s do not snap up to the
new 35 rung. Nothing a player pays changes except the Nightly 10K. The new rung
also lets a heads-up satellite feeder price at 35 where it used to need 50.

## Capacity

The arena's guarantees are earmarked on the Diamond house when each event is
created, up to three days ahead. Read on 2026-10-17, the house balance was
2,303,167 Diamonds. At ten Diamonds a chip, the open guarantees across a
Friday-to-Sunday window come to about 2.5 million, so late in the week a few
Sunday events can wait for earlier events to settle before the house can
earmark them. The scheduler's own backoff handles that; nothing is refused for
good.

Pinned by `server/src/services/theDiamondArenaIsTheLiteSchedule.law.test.ts`.
