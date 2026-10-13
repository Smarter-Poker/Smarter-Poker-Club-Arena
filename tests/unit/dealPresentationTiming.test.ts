import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  observeDealPresentationTiming,
  DEAL_PRESENTATION_TIMING_EVENT,
} from '../../src/utils/dealPresentationTiming';

afterEach(() => {
  delete (window as any).__spObserveDealPresentationTiming;
  vi.restoreAllMocks();
});
describe('certificate-only deal timing', () => {
  it('emits nothing unless a transient certificate observer opted in', () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    observeDealPresentationTiming({ handNumber: 12, phase: 'scheduled' });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('reports the exact hand and clock without cards or player identity', () => {
    (window as any).__spObserveDealPresentationTiming = true;
    vi.spyOn(Date, 'now').mockReturnValue(12345);
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    observeDealPresentationTiming({ handNumber: 12, phase: 'timer-fired' });
    const event = dispatch.mock.calls[0][0] as CustomEvent;
    expect(event.type).toBe(DEAL_PRESENTATION_TIMING_EVENT);
    expect(event.detail).toEqual({ handNumber: 12, phase: 'timer-fired', at: 12345 });
    observeDealPresentationTiming({ handNumber: 0, phase: 'timer-fired' });
    expect(dispatch).toHaveBeenCalledOnce();
  });
  it('cannot throw into gameplay even if observation is unavailable', () => {
    (window as any).__spObserveDealPresentationTiming = true;
    vi.spyOn(window, 'dispatchEvent').mockImplementation(() => {
      throw new Error('observer failure');
    });
    expect(() =>
      observeDealPresentationTiming({ handNumber: 12, phase: 'timer-fired' })
    ).not.toThrow();
  });
});

describe('the diagnostic cannot certify a late animation as on time', () => {
  it('leaves the three-second DOM witness and full four-format certificate intact', () => {
    const read = (path: string) => readFileSync(resolve(__dirname, '../..', path), 'utf8');
    const spec = read('tests/e2e/production-live-table-realtime.spec.ts');
    expect(spec).toContain('const PRESENTATION_DEADLINE_MS = 3_000');
    expect(spec).toContain("entry.kind === 'deal-animation'");
    expect(spec).toContain("entry.kind === 'dealer-button-moved'");
    expect(spec).not.toContain("entry.kind === 'presentation-timing'");
    expect(spec).toContain("const TOURNAMENT_FORMATS = ['mtt', 'spin', 'sng'] as const");
    const journal = read('tests/e2e/support/liveTableRealtime.ts');
    expect(journal).toContain('if (count >= 8) return');
    expect(journal).toContain('handCounts.size >= 8');
    expect(journal).toContain('stopTiming()');
    const page = read('src/pages/TablePage.tsx');
    expect(page).toContain("phase: 'scheduled'");
    expect(page).toContain("phase: 'timer-fired'");
    expect(page).toContain('handNumber={tableState.handNumber}');
  });
});
