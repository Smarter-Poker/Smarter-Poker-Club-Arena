import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHorseJournalReview } from './horseJournalReview.js';
import { HorseDecisionJournalStore } from '../services/horseDecisionJournal/store.js';
import { journalHash, makeHorseJournalRecord } from '../services/horseDecisionJournal/record.js';
import { runtimeHorseJournalArchiveOptions } from '../services/horseDecisionJournal/config.js';
const folders: string[] = [];
afterEach(() => {
  for (const directory of folders.splice(0)) rmSync(directory, { recursive: true, force: true });
});
describe('private Horse journal review command', () => {
  it.each(
    (
      [
        [],
        ['relative', 'a'.repeat(64)],
        ['/private', 'not-a-hash'],
        ['/private', 'a'.repeat(64), 'extra'],
      ] as string[][]
    ).map((args) => ({ args }))
  )('rejects malformed arguments without inspecting storage', ({ args }) => {
    expect(runHorseJournalReview(args)).toEqual({
      code: 64,
      output:
        'Usage: horseJournalReview <absolute-private-journal-directory> <SHA256-hand-coordinate>\n',
    });
  });
  it('returns a failed read without exposing paths or database errors', () => {
    const result = runHorseJournalReview(['/no-such-private-horse-journal', 'a'.repeat(64)]);
    expect(result.code).toBe(3);
    expect(JSON.parse(result.output)).toMatchObject({
      status: 'unavailable',
      gaps: ['storage_unavailable'],
    });
    expect(result.output).not.toContain('/no-such');
  });
  it.each([
    ['--storage-status'],
    ['--storage-status', 'relative'],
    ['--storage-status', '/private', 'extra'],
  ])('refuses malformed storage-status arguments: %j', (...args) => {
    expect(runHorseJournalReview(args).code).toBe(64);
  });
  it.each([false, true])(
    'reports only resource metadata (archive=%s) without creating storage or exposing private record content',
    (archive) => {
      const directory = mkdtempSync(join(tmpdir(), 'horse-journal-status-'));
      folders.push(directory);
      const value = makeHorseJournalRecord(
        {
          producerId: '10000000-0000-4000-8000-000000000001',
          sequence: 1,
          atMs: 1000,
          sourceRelease: null,
          kind: 'decision',
          handKey: journalHash('private-status-hand'),
          turnKey: journalHash('private-status-turn'),
        },
        { privateCard: 'As', privateActor: 'not-for-storage-status' }
      );
      const writer = new HorseDecisionJournalStore(
        directory,
        archive ? { archive: runtimeHorseJournalArchiveOptions(directory, {}) } : {}
      );
      writer.append(value);
      writer.close();
      const path = join(directory, 'horse-decisions.sqlite');
      const before = readFileSync(path);
      const files = readdirSync(directory);
      const result = runHorseJournalReview(['--storage-status', directory]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.output)).toMatchObject({
        version: 1,
        scope: 'private_storage_resources',
        status: 'observed',
        completePopulation: false,
        storage: {
          legacy: { records: archive ? 0 : 1 },
          archive: archive ? { records: 1, pendingSegments: 0 } : null,
        },
      });
      for (const secret of [
        directory,
        value.producerId,
        value.handKey,
        'not-for-storage-status',
        'privateCard',
      ])
        expect(result.output).not.toContain(secret);
      expect(readFileSync(path)).toEqual(before);
      expect(readdirSync(directory)).toEqual(files);
    }
  );
  it('does not turn missing storage into an empty successful resource report', () => {
    const result = runHorseJournalReview(['--storage-status', '/no-such-private-horse-journal']);
    expect(result.code).toBe(3);
    expect(result.output).not.toContain('/no-such');
  });
});
