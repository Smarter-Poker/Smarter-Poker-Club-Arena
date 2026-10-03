export interface SettlementHistoryCycle {
  id: string;
  periodId: string;
  totalRake: number;
  unionTax: number;
  netSettlement: number;
  status: string;
  createdAt: string;
  agentPayouts: number;
}

type JsonRecord = Record<string, unknown>;

const SETTLEMENT_STATUSES = new Set([
  'pending',
  'generated',
  'paid',
  'cancelled',
  'overdue',
  'disputed',
]);

function record(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function timestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value
    ) &&
    Number.isFinite(Date.parse(value))
  );
}

function exactCents(value: unknown): bigint | null {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'number' && !Number.isFinite(value))
  ) {
    return null;
  }
  const source = String(value).trim();
  if (!source || source.length > 128) return null;
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(source);
  if (!match || /[1-9]/.test((match[2] ?? '').slice(2))) return null;
  const cents = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0').slice(0, 2));
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? cents : null;
}

function amountFromCents(cents: bigint): number | null {
  const amount = Number(cents) / 100;
  return Number.isFinite(amount) && Math.round(amount * 100) === Number(cents) ? amount : null;
}

/**
 * Validates the settlement-history read model before any value reaches the
 * console. The table contract stores gross/net as exact cents. For this rake
 * split, net_amount is the union hold and the remainder is retained by the
 * club. Historical rows may omit the duplicated breakdown fields, but when a
 * split is supplied it must agree with those authoritative amounts exactly.
 */
export function parseSettlementHistory(value: unknown): SettlementHistoryCycle[] | null {
  if (!Array.isArray(value)) return null;
  const cycles: SettlementHistoryCycle[] = [];
  const seen = new Set<string>();

  for (const row of value) {
    if (!record(row) || !record(row.breakdown)) return null;
    const id = text(row.id);
    const status = text(row.status);
    const periodId = row.period_id === null ? 'N/A' : text(row.period_id);
    const gross = exactCents(row.gross_amount);
    const net = exactCents(row.net_amount);
    if (
      !id ||
      seen.has(id) ||
      row.invoice_type !== 'union_to_club' ||
      !periodId ||
      !status ||
      !SETTLEMENT_STATUSES.has(status) ||
      !timestamp(row.created_at) ||
      gross === null ||
      net === null ||
      net > gross
    ) {
      return null;
    }

    const suppliedUnionHold = row.breakdown.union_hold_amount;
    const suppliedRetained = row.breakdown.club_retained;
    const unionHold = suppliedUnionHold === undefined ? net : exactCents(suppliedUnionHold);
    const retained = suppliedRetained === undefined ? gross - net : exactCents(suppliedRetained);
    if (
      unionHold === null ||
      retained === null ||
      net !== unionHold ||
      gross !== unionHold + retained
    ) {
      return null;
    }

    const totalRake = amountFromCents(gross);
    const unionTax = amountFromCents(unionHold);
    const netSettlement = amountFromCents(retained);
    if (totalRake === null || unionTax === null || netSettlement === null) return null;

    seen.add(id);
    cycles.push({
      id,
      periodId,
      totalRake,
      unionTax,
      netSettlement,
      status: status === 'paid' ? 'completed' : status,
      createdAt: row.created_at,
      agentPayouts: 0,
    });
  }

  return cycles;
}
