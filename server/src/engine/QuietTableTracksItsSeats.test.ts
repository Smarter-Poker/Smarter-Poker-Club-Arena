/**
 * A QUIET TABLE TRACKS ITS SEATS (disconnect audit item 5, 2026-09-04)
 *
 * The presence FSM meets a player at the deal (registerPlayer in dealHand).
 * A seat taken since boot at a table BELOW the deal minimum was therefore
 * untracked: /heartbeat answered `connected: true` for a key the FSM did not
 * have, a closing socket was invisible, /away was answered `tracked: true`
 * and tracked nothing, and the abandoned-seat rule could never see them go.
 * Every pre-deal signal now registers a SEATED player on demand. A
 * spectator's signals still register nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/supabase.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../services/supabase.js');
  return { ...actual };
});

const { ServerTableEngine } = await import('./ServerTableEngine.js');

const TABLE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

function quietEngine() {
  const engine = new ServerTableEngine(TABLE) as any;
  engine.seatedPlayers = [{ user_id: 'seated', seat_number: 1, stack: 500, is_horse: false }];
  engine.tableInfo = { id: TABLE, tournament_id: null };
  return engine;
}

describe('pre-deal presence signals at a table that has not dealt', () => {
  let engine: any;
  beforeEach(() => {
    engine = quietEngine();
  });

  it('a heartbeat registers a seated player and reports them connected', () => {
    expect(engine.disconnectEngine.getState(TABLE, 'seated')).toBeNull();
    const res = engine.heartbeat('seated');
    expect(res.connected).toBe(true);
    expect(engine.disconnectEngine.getState(TABLE, 'seated')?.isConnected).toBe(true);
  });

  it('a socket close registers a seated player so the seat can become MISSING', () => {
    engine.notifyTransportDisconnect('seated');
    expect(engine.disconnectEngine.getState(TABLE, 'seated')).not.toBeNull();
  });

  it('an /away beacon registers a seated player and marks them away', () => {
    engine.notifyPageLeft('seated');
    expect(engine.disconnectEngine.isAway(TABLE, 'seated')).toBe(true);
  });

  it("a spectator's heartbeat, socket close and beacon register nothing", () => {
    engine.heartbeat('watcher');
    engine.notifyTransportDisconnect('watcher');
    engine.notifyPageLeft('watcher');
    expect(engine.disconnectEngine.getState(TABLE, 'watcher')).toBeNull();
  });
});
