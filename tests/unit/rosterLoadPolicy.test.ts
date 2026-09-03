import { describe, expect, it, vi } from 'vitest';
import {
  ROSTER_SUMMARY_REUSE_MS,
  RosterSummaryCoordinator,
  settleRosterReadsIndependently,
  shouldTouchFeeRollup,
} from '../../src/lib/rosterLoadPolicy';

describe('Player Command summary read policy', () => {
  it('shares one pending summary read across superseded roster queries', async () => {
    let resolveSummary: ((value: string) => void) | undefined;
    const reader = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveSummary = resolve;
        })
    );
    const coordinator = new RosterSummaryCoordinator<string>(() => 1_000);

    const first = coordinator.read('viewer:club', reader);
    const second = coordinator.read('viewer:club', reader);

    await Promise.resolve();
    expect(reader).toHaveBeenCalledTimes(1);
    resolveSummary?.('live summary');
    await expect(Promise.all([first, second])).resolves.toEqual(['live summary', 'live summary']);
  });

  it('reuses a recent settled summary without another network call', async () => {
    let now = 2_000;
    const reader = vi.fn().mockResolvedValue('live summary');
    const coordinator = new RosterSummaryCoordinator<string>(() => now);

    await expect(coordinator.read('viewer:club', reader)).resolves.toBe('live summary');
    now += ROSTER_SUMMARY_REUSE_MS - 1;
    await expect(coordinator.read('viewer:club', reader)).resolves.toBe('live summary');

    expect(reader).toHaveBeenCalledTimes(1);
  });

  it('starts the reuse window when a slow request settles, not when it starts', async () => {
    let now = 2_000;
    let resolveSummary: ((value: string) => void) | undefined;
    const reader = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveSummary = resolve;
        })
    );
    const coordinator = new RosterSummaryCoordinator<string>(() => now);

    const pending = coordinator.read('viewer:club', reader);
    await Promise.resolve();
    now += ROSTER_SUMMARY_REUSE_MS * 2;
    resolveSummary?.('late summary');
    await pending;
    now += ROSTER_SUMMARY_REUSE_MS - 1;

    await expect(coordinator.read('viewer:club', reader)).resolves.toBe('late summary');
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it('refreshes an expired or explicitly forced summary', async () => {
    let now = 3_000;
    const reader = vi
      .fn()
      .mockResolvedValueOnce('first')
      .mockResolvedValueOnce('expired')
      .mockResolvedValueOnce('forced');
    const coordinator = new RosterSummaryCoordinator<string>(() => now);

    await expect(coordinator.read('viewer:club', reader)).resolves.toBe('first');
    now += ROSTER_SUMMARY_REUSE_MS;
    await expect(coordinator.read('viewer:club', reader)).resolves.toBe('expired');
    now += 1;
    await expect(coordinator.read('viewer:club', reader, { force: true })).resolves.toBe('forced');

    expect(reader).toHaveBeenCalledTimes(3);
  });

  it('does not cache a failed summary read', async () => {
    const reader = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue('recovered');
    const coordinator = new RosterSummaryCoordinator<string>(() => 4_000);

    await expect(coordinator.read('viewer:club', reader)).rejects.toThrow('offline');
    await expect(coordinator.read('viewer:club', reader)).resolves.toBe('recovered');
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it('turns a synchronous reader failure into a retryable rejected promise', async () => {
    const reader = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => {
        throw new Error('synchronous setup failure');
      })
      .mockResolvedValue('recovered');
    const coordinator = new RosterSummaryCoordinator<string>(() => 4_000);

    await expect(coordinator.read('viewer:club', reader)).rejects.toThrow(
      'synchronous setup failure'
    );
    await expect(coordinator.read('viewer:club', reader)).resolves.toBe('recovered');
  });

  it('does not let an old club request repopulate a reset coordinator', async () => {
    let resolveOld: ((value: string) => void) | undefined;
    const oldReader = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveOld = resolve;
        })
    );
    const newReader = vi.fn().mockResolvedValue('new club');
    const coordinator = new RosterSummaryCoordinator<string>(() => 5_000);

    const oldRequest = coordinator.read('viewer:old-club', oldReader);
    await Promise.resolve();
    coordinator.reset();
    resolveOld?.('old club');
    await expect(oldRequest).resolves.toBe('old club');
    await expect(coordinator.read('viewer:new-club', newReader)).resolves.toBe('new club');

    expect(newReader).toHaveBeenCalledTimes(1);
  });
});

describe('Player Command fee rollup touch policy', () => {
  it('touches once immediately and then mirrors the server cooldown', () => {
    expect(shouldTouchFeeRollup(null, 10_000)).toBe(true);
    expect(shouldTouchFeeRollup(10_000, 39_999)).toBe(false);
    expect(shouldTouchFeeRollup(10_000, 40_000)).toBe(true);
  });
});

describe('Player Command independent read settlement', () => {
  it('publishes a ready directory page without waiting for a slow summary', async () => {
    let resolveSummary: ((value: string) => void) | undefined;
    const summary = new Promise<string>((resolve) => {
      resolveSummary = resolve;
    });
    const onSummary = vi.fn();
    const onPage = vi.fn();

    const settlement = settleRosterReadsIndependently({
      summary,
      page: Promise.resolve('directory'),
      onSummary,
      onPage,
      onSummaryError: vi.fn(),
      onPageError: vi.fn(),
    });
    await Promise.resolve();

    expect(onPage).toHaveBeenCalledWith('directory');
    expect(onSummary).not.toHaveBeenCalled();

    resolveSummary?.('totals');
    await settlement;
    expect(onSummary).toHaveBeenCalledWith('totals');
  });
});
