/** Keep the actual totals verdict without retaining financial rows or identities. */
export function cashierTotalsObservation(
  status: number | null,
  body: unknown,
  expectedScope: unknown
) {
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const data = object(body) ? body : {};
  const totals = object(data.totals) ? data.totals : {};
  const decimal = (value: unknown) =>
    (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string'
      ? /^\d{1,30}(?:\.\d{1,12})?$/.test(String(value))
      : false;
  const rawCount = totals.count;
  const count =
    typeof rawCount === 'string' && /^\d+$/.test(rawCount) ? Number(rawCount) : rawCount;
  const scope =
    typeof data.scope === 'string' && ['all', 'downline', 'self'].includes(data.scope)
      ? data.scope
      : null;
  return {
    httpStatus: status,
    authorized: typeof data.authorized === 'boolean' ? data.authorized : null,
    scope,
    scopeMatchesPage: scope !== null && scope === expectedScope,
    validTotals:
      ['in', 'out', 'managed'].every((key) => decimal(totals[key])) &&
      typeof count === 'number' &&
      Number.isSafeInteger(count) &&
      count >= 0,
  };
}
