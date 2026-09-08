import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { boardForRabbitReveal } from '../../src/components/table/retainedRabbitBoard';

const page = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');
const start = page.indexOf('  const handleRabbitReveal = useCallback(');
const end = page.indexOf('  // Leaderboard state', start);
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
    useCallback: (fn: unknown) => fn,
    requestRabbitHunt: vi.fn(() => response),
    rabbitHandNumberRef: { current: 40 as number | null },
    liveHandNumberRef: { current: 40 },
    lastBoardOfHandRef: { current: { handNumber: 40, cards: flop, stage: 'flop' } },
    setRabbitRevealedCards: vi.fn(),
    setRabbitRevealedHandNumber: vi.fn(),
    setRetainedRabbitBoard: vi.fn(),
    boardForRabbitReveal,
    retainedRabbitTimerRef: { current: null },
    rabbitRevealClearTimerRef: { current: null },
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

  it('does not paint late old-hand ghost cards on the new live board', () => {
    const from = page.indexOf('  const liveRabbitCards =');
    const to = page.indexOf(';', from) + 1;
    const select = new Function(
      'rabbitRevealedCards',
      'rabbitRevealedHandNumber',
      'retainedRabbitBoard',
      'retainedRabbitCards',
      'tableState',
      page.slice(from, to) + '\nreturn liveRabbitCards;'
    );
    expect(select(ghosts, 40, null, [], { handNumber: 41 })).toEqual([]);
    expect(select(ghosts, 40, null, [], { handNumber: 40 })).toEqual(ghosts);
  });
});
