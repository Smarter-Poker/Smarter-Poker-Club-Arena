# SERVER ARCHITECTURE — Agent Skill Reference

## Overview

The game server runs in `server/src/index.ts` as a Node.js process. It manages:

- Cash game table engines (ServerTableEngine)
- Tournament lifecycle (TournamentManager)
- Tournament scheduling (TournamentRecurringService)
- Player action processing via HTTP endpoint

## GameServer Class

- **File**: `server/src/index.ts`
- Singleton that manages all active games
- Discovery loops:
  - `discoverTables()` — Finds tables with status 'running' or 'waiting', creates ServerTableEngine for each
  - `discoverTournaments()` — Finds REGISTERING/RUNNING tournaments, creates TournamentManager for each
- Cleanup: Cancels stale REGISTERING/ANNOUNCED tournaments > 4 hours old
- HTTP action endpoint for player actions (fold, call, raise, etc.)

## ServerTableEngine

- **File**: `server/src/engines/ServerTableEngine.ts`
- Runs hand-by-hand for a single table
- Manages dealing, betting rounds, pot calculation, winner determination
- Broadcasts hand state via Supabase Realtime (`postgres_changes` on hand state)
- Tournament mode: uses `tournament_id` to link to tournament

## TournamentManager

- **File**: `server/src/index.ts` (inline class)
- Full tournament lifecycle: start, blind advancement, elimination, table balancing, finish
- Features:
  - Spin multiplier roll at start
  - Add-on period (60s after rebuy levels end)
  - Hand-for-hand bubble mode
  - Late reg prize pool finalization
  - 3-player minimum enforcement
  - Tournament rake settlement (union vs standalone)
- See TOURNAMENT_ARCHITECTURE.md for full details

## TournamentRecurringService

- **File**: `server/src/services/TournamentRecurringService.ts`
- Auto-creates recurring tournament instances
- Creates SNG, Spin, and scheduled MTT instances
- Registers horse players for new tournaments
- Runs on interval, checking for tournaments that need new instances

## Supabase Connection

- Uses service role key for full DB access
- All wallet operations use RPCs (SECURITY DEFINER)
- Realtime broadcasts for game state updates

## Key Files

- `server/src/index.ts` — Main entry, GameServer, TournamentManager
- `server/src/engines/ServerTableEngine.ts` — Per-table hand engine
- `server/src/services/TournamentRecurringService.ts` — Auto-scheduling
- `server/src/types.ts` — Type definitions

## Deployment

- The server runs on the Club Arena Hetzner engine host and is deployed only by
  `.github/workflows/auto-deploy-hetzner.yml` after a protected Club Arena merge.
- The Vite/React client publishes only through
  `.github/workflows/publish-club-arena.yml` to the Club Arena Hetzner static
  origin. The World Hub only routes the public URL; it does not publish assets.
- Manual workstation SSH, direct restarts, World Hub bundle syncs, and Vercel
  deployments are not Club Arena release paths.
