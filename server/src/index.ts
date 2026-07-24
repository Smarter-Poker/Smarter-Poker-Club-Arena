/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SMARTER POKER GAME SERVER — 24/7 Server-Side Game Engine (bootstrap only)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This is the production game server entry point. It does five things:
 *   1. Instantiate `GameServer` (orchestrates all tables + tournaments)
 *   2. Attach the native WebSocket server at `/ws/table/:tableId`
 *   3. Attach the channel WebSocket server at `/ws/channel`
 *   4. Mount the HTTP router and `listen()` on PORT
 *   5. Register SIGINT/SIGTERM shutdown + uncaught-error handlers
 *
 * Phase U3 (2026-04-23): all routing logic lives in `./router.ts` + `./handlers/*`;
 * shared HTTP helpers in `./http/*`; game orchestration in `./GameServer.ts`.
 * This file is pure wiring — no business logic, no route handling.
 *
 * Phase U4 (2026-05-18): ChannelWebSocketServer added at /ws/channel to replace
 * Supabase Realtime for club presence, tournament events, lobby updates, and
 * hand replay streaming (Realtime migration).
 *
 * Deploy to: Hetzner VPS (primary), or any Node.js host.
 */

import { createServer } from 'http';
import { reportError } from './services/errorReporter.js';
import { tableStateHub } from './transport/TableStateHub.js';
import { EngineWebSocketServer } from './transport/EngineWebSocketServer.js';
import { ChannelWebSocketServer } from './transport/ChannelWebSocketServer.js';
import { channelHub } from './hub/ChannelHub.js';
import { GameServer } from './GameServer.js';
import { createRouter } from './router.js';
import { hydrateHorseMind } from './services/HorseMindHydrator.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const PORT = parseInt(process.env.PORT || '8080', 10);

// ═══════════════════════════════════════════════════════════════════════════════
// BOOTSTRAP
// ═══════════════════════════════════════════════════════════════════════════════

const gameServer = new GameServer();

// Phase 1.1 PR-2: Attach native WebSocket server at /ws/table/:tableId.
// Constructed BEFORE the HTTP server so the router closure can capture it.
const engineWs = new EngineWebSocketServer({
  hub: tableStateHub,
  tableExists: (tableId) => gameServer.getTableEngine(tableId) !== undefined,
});

// Phase U4: Channel WebSocket server at /ws/channel (Realtime migration).
const channelWs = new ChannelWebSocketServer();

const httpServer = createServer(createRouter({ gameServer, tableStateHub, engineWs, channelHub }));
engineWs.attach(httpServer);
channelWs.attach(httpServer);

httpServer.listen(PORT, () => {
  console.log(`[HTTP] Health check server listening on port ${PORT}`);
  console.log(`[WS]   Engine WebSocket server attached at /ws/table/:tableId`);
  console.log(`[WS]   Channel WebSocket server attached at /ws/channel`);
  gameServer.start().catch((err) => {
    reportError(err, 'GameServer.Fatal_error');
    process.exit(1);
  });
  // AUDIT V6 (2026-07-24): restore the horses' learned opponent memory from
  // the last 24h of real hand history. Fire-and-forget — never blocks boot,
  // never throws (fail-safe inside).
  void hydrateHorseMind();
});

// ═══════════════════════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════════════════

const shutdown = async () => {
  console.log('\n[GameServer] Received shutdown signal...');
  await gameServer.stop();
  await channelWs.close();
  httpServer.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  reportError(err, 'GameServer.Uncaught_exception');
  // Don't crash — keep running
});
process.on('unhandledRejection', (err) => {
  reportError(err, 'GameServer.Unhandled_rejection');
  // Don't crash — keep running
});
