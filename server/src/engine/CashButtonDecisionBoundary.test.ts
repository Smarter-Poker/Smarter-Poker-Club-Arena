import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({ supabase: {}, maintenanceSupabase: {} }));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
import { ServerTableEngine } from './ServerTableEngine.js';

const engines: any[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.preciseTimer.dispose();
});

it.each([
  {
    name: 'rotation resumes after newcomers have been dealt in',
    seats: [1, 3, 5],
    veterans: [1, 3, 5],
    button: 1,
    bb: 5,
    expected: 3,
  },
  {
    name: 'one veteran keeps the button while newcomers enter',
    seats: [1, 3, 5],
    veterans: [1],
    button: 1,
    bb: 4,
    expected: 1,
  },
  {
    name: 'two veterans among three players are not heads-up',
    seats: [2, 3, 5],
    veterans: [2, 3],
    button: 1,
    bb: 3,
    expected: 2,
  },
  {
    name: 'a heads-up newcomer enters opposite the incumbent button',
    seats: [1, 5],
    veterans: [1],
    button: 1,
    bb: 3,
    expected: 1,
  },
  {
    name: 'a new three-player table gets its first button',
    seats: [1, 3, 5],
    veterans: [],
    button: 0,
    bb: 0,
    expected: 1,
  },
  {
    name: 'button busts entering heads-up',
    seats: [2, 3],
    veterans: [2, 3],
    button: 1,
    bb: 3,
    expected: 3,
  },
  {
    name: 'small blind busts entering heads-up',
    seats: [1, 3],
    veterans: [1, 3],
    button: 1,
    bb: 3,
    expected: 3,
  },
  {
    name: 'big blind busts entering heads-up',
    seats: [1, 2],
    veterans: [1, 2],
    button: 1,
    bb: 3,
    expected: 2,
  },
])(
  '$name: prediction agrees with the real deal',
  async ({ seats, veterans, button, bb, expected }) => {
    const engine = new ServerTableEngine('cash-button-boundary') as any;
    engines.push(engine);
    engine.tableInfo = { game_variant: 'nlh', game_type: 'cash', tournament_id: null };
    engine.lastButtonSeat = button;
    engine.lastBigBlindSeat = bb;
    engine.dealtInUserIds = new Set(veterans.map((s) => `u${s}`));
    engine.takePreparedHandNumber = () => 123;
    const players = seats.map((seat) => ({
      seat_number: seat,
      user_id: `u${seat}`,
      username: `P${seat}`,
      stack: 100,
    }));
    const predicted = engine.predictButtonSeat(players);

    // Exercise the actual deal through button selection, stopping before cards,
    // financial writes, or time banks. Eligibility is first recorded AFTER it.
    const stop = new Error('button selected');
    vi.spyOn(engine.dealtInUserIds, 'add').mockImplementation(() => {
      throw stop;
    });
    await expect(engine.dealHand(players)).rejects.toBe(stop);
    expect(engine.currentHandDealerSeat).toBe(expected);
    expect(predicted).toBe(expected);
  }
);
