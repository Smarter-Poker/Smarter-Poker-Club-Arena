import { describe, expect, it } from 'vitest';
import { BootPhaseTimeline } from './bootPhases.js';

function timeline() {
  let now = 10_000;
  const lines: string[] = [];
  const t = new BootPhaseTimeline(
    () => now,
    9_000,
    (line) => lines.push(line)
  );
  return { t, lines, advance: (ms: number) => (now += ms) };
}

describe('boot phase timeline', () => {
  it('cannot turn a successful operation into a boot failure when its logger throws', async () => {
    const t = new BootPhaseTimeline(
      () => 10_000,
      9_000,
      () => {
        throw new Error('log unavailable');
      }
    );
    await expect(t.measure('load', async () => 'ready')).resolves.toBe('ready');
    expect(() => t.markDealerReady()).not.toThrow();
    expect(t.snapshot().dealerReadyMs).toBe(1_000);
    const failure = new Error('original failure');
    await expect(
      t.measure('failed', async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
  });

  it('measures every phase from process start, including overlapping ones', () => {
    const { t, lines, advance } = timeline();
    t.mark('http_listening');
    const lane = t.begin('horse_decision_lane_ready');
    advance(200);
    const cleanup = t.begin('stale_data_cleanup');
    advance(1_500);
    cleanup();
    advance(8_300);
    lane();
    t.markDealerReady();

    const snap = t.snapshot();
    expect(snap.processStartedAt).toBe(new Date(9_000).toISOString());
    expect(snap.dealerReadyMs).toBe(11_000);
    expect(snap.phases).toEqual([
      { name: 'http_listening', startMs: 1_000, endMs: 1_000, durationMs: 0, outcome: 'ok' },
      {
        name: 'horse_decision_lane_ready',
        startMs: 1_000,
        endMs: 11_000,
        durationMs: 10_000,
        outcome: 'ok',
      },
      {
        name: 'stale_data_cleanup',
        startMs: 1_200,
        endMs: 2_700,
        durationMs: 1_500,
        outcome: 'ok',
      },
    ]);
    expect(lines.some((l) => l.includes('stale_data_cleanup ok in 1500ms'))).toBe(true);
    expect(lines.at(-1)).toContain('dealer prerequisites ready 11000ms after process start');
    expect(lines.at(-1)).toContain('horse_decision_lane_ready=10000');
  });

  it('ends a phase once, keeps a running phase open, and records the outcome', async () => {
    const { t, advance } = timeline();
    const end = t.begin('equity_worker_pool_ready');
    t.begin('maintenance_break_adoption');
    advance(50);
    end('cancelled');
    advance(50);
    end('ok');
    await expect(
      t.measure('rake_spec_check', async () => {
        advance(7);
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    await expect(t.measure('leadership_claim', async () => 'leader')).resolves.toBe('leader');
    const [equity, brk, rake, leader] = t.snapshot().phases;
    expect(equity).toMatchObject({ durationMs: 50, outcome: 'cancelled' });
    expect(brk).toMatchObject({ endMs: null, durationMs: null, outcome: null });
    expect(rake).toMatchObject({ durationMs: 7, outcome: 'failed' });
    expect(leader).toMatchObject({ outcome: 'ok' });
  });

  it('reports the dealer gate once and returns copies', () => {
    const { t, advance } = timeline();
    t.markDealerReady();
    advance(5_000);
    t.markDealerReady();
    expect(t.snapshot().dealerReadyMs).toBe(1_000);
    t.mark('x');
    t.snapshot().phases[0]!.name = 'mutated';
    expect(t.snapshot().phases[0]!.name).toBe('x');
  });
});
