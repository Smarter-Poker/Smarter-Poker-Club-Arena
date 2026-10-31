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
  bindLegacyCensusModules,
  collectMarkedLegacyCensus,
  retireLegacyCensusBinding,
} from '../server/scripts/legacy-engine-checkpoint.mjs';

describe('legacy native heap census projection', () => {
  it('matches five native concrete identity sets using one bounded marked census without invoking traps', () => {
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
      markedUnionScans: 1,
      bindingRemoved: true,
      inheritedBehaviorPreserved: true,
      traps: 0,
      admission: true,
      sameProcessAliveAfterCleanup: true,
      inspectorClosed: true,
      portClosed: true,
    });
    expect(receipt.exactSets).toHaveLength(5);
    expect(receipt.exactIdentityEquality).toEqual([true, true, true, true, true]);
  });

  it.each(['connect', 'query', 'deferred', 'disconnect', 'expired', 'restore'])(
    'restores every prototype and releases its own binding on %s failure',
    (failure) => {
      class Shared {
        inherited() {
          return 19;
        }
      }
      const classes = [
        class A {},
        class B extends Shared {},
        class C extends Shared {},
        class D {},
        class E {},
      ];
      const tops = [
        classes[0].prototype,
        Shared.prototype,
        classes[3].prototype,
        classes[4].prototype,
      ];
      const modules = {
        gameServer: { GameServer: classes[0] },
        engine: { ServerTableEngine: classes[1] },
        manager: { TournamentManager: classes[2] },
        lightningWorker: { LightningClusterWorker: classes[3] },
        lightningHost: { LightningHandHost: classes[4] },
      };
      const key = '__legacyEngineCensus_22222222222222222222222222222222';
      let restoreAttempts = 0;
      const object = Object.create(Object);
      object.setPrototypeOf = (target: object, parent: object) => {
        if (parent === Object.prototype) {
          restoreAttempts++;
          if (failure === 'restore' && target === tops[0])
            throw Error('synthetic restoration refusal');
        }
        return Object.setPrototypeOf(target, parent);
      };
      class NativeSession {
        connect() {
          if (failure === 'connect') throw Error('synthetic connect failure');
        }
        post(
          method: string,
          params: Record<string, string>,
          callback: (error: Error | null, result?: unknown) => void
        ) {
          if (method === 'Runtime.evaluate')
            return callback(null, { result: { objectId: 'marker' } });
          if (method === 'Runtime.queryObjects') {
            expect(new classes[1]().inherited()).toBe(19);
            if (failure === 'query') return callback(Error('synthetic query failure'));
            if (failure === 'deferred') return;
            return callback(null, { objects: { objectId: 'native' } });
          }
          vm.runInContext(`(${params.functionDeclaration})`, context).call([]);
          callback(null, { result: { value: true } });
        }
        disconnect() {
          if (failure === 'disconnect') throw Error('synthetic disconnect failure');
        }
      }
      const context: vm.Context = vm.createContext({
        Object: object,
        Date,
        process: {
          getBuiltinModule: (name: string) =>
            name === 'node:inspector' ? { Session: NativeSession } : process.getBuiltinModule(name),
        },
      });
      const bind = vm.runInContext(`(${bindLegacyCensusModules.toString()})`, context);
      const collect = vm.runInContext(`(${collectMarkedLegacyCensus.toString()})`, context);
      const deadline = Date.now() + 5000;
      bind.call(modules, key, deadline);
      if (failure === 'expired') context.Date = { now: () => deadline + 1 };
      try {
        expect(() => collect(key, deadline)).toThrow();
        expect(Object.hasOwn(context, key)).toBe(false);
        if (failure === 'restore') {
          expect(restoreAttempts).toBe(tops.length);
          expect(
            tops.slice(1).every((top) => Object.getPrototypeOf(top) === Object.prototype)
          ).toBe(true);
        } else
          expect(tops.every((top) => Object.getPrototypeOf(top) === Object.prototype)).toBe(true);
      } finally {
        for (const top of tops) Object.setPrototypeOf(top, Object.prototype);
      }
    }
  );

  it('retires only its exact unentered binding, preserving foreign or active ownership', () => {
    const context = vm.createContext({ process, Object, Date });
    const bind = vm.runInContext(`(${bindLegacyCensusModules.toString()})`, context);
    const retire = vm.runInContext(`(${retireLegacyCensusBinding.toString()})`, context);
    const key = '__legacyEngineCensus_33333333333333333333333333333333';
    const deadline = Date.now() + 5000;
    bind.call({}, key, deadline);
    expect(() => bind.call({}, key, deadline)).toThrow('native census binding refused');
    expect(() => retire(key, deadline + 1)).toThrow();
    expect(retire(key, deadline)).toBe(true);
    expect(retire(key, deadline)).toBe(true);
    bind.call({}, key, deadline);
    Object.defineProperty(context[key], 'marker', { value: {} });
    expect(() => retire(key, deadline)).toThrow('native census binding is not unentered');
    expect(Object.hasOwn(context, key)).toBe(true);
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
    expect(() => projectLegacyCensus.call(diverse, modules, Date.now() + 5000)).toThrow(
      'native census topology refused'
    );
    let deep = roots[0].prototype;
    for (let index = 0; index < 257; index++) deep = Object.create(deep);
    expect(() =>
      projectLegacyCensus.call([Object.create(deep)], modules, Date.now() + 5000)
    ).toThrow('native census topology refused');
  });

  it('refuses an expired or exhausted in-target deadline and excessive owner counts without returning a prefix', () => {
    const roots = Array.from({ length: 5 }, () => class Concrete {});
    const modules = {
      gameServer: { GameServer: roots[0] },
      engine: { ServerTableEngine: roots[1] },
      manager: { TournamentManager: roots[2] },
      lightningWorker: { LightningClusterWorker: roots[3] },
      lightningHost: { LightningHandHost: roots[4] },
    };
    expect(() => projectLegacyCensus.call([], modules, Date.now() - 1)).toThrow(
      'native census projection deadline refused'
    );
    expect(() => projectLegacyCensus.call([], modules, Date.now() + 41000)).toThrow(
      'native census projection deadline refused'
    );
    let clockReads = 0;
    const bounded = vm.runInNewContext(`(${projectLegacyCensus.toString()})`, {
      process,
      Date: { now: () => (++clockReads === 1 ? 1000 : 2001) },
    });
    expect(() => bounded.call([new roots[0]()], modules, 2000)).toThrow(
      'native census projection deadline exhausted'
    );
    expect(clockReads).toBe(2);
    const excess = Array.from({ length: 4001 }, () => new roots[1]());
    expect(() => projectLegacyCensus.call(excess, modules, Date.now() + 5000)).toThrow(
      'native census count refused'
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
      availableHeapBytes: 33554944,
      availableProcessBytes: 33562624,
    };
    expect(legacyCensusMemoryAdmission(exact)).toMatchObject({
      ok: true,
      requiredHeapBytes: 33554944,
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

  it('admits half the used heap: a full predecessor still refuses, a fresh one is admitted', () => {
    // The 13:55Z 2026-10-31 production reading: still refused.
    expect(
      legacyCensusMemoryAdmission({
        usedHeapBytes: 3913011648,
        availableHeapBytes: 322107592,
        availableProcessBytes: 50471874560,
      })
    ).toMatchObject({ ok: false, requiredHeapBytes: 1956505824 + 33554432 });
    // A predecessor about an hour after restart (~2.0 GB live of a ~4.2 GB
    // limit), which the full-second-heap rule refused: admitted.
    expect(
      legacyCensusMemoryAdmission({
        usedHeapBytes: 2_100_000_000,
        availableHeapBytes: 2_135_000_000,
        availableProcessBytes: 50_000_000_000,
      })
    ).toMatchObject({ ok: true, requiredHeapBytes: 1_050_000_000 + 33554432 });
    // The rule never admits less than the derived worst case (usedHeap / 3).
    for (const used of [1024, 64 * 1024 * 1024, 2_000_000_000, 3_913_011_648]) {
      const admission = legacyCensusMemoryAdmission({
        usedHeapBytes: used,
        availableHeapBytes: Number.MAX_SAFE_INTEGER - 1,
        availableProcessBytes: Number.MAX_SAFE_INTEGER - 1,
      });
      expect(admission?.requiredHeapBytes).toBeGreaterThanOrEqual(Math.ceil(used / 3) + 32 * 1024 * 1024);
    }
  });
});
