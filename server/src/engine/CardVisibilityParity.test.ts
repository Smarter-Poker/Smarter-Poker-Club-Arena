import { describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw Error('Unexpected database access in visibility fixture');
    }),
    rpc: vi.fn(() => {
      throw Error('Unexpected database RPC in visibility fixture');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
const { ServerTableEngine } = await import('./ServerTableEngine.js');
const { HandController } = await import('./HandController.js');
const { TableStateHub } = await import('../transport/TableStateHub.js');
function fixture() {
  const e = new ServerTableEngine('visibility-test') as any;
  const h = new HandController(
    {
      tableId: 'visibility-test',
      handNumber: 1,
      gameVariant: 'nlh',
      smallBlind: 1,
      bigBlind: 2,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    },
    [1, 2, 3].map((seat) => ({
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
    1
  );
  h.start();
  e.handController = h;
  e.showHandCards = new Map();
  e.tableInfo = {
    game_variant: 'nlh',
    small_blind: 1,
    big_blind: 2,
    max_players: 3,
    observer_show_cards: true,
  };
  e.handCount = 1;
  e.hub = { publish: vi.fn(), emitEvent: vi.fn() };
  return { e, h, state: (h as any).state };
}
async function live(e: any) {
  await e.broadcastCurrentState();
  return e.hub.publish.mock.calls.at(-1)[1];
}
function cards(snapshot: any, user: string) {
  return snapshot.players.find((p: any) => p.user_id === user).cards;
}
describe('private cards and voluntary reveal parity on actual engine snapshots', () => {
  it.each(['folded', 'mucked'])(
    'HTTP resync preserves exactly one voluntarily shown card from a %s hand',
    async (kind) => {
      const { e, state } = fixture();
      state.stage = 'showdown';
      state.currentPlayerSeat = -1;
      state.players[1].is_folded = kind === 'folded';
      e.currentHandShowdownResults = [{ userId: 'u2', mucked: kind === 'mucked' }];
      e.showHandCards.set('u2', new Set([1]));
      e.currentHandWinnerIds = ['u1'];
      const expected = [null, state.players[1].cards[1]];
      expect(cards(await live(e), 'u2')).toEqual(expected);
      expect(cards(e.getTableState('u1'), 'u2')).toEqual(expected);
      expect(cards(e.getTableState('u2'), 'u2')).toEqual(state.players[1].cards);
    }
  );
  it('never exposes picked cards before the hand ends', async () => {
    const { e } = fixture();
    e.showHandCards.set('u2', new Set([0, 1]));
    for (const snapshot of [await live(e), e.getTableState('u1'), e.getObserverState()])
      expect(cards(snapshot, 'u2')).toEqual([]);
  });
  it('keeps unshown folded and mucked hands private after showdown', async () => {
    const { e, state } = fixture();
    state.stage = 'showdown';
    state.players[1].is_folded = true;
    e.currentHandShowdownResults = [{ userId: 'u3', mucked: true }];
    for (const snapshot of [await live(e), e.getTableState('u1'), e.getObserverState()]) {
      expect(cards(snapshot, 'u2')).toEqual([]);
      expect(cards(snapshot, 'u3')).toEqual([]);
    }
  });
  it('tables only nonfolded hands during an all-in runout', async () => {
    const { e, state } = fixture();
    state.players[2].is_folded = true;
    e.runoutRevealActive = true;
    for (const snapshot of [await live(e), e.getTableState('u1'), e.getObserverState()]) {
      expect(cards(snapshot, 'u2')).toEqual(state.players[1].cards);
      expect(cards(snapshot, 'u3')).toEqual([]);
    }
  });
  it('never serializes the undealt deck or private cards into public state', async () => {
    const { e, state } = fixture();
    const snapshot = await live(e);
    expect(snapshot).not.toHaveProperty('deck');
    expect(snapshot.players.every((p: any) => p.cards.length === 0)).toBe(true);
    for (const p of state.players)
      expect(JSON.stringify(snapshot)).not.toContain(JSON.stringify(p.cards));
  });
});

it('private delivery cannot cross tables or replay to a new spectator', () => {
  const hub = new TableStateHub();
  const frames: Record<string, string[]> = {};
  function sub(id: string, userId?: string) {
    frames[id] = [];
    return { id, userId, readyState: 1, send: (s: string) => frames[id].push(s) };
  }
  hub.subscribe('one', sub('hero', 'hero'));
  hub.subscribe('two', sub('other-table', 'hero'));
  hub.subscribe('one', sub('villain', 'villain'));
  hub.sendToUser('one', 'hero', { kind: 'hole_cards', row: { cards: ['As', 'Ks'] } });
  hub.subscribe('one', sub('late-watcher'));
  expect(frames.hero.some((s) => s.includes('hole_cards'))).toBe(true);
  for (const id of ['other-table', 'villain', 'late-watcher'])
    expect(frames[id].some((s) => s.includes('hole_cards'))).toBe(false);
});
