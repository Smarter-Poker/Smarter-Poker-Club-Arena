import { describe, expect, it } from 'vitest';
import { auditClubDataSnapshot, formatClubDataAge } from '../../src/lib/clubDataIntegrity';

const snapshot = {
  range: { start: '2026-08-18', end: '2026-08-31', days: 14 },
  summary: {
    games: 2,
    total_winnings: 30,
    cash_winnings: 10,
    mtt_winnings: 20,
    fee: 8,
    cash_fee: 3,
    mtt_fee: 5,
    hands: 40,
  },
  rows: [
    { kind: 'CASH', id: 'one', fee: 3, winnings: 10, hands: 40, players: 4 },
    { kind: 'MTT', id: 'two', fee: 5, winnings: 20, hands: 0, players: 18 },
  ],
  row_count: 2,
  data_updated_at: '2026-08-31T12:00:00Z',
  generated_at: '2026-08-31T12:00:01Z',
};

describe('Club Data snapshot integrity', () => {
  it('certifies a complete, internally reconciled snapshot', () => {
    const result = auditClubDataSnapshot(snapshot);
    expect(result).toMatchObject({ level: 'verified', renderable: true });
    expect(result.passed).toBe(result.checks);
    expect(result.issues).toEqual([]);
  });

  it('refuses to call a shapeless response renderable', () => {
    const result = auditClubDataSnapshot({ rows: [] });
    expect(result.renderable).toBe(false);
    expect(result.level).toBe('attention');
    expect(result.issues).toContain('Summary totals are missing.');
  });

  it('detects duplicate rows and totals that do not reconcile', () => {
    const result = auditClubDataSnapshot({
      ...snapshot,
      summary: { ...snapshot.summary, games: 3, fee: 99 },
      rows: [snapshot.rows[0], snapshot.rows[0]],
    });
    expect(result.renderable).toBe(true);
    expect(result.level).toBe('attention');
    expect(result.issues).toEqual(
      expect.arrayContaining([
        'Summary game count does not match the filtered ledger count.',
        'The loaded ledger contains missing or duplicate game identities.',
        'Cash and tournament fees do not reconcile to total fees.',
      ])
    );
  });

  it('formats verification age without implying false precision', () => {
    expect(formatClubDataAge(0)).toBe('Now');
    expect(formatClubDataAge(42_000)).toBe('42s Ago');
    expect(formatClubDataAge(121_000)).toBe('2m Ago');
    expect(formatClubDataAge(7_300_000)).toBe('2h Ago');
  });
});
