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
import { HorseSessionRotator } from './services/HorseSessionRotator.js';

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
  // FIX 2 (2026-07-24): on (re)connect / RESYNC, re-push the player's hole
  // cards for the current hand (public state alone leaves reconnecting players
  // blind and auto-folded).
  onResync: (tableId, userId) => {
    void gameServer.getTableEngine(tableId)?.rePushHoleCards(userId);
  },
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
  // V7 (2026-07-24): humanlike session rhythms — horses stand up after real
  // sessions via the SAME hand-boundary-safe leaveTable() path humans use;
  // the fleet manager reseeds fresh horses within its 30s cycle.
  new HorseSessionRotator((tableId) => gameServer.getTableEngine(tableId)).start();
});

// ═══════════════════════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════════════════

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[GameServer] Received shutdown signal...');
  // Refuse new actions immediately, then drain. GameServer.stop() stops engines
  // sequentially and each awaits a snapshot flush, so with 25-40 tables it
  // cannot finish inside Docker's default 10s grace — bound it so we exit
  // cleanly on our own terms instead of being SIGKILLed mid-flush.
  httpServer.close();
  await Promise.race([
    Promise.allSettled([gameServer.stop(), channelWs.close()]),
    new Promise((r) => setTimeout(r, 20_000)),
  ]);
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
/**
 * 2026-08-15: these handlers used to swallow and keep running.
 *
 * After an uncaughtException V8 has unwound a stack mid-operation. In this
 * codebase that concretely means a hand where chips left stacks but the pot was
 * never awarded, a postHandTasksPromise that will never resolve (the dealing
 * loop awaits it forever), or an actionLock stuck true. The process then kept
 * serving /action and kept answering "running":true while every table under it
 * was dead — strictly worse than crashing, because the supervisor was already
 * there and unused.
 *
 * Exiting costs ONE hand: `docker run --restart always` is back in ~2s,
 * cleanupStaleData cashes seats out idempotently, and discovery rebuilds every
 * table within a 5s cycle. Staying up costs every table, indefinitely.
 */
let exiting = false;
const fatal = (err: unknown, kind: string) => {
  reportError(err, kind);
  if (exiting) return;
  exiting = true;
  console.error(`[GameServer] FATAL (${kind}) — exiting for supervisor restart`);
  // Give Sentry a moment, but never hang on it.
  setTimeout(() => process.exit(1), 2000).unref();
};
process.on('uncaughtException', (err) => fatal(err, 'GameServer.Uncaught_exception'));
process.on('unhandledRejection', (err) => fatal(err, 'GameServer.Unhandled_rejection'));
