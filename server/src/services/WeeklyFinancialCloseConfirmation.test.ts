import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync('src/services/RakebackSettlerService.ts', 'utf8');
const ast = ts.createSourceFile('settler.ts', source, ts.ScriptTarget.Latest, true);
const cls = ast.statements.find(
  (n): n is ts.ClassDeclaration =>
    ts.isClassDeclaration(n) && n.name?.text === 'RakebackSettlerService'
);
const method = cls?.members.find(
  (n) => ts.isMethodDeclaration(n) && n.name.getText(ast) === 'runWeeklyFinancialClose'
);
if (!method) throw new Error('Actual weekly close missing');
const compiled = ts.transpileModule(
  'class Subject { ' + method.getText(ast) + ' } return new Subject();',
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
).outputText;
const build = new Function('supabase', 'reportError', 'weekStart', 'console', compiled);
type Options = {
  data?: unknown;
  rpcError?: unknown;
  resetError?: unknown;
  latchError?: unknown;
  stateError?: unknown;
  closed?: boolean;
};
async function run(options: Options = {}) {
  const report = vi.fn();
  const log = vi.fn();
  const reset = vi.fn(() => Promise.resolve({ error: options.resetError ?? null }));
  const latch = vi.fn(() => Promise.resolve({ error: options.latchError ?? null }));
  const rpc = vi.fn(async () => ({
    data: 'data' in options ? options.data : { success: true, failed: 0 },
    error: options.rpcError ?? null,
  }));
  const db = {
    rpc,
    from(table: string) {
      return table === 'agents'
        ? { update: () => ({ gt: reset }) }
        : {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: options.closed ? { high_water_mark: '2026-09-07' } : null,
                  error: options.stateError ?? null,
                }),
              }),
            }),
            upsert: latch,
          };
    },
  };
  const subject = build(db, report, () => '2026-09-07', { log, warn: vi.fn() });
  subject.supabaseRpc = async () => {
    const { error } = await rpc();
    return { error };
  };
  await subject.runWeeklyFinancialClose();
  return { report, log, reset, latch, rpc };
}
describe('weekly financial close confirmation', () => {
  it.each([
    null,
    {},
    { success: false, failed: 0 },
    { success: true },
    { success: true, failed: 1 },
    { success: true, failed: '0' },
  ])('preserves counters and retry eligibility on incomplete invoice receipt %j', async (data) => {
    const result = await run({ data });
    expect(result.reset).not.toHaveBeenCalled();
    expect(result.latch).not.toHaveBeenCalled();
    expect(result.report).toHaveBeenCalled();
  });
  it('preserves counters on invoice transport failure', async () => {
    const result = await run({ rpcError: { message: 'timeout' } });
    expect(result.reset).not.toHaveBeenCalled();
    expect(result.latch).not.toHaveBeenCalled();
  });
  it('does not close the week when reset fails', async () => {
    const result = await run({ resetError: { message: 'reset failed' } });
    expect(result.latch).not.toHaveBeenCalled();
    expect(result.report).toHaveBeenCalled();
  });
  it('reports latch failure without logging completion', async () => {
    const result = await run({ latchError: { message: 'write failed' } });
    expect(result.report).toHaveBeenCalled();
    expect(result.log.mock.calls.flat().some((s) => s.includes('close done'))).toBe(false);
  });
  it('closes only after successful invoices and reset', async () => {
    const result = await run();
    expect(result.reset).toHaveBeenCalledOnce();
    expect(result.latch).toHaveBeenCalledOnce();
    expect(result.report).not.toHaveBeenCalled();
  });
  it.each([{ closed: true }, { stateError: { message: 'unreadable' } }])(
    'does not act on a closed or unreadable week %j',
    async (options) => {
      const result = await run(options);
      expect(result.rpc).not.toHaveBeenCalled();
      expect(result.reset).not.toHaveBeenCalled();
      expect(result.latch).not.toHaveBeenCalled();
    }
  );
});
