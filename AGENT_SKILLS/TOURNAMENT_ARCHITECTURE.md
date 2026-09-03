# TOURNAMENT ARCHITECTURE — Agent Skill Reference

## Overview

Tournaments are the core competitive feature of the Club Arena. They run entirely server-side via `TournamentManager` in `server/src/index.ts`. The client-side `TournamentEngine` in `src/engine/TournamentEngine.ts` is a legacy/parallel implementation that may still be used by the HorseOrchestrator for client-side orchestration.

## Tournament Lifecycle

### 1. Creation

- **File**: `src/components/tournament/CreateTournamentModal.tsx`
- Creates a tournament record in `tournaments` table with status `ANNOUNCED`
- Sets: buy_in_amount, buy_in_fee, starting_chips, blind_structure, game_type, variant, max_players, min_players, start_time, guaranteed_prize
- Tournament types: MTT, SNG, Spin, Bounty (KO), Progressive KO (PKO), Mystery Bounty, XMTT (Union MTT), Multi-Day
- Variants: freezeout, rebuy, addon, bounty, pko, mystery_bounty, spin

### 2. Registration

- **File**: `src/services/TournamentService.ts` → `registerForTournament()`
- Players register via tournament detail page
- Wallet deducted atomically via `deduct_player_wallet` RPC
- Transaction logged via `log_wallet_transaction` RPC
- `tournament_players` record created with status `registered`
- Prize pool recalculated on every registration

### 3. Start (Server-Side)

- **File**: `server/src/index.ts` → `TournamentManager.start()`
- `GameServer.discoverTournaments()` polls every few seconds for REGISTERING tournaments
- When start_time has passed AND current_players >= min_players (3), tournament starts
- Auto-cancels with refunds if 30+ minutes past start_time with < 3 players
- Steps:
  1. Enforce 3-player minimum (cancel with refunds if not met)
  2. Roll Spin multiplier (if Spin variant)
  3. Migrate registrations (registered → playing, set starting_chips)
  4. Create tournament tables in DB
  5. Seat players round-robin across tables
  6. Set status = RUNNING, started_at = now
  7. Start table engines (ServerTableEngine)
  8. Start blind timer
  9. Start elimination checker (every 5s)

### 4. Blind Level Advancement

- **File**: `server/src/index.ts` → `TournamentManager.startBlindTimer()`
- Uses recursive `setTimeout` for per-level durations
- Updates all tournament table blinds in DB
- Updates `tournaments.current_level`
- Triggers add-on period when blind level passes `rebuy_levels` cap
- Checks late reg finalization

### 5. Eliminations

- **File**: `server/src/index.ts` → `TournamentManager.startEliminationChecker()`
- Runs every 5 seconds
- Finds players with 0 chips in `tournament_players` (status = playing, chips <= 0)
- Position = number of players still playing (batch elimination gets same position)
- Credits prize to wallet if position is in payout structure
- Logs wallet transaction
- Marks seat as left in `table_seats`
- When 1 player remains → finishTournament

### 6. Prize Pool

- **File**: `src/services/TournamentService.ts` → `recalculatePrizePool()`, `finalizePrizePool()`
- Recalculated on every registration, rebuy, and add-on
- Formula: `(entries * buy_in) + (rebuys * rebuy_cost) + (addons * addon_cost)`
- Uses `Math.max(calculated, guaranteed)` to honor guarantees
- Finalized when late reg closes or add-on period ends
- `prize_pool_finalized` flag prevents further changes

### 7. Add-On Period

- **File**: `server/src/index.ts` → `TournamentManager.triggerAddOnPeriod()`
- **File**: `src/components/table/AddOnModal.tsx`
- **File**: `src/pages/TablePage.tsx` (subscription)
- Triggered when blind level passes `rebuy_levels` cap
- 60-second window for all players to accept/decline
- Broadcasts `ADDON_PERIOD_START` via Supabase Realtime on channels:
  - `t-break-{tournamentId}` (tournament_event)
  - `t-addon-{tournamentId}` (addon_event)
- TablePage listens for both channels, shows AddOnModal
- Accept: calls `TournamentService.processAddOn()` → wallet deduction → chips added
- Decline/timeout: modal dismisses
- Each player gets max 1 add-on (enforced via wallet_transactions duplicate check)
- After 60s: broadcasts `ADDON_PERIOD_END`, finalizes prize pool

### 8. Hand-For-Hand (Bubble)

- **File**: `server/src/index.ts` → elimination checker
- Activates when remaining players = paid positions + 1
- Only for multi-table tournaments (not Spin/SNG single-table)
- Broadcasts `hand_for_hand` event via Realtime
- Deactivates when bubble bursts (someone eliminated)
- Client-side TournamentEngine also has this logic for HeadlessTableEngine sync

### 9. Table Balancing

- **File**: `server/src/index.ts` → `TournamentManager.checkTableBalance()`
- When tables have < 3 players, merge into another table
- Only merges if combined players fit (≤ 9)
- Moves seats in DB, closes source table

### 10. Tournament Finish

- **File**: `server/src/index.ts` → `TournamentManager.finishTournament()`
- Awards 1st place prize
- Settles tournament rake:
  - If club is in a union → rake goes to union owner
  - If standalone club → rake goes to club owner
- Closes all tournament tables
- Sets status = COMPLETED

## Key Database Tables

- `tournaments` — Main tournament record (status, prize_pool, blind_structure, etc.)
- `tournament_players` — Players in tournament (status, chips, position, prize)
- `tournament_registrations` — Registration records (used for migration)
- `tables` — Physical table records (tournament tables have tournament_id set)
- `table_seats` — Seat assignments (stack, left_at for elimination)
- `wallets` — Player wallets (PLAYER, BUSINESS, PROMO types)
- `wallet_transactions` — All transaction audit trail

## Key Services

- `TournamentService` (src/services/TournamentService.ts) — Client-side tournament operations
- `TournamentManager` (server/src/index.ts) — Server-side tournament lifecycle
- `WalletService` (src/services/WalletService.ts) — Wallet operations
- `RealtimeChannelService` (src/services/RealtimeChannelService.ts) — Supabase Realtime

## Standing Directives

- ALL functionality on server
- NEVER use $ anywhere
- NO rounding — exact cent precision: `Math.trunc(value * 100) / 100`
- Horses = real users (NEVER call them bots)
- Minimum 3 players to start (cancel with refunds if not met)
- Tournament cancellation ONLY if < 3 players join
- Every transaction logged
- All wallet transactions through agents cashier button
