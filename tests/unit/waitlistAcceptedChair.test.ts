import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
const source = readFileSync('src/pages/TablePage.tsx', 'utf8');
const ast = ts.createSourceFile(
  'TablePage.tsx',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);
const declaration = source.indexOf('const autoBuyInFiredRef = useRef(false);');
let effect: ts.Block | undefined;
const visit = (node: ts.Node) => {
  if (
    !effect &&
    ts.isCallExpression(node) &&
    node.expression.getText(ast) === 'useEffect' &&
    node.getStart(ast) > declaration &&
    ts.isArrowFunction(node.arguments[0]) &&
    ts.isBlock(node.arguments[0].body) &&
    node.arguments[0].body.getText(ast).includes('let wantsBuyIn = openBuyInOnArrival')
  ) {
    effect = node.arguments[0].body;
  }
  ts.forEachChild(node, visit);
};
visit(ast);
if (!effect) throw new Error('The Accepted-Chair Effect Was Not Found');
const body = ts.transpile(
  effect.statements.map((statement) => statement.getFullText(ast)).join('\n'),
  {
    target: ts.ScriptTarget.ES2022,
  }
);
function fixture(overrides: Record<string, unknown> = {}) {
  const d = {
    autoBuyInFiredRef: { current: false },
    leftSeatPendingRef: { current: false },
    openBuyInOnArrival: true,
    acceptedChair: 0,
    location: { pathname: '/table/destination' },
    window: { location: { search: '' } },
    tableId: 'destination',
    tableState: { arenaAsset: 'chips', players: [null, null, null], heroSeat: 0 },
    engineSnapshot: { table_id: 'destination', players: [{ seat: 1, user_id: 'other' }] },
    heroSeatRef: { current: 0 },
    userId: 'viewer',
    handleSeatClick: vi.fn(),
    ...overrides,
  };
  return { d, run: () => new Function(...Object.keys(d), body)(...Object.values(d)) };
}
describe('an accepted waiting-list chair opens the destination buy-in', () => {
  it('carries explicit acceptance without relying on the global URL', () => {
    const f = fixture();
    f.run();
    expect(f.d.handleSeatClick).toHaveBeenCalledExactlyOnceWith(2);
    f.run();
    expect(f.d.handleSeatClick).toHaveBeenCalledTimes(1);
  });
  it('waits for the destination snapshot and never selects an occupied bootstrap chair', () => {
    const f = fixture({ engineSnapshot: null });
    f.run();
    expect(f.d.handleSeatClick).not.toHaveBeenCalled();
    expect(f.d.autoBuyInFiredRef.current).toBe(false);
    (f.d as any).engineSnapshot = { table_id: 'destination', players: [{ seat: 1 }, { seat: 2 }] };
    f.run();
    expect(f.d.handleSeatClick).toHaveBeenCalledExactlyOnceWith(3);
  });
  it('waits for a live vacancy instead of consuming acceptance on a full opening snapshot', () => {
    const f = fixture({
      engineSnapshot: { table_id: 'destination', players: [{ seat: 1 }, { seat: 2 }, { seat: 3 }] },
    });
    f.run();
    expect(f.d.autoBuyInFiredRef.current).toBe(false);
    (f.d as any).engineSnapshot = { table_id: 'destination', players: [{ seat: 1 }] };
    f.run();
    expect(f.d.handleSeatClick).toHaveBeenCalledExactlyOnceWith(2);
  });
  it('never reopens a departed seat from a retained buy-in query', () => {
    const f = fixture({
      leftSeatPendingRef: { current: true },
      openBuyInOnArrival: true,
      window: { location: { search: '?buyin=1' } },
    });
    f.run();
    f.run();
    expect(f.d.handleSeatClick).not.toHaveBeenCalled();
    expect(f.d.autoBuyInFiredRef.current).toBe(false);
  });
  it("does not spend another mounted table's buy-in query", () => {
    const f = fixture({
      openBuyInOnArrival: false,
      location: { pathname: '/table/another' },
      window: { location: { search: '?buyin=1' } },
    });
    f.run();
    expect(f.d.handleSeatClick).not.toHaveBeenCalled();
  });
});
