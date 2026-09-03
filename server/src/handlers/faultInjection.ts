/**
 * POST /admin/inject-fault — deliberately freeze a table to prove the watchdog
 * recovers it.
 *
 * WHY THIS EXISTS
 *
 * On 2026-08-15 a set of freeze-recovery mechanisms shipped, and a drill
 * immediately found two of them broken: the watchdog could never reach its
 * kill-and-rebuild tier (a rejected forced action still counted as progress),
 * and the Docker HEALTHCHECK restarted nothing because plain Docker does not
 * act on health status. Both were invisible to unit tests and to reading the
 * code. The only thing that found them was making the failure happen.
 *
 * The alternative to this endpoint is drilling by killing containers, which is
 * blunt, takes the whole platform down, and cannot exercise the per-table
 * recovery paths at all.
 *
 * SAFETY — this endpoint can take a table down, so it is gated four ways:
 *   1. Disabled unless FAULT_INJECTION_TOKEN is set. Absent -> route 404s.
 *   2. Requires that exact token in x-fault-token.
 *   3. REFUSES any table with a human seated. Drills run on horses only.
 *   4. The injected fault is self-limiting: it removes a clock the watchdog is
 *      expected to restore within one 10s heartbeat. It never touches chips,
 *      never writes to the database, and cannot outlive the current hand.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
import { readBody } from '../http/body.js';
import { reportError } from '../services/errorReporter.js';

/** Only the members this handler uses; the router passes the real engine. */
interface FaultEngine {
  /** True when no hand is in flight. The drill waits for this, so it never
   *  voids the hand in front of a player - horses included (CLAUDE.md 10.5).
   *  Optional so an engine that predates it degrades to the old behaviour
   *  rather than failing the request outright. */
  isBetweenHands?: () => boolean;
  /** Marks the engine dead so GameServer reaps and rebuilds it — the exact
   *  path that calls hub.dropTable() while players are still connected. */
  killForRestartPublic(reason: string): void;
  injectTurnStall(): {
    tableId: string;
    seat: number;
    hadClock: boolean;
    hadHorseTimer: boolean;
    handNumber: number;
  };
  seatedRoster(): Array<{ user_id: string; seat_number: number; is_horse: boolean }>;
  msSinceProgress(): number;
  getHandCount(): number;
}

export interface FaultDeps {
  // The router's shared AnyGameServer type is structurally narrower than the
  // real engine, so widen here rather than teach every other handler about
  // drill-only methods.
  gameServer: { getTableEngine(tableId: string): unknown };
}

export function faultInjectionEnabled(): boolean {
  return !!process.env.FAULT_INJECTION_TOKEN;
}

export async function handleInjectFault(
  req: IncomingMessage,
  res: ServerResponse,
  deps: FaultDeps
): Promise<void> {
  try {
    // Gate 1: off unless explicitly enabled. Fail closed.
    const token = process.env.FAULT_INJECTION_TOKEN;
    if (!token) return sendJSON(res, 404, { error: 'Not found' });

    // Gate 2: exact token match.
    if (req.headers['x-fault-token'] !== token) {
      return sendJSON(res, 401, { error: 'Unauthorized' });
    }

    // readBody returns the raw string, not a parsed object.
    let body: { tableId?: string; fault?: string };
    try {
      body = JSON.parse(await readBody(req)) as { tableId?: string; fault?: string };
    } catch {
      return sendJSON(res, 400, { error: 'Invalid JSON body' });
    }
    const tableId = body?.tableId;
    if (!tableId) return sendJSON(res, 400, { error: 'Missing tableId' });

    const engine = deps.gameServer.getTableEngine(tableId) as FaultEngine | null | undefined;
    if (!engine || typeof engine.injectTurnStall !== 'function') {
      return sendJSON(res, 404, { error: 'No engine for that table' });
    }

    // Gate 3: THE IMPORTANT ONE. Never drill on a table with a real player.
    const roster = engine.seatedRoster();
    const humans = roster.filter((p) => !p.is_horse);
    if (humans.length > 0) {
      return sendJSON(res, 409, {
        error: 'Refusing: human players are seated at this table',
        humanSeats: humans.map((h) => h.seat_number),
      });
    }
    if (roster.length < 2) {
      return sendJSON(res, 409, { error: 'Refusing: table is not actively dealing' });
    }

    // Gate 4: NEVER VOID A HAND IN FLIGHT - a horse's hand included.
    //
    // Gate 3 above refuses to disturb a human, and then kill_engine happily
    // tore down a table full of horses mid-hand. CLAUDE.md 10.5 settled that
    // exact shape once already, in the deploy drain gate: "PROTECT THE HAND,
    // NOT THE PLAYER". A horse pays the same buy-in out of the same club
    // wallet; a voided hand costs it the same chips it would cost anybody.
    //
    // isBetweenHands() is the same boundary the maintenance break waits for,
    // so this drill now takes the table at the moment every other restart path
    // takes it, rather than whenever the request happens to arrive.
    // (Every player at the table is owed the hand in front of them, horses
    // included - CLAUDE.md 10.5. That reasoning stays here in the comment
    // rather than in the response body: the title-case guard treats a `hint`
    // field as forward-facing copy, and an API error is not the place for an
    // essay anyway.)
    if (typeof engine.isBetweenHands === 'function' && !engine.isBetweenHands()) {
      return sendJSON(res, 409, {
        error: 'Refusing: a hand is in flight. Retry between hands.',
      });
    }

    const fault = body?.fault || 'turn_stall';
    if (fault !== 'turn_stall' && fault !== 'kill_engine') {
      return sendJSON(res, 400, { error: `Unknown fault type: ${fault}` });
    }

    if (fault === 'kill_engine') {
      // Drills the engine-rebuild path end to end: killForRestart -> GameServer
      // reaper -> hub.dropTable() -> discovery rebuilds. The question this
      // answers is whether a CONNECTED PLAYER keeps receiving afterwards, which
      // before the dropTable fix they did not — the rebuilt engine published
      // into an empty room while their socket stayed open and healthy forever.
      engine.killForRestartPublic('fault_injection_drill');
      return sendJSON(res, 200, {
        ok: true,
        fault,
        tableId,
        expect:
          'GameServer reaps the dead engine, dropTable() runs with live subscribers, discovery rebuilds within ~5s, and connected clients keep receiving.',
      });
    }

    const before = {
      msSinceProgress: engine.msSinceProgress(),
      handCount: engine.getHandCount(),
    };
    const injected = engine.injectTurnStall();

    return sendJSON(res, 200, {
      ok: true,
      fault,
      injected,
      before,
      expect:
        'Watchdog should re-arm the clock within one 10s heartbeat (Tier 1) and the table should resume dealing.',
    });
  } catch (err) {
    reportError(err, 'handlers.injectFault');
    return sendJSON(res, 500, { error: 'Internal error' });
  }
}
