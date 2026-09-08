/**
 * Execute the real recovery entry point through its satellite read boundary.
 * A COMPLETING finish claim is immutable: unreadable champion evidence cannot
 * revive or complete it, and an undecided live field cannot be rewritten to
 * RUNNING. Payout/seat counts are diagnostics only because the atomic database
 * finalizer revalidates exact economic evidence under its transaction lock.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync('src/tournament/tournamentRecovery.ts', 'utf8');
const ast = ts.createSourceFile('recovery.ts', source, ts.ScriptTarget.Latest, true);
const fn = ast.statements.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'recoverStuckCompletingTournaments'
);
if (!fn) throw new Error('Actual recovery function missing');
const compiled = ts.transpileModule(
  `${fn.getText(ast).replace(/^export /, '')}\nreturn recoverStuckCompletingTournaments;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
).outputText;

type Result<T> = { data: T; error: { message: string } | null; count?: unknown };
type Scenario = {
  live: Result<unknown>;
  receipt: Result<unknown>;
  payouts: Result<null>;
  seats: Result<null>;
};

const defaultScenario = (): Scenario => ({
  live: {
    data: [
      { id: 'p1', user_id: 'player-1', status: 'playing', position: null },
      { id: 'p2', user_id: 'player-2', status: 'playing', position: null },
    ],
    error: null,
  },
  receipt: { data: null, error: null },
  payouts: { data: null, count: 0, error: null },
  seats: { data: null, count: 0, error: null },
});

async function run(overrides: Partial<Scenario> = {}) {
  const scenario = { ...defaultScenario(), ...overrides };
  const writes: Array<{ table: string; value: unknown }> = [];
  const rpcs: string[] = [];
  const reads: Array<{
    table: string;
    columns: string;
    filters: Record<string, unknown>;
    limit: number | null;
  }> = [];
  const report = vi.fn();
  const alert = vi.fn();
  const frozen = vi.fn(() => false);

  const db = {
    from(table: string) {
      let columns = '';
      let limit: number | null = null;
      let update: unknown;
      const filters: Record<string, unknown> = {};
      const answer = () => {
        reads.push({ table, columns, filters: { ...filters }, limit });
        if (update !== undefined) return { data: null, error: null };
        if (table === 'tournaments') {
          return {
            data: [
              {
                id: 'satellite-event',
                name: 'Satellite',
                status: 'COMPLETING',
                variant: 'satellite',
                tournament_type: 'SATELLITE',
                satellite_target_id: 'target-event',
              },
            ],
            error: null,
          };
        }
        if (table === 'tournament_finish_receipts') return scenario.receipt;
        if (table === 'tournament_payouts') return scenario.payouts;
        if (table === 'tournament_players' && 'source_satellite_id' in filters) {
          return scenario.seats;
        }
        if (table === 'tournament_players') return scenario.live;
        throw new Error(`unexpected read from ${table}`);
      };
      const query: Record<string, unknown> = {};
      query.select = (value: string) => {
        columns = value;
        return query;
      };
      query.eq = (column: string, value: unknown) => {
        filters[column] = value;
        return query;
      };
      query.in = (column: string, value: unknown) => {
        filters[column] = value;
        return query;
      };
      query.limit = (value: number) => {
        limit = value;
        return query;
      };
      query.update = (value: unknown) => {
        update = value;
        writes.push({ table, value });
        return query;
      };
      query.maybeSingle = async () => answer();
      query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(answer()).then(resolve, reject);
      return query;
    },
    rpc(name: string) {
      rpcs.push(name);
      return Promise.resolve({ data: null, error: null });
    },
  };

  const build = new Function(
    'supabase',
    'reportError',
    'raiseFinancialAlert',
    'isMaintenanceFrozen',
    compiled
  );
  const recover = build(db, report, alert, frozen) as (reason: string) => Promise<void>;
  await recover('audit');
  return { writes, rpcs, reads, report, alert, frozen };
}

describe('satellite recovery requires readable result authority', () => {
  it.each([
    { data: null, error: null },
    { data: null, error: { message: 'survivor read timeout' } },
  ])('does not mutate or settle when survivor rows are unreadable: %j', async (live) => {
    const result = await run({ live });

    expect(result.writes).toEqual([]);
    expect(result.rpcs).toEqual([]);
    expect(result.alert).not.toHaveBeenCalled();
    expect(result.report.mock.calls.map((call) => call[1])).toContain(
      'GameServer.recoverStuckCompleting_satellite_survivors_unreadable'
    );
  });

  it('does not mutate or settle when the immutable finish receipt is unreadable', async () => {
    const result = await run({
      receipt: { data: null, error: { message: 'finish receipt timeout' } },
    });

    expect(result.writes).toEqual([]);
    expect(result.rpcs).toEqual([]);
    expect(result.alert).not.toHaveBeenCalled();
    expect(result.report.mock.calls.map((call) => call[1])).toContain(
      'GameServer.recoverStuckCompleting_satellite_finish_receipt_unreadable'
    );
  });
});

describe('satellite recovery leaves lifecycle and money authority in the database', () => {
  it.each([
    ['payouts', { data: null, count: null, error: { message: 'payout count timeout' } }],
    ['seats', { data: null, count: null, error: { message: 'seat count timeout' } }],
    ['payouts', { data: null, count: -1, error: null }],
    ['seats', { data: null, count: 0.5, error: null }],
  ] as const)(
    'does not turn diagnostic %s evidence into a status or money decision',
    async (key, value) => {
      const result = await run({ [key]: value });

      expect(result.writes).toEqual([]);
      expect(result.rpcs).toEqual([]);
      expect(result.alert).toHaveBeenCalledWith(
        'critical',
        'Satellite.completing_with_live_field',
        expect.any(String),
        expect.objectContaining({
          tournament_id: 'satellite-event',
          alive_count_lower_bound: 2,
        })
      );
      expect(result.report.mock.calls.map((call) => call[1])).toContain(
        'GameServer.recoverStuckCompleting_satellite_live_field_conflict'
      );
    }
  );

  it('reads at most two live rows and preserves an undecided COMPLETING field', async () => {
    const result = await run();
    const liveRead = result.reads.find(
      (read) =>
        read.table === 'tournament_players' &&
        read.columns === 'id, user_id, status, position' &&
        'tournament_id' in read.filters
    );

    expect(liveRead).toBeDefined();
    expect(liveRead?.limit).toBe(2);
    expect(result.writes).toEqual([]);
    expect(result.rpcs).toEqual([]);
    expect(result.report.mock.calls.map((call) => call[1])).toEqual([
      'GameServer.recoverStuckCompleting_satellite_live_field_conflict',
    ]);
  });
});
