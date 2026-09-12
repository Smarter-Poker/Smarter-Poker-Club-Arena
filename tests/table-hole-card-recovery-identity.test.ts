import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Execute the actual recovery effect. Mounting the complete TablePage would
// introduce unrelated sockets, money controls and global page services.
const source = ts.createSourceFile(
  'TablePage.tsx',
  readFileSync('src/pages/TablePage.tsx', 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);
let effectSource = '';
function visit(node: ts.Node): void {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(source) === 'useEffect' &&
    node.arguments[0]?.getText(source).includes("'TablePage.hole_card_recovery_read_failed'")
  ) {
    if (effectSource) throw new Error('Recovery effect is ambiguous');
    effectSource = node.arguments[0].getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);
if (!effectSource) throw new Error('Actual recovery effect was not found');

function start(userId: string, response = Promise.resolve({ data: null, error: null })) {
  const filters: Array<[string, unknown]> = [];
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn((key: string, value: unknown) => {
      filters.push([key, value]);
      return query;
    }),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn(() => response),
  };
  const from = vi.fn((_table: string) => query);
  const setTableState = vi.fn();
  const dependencies = {
    tableId: '11111111-1111-4111-8111-111111111111',
    userId,
    supabase: { from },
    reportError: vi.fn(),
    heroCardFetchRef: { current: null },
    heroCardsRecoveredRef: { current: false },
    heroHandRef: { current: 0 },
    tableStateRef: { current: { players: [], communityCards: [] } },
    setTableState,
  };
  const javascript = ts.transpileModule(`const effect = ${effectSource}; effect();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const body = javascript.replace(/effect\(\);\s*$/, 'return effect();');
  const cleanup = new Function(...Object.keys(dependencies), body)(...Object.values(dependencies));
  return { cleanup, from, filters, setTableState, dependencies };
}

afterEach(() => vi.useRealTimers());

describe('actual private hole-card recovery effect', () => {
  it.each(['', 'guest'])('does not query or arm retries for unresolved identity %s', async (id) => {
    vi.useFakeTimers();
    const recovery = start(id);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(recovery.from).not.toHaveBeenCalled();
    expect(recovery.dependencies.heroCardFetchRef.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps every initial and retry read scoped to the resolved account and table', async () => {
    vi.useFakeTimers();
    const id = '22222222-2222-4222-8222-222222222222';
    const recovery = start(id);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(recovery.from).toHaveBeenCalledTimes(4);
    expect(recovery.from.mock.calls.every(([name]) => name === 'table_hole_cards')).toBe(true);
    expect(recovery.filters).toEqual(
      Array.from({ length: 4 }, () => [
        ['table_id', recovery.dependencies.tableId],
        ['user_id', id],
      ]).flat()
    );
    recovery.cleanup();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(recovery.from).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retires its hand rearm callback when the account or table owner unmounts', () => {
    vi.useFakeTimers();
    const recovery = start('22222222-2222-4222-8222-222222222222');
    const staleRearm = recovery.dependencies.heroCardFetchRef.current as unknown as () => void;
    recovery.cleanup();
    staleRearm();
    expect(recovery.from).toHaveBeenCalledTimes(1);
    expect(recovery.dependencies.heroCardFetchRef.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
