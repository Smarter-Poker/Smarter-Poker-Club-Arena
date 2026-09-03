# REALTIME SYSTEM — Agent Skill Reference

## Overview

The Club Arena uses Supabase Realtime for all live updates. Two mechanisms:

1. **postgres_changes** — DB change subscriptions (auto-push on INSERT/UPDATE/DELETE)
2. **Broadcast** — Direct message passing between clients/server (no DB)

## Channels

### Club Channels: `club:{clubId}`

- Presence: member join/leave, online/away/playing status
- Broadcasts: table_created, table_closed, announcement, tournament_starting, jackpot_hit

### Tournament Channels: `tournament:{tournamentId}`

- Broadcasts: registration, elimination, level_up, winner, payout
- Events: player_registered, player_eliminated, level_up, final_table, heads_up, winner

### Tournament Break/Event Channel: `t-break-{tournamentId}`

- BREAK_START / BREAK_END — Tournament break overlay
- ADDON_PERIOD_START / ADDON_PERIOD_END — Add-on popup
- hand_for_hand — Bubble mode activation/deactivation
- bubble_burst — Someone eliminated on bubble
- prize_pool_finalized — Prize pool locked

### Tournament Add-On Channel: `t-addon-{tournamentId}`

- ADDON_PERIOD_START — Direct add-on notification (redundant with t-break for reliability)

### Table Channels: via TableWebSocket

- Game state sync: hand_state updates, player actions
- Managed by `useTableWebSocket` hook

### Hand Replay Channels: `hand:{handId}`

- Events: deal, action, street, showdown, pot_awarded

### Lobby Channel: `lobby:global`

- Club activity updates, tournament starting announcements

## Key Files

- `src/services/RealtimeChannelService.ts` — Channel management service
- `src/services/TableWebSocket.ts` — Table-specific WebSocket hook
- `src/lib/supabase.ts` — Supabase client + `subscribeToHandState()`

## How TablePage Subscribes

- `useTableWebSocket` for game state
- `subscribeToHandState` for server-dealt hands
- Subscribes to `t-break-{tournamentId}` for tournament events (break, addon, bubble)
- Subscribes to `t-addon-{tournamentId}` for add-on period

## Event Types (TournamentEvent)

```typescript
type: 'registration_open' |
  'registration_closed' |
  'tournament_started' |
  'player_registered' |
  'player_eliminated' |
  'level_up' |
  'final_table' |
  'heads_up' |
  'winner' |
  'payout' |
  'hand_for_hand' |
  'prize_pool_finalized' |
  'bubble_burst' |
  'BREAK_START' |
  'BREAK_END' |
  'ADDON_PERIOD_START' |
  'ADDON_PERIOD_END';
```
