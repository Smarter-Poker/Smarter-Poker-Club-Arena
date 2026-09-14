/**
 * THE ENGINE STOPS HAMMERING A SATURATED DATABASE (2026-09-02)
 *
 * Two pins from one afternoon on a two-core database that was answering point
 * reads in 0.4-2.5 s:
 *
 *   1. 96 seat-first boards whose human window had closed hours earlier were
 *      each retried every 12 s and each came back "top-up added 0 of 1" -
 *      two RPCs a try, ~7 calls a second, about a whole core. A board that
 *      keeps coming back short is now asked less and less often (12 s doubling
 *      to ten minutes), and a board with a HUMAN in it keeps the 12 s cadence.
 *
 *   2. The websocket upgrade awaited four independent gates one after the
 *      other. Measured from a browser: 7-11 s to `open`, against a 15 s client
 *      timeout - "Connecting To The Table" on every felt. They run together.
 *
 * Source pins, bounded by structure (tests/helpers/sourceWindow rule).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceBlockAfter } from '../helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');
const GAME_SERVER = read('server/src/GameServer.ts');
const WS = read('server/src/transport/EngineWebSocketServer.ts');

describe('a seat-first board that will not fill is asked less and less often', () => {
  const fill = sliceBlockAfter(GAME_SERVER, 'private async fillPartialSeatFirstGame(');

  it('backs off on consecutive misses, capped at ten minutes', () => {
    expect(fill).toContain('seatFirstFillMisses');
    expect(fill).toMatch(/Math\.min\(12_000 \* 2 \*\* Math\.min\(misses, 6\), 10 \* 60_000\)/);
  });

  it('only the window-closed trigger backs off - a human is never left waiting', () => {
    expect(fill).toMatch(
      /const misses = windowClosed \? \(this\.seatFirstFillMisses\.get\(tournamentId\) \?\? 0\) : 0;/
    );
  });

  it('a filled board forgets its misses; a short one counts another', () => {
    const topUp = sliceBlockAfter(GAME_SERVER, 'private async topUpPartialSeatFirst(');
    expect(topUp).toContain(
      'if (added >= shortfall) this.seatFirstFillMisses.delete(tournamentId);'
    );
    expect(topUp).toMatch(
      /this\.seatFirstFillMisses\.set\(\s*tournamentId,\s*\(this\.seatFirstFillMisses\.get\(tournamentId\) \?\? 0\) \+ 1\s*\)/
    );
  });
});

describe('the websocket transport resolves durable gates in one database snapshot', () => {
  const gate = read('server/src/services/TableConnectionAccess.ts');

  it('uses the same complete authority for upgrade and mux without per-gate queries', () => {
    expect(WS.match(/await this\.authorizeConnection\(tableId,/g)).toHaveLength(2);
    expect(gate.match(/supabase\.rpc\(/g)).toHaveLength(1);
    expect(gate).toContain("'fn_ca_engine_table_connection_access'");
    expect(WS).not.toContain(".from('tables')");
    expect(WS).not.toContain(".from('table_seats')");
    expect(WS).not.toContain(".from('blacklists')");
    expect(WS).not.toContain('banCache');
  });

  it('keeps failed authority closed and checks live IP conflicts after durable authority', () => {
    expect(gate).toContain("reason: 'check_failed'");
    expect(gate).toContain('if (error');
    expect(gate).toContain('return refused;');
    expect(WS).not.toContain('.catch(() => false)');
    expect(WS.match(/viewerAccess.ipRestricted/g)).toHaveLength(2);
  });
});
