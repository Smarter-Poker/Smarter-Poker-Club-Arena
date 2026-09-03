# POKER TOURNAMENTS — Complete Expert Reference

## 1. Tournament Types

### MTT (Multi-Table Tournament)

- Scheduled start, unlimited players, multiple tables, table balancing
- Late registration (typically 4-8 blind levels)
- Late reg players get full starting stack
- Tables break as players eliminate, final table forms
- Hand-for-hand on money bubble

### SNG (Sit & Go)

- Fixed player count (2, 3, 6, 9, or 10)
- Starts when all seats filled (NOT time-based)
- Single table (except multi-table SNGs for 18/27/45/90)
- No late registration
- Turbo or hyper-turbo structure common
- Auto-create new SNG when one fills (perpetual lobbies)

### Spin & Go / Spins

- 3 players, hyper-turbo
- Random prize pool multiplier (2x to 10000x buy-in)
- Multiplier determined at game start via weighted random
- Typical multiplier weights: 2x=~75%, 3x=~15%, 5x=~5%, 10x=~3%, 25x=~1%, 100x=~0.5%, 1000x=~0.01%
- Winner-take-all for low multipliers, shared payouts for high multipliers
- Starting stack: 500 chips, 10/20 blinds, 2-3 min levels
- Prize pool = buy*in * 3 \_ multiplier (all 3 entries contribute)

### XMTT (Cross-Club/Union Tournament)

- Runs across all clubs in a union
- Players from any member club can register
- Single prize pool, unified blind structure
- Host club manages, union distributes
- PokerBros-style club union tournaments

### Satellite

- Qualifiers that award tournament tickets (not cash)
- Top N players win seats to target tournament
- Remaining prize pool divided to bubble finishers
- Ticket value = target tournament buy-in

### Multi-Day

- Tournament pauses at end of each day
- Players bag chips, resume next day
- Chip counts preserved between days
- Status: RUNNING → PAUSED → RUNNING → COMPLETED

## 2. Tournament Variations/Formats

### Freezeout

- No rebuys, no re-entries, no add-ons
- You bust, you're out — pure form

### Rebuy

- Can purchase additional chips during rebuy period
- Typically first 4-8 blind levels
- Rebuy cost usually = original buy-in
- Rebuy chips usually = starting stack
- Can rebuy when at or below starting stack (some allow at any time)
- Multiple rebuys allowed

### Re-entry

- When eliminated, can re-enter as a new player
- Gets new starting stack, new seat assignment
- Re-entry period usually matches late registration period
- Each re-entry counts as new entry for prize pool calculation
- Different from rebuy: must be fully eliminated first

### Add-on

- One-time chip purchase available to all players
- Occurs at end of rebuy period (60-second window)
- Add-on chips usually > starting stack (e.g., 1.5x)
- All players can take add-on regardless of current stack
- Add-on cost may differ from buy-in

### Turbo

- Shortened blind levels: 3-5 minutes per level
- Same blind structure, just faster
- More variance, less deep play
- Common for SNGs and evening MTTs

### Super Turbo

- Very short levels: 2-3 minutes
- Starting stacks often reduced
- High variance format

### Hyper Turbo

- Shortest levels: 1-2 minutes
- Low starting stacks (25-50 BB)
- Used for Spins and some SNGs
- Nearly pure push/fold poker by level 3-4

### Bounty / Knockout (KO)

- Fixed bounty per player elimination
- Typically 50% of buy-in goes to bounty pool, 50% to prize pool
- Bounty credited immediately to knocker's wallet
- Buy-in example: $10 total = $5 prize pool + $5 bounty

### Progressive Knockout (PKO)

- Bounty GROWS as you eliminate players
- When you knock someone out:
  - 50% of their bounty → your wallet immediately
  - 50% of their bounty → added to YOUR head bounty
- Starting bounty = portion of buy-in (typically 50%)
- Creates snowball effect: big stacks have huge bounties
- Most popular bounty format on major sites

### Mystery Bounty

- Each player has a hidden bounty value
- Bounty value revealed only when player is eliminated
- Values range from 1x to 500x+ base bounty
- Usually kicks in after Day 1 or after a specific level
- Creates excitement on each elimination

### Shootout

- Each table plays until one winner
- Winners advance to next round
- Round-based elimination (NOT bracket-style — standard MTT table merging)
- Single table play at each round

### Double or Nothing

- Top half of players paid equally
- e.g., 10 players, top 5 each win 2x buy-in minus rake
- Very tight play near bubble

### Heads-Up

- 2 players per table, winner advances
- Round-based structure (8, 16, 32, 64 players)
- NOTE: Online poker does NOT use visual brackets — uses standard standings/leaderboard

## 3. Blind Structures (DETAILED — with breaks)

### Standard/Regular MTT (8-10 min levels)

Starting stack: 10,000-20,000 chips (100-200 BB)

```
Level 1:  25/50          (8 min)
Level 2:  50/100         (8 min)
Level 3:  75/150         (8 min)
Level 4:  100/200        (8 min)
Level 5:  100/200 a25    (8 min)
Level 6:  150/300 a40    (8 min)
— BREAK (5 min) —
Level 7:  200/400 a50    (8 min)
Level 8:  250/500 a60    (8 min)
Level 9:  300/600 a75    (8 min)
Level 10: 400/800 a100   (8 min)
Level 11: 500/1000 a125  (8 min)
Level 12: 600/1200 a150  (8 min)
— BREAK (5 min) —
Level 13: 800/1600 a200  (8 min)
Level 14: 1000/2000 a250 (8 min)
Level 15: 1200/2400 a300 (8 min)
Level 16: 1500/3000 a400 (8 min)
Level 17: 2000/4000 a500 (8 min)
Level 18: 2500/5000 a600 (8 min)
— BREAK (5 min) —
Level 19: 3000/6000 a750   (8 min)
Level 20: 4000/8000 a1000  (8 min)
Level 21: 5000/10000 a1250 (8 min)
Level 22: 6000/12000 a1500 (8 min)
Level 23: 8000/16000 a2000 (8 min)
Level 24: 10000/20000 a2500 (8 min)
— BREAK (5 min) —
Level 25: 12000/24000 a3000  (8 min)
Level 26: 15000/30000 a4000  (8 min)
Level 27: 20000/40000 a5000  (8 min)
Level 28: 25000/50000 a6000  (8 min)
Level 29: 30000/60000 a7500  (8 min)
Level 30: 40000/80000 a10000 (8 min)
```

### Turbo MTT (3-5 min levels)

Starting stack: 10,000 chips (100 BB)

```
Level 1:  25/50          (3 min)
Level 2:  50/100         (3 min)
Level 3:  75/150         (3 min)
Level 4:  100/200 a25    (3 min)
Level 5:  150/300 a40    (3 min)
Level 6:  200/400 a50    (3 min)
— BREAK (5 min) —
Level 7:  300/600 a75    (3 min)
Level 8:  400/800 a100   (3 min)
Level 9:  500/1000 a125  (3 min)
Level 10: 600/1200 a150  (3 min)
Level 11: 800/1600 a200  (3 min)
Level 12: 1000/2000 a250 (3 min)
— BREAK (5 min) —
Level 13: 1500/3000 a400  (3 min)
Level 14: 2000/4000 a500  (3 min)
Level 15: 2500/5000 a600  (3 min)
Level 16: 3000/6000 a750  (3 min)
Level 17: 4000/8000 a1000 (3 min)
Level 18: 5000/10000 a1250 (3 min)
— BREAK (5 min) —
Level 19: 6000/12000 a1500  (3 min)
Level 20: 8000/16000 a2000  (3 min)
Level 21: 10000/20000 a2500 (3 min)
Level 22: 12000/24000 a3000 (3 min)
Level 23: 15000/30000 a4000 (3 min)
Level 24: 20000/40000 a5000 (3 min)
```

### Deep Stack MTT (12-15 min levels)

Starting stack: 25,000-50,000 chips (250-500 BB)

```
Level 1:  25/50            (15 min)
Level 2:  50/100           (15 min)
Level 3:  75/150           (15 min)
Level 4:  100/200          (15 min)
Level 5:  100/200 a25      (15 min)
Level 6:  150/300 a40      (15 min)
— BREAK (5 min) —
Level 7:  200/400 a50      (15 min)
Level 8:  250/500 a60      (15 min)
Level 9:  300/600 a75      (15 min)
Level 10: 400/800 a100     (15 min)
— BREAK (10 min) —
Level 11: 500/1000 a125    (15 min)
Level 12: 600/1200 a150    (15 min)
Level 13: 800/1600 a200    (15 min)
Level 14: 1000/2000 a250   (15 min)
— BREAK (10 min) —
Level 15: 1200/2400 a300   (15 min)
Level 16: 1500/3000 a400   (15 min)
Level 17: 2000/4000 a500   (15 min)
Level 18: 2500/5000 a600   (15 min)
— BREAK (10 min) —
Level 19: 3000/6000 a750    (15 min)
Level 20: 4000/8000 a1000   (15 min)
Level 21: 5000/10000 a1250  (15 min)
Level 22: 6000/12000 a1500  (15 min)
Level 23: 8000/16000 a2000  (15 min)
Level 24: 10000/20000 a2500 (15 min)
Level 25: 12000/24000 a3000 (15 min)
Level 26: 15000/30000 a4000 (15 min)
Level 27: 20000/40000 a5000 (15 min)
Level 28: 25000/50000 a6000 (15 min)
Level 29: 30000/60000 a7500 (15 min)
Level 30: 40000/80000 a10000 (15 min)
```

### Hyper-Turbo / Spin & Go (2 min levels)

Starting stack: 500 chips (25 BB)

```
Level 1:  10/20     (2 min)
Level 2:  15/30     (2 min)
Level 3:  20/40     (2 min)
Level 4:  30/60     (2 min)
Level 5:  50/100    (2 min)
Level 6:  75/150    (2 min)
Level 7:  100/200   (2 min)
Level 8:  150/300   (2 min)
Level 9:  200/400   (2 min)
Level 10: 300/600   (2 min)
Level 11: 400/800   (2 min)
Level 12: 500/1000  (2 min)
Level 13: 750/1500  (2 min)
Level 14: 1000/2000 (2 min)
Level 15: 1500/3000 (2 min)
```

### SNG 9-Max Standard (6-8 min levels)

Starting stack: 1,500 chips (75 BB)

```
Level 1:  10/20     (6 min)
Level 2:  15/30     (6 min)
Level 3:  20/40     (6 min)
Level 4:  25/50     (6 min)
Level 5:  50/100    (6 min)
Level 6:  75/150    (6 min)
Level 7:  100/200   (6 min)
Level 8:  150/300   (6 min)
Level 9:  200/400   (6 min)
Level 10: 300/600   (6 min)
Level 11: 400/800   (6 min)
Level 12: 500/1000  (6 min)
Level 13: 750/1500  (6 min)
Level 14: 1000/2000 (6 min)
Level 15: 1500/3000 (6 min)
```

## 4. Break Schedule Rules

- Standard: 5-minute break after every 6 levels (~48-60 min of play)
- Deep Stack: 10-minute break after every 4 levels (~60 min of play)
- Turbo: 5-minute break after every 6 levels (~18-30 min of play)
- Hyper/Spin: No breaks (tournament is very short)
- SNG: No breaks (single table, short format)
- Implementation: Breaks are levels with `isBreak: true` — blind timer pauses, countdown displayed, then play resumes

## 5. Starting Stacks

- Standard MTT: 10,000-20,000 chips (100-200 BB at level 1)
- Deep Stack MTT: 25,000-50,000 chips (250-500 BB at level 1)
- Turbo MTT: 5,000-10,000 chips (50-100 BB at level 1)
- SNG 6-max: 1,500 chips (75 BB at 10/20)
- SNG 9-max: 1,500 chips (75 BB at 10/20)
- Spin & Go: 500 chips (25 BB at 10/20)
- The golden rule: starting_chips / big_blind_at_level_1 = starting BB count

## 6. Payout Structures

### SNG Payouts

- 2-player: Winner takes all (100%)
- 3-player: 1st: 100% (winner take all) — standard for Spins
- 6-player: 1st: 65%, 2nd: 35%
- 9-player: 1st: 50%, 2nd: 30%, 3rd: 20%

### MTT Payouts (by field size)

- 2-9 players: Top 3 paid (SNG rules)
- 10-18 players: Top 3 paid (40/30/20 + bubble 10%)
- 19-27 players: Top 4 paid
- 28-36 players: Top 5 paid
- 37-45 players: Top 6 paid
- 46-54 players: Top 7 paid
- 55-63 players: Top 8 paid
- 64-72 players: Top 9 paid
- 73-90 players: Top 10 paid
- 91-180 players: Top 15% paid
- 181-360 players: Top 15% paid
- 361-720 players: Top 15% paid
- 721+ players: Top 15% paid

### Standard MTT Payout Percentages (50 players, 8 paid)

```
1st: 28.0%
2nd: 17.5%
3rd: 12.5%
4th: 9.5%
5th: 7.5%
6th: 6.0%
7th: 5.0%
8th: 4.0%
(Remaining: Not in the money)
```

### Standard MTT Payout Percentages (100 players, 15 paid)

```
1st: 22.0%
2nd: 14.0%
3rd: 10.0%
4th: 7.5%
5th: 6.0%
6th: 5.0%
7th: 4.0%
8th: 3.5%
9th: 3.0%
10th-12th: 2.5% each
13th-15th: 2.0% each
```

## 7. Prize Pool Calculation

- Basic: prize_pool = (buy_in - rake) \* total_entries
- With rebuys: prize_pool += rebuy_count \* (rebuy_cost - rebuy_rake)
- With add-ons: prize_pool += addon_count \* (addon_cost - addon_rake)
- With re-entries: each re-entry counts as a new entry
- Guaranteed prize: display_prize_pool = MAX(calculated_prize_pool, guaranteed_prize)
- Overlay: when guaranteed > actual (house covers difference)

## 8. Tournament Clock Display

Must show:

- Current level number
- Current blinds (SB/BB)
- Current ante
- Time remaining in current level
- Next level blinds (preview)
- Total players / Players remaining
- Average stack
- Prize pool
- Break countdown (when applicable)
- Hand-for-hand indicator (when on bubble)
- Rebuy/Add-on period indicator

## 9. Table Balancing Rules

- Maximum 1 player difference between any two tables
- Move players from largest table to smallest
- Move the player in the worst position (big blind due next = move them)
- Never move a player who is in the middle of a hand
- When a table breaks, distribute players evenly to remaining tables
- Final table forms when total remaining players ≤ table capacity (9 max)

## 10. Hand-for-Hand (Bubble Play)

- Activated when remaining players = paid positions + 1
- ALL tables must complete their current hand before any table deals the next hand
- Prevents slowplay exploitation (running out the clock at one table)
- Each table pauses after completing a hand, waits for all others
- Once all tables complete, all tables deal simultaneously
- Ends when a player busts (bubble bursts) or deal is made

## 11. Chip Race / Color Up

- When blinds increase, small denomination chips become unnecessary
- Race chips that can't divide evenly into new smallest denomination
- Each player gets 1 card per odd chip (standard method)
- Highest card wins each available chip
- No player can be eliminated by a chip race (minimum 1 chip of new denomination)
- Occurs at each level change where denominations change

## 12. Big Blind Ante (BBA)

- Modern tournament standard replacing per-player antes
- Big blind posts the ante for the entire table
- Ante amount = 1 BB typically
- Simplifies game flow, reduces ante collection time
- Dead players don't post ante
- Only BB posts, included in their forced bet

## 13. Re-entry vs Rebuy Distinction

- REBUY: Buy more chips while still at the table, keep your seat
  - Available when stack ≤ starting stack (or at any time, configurable)
  - Same seat, same table
  - Adds to existing stack
- RE-ENTRY: After elimination, register again as new entry
  - Gets entirely new starting stack
  - Random new seat/table assignment
  - Counts as new entry in tournament
  - Old entry is eliminated with position

## 14. Late Registration

- Period after tournament starts when new players can join
- Typically 4-8 blind levels
- New players get full starting stack regardless of current level
- Late reg players go to alternate list, seated when space available
- Late reg increases prize pool
- Prize pool not finalized until late reg ends

## 15. Key Formulas

- Starting BBs = starting_chips / big_blind_at_level_1
- Average stack = total_chips_in_play / players_remaining
- M-ratio (tournament health) = stack / (SB + BB + antes)
- Prize for position = prize_pool \* (payout_percentage / 100)
- Tables needed = ceil(players / table_capacity)
- Players per table = floor(players / tables) or ceil(players / tables) (balanced)

---

This document is the authoritative reference for all tournament poker implementation in Club Arena.
