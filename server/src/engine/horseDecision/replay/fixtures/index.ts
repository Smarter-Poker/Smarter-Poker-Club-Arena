/** Test support: verbatim journal records exported read-only from the engine
 * host archive (see the header line of the sample). Every decision key binds
 * its snapshot byte for byte, so a test that changes an input must re-sign the
 * record with `resignHorseJournalRecord`; a record changed any other way is an
 * invalid record and is refused as such. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeHorseJournalRecord,
  type HorseJournalRecord,
} from '../../../../services/horseDecisionJournal/record.js';

const here = dirname(fileURLToPath(import.meta.url));

export const PHASE6C_FIXTURE_PATH = join(here, 'phase6c-journal-sample.ndjson');

/** Decision ids (eventId prefixes) in the sample and what each one is. */
export const PHASE6C_FIXTURE_IDS = {
  tournamentAtlasEvaluated: '2ce18894ba43',
  tournamentLabeledFallback: 'e509c261e058',
  tournamentChartOpenJam: '1b6781492ee9',
  tournamentFlop: '51a18a267f11',
  cashNlhPreflop: '8bbf5e39e65a',
  cashNlhRiver: 'dd06c8b88a03',
  cashPlo4Preflop: 'e0e8c23af842',
  deepSecondLook: '6f05da0644a6',
} as const;

export function loadPhase6cFixtureRecords(): HorseJournalRecord[] {
  return readFileSync(PHASE6C_FIXTURE_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { record?: HorseJournalRecord })
    .filter((row) => row.record)
    .map((row) => row.record!);
}

export function phase6cFixtureRecord(idPrefix: string): HorseJournalRecord {
  const record = loadPhase6cFixtureRecords().find((r) => r.eventId.startsWith(idPrefix));
  if (!record) throw new Error(`fixture record ${idPrefix} is missing`);
  return record;
}

export function phase6cFixtureBody<T = Record<string, unknown>>(record: HorseJournalRecord): T {
  return JSON.parse(record.body) as T;
}

/** Re-sign a fixture record around a changed body; the identity fields stay. */
export function resignHorseJournalRecord(
  record: HorseJournalRecord,
  mutate: (body: Record<string, unknown>) => void
): HorseJournalRecord {
  const body = phase6cFixtureBody(record);
  mutate(body);
  return makeHorseJournalRecord(
    {
      producerId: record.producerId,
      sequence: record.sequence,
      atMs: record.atMs,
      sourceRelease: record.sourceRelease,
      kind: record.kind,
      handKey: record.handKey,
      turnKey: record.turnKey,
    },
    body
  );
}
