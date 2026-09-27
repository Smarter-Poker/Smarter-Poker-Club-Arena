/**
 * Read-only journal sources for Phase 6C replay.
 *
 *   - an NDJSON copy: one journal record per line, or one `{ record }`
 *     wrapper per line as the bounded engine-host export writes them; a
 *     first line without a record is a header and is skipped;
 *   - a journal directory with `archive/horse-journal-archive.sqlite` and
 *     `archive/segments/<sha>.ndjson.gz`, opened read-only; the catalog is the
 *     index, the gzip segments hold the records.
 *
 * Neither source writes, and neither invents a record: a row whose segment
 * does not decode to the indexed event is reported as missing.
 */
import { createRequire } from 'node:module';
import type { DatabaseSync as Database } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { HorseJournalDecisionSource } from './HorseDecisionReplay.js';

const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite'
) as typeof import('node:sqlite');

export interface HorseJournalRecordRow {
  /** Catalog rowid when the source has one; the line ordinal otherwise. */
  ordinal: number;
  record: Record<string, unknown>;
}

export interface HorseJournalReplaySource extends HorseJournalDecisionSource {
  /** Newest-first decision records, bounded, optionally at or after `sinceMs`. */
  newestDecisions(limit: number, sinceMs?: number): HorseJournalRecordRow[];
  describe(): string;
  close(): void;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  typeof (v as { kind?: unknown }).kind === 'string';

export function openHorseJournalCopy(path: string): HorseJournalReplaySource {
  const rows: HorseJournalRecordRow[] = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    const parsed = JSON.parse(line) as unknown;
    const wrapped = parsed as { record?: unknown; catalogRowid?: unknown };
    const record = isRecord(parsed) ? parsed : isRecord(wrapped.record) ? wrapped.record : null;
    if (!record) continue;
    rows.push({
      ordinal: Number.isSafeInteger(wrapped.catalogRowid)
        ? (wrapped.catalogRowid as number)
        : index + 1,
      record,
    });
  }
  const byId = new Map(rows.map((row) => [String(row.record.eventId), row.record]));
  return {
    recordById: (id) => byId.get(id) ?? null,
    newestDecisions(limit, sinceMs = 0) {
      return rows
        .filter((row) => row.record.kind === 'decision' && Number(row.record.atMs) >= sinceMs)
        .sort((a, b) => b.ordinal - a.ordinal)
        .slice(0, limit);
    },
    describe: () => `ndjson copy ${path} (${rows.length} records)`,
    close: () => {},
  };
}

interface CatalogRow {
  rowid: number;
  event_id: string;
  segment_sha: string;
  ordinal: number;
}

export function openHorseJournalArchive(directory: string): HorseJournalReplaySource {
  const catalogPath = join(directory, 'archive', 'horse-journal-archive.sqlite');
  const db: Database = new DatabaseSync(catalogPath, { readOnly: true });
  db.exec('PRAGMA busy_timeout=250; PRAGMA query_only=ON;');
  const segments = new Map<string, Record<string, unknown>[]>();
  const segment = (sha: string): Record<string, unknown>[] => {
    let records = segments.get(sha);
    if (!records) {
      if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error('Horse archive segment name is invalid');
      const bytes = gunzipSync(
        readFileSync(join(directory, 'archive', 'segments', `${sha}.ndjson.gz`))
      );
      records = bytes
        .toString('utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      if (segments.size >= 512) segments.clear();
      segments.set(sha, records);
    }
    return records;
  };
  const resolve = (row: CatalogRow): Record<string, unknown> | null => {
    const record = segment(row.segment_sha)[row.ordinal];
    return record && record.eventId === row.event_id ? record : null;
  };
  return {
    recordById(id) {
      const row = db
        .prepare(
          'SELECT rowid, event_id, segment_sha, ordinal FROM archive_events WHERE event_id = ?'
        )
        .get(id) as CatalogRow | undefined;
      return row ? resolve(row) : null;
    },
    newestDecisions(limit, sinceMs = 0) {
      const out: HorseJournalRecordRow[] = [];
      // The catalog does not index kind; walk newest rows in bounded pages.
      const page = 512;
      let before = Number.MAX_SAFE_INTEGER;
      while (out.length < limit) {
        const rows = db
          .prepare(
            'SELECT rowid, event_id, segment_sha, ordinal FROM archive_events WHERE rowid < ? ORDER BY rowid DESC LIMIT ?'
          )
          .all(before, page) as unknown as CatalogRow[];
        if (!rows.length) break;
        for (const row of rows) {
          before = row.rowid;
          const record = resolve(row);
          if (!record || record.kind !== 'decision') continue;
          if (Number(record.atMs) < sinceMs) return out;
          out.push({ ordinal: row.rowid, record });
          if (out.length >= limit) break;
        }
      }
      return out;
    },
    describe: () => `archive ${catalogPath}`,
    close: () => db.close(),
  };
}

export function openHorseJournalSource(path: string): HorseJournalReplaySource {
  return path.endsWith('.ndjson') || path.endsWith('.jsonl')
    ? openHorseJournalCopy(path)
    : openHorseJournalArchive(path);
}
