/** One scoped diagnostic read after a failed assertion; never a certificate verdict. */
type HealthRead = (
  url: string,
  options: { timeout: number; headers: Record<string, string> }
) => Promise<{ status(): number; body(): Promise<Buffer> }>;

export async function captureEngineFailureHealth(
  read: HealthRead,
  healthUrl: string,
  tableId: string
): Promise<Record<string, unknown>> {
  const requestedAt = new Date().toISOString();
  try {
    const url = new URL(healthUrl);
    url.searchParams.set('cb', String(Date.now()));
    url.searchParams.set('liveness_table_ids', tableId);
    const response = await read(url.toString(), {
      timeout: 3_000,
      headers: { 'cache-control': 'no-store' },
    });
    const httpStatus = response.status();
    if (httpStatus !== 200 && httpStatus !== 503) throw new Error('unavailable');
    const body = await response.body();
    if (body.length > 256 * 1024) throw new Error('oversized');
    const health = JSON.parse(body.toString('utf8'));
    if (!health || typeof health !== 'object' || Array.isArray(health)) throw new Error('invalid');
    const selected = Array.isArray(health.tableLiveness)
      ? health.tableLiveness.find((table: { tableId?: string }) => table?.tableId === tableId)
      : null;
    const fields = [
      'tableId',
      'gameFormat',
      'seated',
      'dealable',
      'handCount',
      'msSinceProgress',
      'loopPhase',
      'paused',
      'settlementAgeMs',
    ];
    const table = selected
      ? Object.fromEntries(
          fields.map((key) => {
            const value = selected[key];
            return [
              key,
              typeof value === 'boolean' ||
              (typeof value === 'number' && Number.isFinite(value)) ||
              (typeof value === 'string' && value.length <= 256)
                ? value
                : null,
            ];
          })
        )
      : null;
    return {
      kind: 'observed',
      requestedAt,
      observedAt: new Date().toISOString(),
      httpStatus,
      tableId,
      version:
        typeof health.version === 'string' && /^[0-9a-f]{8,40}$/.test(health.version)
          ? health.version
          : null,
      tableAvailability: table ? 'observed' : 'unavailable',
      table,
    };
  } catch {
    // Diagnostic failure cannot replace the original continuity assertion or expose response data.
    return { kind: 'unavailable', requestedAt, tableId, reason: 'engine_health_read_unavailable' };
  }
}
