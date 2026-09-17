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

export interface StoredRakeAttribution {
  credit: number;
  clubId: string;
  rakeRecordId: string;
}

export interface RakeAttributionLedger {
  credits: Map<string, Map<string, number>>;
  provenance: Map<string, Map<string, StoredRakeAttribution>>;
}

export async function readRakeAttributionLedger(
  handIds: string[],
  read: PageReader
): Promise<RakeAttributionLedger> {
  const ledger: RakeAttributionLedger = { credits: new Map(), provenance: new Map() };
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
          typeof r.club_id !== 'string' ||
          !uuid.test(r.club_id) ||
          typeof r.rake_record_id !== 'string' ||
          !uuid.test(r.rake_record_id) ||
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
        const players = ledger.credits.get(r.hand_id) ?? new Map<string, number>();
        if (players.has(r.player_id)) throw new Error('Duplicate player rake attribution');
        players.set(r.player_id, cents / 100);
        ledger.credits.set(r.hand_id, players);
        const provenance =
          ledger.provenance.get(r.hand_id) ?? new Map<string, StoredRakeAttribution>();
        provenance.set(r.player_id, {
          credit: cents / 100,
          clubId: r.club_id,
          rakeRecordId: r.rake_record_id,
        });
        ledger.provenance.set(r.hand_id, provenance);
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
    id?: string;
    hand_id?: string | null;
    is_tournament?: boolean | null;
    tournament_id?: string | null;
    rake_amount: number;
    player_contributions: Record<string, number> | null;
  }>,
  ledger: RakeAttributionLedger
) {
  for (const row of rows) {
    if (row.is_tournament === true || row.tournament_id) continue;
    if (
      !row.player_contributions ||
      !Object.values(row.player_contributions).some((n) => Number(n) > 0)
    )
      continue;
    const rake = Number(row.rake_amount);
    if (
      !Number.isFinite(rake) ||
      rake < 0 ||
      !Number.isSafeInteger(Math.round(rake * 100)) ||
      Math.abs(rake * 100 - Math.round(rake * 100)) > 0.000001
    )
      throw new Error('Invalid recorded cash rake');
    if (rake === 0) continue;
    if (!row.hand_id || !row.id || !uuid.test(row.id))
      throw new Error('Cash rake attribution has no durable hand and source record');
    const stored = ledger.credits.get(row.hand_id);
    const provenance = ledger.provenance.get(row.hand_id);
    const storedCents = [...(stored?.values() ?? [])].reduce(
      (total, n) => total + Math.round(n * 100),
      0
    );
    if (
      !stored?.size ||
      provenance?.size !== stored.size ||
      [...(provenance?.values() ?? [])].some((a) => a.rakeRecordId !== row.id) ||
      !Number.isSafeInteger(storedCents) ||
      storedCents !== Math.round(rake * 100)
    ) {
      throw new Error(`Cash rake attribution incomplete for hand ${row.hand_id}`);
    }
  }
}

/** A cash player's club is the club recorded with the earning, never the table's
 * house club or their current membership. Call after full-page validation. */
export function rakeCreditClub(
  row: {
    hand_id?: string | null;
    club_id: string;
    is_tournament?: boolean | null;
    tournament_id?: string | null;
  },
  playerId: string,
  ledger: RakeAttributionLedger
): string {
  if (row.is_tournament === true || row.tournament_id) return row.club_id;
  const attribution = row.hand_id ? ledger.provenance.get(row.hand_id)?.get(playerId) : undefined;
  if (!attribution) throw new Error('Cash rake earning club is missing');
  return attribution.clubId;
}
