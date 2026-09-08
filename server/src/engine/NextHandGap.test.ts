import { describe, expect, it } from 'vitest';
import { NEXT_HAND_GAP_SLACK_MS, NextHandGapRecorder } from './NextHandGap.js';

const sample = (
  gapMs: number,
  extra: Partial<Parameters<NextHandGapRecorder['record']>[0]> = {}
) => ({
  tableId: 't',
  gapMs,
  phases: { await_post_hand_tasks: Math.round(gapMs / 2), next_hand_rest: Math.round(gapMs / 2) },
  rebuyPaused: false,
  at: Date.now(),
  ...extra,
});

describe('NextHandGapRecorder', () => {
  it('reports nothing before it has a sample', () => {
    const r = new NextHandGapRecorder(2000);
    expect(r.snapshot()).toMatchObject({
      samples: 0,
      p50Ms: null,
      p90Ms: null,
      maxMs: null,
      over: 0,
    });
  });

  it('p50, p90, max and the over count read the design number', () => {
    const r = new NextHandGapRecorder(2000);
    for (const g of [2000, 2050, 2100, 2200, 2300, 2400, 2600, 2700, 3000, 6000])
      r.record(sample(g));
    const s = r.snapshot();
    expect(s.samples).toBe(10);
    expect(s.p50Ms).toBe(2400);
    expect(s.p90Ms).toBe(6000);
    expect(s.maxMs).toBe(6000);
    // over = gaps beyond restMs + slack (2500): 2600, 2700, 3000, 6000
    expect(s.slackMs).toBe(NEXT_HAND_GAP_SLACK_MS);
    expect(s.over).toBe(4);
    expect(s.phaseP50Ms.await_post_hand_tasks).toBe(1200);
  });

  it('a gap that contained the rebuy pause is counted separately, never as over', () => {
    const r = new NextHandGapRecorder(2000);
    r.record(sample(2100));
    r.record(sample(7100, { rebuyPaused: true }));
    const s = r.snapshot();
    expect(s.samples).toBe(2);
    expect(s.withRebuyPause).toBe(1);
    expect(s.over).toBe(0);
    expect(s.maxMs).toBe(2100);
  });

  it('forgets samples older than the window', () => {
    const r = new NextHandGapRecorder(2000);
    r.record(sample(2100, { at: Date.now() - 11 * 60_000 }));
    r.record(sample(2200));
    expect(r.snapshot().samples).toBe(1);
  });
});
