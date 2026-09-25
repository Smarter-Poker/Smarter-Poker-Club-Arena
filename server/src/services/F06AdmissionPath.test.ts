import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
const src = readFileSync(
  new URL('../tournament/TournamentManagerBase.ts', import.meta.url),
  'utf8'
);
const a = src.indexOf('    const operation = (async () => {');
const b = src.indexOf('    })().catch(async (error) => {', a);
const body = src.slice(a + '    const operation = (async () => {'.length, b);
const js = ts.transpileModule(
  `async function run(lifecycle,tableId,engine,supabase,nodeCrypto,F06HandPermit,resumeRetainedHandSubmission,INSTANCE_ID){${body}}`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
).outputText;
const run = new Function(js + '; return run;')();
const tableId = 'table';
const state = {
  ok: true,
  table_id: tableId,
  lifecycle: '9007199254740993',
  can_reserve: true,
  blocked_reason: null,
  used_hand_number_max: '1000000',
  unresolved_permit: null,
  next_hand_number_candidate: '1000001',
};
function fixture(data: unknown) {
  let starts = 0;
  let installed: any;
  let allocator: any;
  const engine = {
    installF06Allocator: (_epoch: any, fn: any) => {
      allocator = fn;
    },
    installF06HandAdmission: (f: any) => (installed = f),
    start: async () => {
      starts++;
    },
  };
  let valid = true;
  const self = {
    tournamentId: 'tournament',
    tournamentLeaseGeneration: 'lease',
    lifecycleIsCurrent: () => valid,
    tableEngines: new Map([[tableId, engine]]),
    gameServer: {
      ownsTournamentTableEngine: () => true,
      tournamentRetirementCustody: { admissionAllowed: () => true },
    },
  };
  const invoke = () =>
    run.call(
      self,
      {},
      tableId,
      engine,
      {
        rpc: async (name: string) => ({
          data: typeof data === 'function' ? data(name) : data,
          error: null,
        }),
      },
      { randomUUID: () => 'uuid' },
      class {
        constructor(public binding: unknown) {}
      },
      async () => null,
      'original-fixture-instance'
    );
  return {
    invoke,
    starts: () => starts,
    installed: () => installed,
    allocator: () => allocator,
    fence: () => (valid = false),
  };
}
it('actual managed-start body installs provider only after complete resolved projection', async () => {
  const f = fixture(state);
  await f.invoke();
  expect(f.starts()).toBe(1);
  await expect(f.installed()('999999')).rejects.toThrow('below_durable_floor');
  expect((await f.installed()('1000001')).binding.lifecycle).toBe(state.lifecycle);
});
it('actual managed-start body refuses missing, unresolved and unsafe startup state', async () => {
  for (const patch of [
    { unresolved_permit: undefined },
    { unresolved_permit: { permit_id: 'old' } },
    { next_hand_number_candidate: '1000002' },
    { used_hand_number_max: '9007199254740993' },
  ]) {
    const f = fixture({ ...state, ...patch });
    await expect(f.invoke()).rejects.toThrow('projection_unproven');
    expect(f.starts()).toBe(0);
  }
});
it('actual allocator callback validates canonical safe decimal and exact table/lifecycle', async () => {
  for (const patch of [
    { hand_number: '01' },
    { hand_number: '9007199254740992' },
    { table_id: 'other' },
    { lifecycle: '2' },
    { hand_number_high_water: '1000001' },
  ]) {
    const f = fixture((name: string) =>
      name === 'fn_f06_allocate_hand_number'
        ? {
            ok: true,
            table_id: tableId,
            lifecycle: state.lifecycle,
            hand_number: '1000001',
            hand_number_high_water: '1000000',
            ...patch,
          }
        : state
    );
    await f.invoke();
    await expect(f.allocator()()).rejects.toThrow('unproven');
  }
  const f = fixture((name: string) =>
    name === 'fn_f06_allocate_hand_number'
      ? {
          ok: true,
          table_id: tableId,
          lifecycle: state.lifecycle,
          hand_number: '1000001',
          hand_number_high_water: '1000000',
        }
      : state
  );
  await f.invoke();
  expect(await f.allocator()()).toBe(1000001);
});
