# Tournament Masthead, Bounty Rebuys And The Mystery Bounty Ladder (2026-10-22)

Dan, 2026-10-21, from a seat in the 2K GTD Midweek Mystery (62a7c3b1):

1. "UNDER KINGS CLUB - MIDWAY UNION IT SHOULD SAY THE TOURNAMENT NAME AND BUY IN,
   NOT JUST NLH POKER TOURNAMENT. REMOVE LEVEL... AND UNDER THAT."
2. "NO BOUNTY OR MYSTERY BOUNTY TOURNAMENT SHOULD BE A FREEZEOUT, THEY SHOULD ALL
   HAVE REBUY TILL THE END OF REGISTRATION."
3. "ALL MYSTERY BOUNTY TOURNAMENTS NEED TO HAVE THE 'MYSTERY BOUNTY' AMOUNTS
   DISPLAYED IN THE REWARDS, AND SHOW WHICH 'BOUNTIES' ARE STILL AVAILABLE IN
   THAT TOURNAMENT, AND WHICH ONES WERE PAID OUT OR SELECTED ALREADY."

## 1. The Felt Masthead

`TablePage.tsx`: an MTT's second masthead line under "Club - Union" is now the
event's name and buy-in ("Midweek Mystery · 20 Buy-In · Hand #43291199"). The
"NLH Poker Tournament · Level N · blinds" text and the Next Blinds / Break
Starts In line beneath it are gone (`MastheadNextInfo` deleted). The name is
read from `tournaments.name` with the same row the buy-in already came from;
the buy-in label is the tab pill's own (`tournamentTabBuyInLabel`). Spins and
heads-up keep their prize line.

## 2. Bounty Tournaments Are Never Freezeouts

Read from production before the fix: every Diamond Arena bounty, PKO and mystery
bounty event, and every Midway one spawned before Oct 24, was a freezeout. The
Midway schedule rows got rebuys on Oct 20; the arena's copies never did, and
the Diamond door's default `max_rebuys = 0` reads as "no rebuys".

- Database (`20261022044423`): trigger
  `a3_bounty_mtt_rebuys_until_registration_closes` makes every paid pre-start
  bounty MTT a rebuy + re-entry event, `rebuy_levels = late_reg_levels`,
  rebuy at the entry total for the starting stack unless set, no count cap.
  All 76 events on the board were brought under it (asserted in the migration).
  `fn_guard_managed_game_lifecycle` gained one narrow root exception for the
  rebuy keys, the same pattern `20261021222049` used for the level clock.
- Engine: `bountyRebuyPolicy.ts` applies the identical rule at spawn, so the
  spawner and the database agree. Satellites, Sit & Gos, Spins and freerolls
  are untouched.

## 3. The Mystery Bounty Ladder Before It Is Sealed

Before the mystery phase opens the Rewards panel printed "Bounty Pool 0" and
"Chests Left 0 Of 0" on a 260-entry event holding a 2,080 bounty pool.
`src/lib/mysteryBountyProjection.ts` now runs the engine's own pure builders
(`mysteryPoolCents`, `buildInventoryAtUnit`) against the pool so far and the
chest count the activation rule will draw, so the panel shows every amount,
how many of each, "Available" and "Paid Out", marked Projected until sealed.
Once sealed, every tier stays listed for the whole event (no collapse), each
with its Available and Paid Out counts and who won it.
