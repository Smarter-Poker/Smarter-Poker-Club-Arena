import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync('src/tournament/TournamentManagerEliminations.ts', 'utf8');
const ast = ts.createSourceFile('manager.ts', source, ts.ScriptTarget.Latest, true);
let method: ts.MethodDeclaration | undefined;
function visit(n: ts.Node) {
  if (ts.isMethodDeclaration(n) && n.name.getText(ast) === 'finishTournament') method = n;
  ts.forEachChild(n, visit);
}
visit(ast);
if (!method?.body) throw new Error('Actual finish method missing');
const compiled = ts.transpileModule('return async function(winnerId) ' + method.body.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
async function run(
  funded: unknown,
  guarantee = 100,
  receipt?: Record<string, unknown>,
  awardRead?: { data: unknown; error: unknown },
  format: Record<string, unknown> = {},
  playerReads: Record<string, { data: unknown; error: unknown }> = {},
  writeErrors: Record<string, unknown> = {}
) {
  const updates: Array<{ table: string; value: any }> = [];
  const alerts = vi.fn(async () => undefined);
  const report = vi.fn();
  const price = vi.fn((pool: number) => pool);
  const settle = vi.fn(
    async (_db, input) => receipt ?? { ok: true, fully_settled: true, amount_paid: input.amount }
  );
  const tournament = {
    prize_pool: 20,
    guaranteed_prize: guarantee,
    variant: 'holdem',
    tournament_type: 'MTT',
    payout_structure: [{ place: 1, percentage: 100 }],
    ...format,
  };
  const db = {
    rpc: vi.fn(async () => ({ data: { clean: true }, error: null })),
    from(table: string) {
      let columns = '';
      let value: any;
      const q: any = {
        select(c: string) {
          columns = c;
          return q;
        },
        update(v: any) {
          value = v;
          updates.push({ table, value });
          return q;
        },
        eq() {
          return q;
        },
        neq() {
          return q;
        },
        gt() {
          return q;
        },
        not() {
          return q;
        },
        is() {
          return q;
        },
        maybeSingle() {
          return q;
        },
        then(resolve: any, reject: any) {
          if (value?.status && writeErrors[value.status])
            return Promise.resolve({ data: null, error: writeErrors[value.status] }).then(
              resolve,
              reject
            );
          if (table === 'tournament_players' && !value && playerReads[columns])
            return Promise.resolve(playerReads[columns]).then(resolve, reject);
          if (table === 'tournament_players' && columns === 'prize' && awardRead)
            return Promise.resolve(awardRead).then(resolve, reject);
          let data: unknown = [];
          if (table === 'tournaments') {
            data = value
              ? { id: 'event' }
              : Object.fromEntries(
                  columns
                    .split(',')
                    .map((k) => [k.trim(), tournament[k.trim() as keyof typeof tournament]])
                );
          }
          if (table === 'tournament_players' && columns === 'username')
            data = { username: 'Winner' };
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  const owner = {
    tournamentId: 'event',
    tournamentFinished: false,
    eliminatePlayer: vi.fn(async () => undefined),
    applyPrizeGuarantee: vi.fn(async () => {
      if (funded instanceof Error) throw funded;
      return funded;
    }),
    finalFieldSize: vi.fn(async () => 2),
    processSatelliteAwards: vi.fn(async () => undefined),
    tableEngines: new Map(),
    broadcast: vi.fn(),
    settleTournamentRake: vi.fn(),
    cleanupBroadcastChannel: vi.fn(),
    stop: vi.fn(),
  };
  const deps = {
    supabase: db,
    reportError: report,
    raiseFinancialAlert: alerts,
    resolvePayoutStructure: () => (awardRead ? null : [{ place: 1, percentage: 100 }]),
    isSpinTournament: () => false,
    remainingPoolAfterAwards: (pool: number, paid: number) => Math.max(0, pool - paid),
    computePlacePrize: price,
    settleTournamentObligation: settle,
    TRANSPORT_REFUSAL: 'transport_error',
    COMPLETED_FLIP_ATTEMPTS: 3,
    COMPLETED_FLIP_BACKOFF_MS: 250,
    isTransientFlipError: () => false,
  };
  await new Function(...Object.keys(deps), compiled)(...Object.values(deps)).call(owner, 'winner');
  return { owner, updates, alerts, report, price, settle };
}
describe('winner pricing uses confirmed guarantee funding', () => {
  it('selects the guarantee and prices from the funding receipt, not the stale snapshot', async () => {
    const r = await run(100);
    expect(r.owner.applyPrizeGuarantee).toHaveBeenCalledWith('finish_fallback');
    expect(r.settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ amount: 100 })
    );
    expect(r.updates.some((x) => x.value.status === 'COMPLETED')).toBe(true);
  });
  it.each([null, 20, new Error('funding unavailable')])(
    'does not price or complete an unconfirmed guarantee: %s',
    async (funded) => {
      const r = await run(funded);
      expect(r.price).not.toHaveBeenCalled();
      expect(r.settle).not.toHaveBeenCalled();
      expect(r.updates.some((x) => x.value.status === 'COMPLETED')).toBe(false);
      expect(r.alerts).toHaveBeenCalled();
    }
  );
  it('preserves an event without a guarantee', async () => {
    const r = await run(null, 0);
    expect(r.owner.applyPrizeGuarantee).not.toHaveBeenCalled();
    expect(r.settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ amount: 20 })
    );
  });
});

describe('winner completion requires a fully paid receipt', () => {
  it.each([
    { ok: false, refused_reason: 'escrow_short' },
    { ok: true, fully_settled: false, amount_paid: 40 },
    { ok: true, fully_settled: true, amount_paid: 80 },
    { ok: true, paid: 0, already_paid: 100 },
  ])('does not stamp a paid winner or complete for %j', async (receipt) => {
    const r = await run(100, 100, receipt);
    expect(
      r.updates.some((x) => x.table === 'tournament_players' && x.value.status === 'winner')
    ).toBe(false);
    expect(r.updates.some((x) => x.value.status === 'COMPLETED')).toBe(false);
    expect(r.owner.broadcast).not.toHaveBeenCalled();
    expect(r.report).toHaveBeenCalled();
  });
  it('completes a confirmed replay without requiring new money movement', async () => {
    const r = await run(100, 100, { ok: true, fully_settled: true, amount_paid: 100, paid: 0 });
    expect(r.updates.some((x) => x.value.status === 'COMPLETED')).toBe(true);
  });
});

describe('fallback winner pricing needs a readable prior award list', () => {
  it.each([
    { data: null, error: { message: 'unavailable' } },
    { data: null, error: null },
    { data: [{ prize: -10 }], error: null },
    { data: [{ prize: 'bad' }], error: null },
  ])('does not guess the residual pool for %j', async (awardRead) => {
    const r = await run(null, 0, undefined, awardRead);
    expect(r.settle).not.toHaveBeenCalled();
    expect(r.updates.some((x) => x.value.status === 'COMPLETED')).toBe(false);
    expect(r.alerts).toHaveBeenCalled();
  });
  it('deducts confirmed prior awards', async () => {
    const r = await run(null, 0, undefined, { data: [{ prize: 5 }], error: null });
    expect(r.settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ amount: 15 })
    );
  });
});

describe('all satellite identities take the seat award path', () => {
  it.each([
    { satellite_target_id: 'target' },
    { variant: 'satellite' },
    { tournament_type: 'satellite' },
  ])('does not pay structure cash for %j', async (format) => {
    const r = await run(null, 0, undefined, undefined, format);
    expect(r.settle).not.toHaveBeenCalled();
    expect(r.owner.processSatelliteAwards).toHaveBeenCalledOnce();
    expect(r.updates.some((x) => x.value.status === 'COMPLETED')).toBe(true);
  });
});

describe('finishing needs a readable unresolved-player roster', () => {
  it.each([
    { data: null, error: { message: 'unavailable' } },
    { data: null, error: null },
    { data: {}, error: null },
  ])('does not stamp or complete after an unknown roster: %j', async (roster) => {
    const r = await run(20, 0, undefined, undefined, {}, { 'user_id, chips': roster });
    expect(
      r.updates.some((x) => x.value.status === 'winner' || x.value.status === 'COMPLETED')
    ).toBe(false);
    expect(r.owner.broadcast).not.toHaveBeenCalled();
    expect(r.report).toHaveBeenCalled();
  });

  it.each([
    { data: null, error: { message: 'positions unavailable' } },
    { data: null, error: null },
    { data: [{ position: 'bad' }], error: null },
    { data: [{ position: 0 }], error: null },
    { data: [{ position: 2 }, { position: 2 }], error: null },
  ])(
    'does not allocate places from an unknown or inconsistent position list: %j',
    async (positions) => {
      const r = await run(
        20,
        0,
        undefined,
        undefined,
        {},
        {
          'user_id, chips': { data: [{ user_id: 'loser', chips: 0 }], error: null },
          position: positions,
        }
      );
      expect(
        r.updates.some((x) => x.value.status === 'winner' || x.value.status === 'COMPLETED')
      ).toBe(false);
      expect(r.owner.broadcast).not.toHaveBeenCalled();
      expect(r.report).toHaveBeenCalled();
    }
  );
});

describe('finish verifies that unresolved players were actually eliminated', () => {
  it('does not complete when the recorded positions leave no free place', async () => {
    const r = await run(
      20,
      0,
      undefined,
      undefined,
      {},
      {
        'user_id, chips': { data: [{ user_id: 'loser', chips: 0 }], error: null },
        position: { data: [{ position: 2 }], error: null },
      }
    );
    expect(r.owner.eliminatePlayer).not.toHaveBeenCalled();
    expect(r.updates.some((x) => x.value.status === 'COMPLETED')).toBe(false);
  });
  it.each([
    { data: [{ user_id: 'loser' }], error: null },
    { data: null, error: { message: 'verification unavailable' } },
    { data: null, error: null },
  ])('does not complete after an unconfirmed elimination: %j', async (verification) => {
    const r = await run(
      20,
      0,
      undefined,
      undefined,
      {},
      {
        'user_id, chips': { data: [{ user_id: 'loser', chips: 0 }], error: null },
        position: { data: [], error: null },
        user_id: verification,
      }
    );
    expect(r.owner.eliminatePlayer).toHaveBeenCalledWith('loser', 2);
    expect(r.updates.some((x) => x.value.status === 'COMPLETED')).toBe(false);
  });
  it('completes after the assigned player is confirmed resolved', async () => {
    const r = await run(
      20,
      0,
      undefined,
      undefined,
      {},
      {
        'user_id, chips': { data: [{ user_id: 'loser', chips: 0 }], error: null },
        position: { data: [], error: null },
        user_id: { data: [], error: null },
      }
    );
    expect(r.owner.eliminatePlayer).toHaveBeenCalledWith('loser', 2);
    expect(r.updates.some((x) => x.value.status === 'COMPLETED')).toBe(true);
  });
});

describe('finish requires confirmed winner and completion writes', () => {
  it('does not complete or announce after the winner stamp fails', async () => {
    const r = await run(
      20,
      0,
      undefined,
      undefined,
      {},
      {},
      {
        winner: { message: 'winner write unavailable' },
      }
    );
    expect(r.updates.some((x) => x.value.status === 'COMPLETED')).toBe(false);
    expect(r.owner.broadcast).not.toHaveBeenCalled();
    expect(r.owner.cleanupBroadcastChannel).not.toHaveBeenCalled();
    expect(r.report).toHaveBeenCalledWith(expect.any(Error), 'Tournament.winner_row_stamp_failed');
  });
  it('does not announce completion or close the channel after the completion write fails', async () => {
    const r = await run(
      20,
      0,
      undefined,
      undefined,
      {},
      {},
      {
        COMPLETED: { message: 'completion write unavailable', code: 'XX000' },
      }
    );
    expect(r.owner.broadcast).not.toHaveBeenCalled();
    expect(r.owner.cleanupBroadcastChannel).not.toHaveBeenCalled();
    expect(r.report).toHaveBeenCalledWith(
      expect.any(Error),
      'Tournament.completed_transition_failed'
    );
  });
});
