import type { LightningPoolSnapshot } from './LightningMatcherModel.js';

const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const obj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const count = (v: unknown): boolean => finite(v) && Number.isInteger(v) && v >= 0;
const only = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).every((k) => keys.includes(k));

/** A service-only SQL snapshot. Reject unknown fields rather than admitting
 * private cards or integrity data into the pure matcher model. */
export function parseLightningMatcherSnapshot(
  raw: unknown,
  generatedAt: string | null
): {
  binding: string;
  snapshot: LightningPoolSnapshot;
} | null {
  if (
    !obj(raw) ||
    !only(raw, ['binding', 'snapshot']) ||
    typeof raw.binding !== 'string' ||
    !/^[0-9a-f]{32}$/.test(raw.binding) ||
    !obj(raw.snapshot)
  )
    return null;
  const s = raw.snapshot;
  // Date.parse keeps only whole milliseconds; PostgreSQL queue snapshots
  // retain microseconds. Restore the ISO fraction before checking the clock.
  const fraction = generatedAt?.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1].slice(3) ?? '';
  const generatedMs =
    generatedAt === null ? NaN : Date.parse(generatedAt) + (fraction ? Number(`0.${fraction}`) : 0);
  if (
    !only(s, ['nowMs', 'epoch', 'players', 'recentHands', 'legalCount']) ||
    !finite(s.nowMs) ||
    !count(s.epoch) ||
    generatedAt === null ||
    s.nowMs !== generatedMs ||
    !Array.isArray(s.players) ||
    s.players.length > 500 ||
    !Array.isArray(s.recentHands) ||
    s.recentHands.length > 5000
  )
    return null;
  const seen = new Set<string>();
  for (const p of s.players) {
    if (
      !obj(p) ||
      !only(p, [
        'playerId',
        'legal',
        'reasonCode',
        'idleSinceMs',
        'enteredAtMs',
        'joinedAtMs',
        'slotOpenedAtMs',
        'lastBbAtMs',
        'bbUnresolved',
        'debtSinceMs',
        'handsSinceBb',
        'newcomer',
        'positions',
      ]) ||
      !uuid(p.playerId) ||
      seen.has(p.playerId) ||
      typeof p.legal !== 'boolean' ||
      (p.reasonCode !== null && typeof p.reasonCode !== 'string') ||
      typeof p.bbUnresolved !== 'boolean' ||
      typeof p.newcomer !== 'boolean' ||
      !obj(p.positions) ||
      !only(p.positions, ['btn', 'co', 'hj', 'utg'])
    )
      return null;
    seen.add(p.playerId);
    if (
      !['idleSinceMs', 'enteredAtMs', 'slotOpenedAtMs', 'debtSinceMs'].every((k) => finite(p[k])) ||
      !['joinedAtMs', 'lastBbAtMs'].every((k) => p[k] === null || finite(p[k])) ||
      (p.handsSinceBb !== null && !count(p.handsSinceBb)) ||
      !['btn', 'co', 'hj', 'utg'].every((k) => count((p.positions as Record<string, unknown>)[k]))
    )
      return null;
  }
  for (const h of s.recentHands) {
    if (
      !obj(h) ||
      !only(h, ['handId', 'epoch', 'formedAtMs', 'players']) ||
      !uuid(h.handId) ||
      !count(h.epoch) ||
      !finite(h.formedAtMs) ||
      !Array.isArray(h.players) ||
      h.players.length > 9 ||
      !h.players.every(uuid) ||
      new Set(h.players).size !== h.players.length
    )
      return null;
  }
  if (
    s.legalCount !== undefined &&
    (!count(s.legalCount) || s.legalCount !== s.players.filter((p) => p.legal).length)
  )
    return null;
  return { binding: raw.binding, snapshot: s as unknown as LightningPoolSnapshot };
}
