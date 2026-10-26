import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
const here = dirname(fileURLToPath(import.meta.url));
import {
  _resetThrottledReportsForTests,
  describeError,
  isOpponentMemoryBusyRefusal,
  reportError,
  reportThrottled,
  reportWarning,
} from './errorReporter.js';
afterEach(() => vi.restoreAllMocks());
describe('local engine diagnostics', () => {
  it('records the original error and operational context without mutating it', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = Object.freeze(new Error('database unavailable'));
    const data = { tableId: 'fixture-table' };
    reportError(error, 'Table.settle', data);
    expect(spy).toHaveBeenCalledWith('[Table.settle]', error, data);
    expect(error.message).toBe('database unavailable');
  });
  it('keeps failed console writes inside the reporting boundary', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('EPIPE');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('EAGAIN');
    });
    expect(() => reportError(new Error('original failure'), 'Table.read')).not.toThrow();
    expect(() => reportWarning('retry refused', 'Table.read')).not.toThrow();
  });
  it('keeps warning context and structured financial error descriptions', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reportWarning('lease unavailable', 'Table.claim', { reason: 'conflict' });
    expect(spy).toHaveBeenCalledWith('[Table.claim] lease unavailable', { reason: 'conflict' });
    expect(describeError({ message: 'permission denied', code: '42501' })).toBe(
      'permission denied (42501)'
    );
  });
});

describe('an expected refusal is counted, not stack-traced (2026-10-25)', () => {
  afterEach(() => _resetThrottledReportsForTests());

  it('prints the first refusal at once, holds the rest of the window, then prints one line with the count', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t0 = 1_000_000;
    reportThrottled(
      'HorseOpponentMemory.decisionRead',
      'opponent memory unavailable: busy',
      60_000,
      t0
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenLastCalledWith(
      '[HorseOpponentMemory.decisionRead] opponent memory unavailable: busy'
    );
    for (let i = 0; i < 17_921; i++)
      reportThrottled(
        'HorseOpponentMemory.decisionRead',
        'opponent memory unavailable: busy',
        60_000,
        t0 + 1 + i
      );
    expect(warn).toHaveBeenCalledTimes(1);
    reportThrottled(
      'HorseOpponentMemory.decisionRead',
      'opponent memory unavailable: busy',
      60_000,
      t0 + 60_000
    );
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(
      '[HorseOpponentMemory.decisionRead] opponent memory unavailable: busy (17921 more in the last 60s)'
    );
  });

  it('never prints a stack, and keeps separate contexts in separate windows', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportThrottled('A.read', 'busy', 60_000, 0);
    reportThrottled('B.read', 'busy', 60_000, 0);
    expect(warn).toHaveBeenCalledTimes(2);
    for (const call of warn.mock.calls) {
      expect(call).toHaveLength(1);
      expect(typeof call[0]).toBe('string');
      expect(call[0]).not.toContain('\n    at ');
    }
    expect(error).not.toHaveBeenCalled();
  });

  it('a quiet window after a flood starts printing at once again', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reportThrottled('A.read', 'busy', 60_000, 0);
    reportThrottled('A.read', 'busy', 60_000, 10);
    reportThrottled('A.read', 'busy', 60_000, 5 * 60_000);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith('[A.read] busy (1 more in the last 60s)');
    reportThrottled('A.read', 'busy', 60_000, 5 * 60_000 + 1);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed console write inside the reporting boundary', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('EPIPE');
    });
    expect(() => reportThrottled('A.read', 'busy')).not.toThrow();
  });

  it('recognises exactly the admission refusal the opponent-memory readers produce', () => {
    expect(isOpponentMemoryBusyRefusal(new Error('opponent memory unavailable: busy'))).toBe(true);
    expect(isOpponentMemoryBusyRefusal(new Error('opponent memory unavailable: timeout'))).toBe(
      false
    );
    expect(isOpponentMemoryBusyRefusal('opponent memory unavailable: busy')).toBe(false);
    expect(isOpponentMemoryBusyRefusal({ message: 'opponent memory unavailable: busy' })).toBe(
      false
    );
  });
});

describe('the busy refusal is routed through the throttled reporter at every reader', () => {
  const read = (rel: string) => readFileSync(join(here, rel), 'utf8');
  it('HorseOpponentMemory, HandHistory and LightningHorseObservation', () => {
    const hom = read('HorseOpponentMemory.ts');
    expect(hom).toContain('isOpponentMemoryBusyRefusal(error)');
    expect(hom).not.toMatch(
      /reportError\(error, 'HorseOpponentMemory\.(decisionRead|donorRead)'\)/
    );
    const hh = read('supabase/handHistory.ts');
    expect(hh).toMatch(
      /isOpponentMemoryBusyRefusal\(error\)[\s\S]{0,200}reportThrottled\(\s*'HandHistory\.durable_opponent_read'/
    );
    const lho = read('../lightning/LightningHorseObservation.ts');
    expect(lho).toMatch(
      /isOpponentMemoryBusyRefusal\(error\)[\s\S]{0,200}reportThrottled\(\s*'LightningHorseObservation\.durable_opponent_read'/
    );
  });
});
