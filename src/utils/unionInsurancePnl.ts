export interface UnionInsuranceTotals {
  contracts: number;
  premiums: number;
  payouts: number;
  net: number;
}

export interface UnionInsuranceOverlay {
  events: number;
  funded: number;
}

export interface UnionInsuranceDay extends UnionInsuranceTotals {
  d: string;
  overlay: number;
}

export interface UnionInsuranceClub extends UnionInsuranceTotals {
  club_id: string;
  club_name: string;
}

export interface UnionInsurancePnl {
  union_id: string;
  range_days: number;
  totals: UnionInsuranceTotals;
  overlay: UnionInsuranceOverlay;
  daily: UnionInsuranceDay[];
  by_club: UnionInsuranceClub[];
  generated_at: string;
}

type JsonRecord = Record<string, unknown>;

function objectValue(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as JsonRecord;
}

function textValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is invalid`);
  return value;
}

function countValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function moneyValue(value: unknown, label: string, nonnegative = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (nonnegative && value < 0)) {
    throw new Error(`${label} is invalid`);
  }
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(value * 100 - cents) > 0.000001) {
    throw new Error(`${label} is not an exact chip-cent amount`);
  }
  return cents / 100;
}

function dateValue(value: unknown, label: string): string {
  const date = textValue(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${label} is invalid`);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`${label} is invalid`);
  }
  return date;
}

function timestampValue(value: unknown, label: string): string {
  const timestamp = textValue(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${label} is invalid`);
  return timestamp;
}

const cents = (value: number): number => Math.round(value * 100);

function sumCents(values: number[], label: string): number {
  const total = values.reduce((sum, value) => sum + cents(value), 0);
  if (!Number.isSafeInteger(total)) throw new Error(`${label} is invalid`);
  return total;
}

function parseTotals(value: unknown, label: string): UnionInsuranceTotals {
  const totals = objectValue(value, label);
  const parsed: UnionInsuranceTotals = {
    contracts: countValue(totals.contracts, `${label} contract count`),
    premiums: moneyValue(totals.premiums, `${label} premiums`, true),
    payouts: moneyValue(totals.payouts, `${label} payouts`, true),
    net: moneyValue(totals.net, `${label} net`),
  };
  if (cents(parsed.net) !== cents(parsed.premiums) - cents(parsed.payouts)) {
    throw new Error(`${label} net does not reconcile`);
  }
  return parsed;
}

function addUtcDay(date: string): string {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function assertTotalsEqual(
  actual: UnionInsuranceTotals,
  expected: UnionInsuranceTotals,
  label: string
): void {
  if (
    actual.contracts !== expected.contracts ||
    cents(actual.premiums) !== cents(expected.premiums) ||
    cents(actual.payouts) !== cents(expected.payouts) ||
    cents(actual.net) !== cents(expected.net)
  ) {
    throw new Error(`${label} does not reconcile`);
  }
}

function aggregate(rows: UnionInsuranceTotals[]): UnionInsuranceTotals {
  const contractCount = rows.reduce((sum, row) => sum + row.contracts, 0);
  if (!Number.isSafeInteger(contractCount)) throw new Error('Insurance contract total is invalid');
  return {
    contracts: contractCount,
    premiums:
      sumCents(
        rows.map((row) => row.premiums),
        'Insurance premium aggregate'
      ) / 100,
    payouts:
      sumCents(
        rows.map((row) => row.payouts),
        'Insurance payout aggregate'
      ) / 100,
    net:
      sumCents(
        rows.map((row) => row.net),
        'Insurance net aggregate'
      ) / 100,
  };
}

export function parseUnionInsurancePnl(
  value: unknown,
  expectedUnionId: string,
  expectedRangeDays = 14
): UnionInsurancePnl {
  const payload = objectValue(value, 'Union insurance P&L');
  const unionId = textValue(payload.union_id, 'Union insurance identity');
  if (unionId !== expectedUnionId) throw new Error('Union insurance identity does not match');
  const rangeDays = countValue(payload.range_days, 'Union insurance range');
  if (rangeDays !== expectedRangeDays || expectedRangeDays < 1 || expectedRangeDays > 90) {
    throw new Error('Union insurance range does not match');
  }

  const totals = parseTotals(payload.totals, 'Union insurance totals');
  const overlayValue = objectValue(payload.overlay, 'Union insurance overlay');
  const overlay: UnionInsuranceOverlay = {
    events: countValue(overlayValue.events, 'Union insurance overlay event count'),
    funded: moneyValue(overlayValue.funded, 'Union insurance overlay funded total', true),
  };

  if (!Array.isArray(payload.daily) || payload.daily.length !== rangeDays) {
    throw new Error('Union insurance daily series is invalid');
  }
  let previousDate: string | null = null;
  const daily = payload.daily.map((entry, index): UnionInsuranceDay => {
    const row = objectValue(entry, `Union insurance day ${index + 1}`);
    const d = dateValue(row.d, `Union insurance day ${index + 1} date`);
    if (previousDate !== null && d !== addUtcDay(previousDate)) {
      throw new Error('Union insurance daily series is not consecutive');
    }
    previousDate = d;
    return {
      d,
      ...parseTotals(row, `Union insurance day ${index + 1}`),
      overlay: moneyValue(row.overlay, `Union insurance day ${index + 1} overlay`, true),
    };
  });

  if (!Array.isArray(payload.by_club)) throw new Error('Union insurance club series is invalid');
  const clubIds = new Set<string>();
  let previousNet: number | null = null;
  const byClub = payload.by_club.map((entry, index): UnionInsuranceClub => {
    const row = objectValue(entry, `Union insurance club ${index + 1}`);
    const clubId = textValue(row.club_id, `Union insurance club ${index + 1} identity`);
    if (clubIds.has(clubId)) throw new Error('Union insurance club series is duplicated');
    clubIds.add(clubId);
    const parsed = parseTotals(row, `Union insurance club ${index + 1}`);
    if (previousNet !== null && cents(parsed.net) > previousNet) {
      throw new Error('Union insurance club series is out of order');
    }
    previousNet = cents(parsed.net);
    return {
      club_id: clubId,
      club_name: textValue(row.club_name, `Union insurance club ${index + 1} name`),
      ...parsed,
    };
  });

  const generatedAt = timestampValue(payload.generated_at, 'Union insurance generation time');
  const generatedDate = new Date(generatedAt).toISOString().slice(0, 10);
  if (daily[daily.length - 1]?.d !== generatedDate) {
    throw new Error('Union insurance daily series does not reach its generation date');
  }

  assertTotalsEqual(aggregate(daily), totals, 'Union insurance daily totals');
  assertTotalsEqual(aggregate(byClub), totals, 'Union insurance club totals');
  const dailyOverlayCents = sumCents(
    daily.map((row) => row.overlay),
    'Insurance overlay aggregate'
  );
  if (dailyOverlayCents !== cents(overlay.funded)) {
    throw new Error('Union insurance overlay total does not reconcile');
  }

  return {
    union_id: unionId,
    range_days: rangeDays,
    totals,
    overlay,
    daily,
    by_club: byClub,
    generated_at: generatedAt,
  };
}
