import { describe, it, expect } from 'vitest';
import {
  computeScenarioHash,
  fnv1a,
  StubGtoSolverClient,
  WorldHubGtoSolverClient,
  type Scenario,
  type SolverStrategy,
} from './GtoSolverClient.js';

const baseScenario: Scenario = {
  gameVariant: 'nlhe',
  street: 'flop',
  position: 'btn',
  stackBucket: '100bb',
  potBucket: '6bb',
  boardKey: 'AK7-2s',
  heroHoleClass: 'AKs',
  facing: 'unopened',
};

describe('scenario hashing', () => {
  it('fnv1a is stable and 8 hex chars', () => {
    expect(fnv1a('hello')).toBe(fnv1a('hello'));
    expect(fnv1a('hello')).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a('hello')).not.toBe(fnv1a('world'));
  });

  it('same scenario => same hash; different field => different hash', () => {
    const h1 = computeScenarioHash(baseScenario);
    const h2 = computeScenarioHash({ ...baseScenario });
    expect(h1).toBe(h2);
    expect(computeScenarioHash({ ...baseScenario, heroHoleClass: 'QQ' })).not.toBe(h1);
    expect(h1.startsWith('nlhe:flop:')).toBe(true);
  });
});

describe('StubGtoSolverClient', () => {
  it('returns registered strategies and null otherwise', async () => {
    const strat: SolverStrategy = {
      scenarioHash: 'nlhe:flop:abc',
      actions: [{ action: 'bet', frequency: 0.7, ev: 1.2 }],
    };
    const client = new StubGtoSolverClient([strat]);
    expect(await client.lookup('nlhe:flop:abc')).toEqual(strat);
    expect(await client.lookup('missing')).toBeNull();
  });

  it('supports a fallback resolver and batch', async () => {
    const client = new StubGtoSolverClient([], (h) => ({
      scenarioHash: h,
      actions: [{ action: 'check', frequency: 1, ev: 0 }],
    }));
    const batch = await client.lookupBatch(['x', 'y']);
    expect(batch.get('x')!.actions[0].action).toBe('check');
    expect(batch.size).toBe(2);
  });
});

describe('WorldHubGtoSolverClient', () => {
  it('caches fetcher results (single fetch per hash)', async () => {
    let calls = 0;
    const client = new WorldHubGtoSolverClient(async (h) => {
      calls++;
      return { scenarioHash: h, actions: [{ action: 'call', frequency: 1, ev: 0.5 }] };
    });
    await client.lookup('h1');
    await client.lookup('h1');
    expect(calls).toBe(1);
  });

  it('caches null misses too', async () => {
    let calls = 0;
    const client = new WorldHubGtoSolverClient(async () => {
      calls++;
      return null;
    });
    expect(await client.lookup('none')).toBeNull();
    expect(await client.lookup('none')).toBeNull();
    expect(calls).toBe(1);
  });
});
