import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { computePlacePrize, prizePoolAvailableToPlaces } from './payoutMath.js';
import { resolvePayoutStructure } from './payoutStructure.js';

const source = readFileSync('src/tournament/TournamentManagerEliminations.ts', 'utf8');
const ast = ts.createSourceFile('manager.ts', source, ts.ScriptTarget.Latest, true);
const manager = ast.statements.find(
  (n): n is ts.ClassDeclaration =>
    ts.isClassDeclaration(n) && n.name?.text === 'TournamentManagerEliminations'
);
const methods = ['eliminatePlayer', 'recalculateEliminatedPrizes'].map((name) => {
  const method = manager?.members.find(
    (n) => ts.isMethodDeclaration(n) && n.name.getText(ast) === name
  );
  if (!method) throw new Error(`Actual method ${name} is missing`);
  return method.getText(ast);
});
const deepestPlace = ast.statements.find(
  (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'deepestCanonicalPaidPlace'
);
if (!deepestPlace) throw new Error('Actual deepest-place resolver is missing');
const compiled = ts.transpileModule(
  `${deepestPlace.getText(ast)} class Subject { ${methods.join('\n')} } return Subject;`,
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }
).outputText;

function harness(
  options: {
    bubble?: boolean;
    pool?: number;
    field?: number;
    buyIn?: number;
    satellite?: boolean;
  } = {}
) {
  const tournament = {
    format_contract: 'mtt-v1',
    payout_structure: [
      { place: 1, percentage: 50 },
      { place: 2, percentage: 30 },
      { place: 3, percentage: 20 },
    ],
    prize_pool: options.pool ?? 1000,
    bubble_protection: options.bubble ?? true,
    buy_in_amount: options.buyIn ?? 100,
    variant: options.satellite ? 'satellite' : 'mtt',
  };
  const rows = [
    { user_id: 'second', position: 2, prize: 0 },
    { user_id: 'third', position: 3, prize: 0 },
  ];
  const selections: string[] = [];
  const rpc = vi.fn(async (name: string, request: any) => ({
    error: null,
    data:
      name === 'fn_ca_reprice_unpaid_tournament_place'
        ? {
            ok: true,
            tournament_id: 'event',
            user_id: request.p_user_id,
            prize: request.p_new_prize,
          }
        : { ok: true, claimed: true },
  }));
  const db = {
    rpc,
    from(table: string) {
      const query: any = {
        select(columns: string) {
          selections.push(columns);
          return query;
        },
        eq() {
          return query;
        },
        maybeSingle: async () => ({
          error: null,
          data: table === 'tournaments' ? tournament : { status: 'playing', username: 'Player' },
        }),
        then(resolve: (v: unknown) => void) {
          return Promise.resolve({ error: null, data: rows }).then(resolve);
        },
      };
      return query;
    },
  };
  const report = vi.fn();
  const Subject = new Function(
    'supabase',
    'reportError',
    'console',
    'computePlacePrize',
    'prizePoolAvailableToPlaces',
    'resolvePayoutStructure',
    'TournamentManagerBase',
    compiled
  )(
    db,
    report,
    { log: vi.fn() },
    computePlacePrize,
    prizePoolAvailableToPlaces,
    resolvePayoutStructure,
    { SWEEP_MUTATION_BATCH_SIZE: 100, UNRESOLVED_BUST_RETRY_MS: 100 }
  );
  const subject = Object.assign(new Subject(), {
    tournamentId: 'event',
    tournamentCache: tournament,
    finalFieldSize: async () => options.field ?? 4,
    eliminationMutationAllowed: () => true,
    eliminationWorkBudgetExpired: () => false,
    requestUrgentEliminationSweepAfter: vi.fn(),
    broadcast: vi.fn(async () => {}),
  });
  return { subject, rpc, report, selections };
}

describe('result amounts reserve the same bubble buy-in as terminal SQL', () => {
  it('records and broadcasts the funded second-place amount at elimination', async () => {
    const h = harness();
    expect(await h.subject.eliminatePlayer('second', 2)).toBe(true);
    expect(h.rpc).toHaveBeenCalledWith(
      'fn_eliminate_tournament_player_atomic',
      expect.objectContaining({ p_prize: 270, p_bubble_refund: 0 })
    );
    expect(h.subject.broadcast).toHaveBeenCalledWith(
      'player_eliminated',
      expect.objectContaining({ prize: 270 })
    );
    expect(
      h.selections.some((s) => s.includes('bubble_protection') && s.includes('buy_in_amount'))
    ).toBe(true);
  });
  it('reprices all unpaid finishers from the remaining 900-chip ladder', async () => {
    const h = harness();
    expect(await h.subject.recalculateEliminatedPrizes(1000)).toBe(true);
    expect(h.rpc.mock.calls.map(([, r]) => [r.p_user_id, r.p_new_prize])).toEqual([
      ['second', 270],
      ['third', 180],
    ]);
  });
  it.each([{ bubble: false }, { field: 3 }])(
    'keeps full-pool amounts when no bubble exists: %s',
    async (options) => {
      const h = harness(options);
      expect(await h.subject.eliminatePlayer('second', 2)).toBe(true);
      expect(h.rpc.mock.calls[0][1].p_prize).toBe(300);
      h.rpc.mockClear();
      expect(await h.subject.recalculateEliminatedPrizes(1000)).toBe(true);
      expect(h.rpc.mock.calls.map(([, r]) => r.p_new_prize)).toEqual([300, 200]);
    }
  );
  it.each([{ buyIn: 100.001 }, { pool: 50 }, { pool: 1000.001 }])(
    'does not record an unfundable or malformed promise: %s',
    async (options) => {
      const h = harness(options);
      expect(await h.subject.eliminatePlayer('second', 2)).toBe(false);
      expect(await h.subject.recalculateEliminatedPrizes(options.pool ?? 1000)).toBe(false);
      expect(h.rpc).not.toHaveBeenCalled();
      expect(h.report).toHaveBeenCalled();
    }
  );
  it('keeps the pre-cutoff provisional field behavior until the final count is known', async () => {
    const h = harness();
    h.subject.finalFieldSize = async () => undefined;
    expect(await h.subject.eliminatePlayer('second', 2)).toBe(true);
    expect(h.rpc.mock.calls[0][1].p_prize).toBe(300);
  });
  it('uses the deepest sparse paid place when reserving the bubble', async () => {
    const h = harness();
    h.subject.tournamentCache.payout_structure = [
      { place: 1, percentage: 60 },
      { place: 3, percentage: 40 },
    ];
    expect(await h.subject.eliminatePlayer('third', 3)).toBe(true);
    expect(h.rpc.mock.calls[0][1].p_prize).toBe(360);
  });
  it('keeps satellite elimination outside the cash ladder', async () => {
    const h = harness({ satellite: true });
    expect(await h.subject.eliminatePlayer('second', 2)).toBe(true);
    expect(h.rpc.mock.calls[0][1].p_prize).toBe(0);
  });
});
