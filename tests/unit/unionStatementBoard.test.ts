import { describe, expect, it } from 'vitest';
import { parseUnionStatementBoard } from '../../src/utils/unionStatementBoard';

const board = () => ({
  union_id: 'union-a',
  union_name: 'Midway Union',
  period_start: '2026-09-07',
  period_end: '2026-09-14',
  totals: {
    clubs: 1,
    issued: 1,
    missing: 0,
    delivered: 1,
    paid: 0,
    clubs_owe: 120.25,
    union_owes: 0,
    net: 120.25,
    collected: 0,
    outstanding: 120.25,
    rake_generated: 200,
    eco_amount: 0,
  },
  clubs: [
    {
      club_id: 'club-a',
      club_name: 'Shark Club',
      club_code: null,
      club_slug: 'shark-club',
      invoice_id: 'invoice-a',
      snapshot_complete: true,
      status: 'generated',
      issued_at: '2026-09-14T09:00:00Z',
      due_at: '2026-09-21T09:00:00Z',
      amount: 120.25,
      direction: 'club owes union',
      message_sent: true,
      overdue: false,
      paid_total: 0,
      outstanding: 120.25,
      rake_generated: 200,
      rakeback_due: 180,
      union_fee_kept: 20,
      players_won: 0,
      eco_amount: 0,
      presettled: 0,
    },
  ],
  history: [
    {
      period_start: '2026-09-07',
      period_end: '2026-09-14',
      clubs: 1,
      total_amount: 120.25,
      rake_generated: 200,
      eco_amount: 0,
      paid: 0,
      delivered: 1,
    },
  ],
  generated_at: '2026-10-03T12:00:00Z',
});

describe('parseUnionStatementBoard', () => {
  it('accepts a fully reconciled board bound to the requested union and period', () => {
    expect(parseUnionStatementBoard(board(), 'union-a', '2026-09-14')).toMatchObject({
      union_id: 'union-a',
      totals: { net: 120.25, outstanding: 120.25 },
      clubs: [{ invoice_id: 'invoice-a', snapshot_complete: true }],
    });
  });

  it('binds a current absolute invoice amount to its persisted union-owes direction', () => {
    const value = board();
    value.clubs[0].direction = 'union owes club';

    expect(parseUnionStatementBoard(value, 'union-a', '2026-09-14')).toMatchObject({
      clubs: [{ amount: -120.25, direction: 'union owes club' }],
      totals: { clubs_owe: 0, union_owes: 120.25, net: -120.25 },
    });
  });

  it('accepts a future signed board projection when its direction and totals reconcile', () => {
    const value = board();
    value.clubs[0].amount = -120.25;
    value.clubs[0].direction = 'union owes club';
    value.totals.clubs_owe = 0;
    value.totals.union_owes = 120.25;
    value.totals.net = -120.25;

    expect(parseUnionStatementBoard(value, 'union-a', '2026-09-14')).toMatchObject({
      clubs: [{ amount: -120.25 }],
      totals: { clubs_owe: 0, union_owes: 120.25, net: -120.25 },
    });
  });

  it('rejects a nonzero square statement rather than inventing its direction', () => {
    const value = board();
    value.clubs[0].direction = 'square';

    expect(() => parseUnionStatementBoard(value, 'union-a', '2026-09-14')).toThrow(
      /square statement carries a nonzero amount/i
    );
  });

  it('rejects signed totals that match neither the current nor normalized projection', () => {
    const value = board();
    value.clubs[0].direction = 'union owes club';
    value.totals.net = 10;

    expect(() => parseUnionStatementBoard(value, 'union-a', '2026-09-14')).toThrow(
      /signed totals do not reconcile/i
    );
  });

  it('rejects a signed amount that contradicts a club-owes direction', () => {
    const value = board();
    value.clubs[0].amount = -120.25;
    value.totals.clubs_owe = 0;
    value.totals.union_owes = 120.25;
    value.totals.net = -120.25;

    expect(() => parseUnionStatementBoard(value, 'union-a', '2026-09-14')).toThrow(
      /contradicts its club-owes direction/i
    );
  });

  it('accepts the exact missing-statement row emitted for a current club with no invoice', () => {
    const value = board() as any;
    value.period_start = null;
    value.totals = {
      clubs: 1,
      issued: 0,
      missing: 1,
      delivered: 0,
      paid: 0,
      clubs_owe: 0,
      union_owes: 0,
      net: 0,
      collected: 0,
      outstanding: 0,
      rake_generated: 0,
      eco_amount: 0,
    };
    value.clubs[0] = {
      ...value.clubs[0],
      invoice_id: null,
      snapshot_complete: false,
      status: 'missing',
      issued_at: null,
      due_at: null,
      amount: 0,
      direction: null,
      message_sent: false,
      overdue: false,
      paid_total: 0,
      outstanding: 0,
      rake_generated: 0,
      rakeback_due: 0,
      union_fee_kept: 0,
      players_won: 0,
      eco_amount: 0,
      presettled: 0,
    };

    expect(parseUnionStatementBoard(value, 'union-a', '2026-09-14')).toMatchObject({
      period_start: null,
      totals: { issued: 0, missing: 1 },
      clubs: [{ status: 'missing', invoice_id: null, snapshot_complete: false }],
    });
  });

  it.each(['open', 'awaiting_payment', 'partial'])(
    'rejects SQL-impossible %s statement status',
    (status) => {
      const value = board();
      value.clubs[0].status = status;
      expect(() => parseUnionStatementBoard(value, 'union-a', '2026-09-14')).toThrow(
        /status is invalid/
      );
    }
  );

  it.each([
    ['another union', (value: ReturnType<typeof board>) => (value.union_id = 'union-b')],
    ['another period', (value: ReturnType<typeof board>) => (value.period_end = '2026-09-15')],
    [
      'an incomplete snapshot',
      (value: ReturnType<typeof board>) => (value.clubs[0].snapshot_complete = false),
    ],
    [
      'an unknown status',
      (value: ReturnType<typeof board>) => (value.clubs[0].status = 'invented'),
    ],
    [
      'a malformed amount',
      (value: ReturnType<typeof board>) => (value.clubs[0].amount = Number.NaN),
    ],
    ['an unreconciled row', (value: ReturnType<typeof board>) => (value.clubs[0].outstanding = 1)],
    ['an unreconciled total', (value: ReturnType<typeof board>) => (value.totals.net = 999)],
  ])('rejects %s', (_label, mutate) => {
    const value = board();
    mutate(value);
    expect(() => parseUnionStatementBoard(value, 'union-a', '2026-09-14')).toThrow(/statement/i);
  });

  it('rejects duplicate invoice identities before any mutation can use them', () => {
    const value = board();
    value.clubs.push({ ...value.clubs[0], club_id: 'club-b' });
    value.totals = {
      ...value.totals,
      clubs: 2,
      issued: 2,
      delivered: 2,
      clubs_owe: 240.5,
      net: 240.5,
      outstanding: 240.5,
      rake_generated: 400,
    };
    expect(() => parseUnionStatementBoard(value, 'union-a', '2026-09-14')).toThrow(
      /invoice is duplicated/
    );
  });
});
