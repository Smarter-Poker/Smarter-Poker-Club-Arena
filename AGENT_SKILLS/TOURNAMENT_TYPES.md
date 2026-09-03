# TOURNAMENT TYPES — Agent Skill Reference

## Overview

The Club Arena supports multiple tournament formats. Each has unique rules, UI treatment, and engine behavior.

---

## 1. MTT (Multi-Table Tournament)

- **Variant**: `freezeout`, `rebuy`, `addon`
- **DB**: `variant = 'freezeout'` (or `rebuy`/`addon`), `tournament_type = 'MTT'`
- **Players**: Unlimited (max_players = 0 means unlimited)
- **Tables**: Multiple, auto-created based on player count (ceil(players/9))
- **Blinds**: Level-based, advance on timer
- **Rebuys**: Optional, allowed during first N blind levels (`rebuy_levels`)
- **Add-on**: Optional, 60-second window after rebuy period ends
- **Late Registration**: Optional, `late_reg_mins` minutes after start
- **Guaranteed Prize**: `guaranteed_prize` field — display shows Max(pool, guarantee)
- **Hand-for-hand**: Activates on money bubble (multi-table only)
- **Display**: Shows as "MTT" card type in lobby

## 2. SNG (Sit & Go)

- **Variant**: `sng`
- **DB**: `variant = 'sng'`, `tournament_type = 'SNG'`
- **Players**: Fixed (typically 6 or 9, uses max_players)
- **Tables**: Single table
- **Start**: When max_players registers (NOT time-based)
- **Blinds**: Typically turbo structure
- **Rebuys**: None (freezeout)
- **Late Reg**: None
- **Hand-for-hand**: NOT used (single table)
- **Display**: Shows as "SNG" card type in lobby

## 3. Spin & Go

- **Variant**: `spin`
- **DB**: `variant = 'spin'`, `tournament_type = 'SPIN'`
- **Players**: 3 (always)
- **Tables**: Single table
- **Start**: When 3 players register
- **Multiplier**: Rolled at tournament START (not creation) — weighted random:
  - 2x: 750,000/1,000,000 (75%)
  - 3x: 200,000/1,000,000 (20%)
  - 5x: 40,000/1,000,000 (4%)
  - 10x: 8,000/1,000,000 (0.8%)
  - 25x: 1,500/1,000,000 (0.15%)
  - 100x: 400/1,000,000 (0.04%)
  - 1000x: 100/1,000,000 (0.01%)
- **Prize Pool**: `buy_in_amount * multiplier` (e.g., $10 buy-in × 2x = $20 prize pool; players pay 3×$10=$30, so club profit = $30 - $20 + 3×fee)
- **Stored**: `spin_multiplier`, `is_premium_spin` (≥100x) in tournaments table
- **Blinds**: Hyper-turbo (very short levels)
- **Hand-for-hand**: NOT used (single table)
- **Display**: Shows as "SPIN" card type with multiplier wheel animation
- **CRITICAL**: See SPIN_PROFITABILITY.md for rake/profit analysis

## 4. Bounty (Knockout)

- **Variant**: `bounty`
- **DB**: `is_bounty = true`, `bounty_amount > 0`
- **How it works**: Each player has a fixed bounty on their head. When eliminated, the knocker receives the bounty amount credited directly to their wallet.
- **DB tracking**: `tournament_players.bounties_collected`, `tournament_players.bounty_winnings`
- **Knocker detection**: Server tracks last hand winner for bounty attribution
- **Display**: Shows bounty value on each player's seat slot

## 5. Progressive KO (PKO)

- **Variant**: `pko`
- **DB**: `is_pko = true`, `bounty_amount > 0`
- **How it works**: Like bounty, but bounty value increases. When you knock someone out:
  - 50% of their bounty goes to you immediately
  - 50% gets added to YOUR bounty (making you a bigger target)
- **DB tracking**: `tournament_players.current_bounty` (grows as you collect)
- **Display**: Shows dynamic bounty value that changes during play

## 6. Mystery Bounty

- **Variant**: `mystery_bounty`
- **DB**: `is_mystery_bounty = true`, `mystery_bounty_min`, `mystery_bounty_max`
- **How it works**: Each elimination reveals a random bounty between min and max
- **Range**: Configurable min/max in tournament creation
- **Display**: Shows "?" bounty until revealed on elimination

## 7. XMTT (Union Multi-Table Tournament)

- **Variant**: `xmtt`
- **DB**: `tournament_type = 'XMTT'`, `union_id` set
- **How it works**: Runs across all clubs in a union. Players from any club can join.
- **Union Page**: Displayed on UnionDetailPage with all member clubs

## 8. Multi-Day

- **DB**: `tournament_type = 'MULTI_DAY'`
- **How it works**: Tournament pauses after each day's play ends, resumes next day
- **Status**: Uses ANNOUNCED → REGISTERING → RUNNING → PAUSED → RUNNING → COMPLETED

## 9. Turbo

- **Not a separate type** — it's a blind structure speed setting
- **DB**: `blind_structure = 'turbo'` (resolved to shorter level durations)
- **Applies to**: Any tournament type (MTT, SNG, Bounty, etc.)

## 10. Deep Stack

- **Not a separate type** — it's a blind structure + starting chips setting
- **DB**: `blind_structure = 'deepStack'`, higher `starting_chips`
- **Applies to**: Any tournament type

---

## Payout Structures (Auto-Resolved)

When DB has no explicit payout_structure, auto-selects based on entry count:

| Players | Payouts                                         |
| ------- | ----------------------------------------------- |
| ≤ 6     | 1st: 65%, 2nd: 35%                              |
| ≤ 9     | 1st: 50%, 2nd: 30%, 3rd: 20%                    |
| ≤ 18    | 1st: 40%, 2nd: 25%, 3rd: 18%, 4th: 10%, 5th: 7% |
| ≤ 35    | Top 20% paid                                    |
| 50+     | Top 15% paid                                    |

## Blind Structure Names

- `regular` / `standard` — 15-min levels
- `turbo` — 5-min levels
- `deepStack` / `deep` — 20-min levels, more starting chips

## Key Files

- `src/components/tournament/CreateTournamentModal.tsx` — Tournament creation form
- `src/services/TournamentService.ts` — Client tournament operations + bounty/PKO/spin
- `server/src/index.ts` → `TournamentManager` — Server-side lifecycle
- `src/engine/TournamentEngine.ts` — Client-side engine (parallel implementation)
- `src/pages/tournament/TournamentDetails.tsx` — Tournament detail/lobby page
- `src/pages/tournament/TournamentLobbyPage.tsx` — Tournament listing page
- `src/components/tournament/TournamentLobbyCard.tsx` — Lobby card component
