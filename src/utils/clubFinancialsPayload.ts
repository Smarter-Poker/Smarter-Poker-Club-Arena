export interface FinancialTotals {
  raked_hands: number;
  gross_rake: number;
  bbj_drop: number;
  net_rake: number;
  pot_volume: number;
  tournament_fees: number;
  rakeback_paid: number;
  rakeback_rows: number;
  agent_commissions: number;
  union_fee: number;
  union_statements: number;
  union_squareup: number;
  net_revenue: number;
}

export interface FinancialDay {
  d: string;
  raked_hands: number;
  gross_rake: number;
  bbj_drop: number;
  pot_volume: number;
  tournament_fees: number;
  rakeback_paid: number;
  agent_commissions: number;
  union_fee: number;
}

export interface FinancialTable {
  table_id: string;
  name: string;
  status: string;
  stakes: string | null;
  variant: string | null;
  raked_hands: number;
  rake: number;
  players: number;
  table_net: number;
}

export interface RecentRake {
  id: string;
  hand_id: string | null;
  global_hand_id: number | null;
  table_name: string;
  kind: string;
  rake_amount: number;
  bbj_contribution: number;
  pot_size: number;
  num_players: number | null;
  created_at: string;
}

export interface FinancialsPayload {
  range: {
    start: string;
    end: string;
    days: number;
    first_day: string;
    series_from: string;
  };
  union_id: string | null;
  totals: FinancialTotals;
  daily: FinancialDay[];
  by_table: FinancialTable[];
  recent: RecentRake[];
  data_updated_at: string | null;
  club_table_daily_updated_at: string | null;
  generated_at: string;
}

export interface FinancialsRequestRange {
  clubId: string;
  start: string;
  end: string;
}

type JsonRecord = Record<string, unknown>;

const DAY_MS = 86_400_000;
const UUID_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLUB_FINANCIALS_CONTRACT = 'ca_club_financials.v2';

function invalid(label: string): never {
  throw new Error(`Club financials ${label} is invalid`);
}

function objectValue(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(label);
  return value as JsonRecord;
}

function textValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) invalid(label);
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : textValue(value, label);
}

function nullableUuid(value: unknown, label: string): string | null {
  if (value === null) return null;
  const uuid = textValue(value, label);
  if (!UUID_TOKEN.test(uuid)) invalid(label);
  return uuid.toLowerCase();
}

function countValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(label);
  return value;
}

function nullableCount(value: unknown, label: string): number | null {
  return value === null ? null : countValue(value, label);
}

function moneyValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(label);
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(value * 100 - cents) > 0.000001) invalid(label);
  return cents / 100;
}

function nonnegativeMoneyValue(value: unknown, label: string): number {
  const amount = moneyValue(value, label);
  if (amount < 0) invalid(label);
  return amount;
}

function dateMillis(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`);
}

function isoDate(value: unknown, label: string): string {
  const date = textValue(value, label);
  const millis = dateMillis(date);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(millis) ||
    new Date(millis).toISOString().slice(0, 10) !== date
  ) {
    invalid(label);
  }
  return date;
}

function timestamp(value: unknown, label: string): string {
  const time = textValue(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(time) || !Number.isFinite(Date.parse(time))) invalid(label);
  return time;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

function addDays(date: string, days: number): string {
  return new Date(dateMillis(date) + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(start: string, end: string): number {
  return Math.round((dateMillis(end) - dateMillis(start)) / DAY_MS);
}

const cents = (value: number): number => Math.round(value * 100);

function parseTotals(value: unknown): FinancialTotals {
  const totals = objectValue(value, 'totals');
  const parsed: FinancialTotals = {
    raked_hands: countValue(totals.raked_hands, 'total raked hands'),
    gross_rake: nonnegativeMoneyValue(totals.gross_rake, 'total gross rake'),
    bbj_drop: nonnegativeMoneyValue(totals.bbj_drop, 'total bad beat drop'),
    net_rake: nonnegativeMoneyValue(totals.net_rake, 'total net rake'),
    pot_volume: nonnegativeMoneyValue(totals.pot_volume, 'total pot volume'),
    tournament_fees: nonnegativeMoneyValue(totals.tournament_fees, 'total tournament fees'),
    rakeback_paid: nonnegativeMoneyValue(totals.rakeback_paid, 'total rakeback paid'),
    rakeback_rows: countValue(totals.rakeback_rows, 'total rakeback row count'),
    agent_commissions: nonnegativeMoneyValue(totals.agent_commissions, 'total agent commissions'),
    union_fee: nonnegativeMoneyValue(totals.union_fee, 'total union fee'),
    union_statements: countValue(totals.union_statements, 'total union statement count'),
    union_squareup: moneyValue(totals.union_squareup, 'total union squareup'),
    net_revenue: moneyValue(totals.net_revenue, 'total net revenue'),
  };

  if (cents(parsed.net_rake) !== cents(parsed.gross_rake) - cents(parsed.bbj_drop)) {
    invalid('total net rake reconciliation');
  }
  if (
    cents(parsed.net_revenue) !==
    cents(parsed.gross_rake) -
      cents(parsed.bbj_drop) +
      cents(parsed.tournament_fees) -
      cents(parsed.rakeback_paid) -
      cents(parsed.agent_commissions) -
      cents(parsed.union_fee)
  ) {
    invalid('total net revenue reconciliation');
  }
  return parsed;
}

function parseDay(value: unknown, expectedDate: string): FinancialDay {
  const row = objectValue(value, 'daily row');
  const d = isoDate(row.d, 'daily date');
  if (d !== expectedDate) invalid('daily date sequence');
  return {
    d,
    raked_hands: countValue(row.raked_hands, 'daily raked hands'),
    gross_rake: nonnegativeMoneyValue(row.gross_rake, 'daily gross rake'),
    bbj_drop: nonnegativeMoneyValue(row.bbj_drop, 'daily bad beat drop'),
    pot_volume: nonnegativeMoneyValue(row.pot_volume, 'daily pot volume'),
    tournament_fees: nonnegativeMoneyValue(row.tournament_fees, 'daily tournament fees'),
    rakeback_paid: nonnegativeMoneyValue(row.rakeback_paid, 'daily rakeback paid'),
    agent_commissions: nonnegativeMoneyValue(row.agent_commissions, 'daily agent commissions'),
    union_fee: nonnegativeMoneyValue(row.union_fee, 'daily union fee'),
  };
}

function parseTables(value: unknown): FinancialTable[] {
  if (!Array.isArray(value) || value.length > 10) invalid('table rows');
  const seen = new Set<string>();
  let previousRake: number | null = null;
  return value.map((entry): FinancialTable => {
    const row = objectValue(entry, 'table row');
    const tableId = textValue(row.table_id, 'table identity');
    if (seen.has(tableId)) invalid('duplicate table identity');
    seen.add(tableId);
    const rake = nonnegativeMoneyValue(row.rake, 'table rake');
    if (previousRake !== null && cents(rake) > previousRake) invalid('table rake order');
    previousRake = cents(rake);
    return {
      table_id: tableId,
      name: textValue(row.name, 'table name'),
      status: textValue(row.status, 'table status'),
      stakes: nullableText(row.stakes, 'table stakes'),
      variant: nullableText(row.variant, 'table variant'),
      raked_hands: countValue(row.raked_hands, 'table raked hands'),
      rake,
      players: countValue(row.players, 'table player count'),
      table_net: moneyValue(row.table_net, 'table net'),
    };
  });
}

function parseRecent(value: unknown, rangeStart: string, rangeEnd: string): RecentRake[] {
  if (!Array.isArray(value) || value.length > 20) invalid('recent rake rows');
  const seen = new Set<string>();
  let previousTime = Number.POSITIVE_INFINITY;
  return value.map((entry): RecentRake => {
    const row = objectValue(entry, 'recent rake row');
    const id = textValue(row.id, 'recent rake identity');
    if (seen.has(id)) invalid('duplicate recent rake identity');
    seen.add(id);
    const createdAt = timestamp(row.created_at, 'recent rake time');
    const createdMillis = Date.parse(createdAt);
    const createdDate = new Date(createdMillis).toISOString().slice(0, 10);
    if (createdMillis > previousTime || createdDate < rangeStart || createdDate > rangeEnd) {
      invalid('recent rake order or range');
    }
    previousTime = createdMillis;
    const rakeAmount = nonnegativeMoneyValue(row.rake_amount, 'recent rake amount');
    if (cents(rakeAmount) <= 0) invalid('recent rake amount');
    return {
      id,
      hand_id: nullableUuid(row.hand_id, 'recent hand identity'),
      global_hand_id: nullableCount(row.global_hand_id, 'recent global hand identity'),
      table_name: textValue(row.table_name, 'recent table name'),
      kind: textValue(row.kind, 'recent rake kind'),
      rake_amount: rakeAmount,
      bbj_contribution: nonnegativeMoneyValue(row.bbj_contribution, 'recent bad beat contribution'),
      pot_size: nonnegativeMoneyValue(row.pot_size, 'recent pot size'),
      num_players: nullableCount(row.num_players, 'recent player count'),
      created_at: createdAt,
    };
  });
}

function reconcileCompleteSeries(totals: FinancialTotals, daily: FinancialDay[]): void {
  const countSum = daily.reduce((sum, row) => sum + row.raked_hands, 0);
  if (!Number.isSafeInteger(countSum) || countSum !== totals.raked_hands) {
    invalid('daily raked hands reconciliation');
  }

  const moneyFields = [
    'gross_rake',
    'bbj_drop',
    'pot_volume',
    'tournament_fees',
    'rakeback_paid',
    'agent_commissions',
    'union_fee',
  ] as const;
  for (const field of moneyFields) {
    const sum = daily.reduce((total, row) => total + cents(row[field]), 0);
    // Cash rake can be split between clubs by an unrounded contribution
    // ratio in fn_ca_club_rake_daily_compute. The RPC rounds each day and the
    // full-window sum separately, so those independently rounded values can
    // legitimately differ by at most half a cent per displayed day. Every
    // other source column is already stored in whole cents.
    const allowedRoundingDrift = field === 'gross_rake' ? Math.floor(daily.length / 2) : 0;
    if (!Number.isSafeInteger(sum) || Math.abs(sum - cents(totals[field])) > allowedRoundingDrift) {
      invalid(`daily ${field.replace(/_/g, ' ')} reconciliation`);
    }
  }
}

/**
 * Validates the exact JSON contract returned by ca_club_financials. The RPC
 * returns every day only when the requested/clamped window is at most 92 days;
 * for a longer range its totals still cover the full range while daily is the
 * last 92 days, so aggregate reconciliation is intentionally conditional.
 */
export function parseClubFinancialsPayload(
  value: unknown,
  requestedRange: FinancialsRequestRange
): FinancialsPayload {
  const requestedClubId = textValue(requestedRange.clubId, 'requested club identity');
  if (!UUID_TOKEN.test(requestedClubId)) invalid('requested club identity');
  const requestedStart = isoDate(requestedRange.start, 'requested start date');
  const requestedEnd = isoDate(requestedRange.end, 'requested end date');
  if (requestedStart > requestedEnd) invalid('requested range');

  const payload = objectValue(value, 'payload');
  if (
    payload.contract !== CLUB_FINANCIALS_CONTRACT ||
    payload.contract_version !== 2 ||
    payload.club_id !== requestedClubId ||
    payload.requested_start !== requestedStart ||
    payload.requested_end !== requestedEnd
  ) {
    invalid('scope receipt');
  }
  const rangeValue = objectValue(payload.range, 'range');
  const rangeEnd = isoDate(rangeValue.end, 'range end');
  if (rangeEnd !== requestedEnd) invalid('range end binding');
  const firstDay = isoDate(rangeValue.first_day, 'first known day');

  let expectedStart = requestedStart;
  if (expectedStart < firstDay) expectedStart = firstDay;
  if (expectedStart > rangeEnd) expectedStart = rangeEnd;
  const rangeStart = isoDate(rangeValue.start, 'range start');
  if (rangeStart !== expectedStart) invalid('range start binding');

  const days = countValue(rangeValue.days, 'range day count');
  if (days !== daysBetween(rangeStart, rangeEnd) + 1) invalid('range day count');
  const seriesFrom = isoDate(rangeValue.series_from, 'series start');
  const expectedSeriesFrom =
    rangeStart > addDays(rangeEnd, -91) ? rangeStart : addDays(rangeEnd, -91);
  if (seriesFrom !== expectedSeriesFrom) invalid('series range');

  if (!Array.isArray(payload.daily)) invalid('daily rows');
  const expectedDailyCount = daysBetween(seriesFrom, rangeEnd) + 1;
  if (payload.daily.length !== expectedDailyCount) invalid('daily row count');
  const daily = payload.daily.map((entry, index) => parseDay(entry, addDays(seriesFrom, index)));
  const totals = parseTotals(payload.totals);
  if (seriesFrom === rangeStart) reconcileCompleteSeries(totals, daily);

  return {
    range: {
      start: rangeStart,
      end: rangeEnd,
      days,
      first_day: firstDay,
      series_from: seriesFrom,
    },
    union_id: nullableText(payload.union_id, 'union identity'),
    totals,
    daily,
    by_table: parseTables(payload.by_table),
    recent: parseRecent(payload.recent, rangeStart, rangeEnd),
    data_updated_at: nullableTimestamp(payload.data_updated_at, 'data update time'),
    club_table_daily_updated_at: nullableTimestamp(
      payload.club_table_daily_updated_at,
      'table data update time'
    ),
    generated_at: timestamp(payload.generated_at, 'generation time'),
  };
}
