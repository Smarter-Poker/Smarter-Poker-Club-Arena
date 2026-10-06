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

function uuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
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

/**
 * Some immutable historical JSON mirrors carry a binary serialization tail
 * such as 4247.389999999999. The table's gross_amount and net_amount columns
 * remain the exact-cent authorities. Accept only a sub-millionth-of-a-cent
 * mirror artifact, then require it to equal those authoritative columns below.
 */
function mirroredCents(value: unknown): bigint | null {
  const exact = exactCents(value);
  if (exact !== null) return exact;
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'number' && !Number.isFinite(value))
  ) {
    return null;
  }

  const source = String(value).trim();
  if (!source || source.length > 128) return null;
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(source);
  if (!match) return null;
  const fraction = match[2] ?? '';
  const scale = 10n ** BigInt(fraction.length);
  const units = BigInt(match[1]) * scale + BigInt(fraction || '0');
  const scaledCents = units * 100n;
  const floorCents = scaledCents / scale;
  const remainder = scaledCents % scale;
  const nearestCent = floorCents + (remainder * 2n >= scale ? 1n : 0n);
  const dust =
    scaledCents >= nearestCent * scale
      ? scaledCents - nearestCent * scale
      : nearestCent * scale - scaledCents;

  // dust / (scale * 100) is the exact difference in chips. The accepted
  // ceiling is 0.00000001 chip, or one millionth of a cent.
  if (nearestCent > BigInt(Number.MAX_SAFE_INTEGER) || dust * 100000000n > scale * 100n) {
    return null;
  }
  return nearestCent;
}

function amountFromCents(cents: bigint): number | null {
  const amount = Number(cents) / 100;
  return Number.isFinite(amount) && Math.round(amount * 100) === Number(cents) ? amount : null;
}

/**
 * Validates the settlement-history read model before any value reaches the
 * console. The table contract stores gross/net as exact cents. For this rake
 * split, net_amount is the union hold and the remainder is retained by the
 * club. invoice_type is a direction and is also used by unrelated transfer
 * documents, so callers select only rows carrying both rake-split mirrors.
 * The parser requires those mirrors and verifies them against the exact-cent
 * authorities, tolerating only historical binary-serialization dust.
 */
export function parseSettlementHistory(
  value: unknown,
  expectedClubId: string
): SettlementHistoryCycle[] | null {
  if (!Array.isArray(value)) return null;
  const cycles: SettlementHistoryCycle[] = [];
  const seen = new Set<string>();

  for (const row of value) {
    if (!record(row) || !record(row.breakdown)) return null;
    const id = text(row.id);
    const clubId = text(row.club_id);
    const status = text(row.status);
    const periodId = row.period_id === null ? 'N/A' : text(row.period_id);
    const gross = exactCents(row.gross_amount);
    const net = exactCents(row.net_amount);
    if (
      !id ||
      !uuid(id) ||
      seen.has(id) ||
      !clubId ||
      !uuid(clubId) ||
      clubId !== expectedClubId ||
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
    const unionHold = mirroredCents(suppliedUnionHold);
    const retained = mirroredCents(suppliedRetained);
    if (
      unionHold === null ||
      retained === null ||
      net !== unionHold ||
      gross !== unionHold + retained
    ) {
      return null;
    }

    const totalRake = amountFromCents(gross);
    const unionTax = amountFromCents(net);
    const netSettlement = amountFromCents(gross - net);
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
