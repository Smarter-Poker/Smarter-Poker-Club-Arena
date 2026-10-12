export interface UnionStatementClub {
  club_id: string;
  club_name: string;
  club_code: string | null;
  club_slug: string | null;
  invoice_id: string | null;
  snapshot_complete: boolean;
  status: string;
  issued_at: string | null;
  due_at: string | null;
  amount: number;
  direction: string | null;
  message_sent: boolean;
  overdue: boolean;
  paid_total: number;
  outstanding: number;
  rake_generated: number;
  rakeback_due: number;
  union_fee_kept: number;
  players_won: number;
  eco_amount: number;
  presettled: number;
}

export interface UnionStatementPeriod {
  period_start: string | null;
  period_end: string;
  clubs: number;
  total_amount: number;
  rake_generated: number;
  eco_amount: number;
  paid: number;
  delivered: number;
}

export interface UnionStatementTotals {
  clubs: number;
  issued: number;
  missing: number;
  delivered: number;
  paid: number;
  clubs_owe: number;
  union_owes: number;
  net: number;
  collected: number;
  outstanding: number;
  rake_generated: number;
  eco_amount: number;
}

export interface UnionStatementBoard {
  union_id: string;
  union_name: string | null;
  period_end: string | null;
  period_start: string | null;
  totals: UnionStatementTotals;
  clubs: UnionStatementClub[];
  history: UnionStatementPeriod[];
  generated_at: string;
}

type JsonRecord = Record<string, unknown>;

const STATUSES = new Set([
  'missing',
  'generated',
  'pending',
  'overdue',
  'disputed',
  'paid',
  'cancelled',
]);
const DIRECTIONS = new Set(['club owes union', 'union owes club', 'square']);

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

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : textValue(value, label);
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} is invalid`);
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

function isoDate(value: unknown, label: string): string {
  const date = textValue(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error(`${label} is invalid`);
  }
  return date;
}

function nullableDate(value: unknown, label: string): string | null {
  return value === null ? null : isoDate(value, label);
}

function timestamp(value: unknown, label: string): string {
  const time = textValue(value, label);
  if (!Number.isFinite(Date.parse(time))) throw new Error(`${label} is invalid`);
  return time;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

const cents = (value: number): number => Math.round(value * 100);
const sumCents = (values: number[]): number => values.reduce((sum, value) => sum + cents(value), 0);

interface ParsedClub {
  club: UnionStatementClub;
  rawAmount: number;
}

function parseClub(value: unknown): ParsedClub {
  const row = objectValue(value, 'Statement club');
  const status = textValue(row.status, 'Statement status');
  if (!STATUSES.has(status)) throw new Error('Statement status is invalid');
  const direction = nullableText(row.direction, 'Statement direction');
  if (direction !== null && !DIRECTIONS.has(direction)) {
    throw new Error('Statement direction is invalid');
  }
  const rawAmount = moneyValue(row.amount, 'Statement amount');
  const parsed: UnionStatementClub = {
    club_id: textValue(row.club_id, 'Statement club identity'),
    club_name: textValue(row.club_name, 'Statement club name'),
    club_code: nullableText(row.club_code, 'Statement club code'),
    club_slug: nullableText(row.club_slug, 'Statement club slug'),
    invoice_id: nullableText(row.invoice_id, 'Statement invoice identity'),
    snapshot_complete: booleanValue(row.snapshot_complete, 'Statement accounting snapshot'),
    status,
    issued_at: nullableTimestamp(row.issued_at, 'Statement issue time'),
    due_at: nullableTimestamp(row.due_at, 'Statement due time'),
    amount: rawAmount,
    direction,
    message_sent: booleanValue(row.message_sent, 'Statement delivery state'),
    overdue: booleanValue(row.overdue, 'Statement overdue state'),
    paid_total: moneyValue(row.paid_total, 'Statement paid total', true),
    outstanding: moneyValue(row.outstanding, 'Statement outstanding total', true),
    rake_generated: moneyValue(row.rake_generated, 'Statement rake', true),
    rakeback_due: moneyValue(row.rakeback_due, 'Statement rakeback', true),
    union_fee_kept: moneyValue(row.union_fee_kept, 'Statement union fee', true),
    players_won: moneyValue(row.players_won, 'Statement player result'),
    eco_amount: moneyValue(row.eco_amount, 'Statement ECO amount'),
    presettled: moneyValue(row.presettled, 'Statement presettled amount'),
  };

  if (status === 'missing') {
    if (
      parsed.invoice_id !== null ||
      parsed.snapshot_complete ||
      parsed.issued_at !== null ||
      parsed.due_at !== null ||
      parsed.direction !== null ||
      parsed.message_sent ||
      parsed.overdue ||
      [
        parsed.amount,
        parsed.paid_total,
        parsed.outstanding,
        parsed.rake_generated,
        parsed.rakeback_due,
        parsed.union_fee_kept,
        parsed.players_won,
        parsed.eco_amount,
        parsed.presettled,
      ].some((amount) => cents(amount) !== 0)
    ) {
      throw new Error('Missing statement row carries invoice data');
    }
    return { club: parsed, rawAmount };
  }

  if (!parsed.invoice_id || !parsed.snapshot_complete || !parsed.issued_at || !parsed.direction) {
    throw new Error('Issued statement identity is incomplete');
  }
  if (parsed.direction === 'square') {
    if (cents(rawAmount) !== 0) throw new Error('Square statement carries a nonzero amount');
    parsed.amount = 0;
  } else {
    if (cents(rawAmount) === 0) throw new Error('Directed statement carries a zero amount');
    if (parsed.direction === 'club owes union' && rawAmount < 0) {
      throw new Error('Statement amount contradicts its club-owes direction');
    }
    parsed.amount =
      parsed.direction === 'club owes union' ? Math.abs(rawAmount) : -Math.abs(rawAmount);
  }
  if (parsed.paid_total > Math.abs(parsed.amount)) {
    throw new Error('Statement paid total exceeds its amount');
  }
  const expectedOutstanding = Math.max(
    Math.abs(cents(parsed.amount)) - cents(parsed.paid_total),
    0
  );
  if (cents(parsed.outstanding) !== expectedOutstanding) {
    throw new Error('Statement outstanding total does not reconcile');
  }
  if (cents(parsed.rake_generated) !== cents(parsed.rakeback_due) + cents(parsed.union_fee_kept)) {
    throw new Error('Statement rake split does not reconcile');
  }
  if (status === 'paid' && cents(parsed.outstanding) !== 0) {
    throw new Error('Paid statement still has an outstanding balance');
  }
  return { club: parsed, rawAmount };
}

function parseTotals(value: unknown): UnionStatementTotals {
  const totals = objectValue(value, 'Statement totals');
  return {
    clubs: countValue(totals.clubs, 'Statement club count'),
    issued: countValue(totals.issued, 'Statement issued count'),
    missing: countValue(totals.missing, 'Statement missing count'),
    delivered: countValue(totals.delivered, 'Statement delivered count'),
    paid: countValue(totals.paid, 'Statement paid count'),
    clubs_owe: moneyValue(totals.clubs_owe, 'Statement clubs owed', true),
    union_owes: moneyValue(totals.union_owes, 'Statement union owed', true),
    net: moneyValue(totals.net, 'Statement net'),
    collected: moneyValue(totals.collected, 'Statement collected', true),
    outstanding: moneyValue(totals.outstanding, 'Statement outstanding', true),
    rake_generated: moneyValue(totals.rake_generated, 'Statement rake generated', true),
    eco_amount: moneyValue(totals.eco_amount, 'Statement ECO total'),
  };
}

function parseHistory(value: unknown): UnionStatementPeriod[] {
  if (!Array.isArray(value)) throw new Error('Statement history is invalid');
  const seen = new Set<string>();
  let previousEnd: string | null = null;
  return value.map((entry): UnionStatementPeriod => {
    const row = objectValue(entry, 'Statement history row');
    const periodEnd = isoDate(row.period_end, 'Statement history period end');
    const periodStart = nullableDate(row.period_start, 'Statement history period start');
    if (seen.has(periodEnd) || (previousEnd !== null && periodEnd >= previousEnd)) {
      throw new Error('Statement history is duplicated or out of order');
    }
    if (periodStart && periodStart > periodEnd)
      throw new Error('Statement history range is invalid');
    seen.add(periodEnd);
    previousEnd = periodEnd;
    const clubs = countValue(row.clubs, 'Statement history club count');
    const paid = countValue(row.paid, 'Statement history paid count');
    const delivered = countValue(row.delivered, 'Statement history delivered count');
    if (paid > clubs || delivered > clubs) throw new Error('Statement history counts are invalid');
    return {
      period_start: periodStart,
      period_end: periodEnd,
      clubs,
      total_amount: moneyValue(row.total_amount, 'Statement history amount'),
      rake_generated: moneyValue(row.rake_generated, 'Statement history rake', true),
      eco_amount: moneyValue(row.eco_amount, 'Statement history ECO'),
      paid,
      delivered,
    };
  });
}

export function parseUnionStatementBoard(
  value: unknown,
  expectedUnionId: string,
  expectedPeriodEnd: string | null
): UnionStatementBoard {
  const board = objectValue(value, 'Statement board');
  const unionId = textValue(board.union_id, 'Statement union identity');
  if (unionId !== expectedUnionId) throw new Error('Statement board belongs to another union');
  const periodEnd = nullableDate(board.period_end, 'Statement period end');
  const periodStart = nullableDate(board.period_start, 'Statement period start');
  if (expectedPeriodEnd !== null && periodEnd !== expectedPeriodEnd) {
    throw new Error('Statement board belongs to another period');
  }
  if (periodStart && periodEnd && periodStart > periodEnd) {
    throw new Error('Statement board period is invalid');
  }
  if (!Array.isArray(board.clubs)) throw new Error('Statement clubs are invalid');
  const parsedClubs = board.clubs.map(parseClub);
  const clubs = parsedClubs.map(({ club }) => club);
  const clubIds = new Set<string>();
  const invoiceIds = new Set<string>();
  for (const club of clubs) {
    if (clubIds.has(club.club_id)) throw new Error('Statement club is duplicated');
    clubIds.add(club.club_id);
    if (club.invoice_id) {
      if (invoiceIds.has(club.invoice_id)) throw new Error('Statement invoice is duplicated');
      invoiceIds.add(club.invoice_id);
    }
  }
  const totals = parseTotals(board.totals);
  const issued = clubs.filter((club) => club.status !== 'missing');
  const expectedCounts = {
    clubs: clubs.length,
    issued: issued.length,
    missing: clubs.length - issued.length,
    delivered: clubs.filter((club) => club.message_sent).length,
    paid: clubs.filter((club) => club.status === 'paid').length,
  };
  for (const [key, expected] of Object.entries(expectedCounts)) {
    if (totals[key as keyof typeof expectedCounts] !== expected) {
      throw new Error(`Statement ${key} total does not reconcile`);
    }
  }
  if (totals.issued + totals.missing !== totals.clubs || totals.delivered > totals.issued) {
    throw new Error('Statement count totals do not reconcile');
  }
  const normalizedSignedTotals = {
    clubs_owe: sumCents(clubs.filter((row) => row.amount > 0).map((row) => row.amount)),
    union_owes: sumCents(clubs.filter((row) => row.amount < 0).map((row) => -row.amount)),
    net: sumCents(clubs.map((row) => row.amount)),
  };
  const legacySignedTotals = {
    clubs_owe: sumCents(
      parsedClubs.filter(({ rawAmount }) => rawAmount > 0).map(({ rawAmount }) => rawAmount)
    ),
    union_owes: sumCents(
      parsedClubs.filter(({ rawAmount }) => rawAmount < 0).map(({ rawAmount }) => -rawAmount)
    ),
    net: sumCents(parsedClubs.map(({ rawAmount }) => rawAmount)),
  };
  const suppliedSignedTotals = {
    clubs_owe: cents(totals.clubs_owe),
    union_owes: cents(totals.union_owes),
    net: cents(totals.net),
  };
  const matchesSignedTotals = (expected: typeof normalizedSignedTotals): boolean =>
    suppliedSignedTotals.clubs_owe === expected.clubs_owe &&
    suppliedSignedTotals.union_owes === expected.union_owes &&
    suppliedSignedTotals.net === expected.net;
  if (!matchesSignedTotals(normalizedSignedTotals) && !matchesSignedTotals(legacySignedTotals)) {
    throw new Error('Statement signed totals do not reconcile');
  }

  const moneyChecks: Array<[number, number, string]> = [
    [totals.collected, sumCents(clubs.map((row) => row.paid_total)), 'collected'],
    [
      totals.outstanding,
      sumCents(
        clubs
          .filter((row) => row.status !== 'missing' && row.status !== 'cancelled')
          .map((row) => row.outstanding)
      ),
      'outstanding',
    ],
    [totals.rake_generated, sumCents(clubs.map((row) => row.rake_generated)), 'rake'],
    [totals.eco_amount, sumCents(clubs.map((row) => row.eco_amount)), 'ECO'],
  ];
  for (const [actual, expectedCents, label] of moneyChecks) {
    if (cents(actual) !== expectedCents)
      throw new Error(`Statement ${label} total does not reconcile`);
  }

  return {
    union_id: unionId,
    union_name: nullableText(board.union_name, 'Statement union name'),
    period_end: periodEnd,
    period_start: periodStart,
    totals: {
      ...totals,
      clubs_owe: normalizedSignedTotals.clubs_owe / 100,
      union_owes: normalizedSignedTotals.union_owes / 100,
      net: normalizedSignedTotals.net / 100,
    },
    clubs,
    history: parseHistory(board.history),
    generated_at: timestamp(board.generated_at, 'Statement generation time'),
  };
}
