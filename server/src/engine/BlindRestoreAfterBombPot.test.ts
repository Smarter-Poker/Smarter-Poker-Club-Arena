import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ rows: [] as any[], failPrior: false, queries: [] as any[] }));
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn((table: string) => {
      const q = { table, columns: '', normalOnly: false };
      db.queries.push(q);
      const chain: any = {
        select: (columns: string) => {
          q.columns = columns;
          return chain;
        },
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        is: (column: string, value: unknown) => {
          if (column === 'bomb_pot' && value === null) q.normalOnly = true;
          return chain;
        },
        maybeSingle: async () =>
          q.normalOnly && db.failPrior
            ? { data: null, error: { message: 'prior read failed' } }
            : {
                data: db.rows.find((r) => !q.normalOnly || r.bomb_pot == null) ?? null,
                error: null,
              },
      };
      return chain;
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
const { ServerTableEngine } = await import('./ServerTableEngine.js');
const { HandController } = await import('./HandController.js');
const { headsUpButtonSeat } = await import('./headsUpButton.js');
const row = (button: number, seats: number[], bomb = false) => ({
  button_seat: button,
  players: seats.map((seat) => ({ seat })),
  bomb_pot: bomb ? { ante_amount: 2 } : null,
});
beforeEach(() => {
  db.rows = [];
  db.failPrior = false;
  db.queries = [];
});
async function restored() {
  const e = new ServerTableEngine('dddddddd-dddd-dddd-dddd-dddddddddddd') as any;
  await e.restoreButtonFromHistory();
  return e;
}
describe('actual engine blind anchor restoration', () => {
  it('keeps the latest button but restores the last actually posted BB before a bomb pot', async () => {
    db.rows = [row(7, [4, 7], true), row(4, [4, 7])];
    const e = await restored();
    expect(e.lastButtonSeat).toBe(7);
    expect(e.lastBigBlindSeat).toBe(7);
  });
  it('walks past consecutive bomb pots without inventing a blind', async () => {
    db.rows = [row(4, [4, 7], true), row(7, [4, 7], true), row(4, [1, 4, 7])];
    const e = await restored();
    expect(e.lastButtonSeat).toBe(4);
    expect(e.lastBigBlindSeat).toBe(1);
    expect(db.queries[1].normalOnly).toBe(true);
  });
  it('leaves the blind anchor unknown if every settled hand was a bomb pot', async () => {
    db.rows = [row(7, [4, 7], true)];
    const e = await restored();
    expect(e.lastButtonSeat).toBe(7);
    expect(e.lastBigBlindSeat).toBe(0);
  });
  it('retains the known button when the earlier blind read fails', async () => {
    db.rows = [row(7, [4, 7], true), row(4, [4, 7])];
    db.failPrior = true;
    const e = await restored();
    expect(e.lastButtonSeat).toBe(7);
    expect(e.lastBigBlindSeat).toBe(0);
  });
  it.each([
    { button: 1, seats: [1, 4, 7], bb: 7 },
    { button: 4, seats: [4, 7], bb: 7 },
    { button: 7, seats: [4, 7], bb: 4 },
  ])('restores ordinary blind hand $button/$seats in one query', async ({ button, seats, bb }) => {
    db.rows = [row(button, seats)];
    const e = await restored();
    expect(e.lastButtonSeat).toBe(button);
    expect(e.lastBigBlindSeat).toBe(bb);
    expect(db.queries).toHaveLength(1);
  });
  it('does not create a button or blind without history', async () => {
    const e = await restored();
    expect(e.lastButtonSeat).toBe(0);
    expect(e.lastBigBlindSeat).toBe(0);
  });
});

it.each([1, 4, 7])(
  'posts and orders heads-up action correctly after seat %i leaves a three-handed table',
  (departed) => {
    const survivors = [1, 4, 7].filter((seat) => seat !== departed);
    const button = headsUpButtonSeat(survivors, 7)!;
    const bb = survivors.find((seat) => seat !== button)!;
    const h = new HandController(
      {
        tableId: 'hu-transition',
        handNumber: 2,
        gameVariant: 'nlh',
        smallBlind: 1,
        bigBlind: 2,
        rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
      },
      survivors.map((seat) => ({
        seat,
        user_id: `u${seat}`,
        username: `P${seat}`,
        stack: 100,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      })),
      button
    );
    h.start();
    let state = h.getState();
    expect(state.players.find((p) => p.seat === button)!.bet).toBe(1);
    expect(state.players.find((p) => p.seat === bb)!.bet).toBe(2);
    expect(bb).not.toBe(7);
    expect(state.currentPlayerSeat).toBe(button);
    expect(h.performAction(button, 'call')).toBe(true);
    expect(h.performAction(bb, 'check')).toBe(true);
    state = h.getState();
    expect(state.stage).toBe('flop');
    expect(state.currentPlayerSeat).toBe(bb);
  }
);
