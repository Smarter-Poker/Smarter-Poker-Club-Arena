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
type Options = { data?: unknown; rpcError?: unknown; throws?: boolean };
async function run(options: Options = {}) {
  const report = vi.fn();
  const log = vi.fn();
  const rpc = vi.fn(async () => {
    if (options.throws) throw new Error('transport interrupted');
    return {
      data:
        'data' in options
          ? options.data
          : { success: true, failed: 0, checked: 1, detail: [{ result: { success: true } }] },
      error: options.rpcError ?? null,
    };
  });
  const db = {
    rpc,
    from: vi.fn(() => {
      throw new Error('Separate accounting writes are forbidden');
    }),
  };
  const subject = build(db, report, () => '2026-09-07', { log, warn: vi.fn() });
  await subject.runWeeklyFinancialClose();
  return { report, log, rpc, from: db.from };
}
describe('one weekly accounting coordinator', () => {
  it.each([
    null,
    {},
    { success: false, failed: 0 },
    { success: true },
    { success: true, failed: 1, checked: 1, detail: [] },
    { success: true, failed: '0', checked: 0, detail: [] },
    { success: true, failed: 0, checked: 2, detail: [{ result: { success: true } }] },
    { success: true, failed: 0, checked: 1, detail: [{ result: { success: false } }] },
    { success: true, skipped: true, reason: 'unknown' },
  ])(
    'reports incomplete receipts without independent payouts or counter resets: %j',
    async (data) => {
      const result = await run({ data });
      expect(result.report).toHaveBeenCalledOnce();
      expect(result.log).not.toHaveBeenCalled();
      expect(result.from).not.toHaveBeenCalled();
    }
  );
  it.each([{ rpcError: { message: 'timeout' } }, { throws: true }])(
    'reports transport failure without a fallback payer: %j',
    async (options) => {
      const result = await run(options);
      expect(result.report).toHaveBeenCalledOnce();
      expect(result.rpc).toHaveBeenCalledOnce();
      expect(result.from).not.toHaveBeenCalled();
    }
  );
  it('logs completion only for complete scope receipts', async () => {
    const result = await run();
    expect(result.rpc).toHaveBeenCalledWith('fn_union_settlement_cascade_due', {});
    expect(result.log).toHaveBeenCalledOnce();
    expect(result.report).not.toHaveBeenCalled();
    expect(result.from).not.toHaveBeenCalled();
  });
  it.each(['maintenance_window', 'already_running'])(
    'does not claim completion for %s',
    async (reason) => {
      const result = await run({ data: { success: true, skipped: true, reason } });
      expect(result.log).not.toHaveBeenCalled();
      expect(result.report).not.toHaveBeenCalled();
    }
  );
});
