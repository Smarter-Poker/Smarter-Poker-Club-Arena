# SPIN & GO PROFITABILITY — Agent Skill Reference

## STATUS: FIXED (Session 48+)

## How Our Spins Work

3 players each pay `buy_in` (which includes a `fee` portion as rake).
A random multiplier is rolled at tournament start.
The winner receives `buy_in * multiplier` as the prize pool.

**Formula:** `prize_pool = buy_in * multiplier`

This is the PokerStars model: the multiplier applies to a SINGLE buy-in, not all three.

## Profitability Math

For each spin:

- Total collected from players: `3 * buy_in`
- Prize paid out: `buy_in * multiplier`
- Club profit: `3 * buy_in - buy_in * multiplier = buy_in * (3 - multiplier)`

Over many spins:

- Expected profit per spin: `buy_in * (3 - E[multiplier])`
- **For profitability: E[multiplier] must be < 3.0**

Example with buy_in = 10, fee = 1 (10% rake):

- Collected: 30 per spin
- Expected payout: 10 \* 2.2415 = 22.415
- Profit: 30 - 22.415 = 7.585 per spin (25.3% margin)
- Of that, 3.00 is explicit rake (fee \* 3), rest is multiplier structure margin

## Current Multiplier Table (IMPLEMENTED)

### Standard Spins

```
Multiplier | Weight    | Probability | EV Contribution
───────────┼───────────┼─────────────┼─────────────────
2          | 925,000   | 92.50%      | 1.8500
3          |  50,000   |  5.00%      | 0.1500
5          |  18,000   |  1.80%      | 0.0900
10         |   5,000   |  0.50%      | 0.0500
25         |   1,500   |  0.15%      | 0.0375
100        |     400   |  0.04%      | 0.0400 (premium)
240        |     100   |  0.01%      | 0.0240 (premium)
───────────┼───────────┼─────────────┼─────────────────
Total      | 1,000,000 | 100%        | 2.2415
```

### Hyper Spins

```
Multiplier | Probability | EV Contribution
───────────┼─────────────┼─────────────────
2          | 91.00%      | 1.8200
3          |  5.50%      | 0.1650
5          |  2.20%      | 0.1100
10         |  0.80%      | 0.0800
25         |  0.35%      | 0.0875
100        |  0.04%      | 0.0400 (premium)
240        |  0.01%      | 0.0240 (premium)
───────────┼─────────────┼─────────────────
Total      | 100%        | 2.3265
```

Both tables have E[multiplier] well below 3.0 = always profitable.

## Key Code Locations

1. **Client multiplier weights:** `src/services/TournamentService.ts` → `SPIN_MULTIPLIERS`
   - `standard` and `hyper` tables with probability-based selection
   - `spinMultiplier()` method picks using cumulative probability

2. **Client prize pool formula:** `src/engine/TournamentEngine.ts`
   - `const prizePool = Math.trunc(buyIn * spinResult.multiplier * 100) / 100`

3. **Server multiplier weights:** `server/src/index.ts` → TournamentManager.start()
   - Weight-based selection (weights sum to 1,000,000)
   - `const prizePool = Math.trunc(buyIn * spinMultiplier * 100) / 100`

## PREVIOUS BUG (Fixed)

Old formula: `prize_pool = (buy_in - fee) * 3 * multiplier`
Old EV: ~2.56 (server) / ~3.76 (client standard)

With the OLD formula, E[payout] = 2.56 _ net_buy_in _ 3 = 7.68 _ net_buy_in
Total collected = 3 _ buy_in. This required a 60.9% rake to break even.

**Fix applied:**

1. Changed formula to `buy_in * multiplier`
2. Replaced old multiplier weights (2x at 75%, 1000x max) with new profitable weights (2x at 92.5%, 240x max)
3. Removed the 1000x and 10000x multipliers (too volatile for club profitability)

## Premium Spin Detection

- `is_premium_spin = multiplier >= 100` (stored in tournaments table)
- Premium spins trigger special wheel animation on client
- Only 100x and 240x qualify as premium (0.05% combined chance)
