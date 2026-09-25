import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { computePlacePrize, prizePoolAvailableToPlaces } from './payoutMath.js';
import { resolvePayoutStructure } from './payoutStructure.js';
import { UNIT_CENTS_ASSET_NOT_READ } from './tournamentUnit.js';

const source = readFileSync('src/tournament/TournamentManagerEliminations.ts', 'utf8');
const ast = ts.createSourceFile('manager.ts', source, ts.ScriptTarget.Latest, true);
const manager = ast.statements.find(
  (n): n is ts.ClassDeclaration =>
    ts.isClassDeclaration(n) && n.name?.text === 'TournamentManagerEliminations'
);
// 2026-09-13: `placeLadderUnitCents` is extracted alongside the two payout
// methods rather than stubbed on the fixture. Both of them now ask it for the
// unit they price in, and the real method is the thing worth running here - a
// stub would make this harness agree with itself about a number the engine
// actually gets from somewhere else.
const methods = ['eliminatePlayer', 'recalculateEliminatedPrizes', 'placeLadderUnitCents'].map(
  (name) => {
    const method = manager?.members.find(
      (n) => ts.isMethodDeclaration(n) && n.name.getText(ast) === name
    );
    if (!method) throw new Error(`Actual method ${name} is missing`);
    return method.getText(ast);
  }
);
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
    /** What the base class answers for the tournament's unit; null is "the club was not read". */
    unit?: number | null;
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
    // The free identifier `placeLadderUnitCents` returns, injected by name for
    // the same reason every other one above is.
    'UNIT_CENTS_ASSET_NOT_READ',
    compiled
  )(
    db,
    report,
    { log: vi.fn() },
    computePlacePrize,
    prizePoolAvailableToPlaces,
    resolvePayoutStructure,
    { SWEEP_MUTATION_BATCH_SIZE: 100, UNRESOLVED_BUST_RETRY_MS: 100 },
    UNIT_CENTS_ASSET_NOT_READ
  );
  const subject = Object.assign(new Subject(), {
    tournamentId: 'event',
    tournamentCache: tournament,
    finalFieldSize: async () => options.field ?? 4,
    eliminationMutationAllowed: () => true,
    eliminationWorkBudgetExpired: () => false,
    requestUrgentEliminationSweepAfter: vi.fn(),
    broadcast: vi.fn(async () => {}),
    // 2026-09-14: `placeLadderUnitCents` asks the base class, which read the
    // club beside the tournament row. Null is the not-read answer, and the
    // method must then pass the named admission rather than a bare cent.
    tournamentUnit: () => options.unit ?? null,
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
  it('prices a Diamond event in whole Diamonds when the club was read', async () => {
    // 1001 Diamonds, a 100-Diamond bubble reserved: the 901 ladder would pay
    // 270.30 and 180.20 to the cent; a Diamond does not divide, so the shares
    // floor and the remainder lands on the last paid place, as the database
    // ladder does it.
    const h = harness({ pool: 1001, unit: 100 });
    expect(await h.subject.eliminatePlayer('second', 2)).toBe(true);
    expect(h.rpc.mock.calls[0][1].p_prize).toBe(270);
    h.rpc.mockClear();
    expect(await h.subject.recalculateEliminatedPrizes(1001)).toBe(true);
    const prizes = h.rpc.mock.calls.map(([, r]) => r.p_new_prize);
    expect(prizes.every((p: number) => Number.isInteger(p))).toBe(true);
    expect(prizes).toEqual([270, 180]);
  });
  it('prices to the cent, by name, when the club was not read', async () => {
    const h = harness({ pool: 1001, unit: null });
    expect(await h.subject.eliminatePlayer('second', 2)).toBe(true);
    expect(h.rpc.mock.calls[0][1].p_prize).toBe(270.3);
  });
  it('keeps satellite elimination outside the cash ladder', async () => {
    const h = harness({ satellite: true });
    expect(await h.subject.eliminatePlayer('second', 2)).toBe(true);
    expect(h.rpc.mock.calls[0][1].p_prize).toBe(0);
  });
});
