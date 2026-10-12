import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HORSE_JOURNAL_ARCHIVE_BYTES,
  HORSE_JOURNAL_ARCHIVE_CATALOG_BYTES,
  HORSE_JOURNAL_ARCHIVE_SEGMENTS,
  HORSE_JOURNAL_SHARD_DISK_RESERVE_BYTES,
  horseJournalArchiveDirectoryNames,
  horseJournalShardCapacity,
  horseJournalShardDiskBytes,
  horseJournalShardsAffordable,
  readonlyHorseJournalStoreOptions,
  runtimeHorseJournalArchiveOptions,
} from './config.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const directory = () => {
  const d = mkdtempSync(join(tmpdir(), 'horse-journal-config-test-'));
  dirs.push(d);
  return d;
};

describe('horseJournalArchiveDirectoryNames', () => {
  it('finds nothing under a fresh directory', () => {
    expect(horseJournalArchiveDirectoryNames(directory())).toEqual([]);
  });

  it('finds only the unsharded archive when that is all that exists', () => {
    const dir = directory();
    mkdirSync(join(dir, 'archive'));
    expect(horseJournalArchiveDirectoryNames(dir)).toEqual(['archive']);
  });

  it('lists shard 0 first, then later shards lowest index first', () => {
    const dir = directory();
    mkdirSync(join(dir, 'archive'));
    mkdirSync(join(dir, 'archive-shard-1'));
    mkdirSync(join(dir, 'archive-shard-2'));
    expect(horseJournalArchiveDirectoryNames(dir)).toEqual([
      'archive',
      'archive-shard-1',
      'archive-shard-2',
    ]);
  });

  it('stops at the first missing later shard rather than skipping a gap', () => {
    const dir = directory();
    mkdirSync(join(dir, 'archive'));
    mkdirSync(join(dir, 'archive-shard-1'));
    // archive-shard-2 intentionally absent
    mkdirSync(join(dir, 'archive-shard-3'));
    expect(horseJournalArchiveDirectoryNames(dir)).toEqual(['archive', 'archive-shard-1']);
  });

  it('lists a later shard even when shard 0 has never been written', () => {
    const dir = directory();
    mkdirSync(join(dir, 'archive-shard-1'));
    expect(horseJournalArchiveDirectoryNames(dir)).toEqual(['archive-shard-1']);
  });
});

describe('runtimeHorseJournalArchiveOptions shard resolution', () => {
  it('resolves shard 0 (the default) to the original unsharded archive directory', () => {
    const dir = directory();
    const options = runtimeHorseJournalArchiveOptions(dir);
    expect(options.directory).toBe(join(dir, 'archive'));
  });

  it('resolves an explicit shard 0 identically to the default', () => {
    const dir = directory();
    expect(runtimeHorseJournalArchiveOptions(dir, process.env, { index: 0 }).directory).toBe(
      join(dir, 'archive')
    );
  });

  it('resolves later shard indexes to their own dedicated directory', () => {
    const dir = directory();
    expect(runtimeHorseJournalArchiveOptions(dir, process.env, { index: 1 }).directory).toBe(
      join(dir, 'archive-shard-1')
    );
    expect(runtimeHorseJournalArchiveOptions(dir, process.env, { index: 2 }).directory).toBe(
      join(dir, 'archive-shard-2')
    );
  });

  it('gives every shard the same full byte/segment allocation, never a fraction of it', () => {
    const dir = directory();
    const shard0 = runtimeHorseJournalArchiveOptions(dir, process.env, { index: 0 });
    const shard1 = runtimeHorseJournalArchiveOptions(dir, process.env, { index: 1 });
    expect(shard0.maxBytes).toBe(HORSE_JOURNAL_ARCHIVE_BYTES);
    expect(shard1.maxBytes).toBe(HORSE_JOURNAL_ARCHIVE_BYTES);
    expect(shard0.maxSegments).toBe(HORSE_JOURNAL_ARCHIVE_SEGMENTS);
    expect(shard1.maxSegments).toBe(HORSE_JOURNAL_ARCHIVE_SEGMENTS);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses an invalid shard index %s',
    (index) => {
      const dir = directory();
      expect(() => runtimeHorseJournalArchiveOptions(dir, process.env, { index })).toThrow(
        'Invalid Horse journal shard'
      );
    }
  );
});

describe('readonlyHorseJournalStoreOptions shard directory validation', () => {
  it('defaults to the unsharded archive and reports it absent without creating anything', () => {
    const dir = directory();
    expect(readonlyHorseJournalStoreOptions(dir)).toEqual({ readOnly: true });
  });

  it('opens the unsharded archive directory by name identically to the default', () => {
    const dir = directory();
    expect(readonlyHorseJournalStoreOptions(dir, 'archive')).toEqual(
      readonlyHorseJournalStoreOptions(dir)
    );
  });

  it('resolves a later shard name to that shard alone', () => {
    const dir = directory();
    const options = readonlyHorseJournalStoreOptions(dir, 'archive-shard-1');
    expect(options).toEqual({ readOnly: true });
  });

  it.each(['archive-shard-0', 'archive-shard-', 'archive-shard-01', 'bogus'])(
    'refuses a shard directory name that does not round-trip to its own canonical name (%s)',
    (name) => {
      const dir = directory();
      expect(() => readonlyHorseJournalStoreOptions(dir, name)).toThrow(
        'Invalid Horse journal shard directory'
      );
    }
  );

  it('refuses a shard directory name whose index is not a real number at all', () => {
    const dir = directory();
    // archiveDirectoryName(NaN) refuses before the round-trip comparison can
    // even run, so this is a distinct failure from the round-trip mismatches
    // above (no directory it could be mistaken to be given no valid index).
    expect(() => readonlyHorseJournalStoreOptions(dir, 'archive-shard-abc')).toThrow(
      'Invalid Horse journal shard'
    );
  });
});

describe('the journal disk bounds the shards a default may add', () => {
  const GiB = 1024 ** 3;

  it('prices a shard at its segment allocation with block overhead plus the catalog ceiling', () => {
    expect(HORSE_JOURNAL_ARCHIVE_CATALOG_BYTES).toBe(6 * GiB);
    expect(horseJournalShardDiskBytes(HORSE_JOURNAL_ARCHIVE_BYTES)).toBe(16 * GiB);
    expect(horseJournalShardDiskBytes(4 * GiB)).toBe(11 * GiB);
  });

  it('admits the existing shards plus the new ones the free space holds after the reserve', () => {
    const shard = horseJournalShardDiskBytes(HORSE_JOURNAL_ARCHIVE_BYTES);
    const reserve = HORSE_JOURNAL_SHARD_DISK_RESERVE_BYTES;
    expect(reserve).toBe(4 * GiB);
    // The engine host on 2026-10-12: two shards written, 23,526,174,720 bytes free.
    const host = { existingShards: 2, shardBytes: shard, reserveBytes: reserve };
    expect(horseJournalShardsAffordable({ ...host, availableBytes: 23_526_174_720 })).toBe(3);
    expect(horseJournalShardsAffordable({ ...host, availableBytes: 20 * GiB })).toBe(3);
    expect(horseJournalShardsAffordable({ ...host, availableBytes: 20 * GiB - 1 })).toBe(2);
    expect(horseJournalShardsAffordable({ ...host, availableBytes: 36 * GiB })).toBe(4);
    // A full disk never takes away a shard that already exists.
    expect(horseJournalShardsAffordable({ ...host, availableBytes: 0 })).toBe(2);
    // A fresh host counts from nothing and never answers zero.
    expect(
      horseJournalShardsAffordable({ ...host, existingShards: 0, availableBytes: 1 * GiB })
    ).toBe(1);
    expect(
      horseJournalShardsAffordable({ ...host, existingShards: 0, availableBytes: 40 * GiB })
    ).toBe(2);
  });

  it('reads nothing when no journal is configured', () => {
    expect(horseJournalShardCapacity({})).toBeUndefined();
  });

  it('measures the journal directory, or its nearest existing parent before it exists', () => {
    const dir = directory();
    mkdirSync(join(dir, 'archive'));
    mkdirSync(join(dir, 'archive-shard-1'));
    const fs = statfsSync(dir);
    const expected = (existingShards: number) =>
      horseJournalShardsAffordable({
        existingShards,
        availableBytes: fs.bavail * fs.bsize,
        shardBytes: horseJournalShardDiskBytes(HORSE_JOURNAL_ARCHIVE_BYTES),
        reserveBytes: HORSE_JOURNAL_SHARD_DISK_RESERVE_BYTES,
      });
    expect(horseJournalShardCapacity({ HORSE_DECISION_JOURNAL_DIR: dir })).toBe(expected(2));
    expect(
      horseJournalShardCapacity({ HORSE_DECISION_JOURNAL_DIR: join(dir, 'not-yet', 'journal') })
    ).toBe(expected(0));
    // The allocation it prices is the configured one.
    expect(
      horseJournalShardCapacity({
        HORSE_DECISION_JOURNAL_DIR: dir,
        HORSE_DECISION_JOURNAL_ARCHIVE_MAX_BYTES: String(1024 ** 2),
      })
    ).toBeGreaterThanOrEqual(expected(2));
  });

  it('reads nothing from a configuration the journal itself would refuse', () => {
    expect(horseJournalShardCapacity({ HORSE_DECISION_JOURNAL_DIR: 'relative/journal' })).toBe(
      undefined
    );
    expect(
      horseJournalShardCapacity({
        HORSE_DECISION_JOURNAL_DIR: directory(),
        HORSE_DECISION_JOURNAL_ARCHIVE_MAX_BYTES: 'lots',
      })
    ).toBeUndefined();
  });
});
