import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { isLightningObserverSnapshot } from '../../src/utils/mapEngineSnapshot';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync('src/pages/TablePage.tsx', 'utf8');
const ast = ts.createSourceFile(
  'TablePage.tsx',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);

function callback(marker: string, variable = false) {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (variable && ts.isVariableDeclaration(node) && node.name.getText(ast) === marker) {
      found = (node.initializer as ts.CallExpression).arguments[0];
    } else if (
      !variable &&
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === 'useEffect'
    ) {
      const fn = node.arguments[0];
      if (fn?.getText(ast).includes(marker)) found = fn;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!found) throw new Error('Missing real route callback: ' + marker);
  return (
    ts.transpile('const run = ' + found.getText(ast), { target: ts.ScriptTarget.ES2022 }) +
    '\nreturn run;'
  );
}

function execute(code: string, deps: Record<string, unknown>) {
  const scoped = {
    lightningObserver: false,
    engineSnapshotRef: { current: null },
    isLightningObserverSnapshot,
    ...deps,
  };
  return new Function(...Object.keys(scoped), code)(...Object.values(scoped));
}

function fixture() {
  const ref = (current: unknown) => ({ current });
  let state: any = { heroSeat: 8, players: Array(9).fill(null) };
  state.players[0] = { id: 'other', stack: 10 };
  state.players[7] = { id: 'hero', isHero: true, stack: 19.9, status: 'sitting_out' };
  const deps: any = {
    userId: 'hero',
    leftSeatPendingRef: ref(false),
    heroSeatRef: ref(8),
    sittingOutIdsRef: ref(new Set(['hero'])),
    pendingSeatStackRef: ref(20),
    seatAcquiredAtRef: ref(100),
    heroSeatJoinedAtRef: ref(100),
    setPendingSeat: vi.fn(),
    setSelectedSeat: vi.fn(),
    setHeroRowStack: vi.fn(),
    setShowBuyInModal: vi.fn(),
    setShowRebuyModal: vi.fn(),
    setHeroSitsOutPerRow: vi.fn(),
    setShowSitOut: vi.fn(),
    setSitOutSince: vi.fn(),
    setSitOutNextHand: vi.fn(),
    setTableState: (update: any) => {
      state = update(state);
    },
    bootNoticeShownRef: ref(false),
  };
  return { deps, state: () => state };
}

function seatRead() {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(ast) === 'reload' &&
      node.initializer?.getText(ast).includes('setHeroRowStack')
    )
      found = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!found) throw new Error('Missing seat read');
  return (
    ts.transpile('const run = ' + found.getText(ast), { target: ts.ScriptTarget.ES2022 }) +
    '\nreturn run;'
  );
}

describe('authoritative seat read owns the final removal', () => {
  function readFixture(data: unknown, error: unknown = null) {
    const f = fixture();
    f.deps.heroSeatRef.current = 0;
    const chain: any = {};
    for (const key of ['from', 'select', 'eq']) chain[key] = () => chain;
    chain.is = async () => ({ data, error });
    const deps = {
      ...f.deps,
      tableId: 'table',
      tableStateRef: { current: f.state() },
      cancelled: false,
      supabase: chain,
      setSitOutStamps: vi.fn(),
      sameStamps: vi.fn(),
      applySeatRemoved: vi.fn(),
      evictionReasonRef: { current: 'sit_out_timeout' },
      paint: vi.fn(),
      reportError: vi.fn(),
    };
    return { f, deps, run: execute(seatRead(), deps) };
  }

  it('clears a rendered claim even when the instant hero ref is already zero', async () => {
    const t = readFixture([]);
    await t.run();
    expect(t.deps.applySeatRemoved).toHaveBeenCalledWith('sit_out_timeout', { announce: true });
  });

  it('does not turn a read failure into an eviction or silently hide it', async () => {
    const error = new Error('unavailable');
    const t = readFixture(null, error);
    await t.run();
    expect(t.deps.applySeatRemoved).not.toHaveBeenCalled();
    expect(t.deps.reportError).toHaveBeenCalledWith(error, 'TablePage.seat_sitout_poll_failed');
  });

  it('does not evict a purchase still within its existing join window', async () => {
    const t = readFixture([]);
    t.deps.seatAcquiredAtRef.current = Date.now();
    await t.run();
    expect(t.deps.applySeatRemoved).not.toHaveBeenCalled();
  });

  it.each([0, 20])('does not evict an authoritative active seat holding %s', async (stack) => {
    const t = readFixture([{ user_id: 'hero', stack, is_sitting_out: false }]);
    await t.run();
    expect(t.deps.applySeatRemoved).not.toHaveBeenCalled();
  });
});

describe('confirmed seat removal clears every local seat claim', () => {
  it.each(['sit_out_timeout', undefined])('clears paid placeholders for %s removal', (reason) => {
    const f = fixture();
    execute(callback('applySeatRemoved', true), f.deps)(reason, { announce: false });
    expect(f.state().heroSeat).toBe(0);
    expect(f.state().players[7]).toBeNull();
    expect(f.state().players[0].id).toBe('other');
    expect(f.deps.setPendingSeat).toHaveBeenCalledWith(null);
    expect(f.deps.setSelectedSeat).toHaveBeenCalledWith(null);
    expect(f.deps.pendingSeatStackRef.current).toBe(0);
    expect(f.deps.setHeroRowStack).toHaveBeenCalledWith(null);
    expect(f.deps.setShowRebuyModal).toHaveBeenCalledWith(false);
    expect(f.deps.setShowBuyInModal).toHaveBeenCalledWith(false);
  });

  it('does not resurrect a removed hero from the last pre-removal engine snapshot', () => {
    const f = fixture();
    execute(callback('applySeatRemoved', true), f.deps)('sit_out_timeout', { announce: false });
    const reconcile = vi.fn(() => ({ heroSeat: 8 }));
    execute(callback('const enginePlayers ='), {
      ...f.deps,
      USE_ENGINE_WS: true,
      engineSnapshot: { players: [{ seat: 8, user_id: 'hero' }] },
      tableState: f.state(),
      engineSeatMismatchReportedRef: { current: '' },
      reportError: vi.fn(),
      reconcileHeroSeatFromEngine: reconcile,
    })();
    expect(reconcile).not.toHaveBeenCalled();
    expect(f.state().heroSeat).toBe(0);
  });

  it('a delayed snapshot cannot repaint the removed hero, but keeps other players', () => {
    const map = execute(callback('nextPlayers', true), {
      leftSeatPendingRef: { current: true },
      userId: 'hero',
      cardHoldSameHand: false,
    });
    expect(map({ id: 'hero', isHero: true, stack: 19.9 }, 7)).toBeNull();
    const other = { id: 'other', stack: 10 };
    expect(map(other, 0)).toBe(other);
  });

  it.each([0, 20])('keeps an unremoved waiting hero with stack %s', (stack) => {
    const map = execute(callback('nextPlayers', true), {
      leftSeatPendingRef: { current: false },
      userId: 'hero',
      cardHoldSameHand: false,
      prev: { players: [] },
    });
    const hero = { id: 'hero', isHero: true, stack };
    expect(map(hero, 7)).toBe(hero);
  });

  it.each([0, 20])('still reconciles a legitimate live seat with stack %s', (stack) => {
    const f = fixture();
    const reconcile = vi.fn(() => ({ heroSeat: 8 }));
    const state = { ...f.state(), heroSeat: 0, players: Array(9).fill(null) };
    execute(callback('const enginePlayers ='), {
      ...f.deps,
      USE_ENGINE_WS: true,
      engineSnapshot: { players: [{ seat: 8, user_id: 'hero', stack }] },
      tableState: state,
      engineSeatMismatchReportedRef: { current: '' },
      reportError: vi.fn(),
      reconcileHeroSeatFromEngine: reconcile,
    })();
    expect(reconcile).toHaveBeenCalled();
  });
});

it('neither hero recovery invariant claims a public observer whose ID is in the virtual hand', () => {
  const f = fixture();
  const reconcile = vi.fn(() => ({ heroSeat: 8 }));
  const state = { ...f.state(), heroSeat: 0 };
  state.players[7] = { ...state.players[7], isHero: false };
  f.deps.heroSeatRef.current = 0;
  const dependencies = {
    ...f.deps,
    lightningObserver: true,
    engineSnapshotRef: { current: { lightning_observer: true } },
    USE_ENGINE_WS: true,
    engineSnapshot: { lightning_observer: true, players: [{ seat: 8, user_id: 'hero' }] },
    tableState: state,
    engineSeatMismatchReportedRef: { current: '' },
    reportError: vi.fn(),
    reconcileHeroSeatFromEngine: reconcile,
  };
  execute(callback('const enginePlayers ='), dependencies)();
  execute(callback('const idx = tableState.players.findIndex'), dependencies)();
  expect(reconcile).not.toHaveBeenCalled();
  expect(f.deps.heroSeatRef.current).toBe(0);
  expect(state.players[7].isHero).toBe(false);
});
