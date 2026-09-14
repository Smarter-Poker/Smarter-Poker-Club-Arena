/** Read the complete stored allocation before any accrual or cursor advance. */
export const ATTRIBUTION_PAGE_SIZE = 1000;
const HAND_CHUNK_SIZE = 200;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PageReader = (
  handIds: string[],
  afterId: string | null
) => PromiseLike<{
  data: unknown;
  error: unknown;
}>;

export async function readRakeAttributionLedger(handIds: string[], read: PageReader) {
  const ledger = new Map<string, Map<string, number>>();
  const hands = [...new Set(handIds)];
  for (let offset = 0; offset < hands.length; offset += HAND_CHUNK_SIZE) {
    const chunk = hands.slice(offset, offset + HAND_CHUNK_SIZE);
    let afterId: string | null = null;
    for (;;) {
      const { data, error } = await read(chunk, afterId);
      if (error) throw new Error('Rake attribution read failed', { cause: error });
      if (!Array.isArray(data)) throw new Error('Rake attribution page missing');
      for (const value of data) {
        const r = value as Record<string, unknown> | null;
        if (
          !r ||
          typeof r.id !== 'string' ||
          !uuid.test(r.id) ||
          typeof r.hand_id !== 'string' ||
          !chunk.includes(r.hand_id) ||
          typeof r.player_id !== 'string' ||
          !uuid.test(r.player_id) ||
          r.weighted_rake_credit === null ||
          r.weighted_rake_credit === '' ||
          !['number', 'string'].includes(typeof r.weighted_rake_credit)
        ) {
          throw new Error('Invalid rake attribution row');
        }
        if (afterId !== null && r.id <= afterId)
          throw new Error('Rake attribution cursor did not advance');
        afterId = r.id;
        const credit = Number(r.weighted_rake_credit);
        const cents = Math.round(credit * 100);
        if (
          !Number.isFinite(credit) ||
          credit < 0 ||
          !Number.isSafeInteger(cents) ||
          Math.abs(credit * 100 - cents) > 0.000001
        )
          throw new Error('Invalid rake attribution amount');
        const players = ledger.get(r.hand_id) ?? new Map<string, number>();
        if (players.has(r.player_id)) throw new Error('Duplicate player rake attribution');
        players.set(r.player_id, cents / 100);
        ledger.set(r.hand_id, players);
      }
      // Always ask for the next page after a non-empty response. This remains
      // complete even when PostgREST's configured cap is below our page size.
      if (data.length === 0) break;
    }
  }
  return ledger;
}

export function assertCashAttributionComplete(
  rows: Array<{
    hand_id?: string | null;
    is_tournament?: boolean | null;
    tournament_id?: string | null;
    rake_amount: number;
    player_contributions: Record<string, number> | null;
  }>,
  ledger: Map<string, Map<string, number>>
) {
  for (const row of rows) {
    if (!row.hand_id || row.is_tournament === true || row.tournament_id) continue;
    if (
      !row.player_contributions ||
      !Object.values(row.player_contributions).some((n) => Number(n) > 0)
    )
      continue;
    const rake = Number(row.rake_amount);
    if (!Number.isFinite(rake) || rake < 0) throw new Error('Invalid recorded cash rake');
    if (rake === 0) continue;
    const stored = ledger.get(row.hand_id);
    const storedCents = [...(stored?.values() ?? [])].reduce(
      (total, n) => total + Math.round(n * 100),
      0
    );
    if (
      !stored?.size ||
      !Number.isSafeInteger(storedCents) ||
      storedCents !== Math.round(rake * 100)
    ) {
      throw new Error(`Cash rake attribution incomplete for hand ${row.hand_id}`);
    }
  }
}
