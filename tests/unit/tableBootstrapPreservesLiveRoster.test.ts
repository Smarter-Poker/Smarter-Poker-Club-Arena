import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');

// Execute the real async bootstrap up to its metadata commit, with a deferred
// Supabase response. No copied updater: changing the owning page changes this test.
function bootstrapHarness() {
  const start = source.indexOf('async function loadTableInfo() {');
  const end = source.indexOf('const settings = (table.settings as any) || {};', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const script = ts.transpileModule(
    `let isMounted = true; ${source.slice(start, end)} }}
     return { run: loadTableInfo, cancel: () => { isMounted = false; } };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
  ).outputText;
  let answer!: (value: unknown) => void;
  const response = new Promise((resolve) => {
    answer = resolve;
  });
  let state: any = {
    tableId: 'table-a',
    players: [],
    positions: [],
    lastActions: [],
    lastBetAmounts: [],
  };
  const engineSnapshotRef = { current: null as unknown };
  const tableStateRef = { current: state };
  const query: any = { select: () => query, eq: () => query, maybeSingle: () => response };
  const env = {
    tableId: 'table-a',
    lightningRoomRef: { current: null },
    engineSnapshotRef,
    tableStateRef,
    supabase: { from: () => query },
    setTableState: (update: any) => {
      state = update(state);
    },
    setTableLoadFailure: vi.fn(),
    reportError: vi.fn(),
    parseTableArenaIdentity: () => ({ asset: 'chips', id: 'club-a' }),
    cashBuyInRange: () => ({ min: 10, max: 100 }),
    formatGameTitle: (name: string) => name,
    formatBlindPair: (small: number, big: number) => `${small}/${big}`,
    createEmptySeats: (width: number) => Array(width).fill(null),
  };
  const controller = new Function(...Object.keys(env), script)(...Object.values(env));
  return {
    ...controller,
    read: () => state,
    installLive: () => {
      engineSnapshotRef.current = { players: [{ seat: 1 }, { seat: 2 }] };
      state = {
        ...state,
        players: [
          { id: 'a', stack: 883 },
          { id: 'b', stack: 1117 },
        ],
        positions: ['SB', 'BB'],
        lastActions: ['call', 'check'],
        lastBetAmounts: [15, 30],
        maxPlayers: 2,
        blinds: '150/300',
        isFinalTable: true,
      };
      return state;
    },
    answer: () =>
      answer({
        data: {
          id: 'table-a',
          name: 'Heads Up',
          max_players: 2,
          game_type: 'tournament',
          tournament_id: 'tournament-a',
          small_blind: 15,
          big_blind: 30,
        },
        error: null,
      }),
  };
}

describe('late table bootstrap cannot erase a live engine roster', () => {
  it('preserves the hand when metadata resolves after the engine snapshot', async () => {
    const h = bootstrapHarness();
    const loading = h.run();
    const live = h.installLive();
    h.answer();
    await loading;
    for (const key of ['players', 'positions', 'lastActions', 'lastBetAmounts']) {
      expect(h.read()[key], key).toBe(live[key]);
    }
    expect(h.read().tableName).toBe('Heads Up');
    expect(h.read().blinds).toBe('150/300');
    expect(h.read().isFinalTable).toBe(true);
  });

  it('ignores the answer of an effect cancelled during identity hydration', async () => {
    const h = bootstrapHarness();
    const loading = h.run();
    h.cancel();
    const live = h.installLive();
    h.answer();
    await loading;
    expect(h.read()).toBe(live);
  });

  it('still creates the correct empty ring before any engine state exists', async () => {
    const h = bootstrapHarness();
    const loading = h.run();
    h.answer();
    await loading;
    expect(h.read().players).toEqual([null, null]);
    expect(h.read().maxPlayers).toBe(2);
  });
});

it('a seat/profile restore already in flight cannot replace a newer engine roster or hero', async () => {
  const ast = ts.createSourceFile(
    'TablePage.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  let callback: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isArrowFunction(node) &&
      node.body.getText(ast).includes('const widestSeat = existingSeats.reduce')
    ) {
      callback = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  expect(callback).toBeDefined();
  const code = ts.transpileModule(`const update = ${callback!.getText(ast)}; return update;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const engineSnapshotRef = { current: null as unknown };
  const heroSeatRef = { current: 2 };
  const env = {
    isMounted: true,
    table: { id: 'table-a' },
    engineSnapshotRef,
    existingSeats: [],
    MAX_SUPPORTED_SEATS: 9,
    heroSeatRef,
    profileMap: new Map(),
  };
  const update = new Function(...Object.keys(env), code)(...Object.values(env));
  let deliver!: () => void;
  const profileResponse = new Promise<void>((resolve) => {
    deliver = resolve;
  });
  const live = {
    tableId: 'table-a',
    players: [
      { id: 'opponent', stack: 883 },
      { id: 'hero', stack: 1117 },
    ],
    heroSeat: 2,
    maxPlayers: 2,
  };
  const restoring = profileResponse.then(() => update(live));
  engineSnapshotRef.current = { players: live.players };
  deliver();
  expect(await restoring).toBe(live);
  expect(heroSeatRef.current).toBe(2);
});

it.each([true, false])(
  'late time-bank restoration cannot overwrite a live allowance (mounted=%s)',
  async (isMounted) => {
    const start = source.indexOf('// ─── Initialize Time Bank state from DB');
    const end = source.indexOf('      }\n    }\n    loadTableInfo();', start);
    expect(end).toBeGreaterThan(start);
    const code = ts.transpileModule(source.slice(start, end), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const setTimeBankTimeRemaining = vi.fn();
    const setTimeBanksRemaining = vi.fn();
    const env = {
      isMounted,
      engineSnapshotRef: { current: { players: [] } },
      userId: 'hero',
      existingSeats: [{ user_id: 'hero', time_bank_remaining: 80, time_bank_uses_remaining: 4 }],
      setTimeBankTimeRemaining,
      setTimeBanksRemaining,
    };
    await Promise.resolve().then(() =>
      new Function(...Object.keys(env), code)(...Object.values(env))
    );
    expect(setTimeBanksRemaining).not.toHaveBeenCalled();
    expect(setTimeBankTimeRemaining).not.toHaveBeenCalled();
  }
);
