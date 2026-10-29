import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
// The fixture imports the maintained functions; no copied implementation or CDP handler replaces them.
import {
  readLegacyCensusMemory,
  legacyCensusMemoryAdmission,
  projectLegacyCensus,
} from '../server/scripts/legacy-engine-checkpoint.mjs';

describe('legacy native heap census projection', () => {
  it('matches five native concrete identity sets using one broad census without invoking traps', () => {
    const result = spawnSync(
      process.execPath,
      [
        resolve('tests/operations/legacy-census-projection.mjs'),
        pathToFileURL(resolve('server/scripts/legacy-engine-checkpoint.mjs')).href,
      ],
      {
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 65536,
        env: { PATH: dirname(process.execPath), TZ: 'UTC' },
      }
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout.trim());
    expect(receipt).toMatchObject({
      ok: true,
      nativeBaselineScans: 5,
      broadScans: 1,
      traps: 0,
      admission: true,
      sameProcessAliveAfterCleanup: true,
      inspectorClosed: true,
      portClosed: true,
    });
    expect(receipt.exactSets).toHaveLength(5);
    expect(receipt.exactIdentityEquality).toEqual([true, true, true, true, true]);
  });

  it('refuses excessive prototype diversity or depth instead of omitting owners or growing an unbounded cache', () => {
    const roots = Array.from({ length: 5 }, () => class Concrete {});
    const modules = {
      gameServer: { GameServer: roots[0] },
      engine: { ServerTableEngine: roots[1] },
      manager: { TournamentManager: roots[2] },
      lightningWorker: { LightningClusterWorker: roots[3] },
      lightningHost: { LightningHandHost: roots[4] },
    };
    const diverse = Array.from({ length: 4097 }, () =>
      Object.create(Object.create(Object.prototype))
    );
    expect(() => projectLegacyCensus.call(diverse, modules)).toThrow(
      'native census topology refused'
    );
    let deep = roots[0].prototype;
    for (let index = 0; index < 257; index++) deep = Object.create(deep);
    expect(() => projectLegacyCensus.call([Object.create(deep)], modules)).toThrow(
      'native census topology refused'
    );
  });

  it('does not substitute host free memory when constrained-process availability is unavailable', () => {
    const memory = vm.runInNewContext(`(${readLegacyCensusMemory.toString()})()`, {
      process: {
        getBuiltinModule: () => ({
          getHeapStatistics: () => ({ used_heap_size: 1, total_available_size: 1024 ** 3 }),
        }),
      },
    });
    expect(memory.availableProcessBytes).toBeNull();
    expect(legacyCensusMemoryAdmission(memory)).toBeNull();
  });

  it.each([
    null,
    undefined,
    false,
    [],
    {},
    { usedHeapBytes: 1 },
    { usedHeapBytes: 1, availableHeapBytes: 1, availableProcessBytes: 1, extra: 1 },
  ])('refuses unknown or malformed memory evidence %j', (value) => {
    expect(legacyCensusMemoryAdmission(value)).toBeNull();
  });

  it.each(['usedHeapBytes', 'availableHeapBytes', 'availableProcessBytes'])(
    'refuses invalid numeric %s evidence',
    (field) => {
      for (const value of [0, -1, 0.5, NaN, Infinity, '1', Number.MAX_SAFE_INTEGER + 1]) {
        expect(
          legacyCensusMemoryAdmission({
            usedHeapBytes: 1024,
            availableHeapBytes: 64 * 1024 * 1024,
            availableProcessBytes: 64 * 1024 * 1024,
            [field]: value,
          })
        ).toBeNull();
      }
    }
  );

  it('refuses overflow and admits exact independent heap/process reserve boundaries', () => {
    expect(
      legacyCensusMemoryAdmission({
        usedHeapBytes: Number.MAX_SAFE_INTEGER,
        availableHeapBytes: Number.MAX_SAFE_INTEGER,
        availableProcessBytes: Number.MAX_SAFE_INTEGER,
      })
    ).toBeNull();
    const exact = {
      usedHeapBytes: 1024,
      availableHeapBytes: 33555456,
      availableProcessBytes: 33562624,
    };
    expect(legacyCensusMemoryAdmission(exact)).toMatchObject({
      ok: true,
      requiredHeapBytes: 33555456,
      requiredProcessBytes: 33562624,
    });
    expect(
      legacyCensusMemoryAdmission({ ...exact, availableHeapBytes: exact.availableHeapBytes - 1 })
        ?.ok
    ).toBe(false);
    expect(
      legacyCensusMemoryAdmission({
        ...exact,
        availableProcessBytes: exact.availableProcessBytes - 1,
      })?.ok
    ).toBe(false);
  });
});
