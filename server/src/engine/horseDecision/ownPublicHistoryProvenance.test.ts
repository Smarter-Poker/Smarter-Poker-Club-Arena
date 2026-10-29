import { expect, it, vi } from 'vitest';
import { HorseOwnPublicHistoryCache } from './ownPublicHistory.js';
import {
  HorseHistoryRetentionBudget,
  HISTORY_ACTIVE_LOADS,
  HISTORY_PACKET_MAX_BYTES,
} from './ownPublicHistoryBudget.js';
import { horseHistoryReadProvenanceIsValid } from './ownPublicHistoryProvenance.js';
import { horseObserverReadContextFromRequest } from '../HorseObserverReadContext.js';
import { decisionRequest, workerHarness } from '../../testing/horseRegression/plan/fixture.js';
import { buildHorseDecisionKey } from './protocol.js';
const context = () => horseObserverReadContextFromRequest(decisionRequest())!;
const window = (c = context()) => ({
  version: 1,
  source: 'original_dealt_public_v1',
  context: c,
  capped: false,
  hands: [],
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const ample = () => ({
  heap_size_limit: 1024 ** 3,
  used_heap_size: 0,
  total_available_size: 1024 ** 3,
});

it('retains original loading provenance as packets become ready, cut off and acknowledged', async () => {
  let finish!: (value: unknown) => void;
  let now = 100;
  const cache = new HorseOwnPublicHistoryCache(
    () =>
      new Promise((r) => {
        finish = r;
      }),
    () => now
  );
  try {
    expect(cache.forSnapshot(context(), now)).toBeUndefined();
    const original = cache.provenance(context(), now);
    expect(original).toMatchObject({ state: 'pending', reason: 'loading', context: context() });
    now = 200;
    finish(window());
    await flush();
    expect(cache.forSnapshot(context(), 100)).toBeUndefined();
    expect(cache.provenance(context(), 100)).toMatchObject({
      state: 'available',
      reason: 'packet_after_cutoff',
    });
    const packet = cache.forSnapshot(context(), 200)!;
    expect(cache.provenance(context(), 200)).toMatchObject({
      state: 'available',
      reason: 'packet_ready',
    });
    cache.acknowledge(context(), packet.digest);
    expect(cache.forSnapshot(context(), 200)).toBeUndefined();
    expect(cache.provenance(context(), 200)).toMatchObject({
      state: 'available',
      reason: 'worker_acknowledged',
    });
    expect(original).toMatchObject({ state: 'pending', reason: 'loading', decisionTimeMs: 100 });
    expect(
      horseHistoryReadProvenanceIsValid(
        cache.provenance(context(), 100),
        context(),
        'available',
        200
      )
    ).toBe(false);
  } finally {
    cache.dispose();
  }
});

it('distinguishes exhausted load slots from actual in-flight reads without additional I/O', async () => {
  const finish: Array<(value: unknown) => void> = [];
  const load = vi.fn(() => new Promise((r) => finish.push(r)));
  const cache = new HorseOwnPublicHistoryCache(load, () => 100);
  const contexts = Array.from({ length: HISTORY_ACTIVE_LOADS + 1 }, (_, i) => ({
    ...context(),
    observerId: `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`,
  }));
  try {
    for (const c of contexts) cache.forSnapshot(c, 100);
    expect(load).toHaveBeenCalledTimes(HISTORY_ACTIVE_LOADS);
    expect(cache.provenance(contexts[0]!, 100).reason).toBe('loading');
    expect(cache.provenance(contexts.at(-1)!, 100)).toMatchObject({
      state: 'pending',
      reason: 'load_capacity',
    });
  } finally {
    finish.forEach((resolve, i) => resolve(window(contexts[i]!)));
    await flush();
    cache.dispose();
  }
});

it.each(['nlh', 'plo4', 'plo5', 'plo6', 'plo8'] as const)(
  'binds the %s diagnostic to exact context, not neighboring partitions',
  async (variant) => {
    const c = { ...context(), variant };
    const cache = new HorseOwnPublicHistoryCache(
      async (_context, report) => {
        report?.('provider_error');
        return null;
      },
      () => 100
    );
    try {
      cache.forSnapshot(c, 100);
      await flush();
      const p = cache.provenance(c, 100);
      expect(p).toMatchObject({ state: 'unavailable', reason: 'provider_error', context: c });
      expect(horseHistoryReadProvenanceIsValid(p, c, 'unavailable', 100)).toBe(true);
      for (const changed of [
        { ...c, observerId: '22222222-2222-4222-8222-222222222222' },
        { ...c, variant: variant === 'nlh' ? ('plo4' as const) : ('nlh' as const) },
        { ...c, format: 'mtt' as const },
        { ...c, dealtCount: 3 },
      ])
        expect(horseHistoryReadProvenanceIsValid(p, changed, 'unavailable', 100)).toBe(false);
      expect(
        horseHistoryReadProvenanceIsValid(
          { ...p, reason: 'private raw error' },
          c,
          'unavailable',
          100
        )
      ).toBe(false);
      expect(horseHistoryReadProvenanceIsValid({ ...p, extra: true }, c, 'unavailable', 100)).toBe(
        false
      );
      expect(horseHistoryReadProvenanceIsValid(p, c, 'available', 100)).toBe(false);
    } finally {
      cache.dispose();
    }
  }
);

it.each(['invalid', 'rejected', 'thrown'] as const)(
  'distinguishes a %s loader and preserves cooldown',
  async (fault) => {
    const load = vi.fn(() => {
      if (fault === 'thrown') throw Error('not transported');
      return fault === 'rejected'
        ? Promise.reject(Error('not transported'))
        : Promise.resolve({ bad: true });
    });
    const cache = new HorseOwnPublicHistoryCache(load, () => 100);
    try {
      cache.forSnapshot(context(), 100);
      await flush();
      expect(cache.provenance(context(), 100).reason).toBe(
        { invalid: 'invalid_window', rejected: 'load_rejected', thrown: 'load_thrown' }[fault]
      );
      cache.forSnapshot(context(), 200);
      expect(load).toHaveBeenCalledTimes(1);
    } finally {
      cache.dispose();
    }
  }
);

it.each(['headroom', 'measurement'] as const)(
  'attributes actual %s admission refusal without loading',
  (fault) => {
    const budget = new HorseHistoryRetentionBudget(HISTORY_PACKET_MAX_BYTES * 2, () => {
      if (fault === 'measurement') throw Error('not transported');
      return { ...ample(), total_available_size: 0 };
    });
    const load = vi.fn(async () => window());
    const cache = new HorseOwnPublicHistoryCache(load, () => 100, 2048, budget);
    try {
      cache.forSnapshot(context(), 100);
      expect(cache.provenance(context(), 100)).toMatchObject({
        state: 'unavailable',
        reason: fault === 'headroom' ? 'retention_heap_headroom' : 'retention_heap_unavailable',
      });
      expect(load).not.toHaveBeenCalled();
      expect(budget.status()).toMatchObject({ encodedBytes: 0, reservations: 0 });
    } finally {
      cache.dispose();
    }
  }
);

it('diagnostic callback failure cannot change admission or retained accounting', () => {
  const budget = new HorseHistoryRetentionBudget(HISTORY_PACKET_MAX_BYTES, () => ({
    ...ample(),
    total_available_size: 0,
  }));
  expect(
    budget.reserve(
      {},
      100,
      () => {},
      () => {
        throw Error('diagnostic rejected');
      }
    )
  ).toBe(false);
  expect(budget.status()).toMatchObject({ encodedBytes: 0, reservations: 0 });
});

it('keeps a capacity-blocked retry distinct from its earlier provider failure', async () => {
  let now = 100;
  const finish: Array<(value: unknown) => void> = [];
  const target = context();
  const cache = new HorseOwnPublicHistoryCache(
    (c, report) => {
      if (c.observerId === target.observerId) {
        report?.('provider_error');
        return Promise.resolve(null);
      }
      return new Promise((resolve) => finish.push(resolve));
    },
    () => now
  );
  try {
    cache.forSnapshot(target, now);
    await flush();
    const original = cache.provenance(target, now);
    const contexts = Array.from({ length: HISTORY_ACTIVE_LOADS }, (_, i) => ({
      ...context(),
      observerId: `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`,
    }));
    for (const c of contexts) cache.forSnapshot(c, now);
    now += 60_001;
    cache.forSnapshot(target, now);
    expect(cache.provenance(target, now)).toMatchObject({
      state: 'unavailable',
      reason: 'retry_load_capacity',
    });
    expect(original.reason).toBe('provider_error');
    finish.forEach((resolve, i) => resolve(window(contexts[i]!)));
    await flush();
  } finally {
    finish.forEach((resolve) => resolve(null));
    await flush();
    cache.dispose();
  }
});

it.each([
  'observer',
  'variant',
  'format',
  'dealt_count',
  'reason',
  'extra',
  'state',
  'missing_packet',
  'cutoff',
] as const)(
  'the actual worker refuses forged %s provenance before decision capture',
  async (fault) => {
    const h = workerHarness();
    const request = decisionRequest();
    const provenance: any = {
      version: 1,
      context: { ...context() },
      decisionTimeMs: request.decisionTimeMs,
      state: 'pending',
      reason: 'loading',
    };
    request.ownPublicHistoryState = 'pending';
    if (fault === 'cutoff') provenance.decisionTimeMs++;
    if (fault === 'observer')
      provenance.context.observerId = '22222222-2222-4222-8222-222222222222';
    if (fault === 'variant') provenance.context.variant = 'plo5';
    if (fault === 'format') provenance.context.format = 'mtt';
    if (fault === 'dealt_count') provenance.context.dealtCount = 3;
    if (fault === 'reason') provenance.reason = 'raw error not allowed';
    if (fault === 'extra') provenance.raw = 'not allowed';
    if (fault === 'state') provenance.state = 'unavailable';
    if (fault === 'missing_packet') {
      provenance.state = 'available';
      provenance.reason = 'packet_ready';
      request.ownPublicHistoryState = 'available';
    }
    request.ownPublicHistoryProvenance = provenance;
    try {
      await h.runtime.start();
      h.runtime.receive(request);
      await h.runtime.drain();
      expect(h.captures).toHaveLength(0);
      expect(h.messages).toContainEqual(
        expect.objectContaining({
          type: 'ERROR',
          requestId: request.requestId,
          recoverable: true,
          message: expect.stringContaining('history provenance'),
        })
      );
    } finally {
      await h.close();
    }
  }
);

it('optional valid diagnostics preserve the canonical decision key and actual policy result', async () => {
  const request = decisionRequest();
  const first = workerHarness();
  const second = workerHarness();
  try {
    await first.runtime.start();
    await second.runtime.start();
    const baseline = await first.fast(request);
    const diagnostic = {
      ...request,
      ownPublicHistoryState: 'pending' as const,
      ownPublicHistoryProvenance: {
        version: 1 as const,
        context: context(),
        decisionTimeMs: request.decisionTimeMs,
        state: 'pending' as const,
        reason: 'loading' as const,
      },
    };
    expect(buildHorseDecisionKey(diagnostic)).toBe(request.decisionKey);
    const withDiagnostic = await second.fast(diagnostic);
    expect(withDiagnostic.decision).toEqual(baseline.decision);
    expect(second.captures.at(-1)?.snapshot).toMatchObject({
      ownPublicHistoryProvenance: diagnostic.ownPublicHistoryProvenance,
    });
  } finally {
    await first.close();
    await second.close();
  }
});
