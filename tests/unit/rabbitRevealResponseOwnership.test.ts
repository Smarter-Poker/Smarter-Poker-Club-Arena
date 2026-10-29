import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { boardForRabbitReveal } from '../../src/components/table/retainedRabbitBoard';
import { canonicalCards } from '../../src/utils/tableGeometry';
import { rabbitVipUsageMonth } from '../../src/components/table/rabbitEntitlement';

const page = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');
const start = page.indexOf('  const handleRabbitReveal = useCallback(');
const end = page.indexOf('  // Mobile browsers throttle timers', start);
// Execute the actual callback without booting the full table, auth, and sockets.
const callback = ts.transpileModule(page.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const flop = [
  { rank: 'A', suit: 's' },
  { rank: 'K', suit: 'd' },
  { rank: '7', suit: 'c' },
];
const ghosts = [
  { rank: '2', suit: 'h' },
  { rank: '9', suit: 's' },
];

function harness() {
  vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  const response = new Promise((yes) => {
    finish = yes;
  });
  const deps = {
    tableId: 'table-one',
    rabbitLiveRequestRef: { current: 0 },
    rememberRabbitVipRemaining: vi.fn(),
    rabbitVipUsageMonth,
    rabbitViewerRef: { current: { tableId: 'table-one', userId: 'viewer-one' } as object | null },
    useCallback: (fn: unknown) => fn,
    requestRabbitHunt: vi.fn(() => response),
    rabbitHandNumberRef: { current: 40 as number | null },
    liveHandNumberRef: { current: 40 },
    lastBoardOfHandRef: { current: { handNumber: 40, cards: flop, stage: 'flop' } },
    setRabbitRevealedCards: vi.fn(),
    setRabbitRevealedHandNumber: vi.fn(),
    setRetainedRabbitBoard: vi.fn(),
    boardForRabbitReveal,
    canonicalCards,
    retainedRabbitTimerRef: { current: null },
    retainedRabbitExpiresAtRef: { current: 0 },
    RABBIT_REVEAL_MIN_VISIBLE_MS: 3000,
  };
  const reveal = new Function(...Object.keys(deps), callback + '\nreturn handleRabbitReveal;')(
    ...Object.values(deps)
  );
  return { deps, reveal, finish: () => finish({ success: true, cards: ghosts, board_length: 3 }) };
}

afterEach(() => vi.useRealTimers());

describe('a delayed Rabbit Hunt response belongs to the clicked hand', () => {
  it('retains the clicked hand and board when a new hand starts during payment', async () => {
    const { deps, reveal, finish } = harness();
    const buying = reveal();
    expect(deps.requestRabbitHunt).toHaveBeenCalledWith('table-one', 40);
    deps.rabbitHandNumberRef.current = null;
    deps.liveHandNumberRef.current = 41;
    deps.lastBoardOfHandRef.current = { handNumber: 41, cards: [], stage: 'preflop' };
    finish();
    await buying;
    expect(deps.setRetainedRabbitBoard).toHaveBeenCalledWith(
      expect.objectContaining({ handNumber: 40, cards: flop })
    );
  });

  it('returns replayer purchases to the replayer without replacing the live felt', async () => {
    const { deps, reveal, finish } = harness();
    const buying = reveal(39);
    finish();
    expect((await buying).success).toBe(true);
    expect(deps.setRetainedRabbitBoard).not.toHaveBeenCalled();
    expect(deps.setRabbitRevealedCards).not.toHaveBeenCalled();
  });

  it('never paints a paid response into a replacement viewer or closed table', async () => {
    for (const replacement of [{ tableId: 'table-two', userId: 'viewer-two' }, null]) {
      const { deps, reveal, finish } = harness();
      const buying = reveal();
      deps.rabbitViewerRef.current = replacement;
      finish();
      expect((await buying).success).toBe(false);
      expect(deps.setRetainedRabbitBoard).not.toHaveBeenCalled();
      expect(deps.setRabbitRevealedCards).not.toHaveBeenCalled();
    }
  });

  it('clears the retained and live copies on the same expiry beat', async () => {
    const { deps, reveal, finish } = harness();
    const buying = reveal();
    finish();
    await buying;
    deps.setRabbitRevealedCards.mockClear();
    await vi.advanceTimersByTimeAsync(3000);
    expect(deps.setRetainedRabbitBoard).toHaveBeenLastCalledWith(null);
    expect(deps.setRabbitRevealedCards).toHaveBeenLastCalledWith([]);
  });

  it('clears already-visible private cards and timers when the table or account changes', () => {
    const begin = page.indexOf('  // Private cards and an offer must never survive');
    const end = page.indexOf('  /**', begin);
    const effect = ts.transpileModule(page.slice(begin, end), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const deps = {
      useEffect: (fn: () => unknown, keys: unknown[]) => {
        expect(keys.slice(0, 2)).toEqual(['replacement-table', 'replacement-user']);
        return fn();
      },
      tableId: 'replacement-table',
      userId: 'replacement-user',
      rabbitViewerRef: { current: {} as unknown },
      rabbitStateViewerRef: { current: {} as unknown },
      setRabbitRevealedCards: vi.fn(),
      setRabbitRevealedHandNumber: vi.fn(),
      setRetainedRabbitBoard: vi.fn(),
      clearRabbitOffer: vi.fn(),
      retainedRabbitTimerRef: { current: 1 },
      rabbitExpiryTimerRef: { current: 2 },
      clearTimeout: vi.fn(),
    };
    new Function(...Object.keys(deps), effect)(...Object.values(deps));
    expect(deps.setRabbitRevealedCards).toHaveBeenCalledWith([]);
    expect(deps.setRabbitRevealedHandNumber).toHaveBeenCalledWith(null);
    expect(deps.setRetainedRabbitBoard).toHaveBeenCalledWith(null);
    expect(deps.clearRabbitOffer).toHaveBeenCalledWith(true);
    expect(deps.clearTimeout.mock.calls).toEqual([[1], [2]]);
  });

  it('does not paint late old-hand ghost cards on the new live board', () => {
    const from = page.indexOf('  const liveRabbitCards =');
    const to = page.indexOf(';', from) + 1;
    const select = new Function(
      'rabbitRevealedCards',
      'rabbitRevealedHandNumber',
      'retainedRabbitBoard',
      'retainedRabbitCards',
      'tableState',
      'rabbitViewIsCurrent',
      page.slice(from, to) + '\nreturn liveRabbitCards;'
    );
    expect(select(ghosts, 40, null, [], { handNumber: 41 }, true)).toEqual([]);
    expect(select(ghosts, 40, null, [], { handNumber: 40 }, true)).toEqual(ghosts);
    expect(select(ghosts, 40, null, [], { handNumber: 40 }, false)).toEqual([]);
  });
});

it('expires old ghosts on foreground resume even when the background timer was throttled', () => {
  const begin = page.indexOf('  // Mobile browsers throttle timers');
  const end = page.indexOf('  const handleRabbitReceipt', begin);
  const effect = ts.transpileModule(page.slice(begin, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const listeners: Record<string, () => void> = {};
  const remove = vi.fn();
  const clear = vi.fn();
  const board = vi.fn();
  const cards = vi.fn();
  const deps = {
    useEffect: (fn: () => unknown) => fn(),
    document: {
      hidden: false,
      addEventListener: (name: string, fn: () => void) => {
        listeners[name] = fn;
      },
      removeEventListener: remove,
    },
    window: {
      addEventListener: (name: string, fn: () => void) => {
        listeners[name] = fn;
      },
      removeEventListener: remove,
    },
    retainedRabbitExpiresAtRef: { current: Date.now() - 1 },
    retainedRabbitTimerRef: { current: 123 },
    clearTimeout: clear,
    setRetainedRabbitBoard: board,
    setRabbitRevealedCards: cards,
  };
  new Function(...Object.keys(deps), effect)(...Object.values(deps));
  listeners.visibilitychange();
  expect(board).toHaveBeenCalledWith(null);
  expect(cards).toHaveBeenCalledWith([]);
  expect(clear).toHaveBeenCalledWith(123);
  expect(deps.retainedRabbitExpiresAtRef.current).toBe(0);
});

it('a later live hunt owns the felt when two purchased hands finish out of order', async () => {
  const { deps, reveal, finish } = harness();
  const older = reveal();
  deps.rabbitHandNumberRef.current = 41;
  deps.lastBoardOfHandRef.current = { handNumber: 41, cards: [], stage: 'preflop' };
  deps.requestRabbitHunt.mockResolvedValueOnce({
    success: true,
    cards: [{ rank: 'Q', suit: 'h' }],
  } as any);
  await reveal();
  finish();
  expect((await older).success).toBe(true);
  expect(deps.setRetainedRabbitBoard).toHaveBeenCalledTimes(1);
  expect(deps.setRetainedRabbitBoard).toHaveBeenLastCalledWith(
    expect.objectContaining({ handNumber: 41 })
  );
});

it('a receipt read cannot adopt a new login while its module is loading', async () => {
  const api = readFileSync(resolve(__dirname, '../../src/services/GameServerAPI.ts'), 'utf8');
  const from = api.indexOf('export async function readRabbitHuntReceipt(');
  const to = api.indexOf('export async function requestRabbitHunt(', from);
  const code = ts.transpileModule(api.slice(from, to).replace('export ', ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let owner = 'old-login';
  let finish!: (v: unknown) => void;
  const module = new Promise((resolve) => {
    finish = resolve;
  });
  const read = vi.fn().mockResolvedValue({ success: true, cards: ghosts });
  const action = new Function(
    'storedLoginIdentity',
    'rabbitReceiptModule',
    code + ';return readRabbitHuntReceipt;'
  )(
    () => owner,
    () => module
  );
  const pending = action('table', 42);
  owner = 'new-login';
  finish({ readRabbitReceipt: read });
  expect(await pending).toBeNull();
  expect(read).not.toHaveBeenCalled();
});

it('remembers the authoritative remaining count even when the paid surface has closed', async () => {
  const { deps, reveal } = harness();
  let finish!: (v: any) => void;
  deps.requestRabbitHunt.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  const pending = reveal();
  deps.rabbitViewerRef.current = null;
  finish({ success: true, cards: ghosts, vip_remaining: 0 });
  await pending;
  expect(deps.rememberRabbitVipRemaining).toHaveBeenCalledWith('viewer-one', 0);
});

it('keeps a paid result but does not apply its old quota across the UTC monthly reset', async () => {
  const { deps, reveal } = harness();
  vi.setSystemTime(new Date('2026-10-31T23:59:59Z'));
  let finish!: (value: any) => void;
  deps.requestRabbitHunt.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  const pending = reveal();
  vi.setSystemTime(new Date('2026-11-01T00:00:01Z'));
  finish({ success: true, cards: ghosts, vip_remaining: 0 });
  expect(await pending).toMatchObject({ success: true, cards: ghosts, vipRemaining: null });
  expect(deps.rememberRabbitVipRemaining).toHaveBeenCalledWith('viewer-one', null);
});
