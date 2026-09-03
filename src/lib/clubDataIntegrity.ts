export type ClubDataIntegrityLevel = 'verified' | 'attention';

export interface ClubDataIntegrityResult {
  level: ClubDataIntegrityLevel;
  passed: number;
  checks: number;
  issues: string[];
  renderable: boolean;
}

type RecordLike = Record<string, unknown>;

function record(value: unknown): RecordLike | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordLike)
    : null;
}

function finite(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sameMoney(left: unknown, right: unknown): boolean {
  const a = finite(left);
  const b = finite(right);
  return a !== null && b !== null && Math.abs(a - b) <= 0.02;
}

/**
 * Client-side contract verification for the owner-facing financial snapshot.
 * This does not replace the database as authority; it catches malformed,
 * internally contradictory, or duplicated payloads before the UI quietly
 * presents them as trustworthy money.
 */
export function auditClubDataSnapshot(value: unknown): ClubDataIntegrityResult {
  const issues: string[] = [];
  let passed = 0;
  let checks = 0;
  const check = (condition: boolean, issue: string) => {
    checks += 1;
    if (condition) passed += 1;
    else issues.push(issue);
  };

  const snapshot = record(value);
  const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : null;
  const summary = record(snapshot?.summary);
  const range = record(snapshot?.range);
  const rowCount = finite(snapshot?.row_count);

  check(Boolean(snapshot), 'Snapshot envelope is missing.');
  check(Boolean(rows), 'Game rows are missing.');
  check(Boolean(summary), 'Summary totals are missing.');
  check(
    rowCount !== null && Number.isInteger(rowCount) && rowCount >= 0,
    'Filtered game count is invalid.'
  );

  const renderable = Boolean(snapshot && rows && summary && rowCount !== null && rowCount >= 0);
  if (!renderable) {
    return { level: 'attention', passed, checks, issues, renderable: false };
  }

  check(rowCount! >= rows!.length, 'Loaded rows exceed the reported game count.');
  check(
    finite(summary!.games) === rowCount,
    'Summary game count does not match the filtered ledger count.'
  );

  const identities = rows!.map((row) => {
    const item = record(row);
    return item ? `${String(item.kind || '')}:${String(item.id || '')}` : '';
  });
  check(
    identities.every(Boolean) && new Set(identities).size === identities.length,
    'The loaded ledger contains missing or duplicate game identities.'
  );

  check(
    rows!.every((row) => {
      const item = record(row);
      return (
        item !== null &&
        finite(item.fee) !== null &&
        finite(item.winnings) !== null &&
        (finite(item.hands) ?? -1) >= 0 &&
        (finite(item.players) ?? -1) >= 0
      );
    }),
    'One or more game rows contain invalid financial or count values.'
  );

  const cashFee = finite(summary!.cash_fee);
  const mttFee = finite(summary!.mtt_fee);
  check(
    cashFee === null || mttFee === null || sameMoney(summary!.fee, cashFee + mttFee),
    'Cash and tournament fees do not reconcile to total fees.'
  );
  check(
    sameMoney(
      summary!.total_winnings,
      (finite(summary!.cash_winnings) ?? Number.NaN) + (finite(summary!.mtt_winnings) ?? Number.NaN)
    ),
    'Cash and tournament results do not reconcile to total winnings.'
  );

  const rangeStart = Date.parse(`${String(range?.start || '')}T00:00:00Z`);
  const rangeEnd = Date.parse(`${String(range?.end || '')}T00:00:00Z`);
  const rangeDays = finite(range?.days);
  const expectedDays =
    Number.isFinite(rangeStart) && Number.isFinite(rangeEnd)
      ? Math.round((rangeEnd - rangeStart) / 86_400_000) + 1
      : Number.NaN;
  check(
    rangeDays !== null && rangeDays >= 1 && rangeDays <= 93 && rangeDays === expectedDays,
    'Reporting window metadata is inconsistent.'
  );

  const generatedAt = Date.parse(String(snapshot!.generated_at || ''));
  const dataUpdatedAt = snapshot!.data_updated_at
    ? Date.parse(String(snapshot!.data_updated_at))
    : generatedAt;
  check(
    Number.isFinite(generatedAt) &&
      Number.isFinite(dataUpdatedAt) &&
      dataUpdatedAt <= generatedAt + 5 * 60_000,
    'Ledger timestamps are invalid or out of order.'
  );

  return {
    level: issues.length ? 'attention' : 'verified',
    passed,
    checks,
    issues,
    renderable: true,
  };
}

export function formatClubDataAge(ageMs: number): string {
  const seconds = Math.max(0, Math.floor(ageMs / 1000));
  if (seconds < 5) return 'Now';
  if (seconds < 60) return `${seconds}s Ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m Ago`;
  return `${Math.floor(minutes / 60)}h Ago`;
}

/**
 * A background revalidation only fetches the first bounded page. Replacing an
 * already-expanded ledger with that page makes a 200/300-row investigation
 * jump back to 100 every minute. Preserve the coherent expanded cursor window;
 * summaries/counts still refresh, and a user-driven query change starts fresh.
 */
export function preserveExpandedClubDataRows<T>(
  current: readonly T[],
  refreshedFirstPage: readonly T[],
  preserve: boolean
): T[] {
  return preserve && current.length > refreshedFirstPage.length
    ? [...current]
    : [...refreshedFirstPage];
}
