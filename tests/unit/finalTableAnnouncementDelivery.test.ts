import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Execute the actual TablePage final-table handler with only its IO substituted.
const source = readFileSync('src/pages/TablePage.tsx', 'utf8');
const ast = ts.createSourceFile(
  'TablePage.tsx',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);
let handler = '';
function visit(node: ts.Node): void {
  if (ts.isIfStatement(node) && node.expression.getText(ast) === "data?.type === 'final_table'") {
    handler = node.thenStatement.getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
if (!handler) throw new Error('TablePage final-table consumer not found');
const compiled = ts.transpileModule(`function receive(data) ${handler}\nreturn receive;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function receiver() {
  const emit = vi.fn();
  const success = vi.fn();
  const query: any = {
    select: () => query,
    eq: () => query,
    order: () => query,
    maybeSingle: async () => ({ data: { prize_pool: 900 }, error: null }),
    then: (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve),
  };
  const format = { current: 'mtt' };
  const table = { current: { tournamentId: 'one', tableName: 'MTT' } };
  const receive = new Function(
    'tournamentFormatRef',
    'tableStateRef',
    'finalTableAnnouncedRef',
    'setTableState',
    'supabase',
    'masterBus',
    'toast',
    'reportError',
    compiled
  )(
    format,
    table,
    { current: new Set<string>() },
    vi.fn(),
    { from: () => query },
    { emit },
    { success },
    vi.fn()
  );
  return { receive, emit, success, format, table };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
describe('final table delivery across an ambiguous broadcast receipt', () => {
  it('announces once even when the same transition arrives while its roster read is pending', async () => {
    const h = receiver();
    h.receive({ payload: { playerCount: 9 } });
    h.receive({ payload: { playerCount: 9 } });
    await flush();
    expect(h.emit).toHaveBeenCalledTimes(1);
    expect(h.success).toHaveBeenCalledTimes(1);
    h.table.current.tournamentId = 'two';
    h.receive({ payload: { playerCount: 9 } });
    await flush();
    expect(h.emit).toHaveBeenCalledTimes(2);
  });
  it.each(['spin', 'sng', 'satellite'])('does not announce for %s', async (format) => {
    const h = receiver();
    h.format.current = format;
    h.receive({ payload: { playerCount: 3 } });
    await flush();
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.success).not.toHaveBeenCalled();
  });
});
