import { expect, it } from 'vitest';
import { TournamentRetirementCustody } from './TournamentRetirementCustody.js';
const prepared = async () => {};
const binding = {
  breakId: 'break',
  tableId: 'table',
  tableIncarnation: '9007199254740993',
  leaseGeneration: 'lease',
  tournamentId: 'tournament',
  custodyId: 'custody',
  durableRevision: '9007199254740994',
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
it('holds admission through stop, close, cleanup and delayed ack', async () => {
  const stop = deferred(),
    ack = deferred();
  let released = false;
  const engine = {
    stop: async () => {
      await stop.promise;
      released = true;
    },
    hasReleasedProcessOwnership: () => released,
  };
  const global = new Map([['table', engine]]),
    local = new Map(global);
  const gate = new TournamentRetirementCustody<typeof engine>();
  const work = gate.withCustody(
    binding,
    global,
    local,
    () => true,
    async (c) => {
      c.assertCurrent();
      global.delete('table');
      local.delete('table');
      c.confirmAbsent();
      await ack.promise;
      c.assertCurrent();
      return 'ack';
    },
    prepared
  );
  expect(gate.admissionAllowed('table')).toBe(false);
  stop.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(gate.admissionAllowed('table')).toBe(false);
  ack.resolve();
  expect(await work).toBe('ack');
  expect(gate.admissionAllowed('table')).toBe(true);
});
it('does not stop a one-map-only engine and rejects concurrent custody', async () => {
  const gate = new TournamentRetirementCustody<any>();
  const wait = deferred();
  await expect(
    gate.withCustody(
      binding,
      new Map(),
      new Map([['table', {}]]),
      () => true,
      async () => {},
      prepared
    )
  ).rejects.toThrow('disagreement');
  const work = gate.withCustody(
    binding,
    new Map(),
    new Map(),
    () => true,
    () => wait.promise,
    prepared
  );
  await expect(
    gate.withCustody(
      binding,
      new Map(),
      new Map(),
      () => true,
      async () => {},
      prepared
    )
  ).rejects.toThrow('busy');
  wait.resolve();
  await work;
});
it('rejects replacement and lease loss across an awaited stop', async () => {
  for (const change of ['engine', 'lease']) {
    const gate = new TournamentRetirementCustody<any>();
    const wait = deferred();
    let valid = true;
    const engine = { stop: () => wait.promise, hasReleasedProcessOwnership: () => true };
    const global = new Map([['table', engine]]),
      local = new Map(global);
    const result = gate.withCustody(
      binding,
      global,
      local,
      () => valid,
      async () => {
        throw new Error('must not execute');
      },
      prepared
    );
    if (change === 'engine') global.set('table', { ...engine });
    else valid = false;
    wait.resolve();
    await expect(result).rejects.toThrow(/registry_changed|custody_stale/);
  }
});
it('verifies absence through delayed acknowledgement without manufacturing an engine', async () => {
  const gate = new TournamentRetirementCustody<any>();
  const wait = deferred();
  let valid = true;
  const result = gate.withCustody(
    binding,
    new Map(),
    new Map(),
    () => valid,
    async (c) => {
      expect(c.engine).toBeNull();
      await wait.promise;
    },
    prepared
  );
  valid = false;
  wait.resolve();
  await expect(result).rejects.toThrow('custody_stale');
});
it('does not stop before durable claim and retains exclusion after claim uncertainty', async () => {
  let stopped = false;
  const engine = {
    stop: async () => {
      stopped = true;
    },
    hasReleasedProcessOwnership: () => true,
  };
  const gate = new TournamentRetirementCustody<typeof engine>();
  const global = new Map([['table', engine]]);
  await expect(
    gate.withCustody(
      binding,
      global,
      new Map(global),
      () => true,
      async () => {},
      async () => {
        throw new Error('claim unknown');
      }
    )
  ).rejects.toThrow('claim unknown');
  expect(stopped).toBe(false);
  expect(gate.admissionAllowed('table')).toBe(false);
});
it('reopen reservation excludes retirement until the awaited SQL result is settled', async () => {
  const gate = new TournamentRetirementCustody<any>();
  const wait = deferred();
  const admission = gate.withAdmission(
    'table',
    () => true,
    async (check) => {
      await wait.promise;
      check();
      return 'reopened';
    }
  );
  expect(gate.admissionAllowed('table')).toBe(false);
  await expect(
    gate.withCustody(
      binding,
      new Map(),
      new Map(),
      () => true,
      async () => {},
      async () => {}
    )
  ).rejects.toThrow('busy');
  wait.resolve();
  expect(await admission).toBe('reopened');
  expect(gate.admissionAllowed('table')).toBe(true);
});
it('reopen await cannot certify success after the admitting generation is fenced', async () => {
  const gate = new TournamentRetirementCustody<any>();
  const wait = deferred();
  let current = true;
  const admission = gate.withAdmission(
    'table',
    () => current,
    async () => {
      await wait.promise;
      return true;
    }
  );
  current = false;
  wait.resolve();
  await expect(admission).rejects.toThrow('stale');
});
