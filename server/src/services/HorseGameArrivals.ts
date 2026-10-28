/** Game-scoped arrivals. Only this existing fleet cycle releases eligibility;
 * database receipts, never process timers, own cadence and restart recovery. */
import { createHash } from 'node:crypto';

export interface ArrivalTable {
  cluster_id?: string | null;
  settings?: unknown;
}
export interface ArrivalSnapshot {
  version: 1;
  configured: true;
  game_id: string;
  policy_id: string;
  released_ids: string[];
  ranked_horse_ids: string[];
  ranked_unreleased_ids: string[];
  new_identity_capacity: number;
}
type RpcResult = { data: unknown; error: unknown };
export type ArrivalRpc = (name: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
export function arrivalMarker(table: ArrivalTable): Record<string, unknown> | null {
  const settings = record(table.settings);
  if (!settings || !Object.hasOwn(settings, 'horse_arrivals')) return null;
  // A malformed marker is still scoped and must refuse horses.
  return record(settings.horse_arrivals) ?? {};
}
function ids(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((x) => typeof x === 'string') &&
    new Set(value).size === value.length
  );
}
export function parseArrivalSnapshot(
  value: unknown,
  game: string,
  policy: unknown
): ArrivalSnapshot | null {
  const r = record(value);
  if (
    !r ||
    r.version !== 1 ||
    r.configured !== true ||
    r.game_id !== game ||
    typeof policy !== 'string' ||
    r.policy_id !== policy ||
    !ids(r.ranked_horse_ids) ||
    r.ranked_horse_ids.length !== 20 ||
    !ids(r.released_ids) ||
    !ids(r.ranked_unreleased_ids) ||
    !Number.isInteger(r.new_identity_capacity) ||
    Number(r.new_identity_capacity) < 0 ||
    Number(r.new_identity_capacity) > 4
  )
    return null;
  const ranked = new Set(r.ranked_horse_ids);
  const released = new Set(r.released_ids);
  if (
    r.released_ids.some((x) => !ranked.has(x)) ||
    r.ranked_unreleased_ids.some((x) => !ranked.has(x) || released.has(x)) ||
    r.released_ids.length + r.ranked_unreleased_ids.length !== 20 ||
    (r.released_ids.length < 4 && Number(r.new_identity_capacity) > 4 - r.released_ids.length) ||
    (r.released_ids.length >= 4 && Number(r.new_identity_capacity) > 1) ||
    Number(r.new_identity_capacity) > 20 - r.released_ids.length
  )
    return null;
  return r as unknown as ArrivalSnapshot;
}

/** One instance per cycle. Unknown acknowledgments close only the scoped game
 * until the next cycle reads durable receipts. Other games never change. */
export class HorseGameArrivals {
  private snapshots = new Map<string, ArrivalSnapshot | null>();
  private attempted = new Set<string>();
  constructor(
    private rpc: ArrivalRpc,
    private report: (error: unknown) => void
  ) {}
  async load(tables: readonly ArrivalTable[]): Promise<void> {
    const policies = new Map<string, unknown>();
    for (const t of tables) {
      const m = arrivalMarker(t);
      if (!m || !t.cluster_id) continue;
      const previous = policies.get(t.cluster_id);
      const policy = m.version === 1 ? m.policy_id : null;
      policies.set(t.cluster_id, policies.has(t.cluster_id) && previous !== policy ? null : policy);
      this.snapshots.set(t.cluster_id, null);
    }
    const games = [...policies.keys()];
    if (!games.length) return;
    try {
      // Keep the reader's hard batch ceiling; partial reads never widen scope.
      for (let offset = 0; offset < games.length; offset += 100) {
        const requested = games.slice(offset, offset + 100);
        const result = await this.rpc('fn_cash_game_horse_arrival_snapshots', {
          p_game_ids: requested,
        });
        const envelope = record(result.data);
        if (
          result.error ||
          envelope?.version !== 1 ||
          envelope.complete !== true ||
          !Array.isArray(envelope.games)
        )
          throw new Error('Horse arrival snapshot unavailable or incomplete');
        for (const game of requested) {
          const matching = envelope.games.filter((x) => record(x)?.game_id === game);
          this.snapshots.set(
            game,
            matching.length === 1
              ? parseArrivalSnapshot(matching[0], game, policies.get(game))
              : null
          );
        }
      }
    } catch (error) {
      this.report(error);
    }
  }
  scoped(table: ArrivalTable): boolean {
    return (
      arrivalMarker(table) !== null || (!!table.cluster_id && this.snapshots.has(table.cluster_id))
    );
  }
  candidateAllowed(table: ArrivalTable, horse: string): boolean {
    if (!this.scoped(table)) return true;
    const s = table.cluster_id ? this.snapshots.get(table.cluster_id) : null;
    return !!s && s.ranked_horse_ids.includes(horse);
  }
  releasedAllowed(table: ArrivalTable, horse: string): boolean {
    if (!this.scoped(table)) return true;
    const s = table.cluster_id ? this.snapshots.get(table.cluster_id) : null;
    return !!s && s.released_ids.includes(horse);
  }
  rank(table: ArrivalTable, horse: string): number {
    const s = table.cluster_id ? this.snapshots.get(table.cluster_id) : null;
    return s?.ranked_horse_ids.indexOf(horse) ?? Number.MAX_SAFE_INTEGER;
  }
  async releaseEligible(
    table: ArrivalTable,
    normalEligible: readonly { id: string }[]
  ): Promise<void> {
    const game = table.cluster_id;
    if (!game || !this.scoped(table) || this.attempted.has(game)) return;
    const s = this.snapshots.get(game);
    if (!s || s.new_identity_capacity === 0) return;
    const eligible = new Set(normalEligible.map((h) => h.id));
    const selected = s.ranked_unreleased_ids
      .filter((h) => eligible.has(h))
      .slice(0, s.new_identity_capacity);
    if (!selected.length) return;
    this.attempted.add(game);
    // Content-address this observed epoch, including exact selected IDs.
    // Replaying an unknown request after restart cannot consume another slot.
    const digest = createHash('sha256')
      .update(JSON.stringify([game, s.policy_id, s.released_ids, selected]))
      .digest('hex');
    const request =
      digest.slice(0, 8) +
      '-' +
      digest.slice(8, 12) +
      '-4' +
      digest.slice(13, 16) +
      '-8' +
      digest.slice(17, 20) +
      '-' +
      digest.slice(20, 32);
    try {
      const response = await this.rpc('fn_cash_game_horse_arrival_release', {
        p_game_id: game,
        p_horse_ids: selected,
        p_request_id: request,
      });
      const envelope = record(response.data);
      const updated = parseArrivalSnapshot(envelope?.game, game, s.policy_id);
      if (response.error || envelope?.version !== 1 || !updated)
        throw new Error('Horse arrival release not acknowledged');
      this.snapshots.set(game, updated);
    } catch (error) {
      this.snapshots.set(game, null);
      this.report(error);
    }
  }
}
