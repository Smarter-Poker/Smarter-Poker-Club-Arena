import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  horseRebuyFailureClass,
  reportHorseRebuyDecision,
} from './horseTournamentRebuyDiagnostic.js';
afterEach(() => vi.restoreAllMocks());
describe('original Horse rebuy input diagnostics', () => {
  it('records a stable generation, choice, deadline, response timing and SQLSTATE without error payloads', () => {
    vi.spyOn(Date, 'now').mockReturnValue(12345);
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    reportHorseRebuyDecision({
      tournamentId: 'event',
      userId: 'horse',
      handNumber: 7,
      choice: true,
      phase: 'purchase_unproven',
      bustAtMs: 1000,
      promptUntilMs: 12000,
      startedAtMs: 11000,
      error: {
        code: '55000',
        message: 'Rebuy or re-entry decision window has closed',
        secret: 'never export',
      },
    });
    const text = log.mock.calls[0][0] as string;
    const record = JSON.parse(text.slice(text.indexOf('{')));
    expect(record).toMatchObject({
      schema: 'horse-rebuy-decision/v1',
      handNumber: 7,
      choice: true,
      phase: 'purchase_unproven',
      remainingMs: -345,
      elapsedMs: 1345,
      sqlstate: '55000',
      failureClass: 'cutoff',
    });
    expect(text).not.toContain('never export');
    expect(text).not.toContain('message');
  });
  it('keeps transport/timeout outcomes unknown and diagnostics cannot unwind gameplay', () => {
    expect(horseRebuyFailureClass(new Error('fetch failed'))).toBe('transport');
    expect(horseRebuyFailureClass({ code: '57014' })).toBe('timeout');
    expect(horseRebuyFailureClass(null)).toBe('unknown');
    vi.spyOn(console, 'info').mockImplementation(() => {
      throw new Error('broken stderr');
    });
    expect(() =>
      reportHorseRebuyDecision({
        tournamentId: 'event',
        userId: 'horse',
        handNumber: 7,
        choice: true,
        phase: 'purchased',
        bustAtMs: null,
        promptUntilMs: null,
      })
    ).not.toThrow();
  });
});
