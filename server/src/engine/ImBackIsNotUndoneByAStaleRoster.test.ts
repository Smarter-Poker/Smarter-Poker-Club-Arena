/**
 * "I'M BACK" IS NOT UNDONE BY A ROW READ BEFORE IT LANDED (launch audit
 * 2026-10-05). sitBack clears the sit-out in memory and writes the row
 * without waiting; a roster read already in flight still said the player was
 * sitting out, on the original clock, and the per-pass restore sat them out
 * again seconds after they were told they were back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';

vi.mock('../services/supabase/client.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  maintenanceSupabase: {},
}));

const TABLE = 'aaaa2244-4444-4444-8444-444444444444';
const HUMAN = 'human-who-came-back';
const engines: any[] = [];

function engineWith(row: { is_sitting_out: boolean; sit_out_at: string | null }) {
  const engine = new ServerTableEngine(TABLE) as any;
  engines.push(engine);
  engine.running = true;
  engine.tableInfo = { id: TABLE, tournament_id: null, max_players: 6 };
  engine.seatedPlayers = [{ user_id: HUMAN, seat_number: 1, stack: 100, ...row }];
  return engine;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse('2026-10-06T05:00:00Z'));
});
afterEach(() => {
  for (const engine of engines.splice(0)) {
    engine.disconnectEngine.dispose(TABLE);
    engine.preciseTimer.dispose();
  }
  vi.useRealTimers();
});

describe("I'm Back is not undone by a stale roster", () => {
  it('a row from before the return does not sit the player out again', () => {
    // Sat out at 04:55:10; the stale read still carries that row.
    const stale = { is_sitting_out: true, sit_out_at: '2026-10-06T04:55:10Z' };
    const engine = engineWith(stale);
    engine.restoreSitOutsFromSeats();
    expect(engine.disconnectEngine.isSittingOut(TABLE, HUMAN)).toBe(true);

    // 05:00:00 - the player taps I'm Back.
    engine.returnedFromSitOutAtMs.set(HUMAN, Date.now());
    engine.disconnectEngine.sitBack(TABLE, HUMAN);
    expect(engine.disconnectEngine.isSittingOut(TABLE, HUMAN)).toBe(false);

    // The next pass still holds the row read before the write landed.
    vi.advanceTimersByTime(1_000);
    engine.restoreSitOutsFromSeats();
    expect(engine.disconnectEngine.isSittingOut(TABLE, HUMAN)).toBe(false);
    // And every pass after it, for as long as that row keeps arriving.
    vi.advanceTimersByTime(30_000);
    engine.restoreSitOutsFromSeats();
    expect(engine.disconnectEngine.isSittingOut(TABLE, HUMAN)).toBe(false);
  });

  it('a row with no stamp at all is also the old sit-out', () => {
    const engine = engineWith({ is_sitting_out: true, sit_out_at: null });
    engine.returnedFromSitOutAtMs.set(HUMAN, Date.now());
    engine.restoreSitOutsFromSeats();
    expect(engine.disconnectEngine.isSittingOut(TABLE, HUMAN)).toBe(false);
  });

  it('a sit-out the database stamped AFTER the return is restored', () => {
    const engine = engineWith({ is_sitting_out: true, sit_out_at: '2026-10-06T05:02:00Z' });
    engine.returnedFromSitOutAtMs.set(HUMAN, Date.parse('2026-10-06T05:00:00Z'));
    vi.setSystemTime(Date.parse('2026-10-06T05:02:05Z'));
    engine.restoreSitOutsFromSeats();
    expect(engine.disconnectEngine.isSittingOut(TABLE, HUMAN)).toBe(true);
    expect(engine.returnedFromSitOutAtMs.has(HUMAN)).toBe(false);
  });

  it('a player this engine never took back is restored exactly as before', () => {
    const engine = engineWith({ is_sitting_out: true, sit_out_at: '2026-10-06T04:55:10Z' });
    engine.restoreSitOutsFromSeats();
    expect(engine.disconnectEngine.isSittingOut(TABLE, HUMAN)).toBe(true);
  });
});
