import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
vi.mock('../services/supabase.js', () => ({ supabase: {} }));
vi.mock('../services/financialAlerts.js', () => ({ raiseFinancialAlert: vi.fn(async () => {}) }));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
import { settleTournamentObligation } from './settleObligation.js';

const source = readFileSync('src/tournament/TournamentManagerEliminations.ts', 'utf8');
const ast = ts.createSourceFile('manager.ts', source, ts.ScriptTarget.Latest, true);
let block: ts.IfStatement | undefined;
function visit(node: ts.Node) {
  if (ts.isIfStatement(node) && node.expression.getText(ast).includes('bubble_protection === true'))
    block = node;
  ts.forEachChild(node, visit);
}
visit(ast);
if (!block) throw new Error('Original bubble-protection branch missing');
const compiled = ts.transpileModule('return async function() {' + block.getText(ast) + '}', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

async function run(receipt: Record<string, unknown>) {
  const owner = {
    tournamentId: 'event',
    bubbleProtectionPaid: false,
    finalFieldSize: vi.fn(async () => 3),
    broadcast: vi.fn(async () => undefined),
  };
  const settle = vi.fn(async () => receipt);
  const alerts = vi.fn(async () => undefined);
  const deps = {
    isSatellite: false,
    tournament: { bubble_protection: true, buy_in_amount: 20 },
    prize: 0,
    position: 3,
    userId: 'bubble-player',
    supabase: {},
    resolvePayoutStructure: () => [{ place: 1 }, { place: 2 }],
    settleTournamentObligation: settle,
    reportError: vi.fn(),
    raiseFinancialAlert: alerts,
  };
  await new Function(...Object.keys(deps), compiled)(...Object.values(deps)).call(owner);
  return { owner, settle, alerts };
}

describe('bubble protection announces only a confirmed full refund', () => {
  it.each([
    { ok: false, fully_settled: true, amount_paid: 20 },
    { ok: true, fully_settled: true, amount_paid: 10 },
    { ok: true, fully_settled: true },
    { ok: true, fully_settled: false, amount_paid: 10 },
    { ok: false, refused_reason: 'escrow_short' },
  ])('keeps an unconfirmed receipt pending: %j', async (receipt) => {
    const r = await run(receipt);
    expect(r.owner.bubbleProtectionPaid).toBe(false);
    expect(r.owner.broadcast).not.toHaveBeenCalledWith('bubble_protection_paid', expect.anything());
    expect(r.owner.broadcast).toHaveBeenCalledWith(
      'bubble_protection_pending',
      expect.objectContaining({ amount: 20 })
    );
  });
  it.each([
    { ok: true, fully_settled: true, amount_paid: 20, paid: 20 },
    { ok: true, fully_settled: true, amount_paid: 20, paid: 0, already_paid: 20 },
  ])('accepts a confirmed payment or replay: %j', async (receipt) => {
    const r = await run(receipt);
    expect(r.owner.bubbleProtectionPaid).toBe(true);
    expect(r.owner.broadcast).toHaveBeenCalledWith('bubble_protection_paid', {
      userId: 'bubble-player',
      position: 3,
      amount: 20,
    });
    expect(r.owner.broadcast).not.toHaveBeenCalledWith(
      'bubble_protection_pending',
      expect.anything()
    );
    expect(r.settle).toHaveBeenCalledTimes(1);
  });
});

it('checks the requested refund even when the real parser confirms a smaller settled obligation', async () => {
  const receipt = await settleTournamentObligation(
    {
      rpc: async () => ({
        data: {
          ok: true,
          fully_settled: true,
          amount_owed: 10,
          amount_paid: 10,
          remaining: 0,
          paid: 10,
          already_paid: 0,
          obligation_id: 'obligation',
        },
        error: null,
      }),
    },
    {
      tournamentId: 'event',
      userId: 'bubble-player',
      kind: 'bubble_protection',
      amount: 20,
      source: 'test',
    },
    { maxAttempts: 1 }
  );
  expect(receipt.fully_settled).toBe(true);
  const r = await run({ ...receipt });
  expect(r.owner.bubbleProtectionPaid).toBe(false);
  expect(r.alerts).toHaveBeenCalledWith(
    'critical',
    'Tournament.bubble_protection_amount_unconfirmed',
    expect.any(String),
    expect.objectContaining({ requested_refund: 20, amount_paid: 10 })
  );
});
