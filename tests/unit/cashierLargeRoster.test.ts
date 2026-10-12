import { describe, expect, it } from 'vitest';
import {
  rosterMatchRank,
  rosterRowMatches,
  sortCashierRosterMatches,
  type DownlineRow,
} from '../../src/lib/cashierRoster';
import {
  mergeCashierBatchReceiptRows,
  type CashierBatchReceiptRow,
} from '../../src/utils/cashierBatch';

const roster = (size: number): DownlineRow[] =>
  Array.from({ length: size }, (_, i) => ({
    userId: `member-${i}`,
    name: `Player ${i}`,
    username: `member_${i}`,
    avatarUrl: null,
    role: i % 11 === 0 ? 'super_agent' : 'player',
    chipBalance: (i * 7919) % size,
    depth: i % 3,
    isMine: i % 3 === 1,
    playerNumber: `${940000 + i}`,
    isSelf: i === size - 1,
  }));
const byBalance = (a: DownlineRow, b: DownlineRow) => b.chipBalance - a.chipBalance;

describe('cashier complete roster and receipt scaling', () => {
  it.each(['', '  PLAYER  ', 'member_9', '940', 'SUPER AGENT', 'missing'])(
    'preserves the full existing search order for %s',
    (query) => {
      const rows = roster(2500);
      const q = query.trim();
      const expected = rows
        .filter((row) => rosterRowMatches(row, q))
        .sort((a, b) => (q ? rosterMatchRank(b, q) - rosterMatchRank(a, q) : 0) || byBalance(a, b));
      const original = rows.slice();
      expect(sortCashierRosterMatches(rows, query, byBalance)).toEqual(expected);
      expect(rows).toEqual(original);
    }
  );

  it('scores each member once even when all 10000 names match', () => {
    let nameReads = 0;
    const rows = roster(10000).map((row) => ({
      ...row,
      get name() {
        nameReads++;
        return row.name;
      },
    }));
    const result = sortCashierRosterMatches(rows, 'Player', byBalance);
    expect(result).toHaveLength(10000);
    expect(result[0].isSelf).toBe(true);
    expect(nameReads).toBe(10000);
  });

  it('retains confirmed receipts, exact amounts and original references on a large partial retry', () => {
    let idReads = 0;
    const previous: CashierBatchReceiptRow[] = Array.from({ length: 5000 }, (_, i) => ({
      userId: `member-${i}`,
      name: `Player ${i}`,
      amount: i / 100 + 0.01,
      destination: 'Player Wallet',
      outcome: 'Confirmed',
      reference: `original-${i}`,
    }));
    const current = previous
      .filter((_, i) => i % 2 === 0)
      .map((row) => ({
        ...row,
        get userId() {
          idReads++;
          return row.userId;
        },
        outcome: 'Outcome Needs Verification' as const,
      }));
    const original = previous.slice();
    const result = mergeCashierBatchReceiptRows(previous, current);
    expect(idReads).toBe(current.length);
    expect(result).toHaveLength(5000);
    expect(result.slice(0, 2500)).toEqual(previous.filter((_, i) => i % 2 === 1));
    expect(result.slice(2500)).toEqual(current);
    expect(result[0].reference).toBe('original-1');
    expect(result[2500].amount).toBe(0.01);
    expect(previous).toEqual(original);
  });
});
