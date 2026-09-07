export type StatementStatus = 'missing' | 'cancelled' | 'pending' | 'paid' | 'overdue' | 'disputed';

export interface ClubSettlementBreakdown {
  clubId: string;
  clubName: string;
  invoiceId: string | null;
  rakeCollected: number | null;
  unionShare: number | null;
  netToClub: number | null;
  wireDirection: 'PAY_TO_UNION' | 'COLLECT_FROM_UNION' | null;
  status: StatementStatus;
  outstanding: number | null;
}

export interface UnionSettlement {
  unionId: string;
  periodStart: string | null;
  periodEnd: string | null;
  totalClubs: number;
  issuedClubs: number;
  coverage: 'complete' | 'partial' | 'missing';
  totalRakeCollected: number | null;
  totalUnionTax: number | null;
  totalAgentCommissions: null;
  totalPlayerRakeback: null;
  netUnionRevenue: number | null;
  overdueAmount: number;
  pendingSettlements: number;
  clubBreakdowns: ClubSettlementBreakdown[];
}

type Row = Record<string, unknown>;
function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Statement report is unavailable');
  }
  return value as Row;
}

// Aggregate exact cents, never infer historical rake from a current rate.
function cents(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error('Statement amount is missing');
  }
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match || (match[3]?.slice(2).replace(/0/g, '') ?? '') !== '') {
    throw new Error('Statement amount must be finite whole cents');
  }
  const magnitude = BigInt(match[2]) * 100n + BigInt((match[3] ?? '').slice(0, 2).padEnd(2, '0'));
  if (magnitude > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Statement amount is too large');
  return Number(magnitude) * (match[1] ? -1 : 1);
}

function sumCents(values: number[]): number {
  const total = values.reduce((sum, n) => sum + BigInt(n), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error('Statement total is too large');
  }
  return Number(total) / 100;
}

export function mapUnionStatementReport(unionId: string, raw: unknown, now = Date.now()): UnionSettlement {
  const board = object(raw);
  if (board.union_id !== unionId || !Array.isArray(board.clubs)) {
    throw new Error('Statement report does not match this union');
  }
  const seen = new Set<string>();
  const rake: number[] = [];
  const share: number[] = [];
  const clubs = board.clubs.map((value): ClubSettlementBreakdown => {
    const row = object(value);
    if (typeof row.club_id !== 'string' || seen.has(row.club_id)) throw new Error('Invalid statement club identity');
    seen.add(row.club_id);
    const base = { clubId: row.club_id, clubName: String(row.club_name ?? 'Unnamed Club') };
    if (row.status === 'missing') {
      return { ...base, invoiceId: null, status: 'missing', rakeCollected: null,
        unionShare: null, netToClub: null, wireDirection: null, outstanding: null };
    }
    if (!row.invoice_id || !['generated', 'sent', 'pending', 'paid', 'overdue', 'disputed', 'cancelled'].includes(String(row.status))) {
      throw new Error('Invalid issued statement identity or status');
    }
    if (row.snapshot_complete !== true) throw new Error('Issued statement accounting snapshot is incomplete');
    const amount = cents(row.amount);
    const paid = cents(row.paid_total);
    if (paid < 0) throw new Error('Statement paid total cannot be negative');
    const remaining = Math.max(Math.abs(amount) - paid, 0);
    const cancelled = row.status === 'cancelled';
    const rakeAmount = cents(row.rake_generated);
    const shareAmount = cents(row.union_fee_kept);
    const clubAmount = cents(row.rakeback_due);
    if (!cancelled) { rake.push(rakeAmount); share.push(shareAmount); }
    const due = row.due_at == null ? null : Date.parse(String(row.due_at));
    if (due !== null && !Number.isFinite(due)) throw new Error('Invalid statement due date');
    const status: StatementStatus = cancelled ? 'cancelled'
      : row.status === 'disputed' ? 'disputed'
      : row.status === 'paid' && remaining === 0 ? 'paid'
      : remaining > 0 && due !== null && due < now ? 'overdue' : 'pending';
    return { ...base, invoiceId: String(row.invoice_id), status,
      rakeCollected: rakeAmount / 100, unionShare: shareAmount / 100, netToClub: clubAmount / 100,
      wireDirection: amount > 0 ? 'PAY_TO_UNION' : amount < 0 ? 'COLLECT_FROM_UNION' : null,
      outstanding: cancelled ? 0 : remaining / 100 };
  });
  const issued = clubs.filter(c => c.status !== 'missing' && c.status !== 'cancelled').length;
  const start = board.period_start == null ? null : String(board.period_start);
  const end = board.period_end == null ? null : String(board.period_end);
  if (issued && (!start || !end || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)))) {
    throw new Error('Issued statement period is missing');
  }
  return { unionId, periodStart: start, periodEnd: end, totalClubs: clubs.length,
    issuedClubs: issued, coverage: issued === 0 ? 'missing' : issued === clubs.length ? 'complete' : 'partial',
    totalRakeCollected: issued ? sumCents(rake) : null,
    totalUnionTax: issued ? sumCents(share) : null,
    netUnionRevenue: issued ? sumCents(share) : null,
    overdueAmount: sumCents(clubs.filter(c => c.status === 'overdue').map(c => cents(c.outstanding))),
    pendingSettlements: clubs.filter(c => ['pending', 'overdue', 'disputed'].includes(c.status)).length,
    totalAgentCommissions: null, totalPlayerRakeback: null, clubBreakdowns: clubs };
}
