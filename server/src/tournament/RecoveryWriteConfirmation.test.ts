import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { computePlacePrize } from './payoutMath.js';
import { resolvePayoutStructure } from './payoutStructure.js';
import { fieldIsStillLive } from './recoveryFieldGuard.js';
import { chipsCannotRank, noHandWasEverDealt } from './recoveryRankEvidence.js';

const source = readFileSync('src/tournament/tournamentRecovery.ts', 'utf8');
const ast = ts.createSourceFile('recovery.ts', source, ts.ScriptTarget.Latest, true);
const fn = ast.statements.find(
  (n): n is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(n) && n.name?.text === 'recoverStuckCompletingTournaments'
);
if (!fn) throw new Error('Actual recovery function missing');
const compiled = ts.transpileModule(
  fn.getText(ast).replace(/^export /, '') + '\nreturn recoverStuckCompletingTournaments;',
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }
).outputText;
const build = new Function(
  'supabase',
  'reportError',
  'raiseFinancialAlert',
  'settleTournamentObligation',
  'computePlacePrize',
  'resolvePayoutStructure',
  'fieldIsStillLive',
  'chipsCannotRank',
  'noHandWasEverDealt',
  'console',
  compiled
);

type Stage = 'survivor' | 'topup' | 'complete';
async function run(
  stage: Stage,
  receipt: { count?: number | null; error?: { message: string } } = { count: 1 },
  reads: Partial<Record<'deal' | 'field' | 'players', any>> = {}
) {
  const updates: Array<{ table: string; value: any; options: any }> = [];
  const report = vi.fn();
  const log = vi.fn();
  const settle = vi.fn(async (_db, args) => ({
    ok: true,
    fully_settled: true,
    amount_paid: args.amount,
    paid: args.amount,
  }));
  const rows =
    stage === 'topup'
      ? [{ id: 'p1', user_id: 'player-one', status: 'eliminated', position: 1, prize: 0, chips: 0 }]
      : [
          {
            id: 'p1',
            user_id: 'player-one',
            status: 'playing',
            position: null,
            prize: 0,
            chips: 1000,
          },
        ];
  const db = {
    rpc: vi.fn(async () => ({ data: { ok: true, already_settled: true }, error: null })),
    from(table: string) {
      let write: any;
      let options: any;
      let countRead = false;
      const query = {
        select(_columns?: string, opts?: any) {
          countRead = opts?.count === 'exact';
          return query;
        },
        eq() {
          return query;
        },
        in() {
          return query;
        },
        neq() {
          return query;
        },
        limit() {
          return query;
        },
        maybeSingle() {
          return query;
        },
        update(value: any, opts?: any) {
          write = value;
          options = opts;
          updates.push({ table, value, options });
          return query;
        },
        then(resolve: (value: any) => unknown, reject: (e: unknown) => unknown) {
          let result: any;
          if (write) {
            const current =
              table === 'tournaments'
                ? 'complete'
                : table === 'tournament_players'
                  ? 'status' in write
                    ? 'survivor'
                    : 'topup'
                  : 'tables';
            const response = current === stage ? receipt : { count: 1 };
            result = {
              error: response.error ?? null,
              count: options?.count === 'exact' ? response.count : null,
            };
          } else if (table === 'tournaments')
            result = {
              data: [
                {
                  id: 'event',
                  name: 'Audit',
                  prize_pool: 100,
                  payout_structure: [{ place: 1, percentage: 100 }],
                },
              ],
              error: null,
            };
          else if (table === 'tournament_payouts') result = reads.deal ?? { data: [], error: null };
          else if (table === 'hand_history') result = { data: { id: 'hand' }, error: null };
          else
            result = countRead
              ? (reads.field ?? { count: rows.length, error: null })
              : (reads.players ?? { data: rows, error: null });
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return query;
    },
  };
  await build(
    db,
    report,
    vi.fn(),
    settle,
    computePlacePrize,
    resolvePayoutStructure,
    fieldIsStillLive,
    chipsCannotRank,
    noHandWasEverDealt,
    { log, warn: vi.fn() }
  )('audit');
  return { updates, report, log, settle };
}

describe('recovery confirms paid-player stamps and completion before progressing', () => {
  for (const stage of ['survivor', 'topup', 'complete'] as const) {
    it.each([
      { count: 0 },
      { count: null },
      {},
      { count: 2 },
      { count: 1, error: { message: 'write failed' } },
    ])(`${stage} does not claim recovery after an unconfirmed write: %j`, async (receipt) => {
      const r = await run(stage, receipt);
      expect(r.settle).toHaveBeenCalledTimes(1);
      expect(r.report).toHaveBeenCalledWith(
        expect.any(Error),
        'GameServer.recoverStuckCompleting_per_tournament'
      );
      expect(r.updates.some((x) => x.table === 'tables')).toBe(false);
      expect(r.log.mock.calls.some((x) => String(x[0]).includes('Recovered stuck'))).toBe(false);
      if (stage !== 'complete')
        expect(r.updates.some((x) => x.table === 'tournaments')).toBe(false);
    });
    it(`${stage} preserves completion with confirmed writes`, async () => {
      const r = await run(stage);
      expect(r.settle).toHaveBeenCalledTimes(1);
      expect(r.report).not.toHaveBeenCalled();
      expect(r.updates.some((x) => x.table === 'tables')).toBe(true);
      expect(r.log.mock.calls.some((x) => String(x[0]).includes('Recovered stuck'))).toBe(true);
    });
  }
});

describe('recovery needs confirmed pricing and roster reads before payment', () => {
  it.each([
    ['deal', { data: null, error: null }],
    ['deal', { data: {}, error: null }],
    ['deal', { data: [], error: { message: 'unreadable' } }],
    ['field', { count: null, error: null }],
    ['field', { count: 0, error: null }],
    ['field', { count: -1, error: null }],
    ['field', { count: 1.5, error: null }],
    ['field', { count: 1, error: { message: 'unreadable' } }],
    ['players', { data: null, error: null }],
    ['players', { data: {}, error: null }],
    ['players', { data: [], error: { message: 'unreadable' } }],
  ])('does not pay or complete after unknown %s: %j', async (key, value) => {
    const r = await run('survivor', { count: 1 }, { [key as string]: value });
    expect(r.settle).not.toHaveBeenCalled();
    expect(r.updates).toEqual([]);
    expect(r.report).toHaveBeenCalled();
    expect(r.log).not.toHaveBeenCalled();
  });
});
