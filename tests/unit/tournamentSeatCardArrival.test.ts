import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { heroHoleCardsAreForThisHand } from '../../src/lib/tableCardDisplay';
import { earlyHeroCardsReady } from '../../src/utils/earlyHeroCards';

// Execute the maintained private-card handler and replay effect, including
// their real hand/table guards, without mounting unrelated purchase controls.
const source = ts.createSourceFile(
  'TablePage.tsx',
  readFileSync('src/pages/TablePage.tsx', 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);
let handler = '';
let replay = '';
let readSeat = '';
function visit(node: ts.Node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(source) === 'handleHoleCardPayload' &&
    node.initializer &&
    ts.isCallExpression(node.initializer)
  )
    handler = node.initializer.arguments[0].getText(source);
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(source) === 'useEffect' &&
    node.arguments[0]?.getText(source).includes('const decision = earlyHeroCardsReady')
  )
    replay = node.arguments[0].getText(source);
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(source) === 'reload' &&
    node.initializer?.getText(source).includes("'TablePage.seat_sitout_poll_failed'")
  )
    readSeat = node.initializer.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
if (!handler || !replay) throw new Error('Actual private-card pipeline not found');
function callback(text: string, dependencies: Record<string, any>) {
  const body =
    ts.transpileModule(`const callback = ${text};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText + '\nreturn callback;';
  return new Function(...Object.keys(dependencies), body)(...Object.values(dependencies));
}
function setup(hand = 20) {
  const state: any = { handNumber: hand, players: [], communityCards: [] };
  const dependencies: any = {
    userId: 'hero',
    tableId: 'table',
    engineSnapshotRef: { current: null },
    isLightningObserverSnapshot: () => false,
    tableStateRef: { current: state },
    tableState: state,
    heroHandRef: { current: hand },
    lightningRoomRef: { current: null },
    earlyHeroCardsRef: { current: null },
    earlyHeroCardsReady,
    heroHoleCardsAreForThisHand,
    reportError: vi.fn(),
    heroCardsRecoveredRef: { current: false },
    heroCardFetchRef: { current: vi.fn() },
    heroDealSoundHandRef: { current: 0 },
    lastDealPresentationHandRef: { current: 0 },
    dealSettledHandRef: { current: 0 },
    heldHeroDealSoundRef: { current: 0 },
    lightningHoldsHeroDealSound: () => false,
    soundService: { isEnabled: () => false },
    ambientSoundsAllowed: false,
    canonicalCards: (cards: any) => cards,
    cardsPreSortRef: { current: false },
    heroEngineCardOrderRef: { current: [] },
    heroHandOutcomeRef: { current: {} },
    setTableState: (update: any) => Object.assign(state, update(state)),
  };
  dependencies.handleHoleCardPayload = callback(handler, dependencies);
  return {
    state,
    dependencies,
    receive: (overrides = {}) =>
      dependencies.handleHoleCardPayload({
        new: {
          table_id: 'table',
          user_id: 'hero',
          hand_number: hand,
          cards: [
            { rank: 'A', suit: 'h' },
            { rank: 'K', suit: 'c' },
          ],
          ...overrides,
        },
      }),
    replay: () => callback(replay, dependencies)(),
  };
}
describe('private cards on a newly registered classic tournament seat', () => {
  it('keeps cards that precede the roster and paints them as soon as the hero arrives', () => {
    const f = setup();
    f.receive();
    expect(f.dependencies.earlyHeroCardsRef.current?.hand).toBe(20);
    f.state.players = [{ id: 'hero', isHero: true, holeCards: [] }];
    f.replay();
    expect(f.state.players[0].holeCards.map((c: any) => c.rank)).toEqual(['A', 'K']);
    expect(f.dependencies.heroCardFetchRef.current).not.toHaveBeenCalled();
  });
  it('waits for HAND_STARTED instead of losing future cards to the old-hand clear', () => {
    const f = setup();
    f.state.players = [{ id: 'hero', holeCards: [] }];
    f.receive({ hand_number: 21 });
    f.replay();
    expect(f.state.players[0].holeCards).toEqual([]);
    f.state.handNumber = 21;
    f.dependencies.heroHandRef.current = 21;
    f.replay();
    expect(f.state.players[0].holeCards).toHaveLength(2);
  });
  it('drops a held previous hand and ignores another user or table', () => {
    const f = setup();
    f.receive();
    f.state.handNumber = 21;
    f.dependencies.heroHandRef.current = 21;
    f.state.players = [{ id: 'hero', holeCards: [] }];
    f.replay();
    expect(f.dependencies.earlyHeroCardsRef.current).toBeNull();
    f.receive({ user_id: 'other' });
    f.receive({ table_id: 'other', hand_number: 21 });
    expect(f.state.players[0].holeCards).toEqual([]);
    expect(f.dependencies.reportError).toHaveBeenCalled();
  });
});

describe('the actual physical-seat read before the next hand', () => {
  async function read(
    row: any,
    options: { cancelled?: boolean; left?: boolean; error?: unknown } = {}
  ) {
    const state: any = { heroSeat: 0, maxPlayers: 6, players: [] };
    const q: any = {
      select: vi.fn(() => q),
      eq: () => q,
      is: async () => ({
        data: row ? [row] : [],
        error: options.error ?? null,
      }),
    };
    const d: any = {
      cancelled: options.cancelled ?? false,
      tableId: 'table',
      userId: 'hero',
      supabase: { from: () => q },
      setOwnSeatIdentity: vi.fn(),
      heroSeatRef: { current: 0 },
      leftSeatPendingRef: { current: options.left ?? false },
      MAX_SUPPORTED_SEATS: 10,
      setTableState: (update: any) => Object.assign(state, update(state)),
      tableStateRef: { current: state },
      presentRemoteSeatExitRef: { current: vi.fn() },
      applySeatRemoved: vi.fn(),
      pendingSeatStackRef: { current: 0 },
      setHeroRowStack: vi.fn(),
      setSitOutStamps: vi.fn(),
      sameStamps: vi.fn(),
      sittingOutIdsRef: { current: new Set() },
      seatAcquiredAtRef: { current: null },
      evictionReasonRef: { current: null },
      setHeroSitsOutPerRow: vi.fn(),
      setSitOutSince: vi.fn(),
      paint: vi.fn(),
      reportError: vi.fn(),
    };
    await callback(readSeat, d)();
    return { state, d, q };
  }
  it('shows server seat nine immediately while the dealt roster still omits the entrant', async () => {
    const f = await read({ user_id: 'hero', seat_number: 9, stack: 20000, occupancy_id: 'stay' });
    expect(f.state.heroSeat).toBe(9);
    expect(f.state.maxPlayers).toBe(9);
    expect(f.state.players).toEqual([]); // Never invent a hand, cards or action eligibility.
    expect(f.d.heroSeatRef.current).toBe(9);
    expect(f.d.reportError).not.toHaveBeenCalled();
    expect(f.q.select).toHaveBeenCalledWith(expect.stringContaining('seat_number'));
  });
  it.each([
    [{ user_id: 'other', seat_number: 9 }, {}],
    [{ user_id: 'hero', seat_number: 99 }, {}],
    [{ user_id: 'hero', seat_number: 9, leave_pending: true }, {}],
    [{ user_id: 'hero', seat_number: 9 }, { left: true }],
    [{ user_id: 'hero', seat_number: 9 }, { cancelled: true }],
    [{ user_id: 'hero', seat_number: 9 }, { error: new Error('unknown') }],
  ])(
    'does not claim another, invalid, leaving, cancelled or unknown seat',
    async (row, options) => {
      const f = await read(row, options);
      expect(f.state.heroSeat).toBe(0);
    }
  );
});
