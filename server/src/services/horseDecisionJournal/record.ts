import { createHash } from 'node:crypto';

export const HORSE_JOURNAL_RECORD_BYTES = 524288;
export type HorseJournalKind =
  | 'request_lifecycle'
  | 'decision'
  | 'execution'
  | 'accepted_hand'
  | 'discard_decision'
  | 'discard_execution';
export interface HorseJournalRecord {
  version: 1;
  producerId: string;
  sequence: number;
  eventId: string;
  atMs: number;
  sourceRelease: string | null;
  kind: HorseJournalKind;
  handKey: string;
  turnKey: string;
  body: string;
  sha256: string;
  bytes: number;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha = /^[0-9a-f]{64}$/;
export const journalHash = (v: string): string => createHash('sha256').update(v).digest('hex');
const recordDigest = (r: HorseJournalRecord): string =>
  journalHash(
    JSON.stringify([
      r.version,
      r.producerId,
      r.sequence,
      r.eventId,
      r.atMs,
      r.sourceRelease,
      r.kind,
      r.handKey,
      r.turnKey,
      r.bytes,
      r.body,
    ])
  );

/** Freeze the JSON bytes before asynchronous transport. Refuse values JSON
 * would silently change, rather than persisting a different replay input. */
export function horseJournalJson(value: unknown): string {
  let nodes = 0;
  const visit = (v: unknown, depth: number): unknown => {
    if (++nodes > 100000 || depth > 40) throw Error('Horse journal value exceeds bounds');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      if (Buffer.byteLength(v) > HORSE_JOURNAL_RECORD_BYTES)
        throw Error('Horse journal string exceeds bounds');
      return v;
    }
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (Array.isArray(v)) return v.map((x) => visit(x, depth + 1));
    if (typeof v === 'object' && v && [Object.prototype, null].includes(Object.getPrototypeOf(v))) {
      const result: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(v).sort()) {
        const item = (v as Record<string, unknown>)[key];
        if (item !== undefined) result[key] = visit(item, depth + 1);
      }
      return result;
    }
    throw Error('Horse journal value is not portable JSON');
  };
  const json = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(json) > HORSE_JOURNAL_RECORD_BYTES)
    throw Error('Horse journal record exceeds bounds');
  return json;
}

export function makeHorseJournalRecord(
  input: Omit<HorseJournalRecord, 'version' | 'eventId' | 'body' | 'sha256' | 'bytes'>,
  payload: unknown
): HorseJournalRecord {
  const body = horseJournalJson(payload);
  const record: HorseJournalRecord = {
    ...input,
    version: 1,
    body,
    bytes: Buffer.byteLength(body),
    sha256: journalHash(body),
    eventId: journalHash(
      JSON.stringify(['horse-journal-event-v1', input.producerId, input.sequence])
    ),
  };
  record.sha256 = recordDigest(record);
  validateHorseJournalRecord(record);
  return Object.freeze(record);
}

export function validateHorseJournalRecord(raw: unknown): asserts raw is HorseJournalRecord {
  const r = raw as HorseJournalRecord;
  if (
    !r ||
    typeof r !== 'object' ||
    Array.isArray(r) ||
    Object.keys(r).length !== 12 ||
    r.version !== 1 ||
    !uuid.test(r.producerId) ||
    !Number.isSafeInteger(r.sequence) ||
    r.sequence < 1 ||
    !Number.isSafeInteger(r.atMs) ||
    r.atMs < 0 ||
    (r.sourceRelease !== null &&
      (typeof r.sourceRelease !== 'string' || !/^[0-9a-f]{40}$/.test(r.sourceRelease))) ||
    ![
      'decision',
      'execution',
      'accepted_hand',
      'discard_decision',
      'discard_execution',
      'request_lifecycle',
    ].includes(r.kind) ||
    !sha.test(r.handKey) ||
    !sha.test(r.turnKey) ||
    typeof r.body !== 'string' ||
    !Number.isSafeInteger(r.bytes) ||
    r.bytes < 1 ||
    r.bytes > HORSE_JOURNAL_RECORD_BYTES ||
    Buffer.byteLength(r.body) !== r.bytes ||
    !sha.test(r.sha256) ||
    recordDigest(r) !== r.sha256 ||
    r.eventId !== journalHash(JSON.stringify(['horse-journal-event-v1', r.producerId, r.sequence]))
  )
    throw Error('Invalid Horse journal record');
  if (horseJournalJson(JSON.parse(r.body)) !== r.body) throw Error('Invalid Horse journal JSON');
}
