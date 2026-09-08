import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { isSatelliteTargetOpen, satelliteTicketCost } from './satelliteTargetOpen.js';
import { planSatelliteAwards } from './satelliteAwardPlan.js';
function method(path: string, name: string) {
  const source = readFileSync(path, 'utf8');
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  let body: ts.Block | undefined;
  function visit(n: ts.Node) {
    if (ts.isMethodDeclaration(n) && n.name.getText(ast) === name) body = n.body;
    ts.forEachChild(n, visit);
  }
  visit(ast);
  if (!body) throw new Error('Missing actual method ' + name);
  return { ast, body: body as ts.Block };
}
const awards = method('src/tournament/TournamentManager.ts', 'processSatelliteAwards');
const compiled = ts.transpileModule(
  'return async function(tournament) ' + awards.body.getText(awards.ast),
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }
).outputText;
const make = new Function(
  'supabase',
  'settleTournamentObligation',
  'reportError',
  'raiseFinancialAlert',
  'isSatelliteTargetOpen',
  'satelliteTicketCost',
  'planSatelliteAwards',
  compiled
);
function fixture(seat: unknown, error: unknown = null) {
  const writes: string[] = [];
  const client = {
    from(table: string) {
      let op = 'read';
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'not', 'order']) c[m] = () => c;
      c.update = () => {
        op = 'update';
        return c;
      };
      const answer = () => {
        if (op === 'update') writes.push(table);
        return {
          data:
            table === 'tournaments'
              ? {
                  id: 'target',
                  name: 'Target',
                  status: 'REGISTERING',
                  buy_in_amount: 10,
                  buy_in_fee: 0,
                }
              : [{ user_id: 'winner', username: 'Winner', position: 1 }],
          count: 1,
          error: null,
        };
      };
      c.maybeSingle = async () => answer();
      c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(answer()).then(resolve);
      return c;
    },
    rpc: async () => ({ data: seat, error }),
  };
  const run = make(
    client,
    async () => {
      writes.push('cash');
      return { ok: true, paid: 10, amount_paid: 10, fully_settled: true };
    },
    () => {},
    async () => {},
    isSatelliteTargetOpen,
    satelliteTicketCost,
    planSatelliteAwards
  );
  return {
    writes,
    run: () =>
      run.call(
        { tournamentId: 'satellite' },
        { prize_pool: 10, satellite_target_id: 'target', satellite_seats: 1 }
      ),
  };
}
describe('unknown seat outcome cannot become cash or a confirmed prize', () => {
  it.each([
    [null, { message: 'timeout after commit' }],
    [{ ok: true, awarded: true }, { message: 'transport response error' }],
    [null, null],
    [{}, null],
    [{ ok: 'true', awarded: true }, null],
    [{ ok: true, awarded: false }, null],
  ])('rejects ambiguous receipt %j / %j', async (seat, error) => {
    const f = fixture(seat, error);
    await expect(f.run()).rejects.toThrow();
    expect(f.writes).toEqual([]);
  });
  it('keeps cash fallback for an explicit target refusal', async () => {
    const f = fixture({ ok: false, reason: 'target_closed' });
    await f.run();
    expect(f.writes.filter((x) => x === 'cash')).toHaveLength(1);
  });
  it.each([
    { ok: true, awarded: true },
    { ok: true, awarded: false, held_from_this_satellite: true },
  ])('confirms a new or replayed seat %j without cash', async (seat) => {
    const f = fixture(seat);
    await f.run();
    expect(f.writes).not.toContain('cash');
    expect(f.writes).toContain('tournament_players');
  });
  it('pays cash when a seat is explicitly held from elsewhere', async () => {
    const f = fixture({ ok: true, awarded: false, held_from_this_satellite: false });
    await f.run();
    expect(f.writes.filter((x) => x === 'cash')).toHaveLength(1);
  });
});
const finish = method('src/tournament/TournamentManagerEliminations.ts', 'finishTournament');
const handoff = finish.body.statements.find(
  (n) => ts.isIfStatement(n) && n.expression.getText(finish.ast) === 'isSatelliteFinish'
);
if (!handoff) throw new Error('Missing actual satellite handoff');
const handoffCode = ts.transpileModule(
  'return async function(tournament) { const isSatelliteFinish=true; ' +
    handoff.getText(finish.ast) +
    '; return "completed"; }',
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
).outputText;
const finishHandoff = new Function('reportError', handoffCode)(() => {});
it('the finish handoff stops after an award exception', async () => {
  await expect(
    finishHandoff.call(
      {
        processSatelliteAwards: async () => {
          throw new Error('unknown seat');
        },
      },
      {}
    )
  ).resolves.toBeUndefined();
});
it('the finish handoff proceeds after a successful award method', async () => {
  await expect(finishHandoff.call({ processSatelliteAwards: async () => {} }, {})).resolves.toBe(
    'completed'
  );
});
