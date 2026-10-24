import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, statfsSync: vi.fn(actual.statfsSync) };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn(actual.execFile),
    execFileSync: vi.fn(actual.execFileSync),
  };
});
import { mkdirSync, mkdtempSync, rmSync, statfsSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HORSE_JOURNAL_ARCHIVE_BYTES,
  HORSE_JOURNAL_ADDITIONAL_ARCHIVE_BYTES,
  HORSE_JOURNAL_ARCHIVE_CATALOG_BYTES,
  HORSE_JOURNAL_ARCHIVE_SEGMENTS,
  HORSE_JOURNAL_SHARD_DISK_RESERVE_BYTES,
  horseJournalArchiveDirectoryNames,
  horseJournalArchiveAllocatedBytes,
  horseJournalArchiveAllocatedBytesAsync,
  horseJournalShardCapacityMeasured,
  horseJournalCapacityUnreadableReason,
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

  it('preserves the two historical shards full byte/segment allocations', () => {
    const dir = directory();
    const shard0 = runtimeHorseJournalArchiveOptions(dir, process.env, { index: 0 });
    const shard1 = runtimeHorseJournalArchiveOptions(dir, process.env, { index: 1 });
    expect(shard0.maxBytes).toBe(HORSE_JOURNAL_ARCHIVE_BYTES);
    expect(shard1.maxBytes).toBe(HORSE_JOURNAL_ARCHIVE_BYTES);
    expect(shard0.maxSegments).toBe(HORSE_JOURNAL_ARCHIVE_SEGMENTS);
    expect(shard1.maxSegments).toBe(HORSE_JOURNAL_ARCHIVE_SEGMENTS);
  });

  it('sizes additional shards without lowering historical allocations or overriding configuration', () => {
    const dir = directory();
    for (const index of [0, 1])
      expect(runtimeHorseJournalArchiveOptions(dir, {}, { index }).maxBytes).toBe(8 * 1024 ** 3);
    for (const index of [2, 3, 7])
      expect(runtimeHorseJournalArchiveOptions(dir, {}, { index }).maxBytes).toBe(4 * 1024 ** 3);
    for (const index of [0, 1, 2, 7]) {
      const options = runtimeHorseJournalArchiveOptions(
        dir,
        { HORSE_DECISION_JOURNAL_ARCHIVE_MAX_BYTES: String(7 * 1024 ** 3) },
        { index }
      );
      expect(options.maxBytes).toBe(7 * 1024 ** 3);
      expect(options.maxSegments).toBe(HORSE_JOURNAL_ARCHIVE_SEGMENTS);
    }
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

  it('charges existing growth before adding shards, including the exact host reading', () => {
    const shard = horseJournalShardDiskBytes(HORSE_JOURNAL_ARCHIVE_BYTES);
    const reserve = HORSE_JOURNAL_SHARD_DISK_RESERVE_BYTES;
    const host = {
      existingShardAllocatedBytes: [13_881_448 * 1024, 13_479_580 * 1024],
      shardBytes: shard,
      reserveBytes: reserve,
    };
    // 2026-10-12 read-only host observation. The former code answered three.
    expect(horseJournalShardsAffordable({ ...host, availableBytes: 23_377_231_872 })).toBe(2);
    const growth = host.existingShardAllocatedBytes.reduce((n, b) => n + shard - b, 0);
    expect(growth).toBe(6_342_045_696);
    expect(
      horseJournalShardsAffordable({ ...host, availableBytes: reserve + growth + shard })
    ).toBe(3);
    expect(
      horseJournalShardsAffordable({ ...host, availableBytes: reserve + growth + shard - 1 })
    ).toBe(2);
    // Existing empty directories are not paid-for allocations.
    expect(
      horseJournalShardsAffordable({
        ...host,
        existingShardAllocatedBytes: [0, 0],
        availableBytes: 20 * GiB,
      })
    ).toBe(2);
    // Fully allocated existing shards need no more room.
    expect(
      horseJournalShardsAffordable({
        ...host,
        existingShardAllocatedBytes: [shard, shard],
        availableBytes: 20 * GiB,
      })
    ).toBe(3);
    // Never credit excess allocation towards another shard.
    expect(
      horseJournalShardsAffordable({
        ...host,
        existingShardAllocatedBytes: [2 * shard, shard],
        availableBytes: reserve,
      })
    ).toBe(2);
    expect(horseJournalShardsAffordable({ ...host, availableBytes: 0 })).toBe(2);
    expect(
      horseJournalShardsAffordable({
        ...host,
        existingShardAllocatedBytes: [],
        availableBytes: GiB,
      })
    ).toBe(1);
    expect(
      horseJournalShardsAffordable({
        ...host,
        existingShardAllocatedBytes: [],
        availableBytes: 40 * GiB,
      })
    ).toBe(2);
  });

  it('the host can afford three configured shards, but not four, with legacy history intact', () => {
    const legacy = horseJournalShardDiskBytes(HORSE_JOURNAL_ARCHIVE_BYTES);
    const additional = horseJournalShardDiskBytes(HORSE_JOURNAL_ADDITIONAL_ARCHIVE_BYTES);
    expect(additional).toBe(11 * GiB);
    const host = {
      existingShardAllocatedBytes: [13_881_448 * 1024, 13_479_580 * 1024],
      shardBytes: legacy,
      additionalShardBytes: additional,
      reserveBytes: 4 * GiB,
    };
    expect(horseJournalShardsAffordable({ ...host, availableBytes: 23_377_231_872 })).toBe(3);
    const growth = host.existingShardAllocatedBytes.reduce((n, b) => n + legacy - b, 0);
    expect(
      horseJournalShardsAffordable({
        ...host,
        availableBytes: host.reserveBytes + growth + additional - 1,
      })
    ).toBe(2);
    expect(
      horseJournalShardsAffordable({
        ...host,
        availableBytes: host.reserveBytes + growth + additional,
      })
    ).toBe(3);
    expect(
      horseJournalShardsAffordable({
        ...host,
        availableBytes: host.reserveBytes + growth + 2 * additional - 1,
      })
    ).toBe(3);
    expect(
      horseJournalShardsAffordable({
        ...host,
        availableBytes: host.reserveBytes + growth + 2 * additional,
      })
    ).toBe(4);
    expect(
      horseJournalShardsAffordable({
        ...host,
        existingShardAllocatedBytes: [],
        availableBytes: 4 * GiB + 2 * legacy + additional - 1,
      })
    ).toBe(2);
    expect(
      horseJournalShardsAffordable({
        ...host,
        existingShardAllocatedBytes: [],
        availableBytes: 4 * GiB + 2 * legacy + additional,
      })
    ).toBe(3);
    expect(
      horseJournalShardsAffordable({
        ...host,
        existingShardAllocatedBytes: [...host.existingShardAllocatedBytes, 0],
        availableBytes: 23_377_231_872,
      })
    ).toBe(3);
  });

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY, 1.5])(
    'refuses unreadable allocation %s',
    (bytes) => {
      expect(() =>
        horseJournalShardsAffordable({
          existingShardAllocatedBytes: [bytes],
          availableBytes: 40 * GiB,
          shardBytes: 16 * GiB,
          reserveBytes: 4 * GiB,
        })
      ).toThrow('Unreadable');
    }
  );

  it('measures allocated blocks and refuses symlinked archive directories', () => {
    const dir = directory();
    const archive = join(dir, 'archive');
    mkdirSync(archive);
    writeFileSync(join(archive, 'segment'), Buffer.alloc(8192));
    const [bytes] = horseJournalArchiveAllocatedBytes([archive]);
    expect(bytes).toBeGreaterThan(0);
    expect(Number.isSafeInteger(bytes)).toBe(true);
    expect(horseJournalArchiveAllocatedBytes([])).toEqual([]);
    const link = join(dir, 'linked');
    symlinkSync(archive, link);
    expect(() => horseJournalArchiveAllocatedBytes([link])).toThrow('Invalid Horse journal');
  });

  it('accepts du totals when retention retires a segment during the scan (2026-10-15)', () => {
    const dir = directory();
    const archive = join(dir, 'archive');
    mkdirSync(archive);
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw Object.assign(Error('Command failed: du'), {
        status: 1,
        signal: null,
        stdout: '13881448\t' + archive + '\n',
        stderr:
          `du: cannot access '${archive}/segments/a.ndjson.gz': No such file or directory\n` +
          `du: cannot access '${archive}/segments/b.ndjson.gz': No such file or directory\n`,
      });
    });
    expect(horseJournalArchiveAllocatedBytes([archive])).toEqual([13881448 * 1024 - 1024]);
  });

  it.each([
    ['another error', 1, null, "du: cannot read directory 'X/segments': Permission denied\n"],
    [
      'a retired path outside the archives',
      1,
      null,
      "du: cannot access '/elsewhere/a': No such file or directory\n",
    ],
    ['a timeout', null, 'SIGTERM', ''],
    ['a different exit', 2, null, "du: cannot access 'X/segments/a': No such file or directory\n"],
  ])('still refuses du output after %s', (_label, status, signal, stderr) => {
    const dir = directory();
    const archive = join(dir, 'archive');
    mkdirSync(archive);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw Object.assign(Error('du failed'), {
        status,
        signal,
        stdout: '13881448\t' + archive + '\n',
        stderr: String(stderr).replaceAll('X', archive),
      });
    });
    expect(horseJournalShardCapacity({ HORSE_DECISION_JOURNAL_DIR: dir })).toBe(2);
    expect(warning).toHaveBeenCalledWith(
      '[HorseDecisionLane] journal disk capacity unreadable; retaining legacy two-worker ceiling',
      expect.stringContaining('du failed')
    );
    expect(horseJournalCapacityUnreadableReason()).toContain('du failed');
    warning.mockRestore();
  });

  it('measures the same allocation and capacity off the event loop (2026-10-15)', async () => {
    const dir = directory();
    const archive = join(dir, 'archive');
    mkdirSync(archive);
    writeFileSync(join(archive, 'segment'), Buffer.alloc(8192));
    expect(await horseJournalArchiveAllocatedBytesAsync([archive])).toEqual(
      horseJournalArchiveAllocatedBytes([archive])
    );
    expect(await horseJournalArchiveAllocatedBytesAsync([])).toEqual([]);
    const link = join(dir, 'linked');
    symlinkSync(archive, link);
    await expect(horseJournalArchiveAllocatedBytesAsync([link])).rejects.toThrow(
      'Invalid Horse journal'
    );
    const fs = { ...statfsSync(dir), bsize: 4096, bavail: (100 * GiB) / 4096 };
    vi.mocked(statfsSync).mockReturnValueOnce(fs).mockReturnValueOnce(fs);
    const env = { HORSE_DECISION_JOURNAL_DIR: dir };
    const measured = await horseJournalShardCapacityMeasured(env);
    expect(measured).toBe(horseJournalShardCapacity(env));
    expect(await horseJournalShardCapacityMeasured({})).toBeUndefined();
  });

  it('skips the boot walk only when a lower bound already admits the sufficient count (2026-10-24)', async () => {
    const dir = directory();
    for (const name of ['archive', 'archive-shard-1', 'archive-shard-2']) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, 'segment'), Buffer.alloc(8192));
    }
    const env = { HORSE_DECISION_JOURNAL_DIR: dir };
    const ample = { ...statfsSync(dir), bsize: 4096, bavail: (400 * GiB) / 4096 };
    vi.mocked(execFile).mockClear();
    vi.mocked(statfsSync).mockReturnValueOnce(ample);
    const skipped = await horseJournalShardCapacityMeasured(env, { sufficientShards: 8 });
    expect(vi.mocked(execFile)).not.toHaveBeenCalled();
    expect(horseJournalCapacityUnreadableReason()).toBeNull();
    // The published answer is the lower bound: every archive priced as empty.
    vi.mocked(statfsSync).mockReturnValueOnce(ample);
    expect(skipped).toBe(horseJournalShardCapacity(env, (dirs) => dirs.map(() => 0)));
    expect(skipped).toBeGreaterThanOrEqual(8);
    // ...which never exceeds the measured answer on the same filesystem.
    vi.mocked(statfsSync).mockReturnValueOnce(ample);
    expect(skipped).toBeLessThanOrEqual(horseJournalShardCapacity(env)!);

    // A disk whose lower bound cannot admit the count is walked exactly as before.
    const tight = { ...statfsSync(dir), bsize: 4096, bavail: (60 * GiB) / 4096 };
    vi.mocked(execFile).mockClear();
    vi.mocked(statfsSync).mockReturnValueOnce(tight).mockReturnValueOnce(tight);
    const walked = await horseJournalShardCapacityMeasured(env, { sufficientShards: 8 });
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
    vi.mocked(statfsSync).mockReturnValueOnce(tight);
    expect(walked).toBe(horseJournalShardCapacity(env));
    expect(walked).toBeLessThan(8);

    // Without the option the walk always runs (unchanged default behaviour).
    vi.mocked(execFile).mockClear();
    vi.mocked(statfsSync).mockReturnValueOnce(ample);
    await horseJournalShardCapacityMeasured(env);
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
  });

  it('prices empty archives as the most growth they can claim, so the bound never exceeds the measurement', () => {
    const shard = horseJournalShardDiskBytes(HORSE_JOURNAL_ARCHIVE_BYTES);
    const additional = horseJournalShardDiskBytes(HORSE_JOURNAL_ADDITIONAL_ARCHIVE_BYTES);
    const base = {
      shardBytes: shard,
      additionalShardBytes: additional,
      reserveBytes: HORSE_JOURNAL_SHARD_DISK_RESERVE_BYTES,
    };
    for (const availableBytes of [20 * GiB, 120 * GiB, 240 * GiB, 900 * GiB]) {
      for (const allocated of [
        [shard, shard, additional],
        [13 * GiB, 9 * GiB, 4 * GiB, 4 * GiB, 4 * GiB, 4 * GiB, 4 * GiB, 4 * GiB],
        [0, 2 * shard],
      ]) {
        const bound = horseJournalShardsAffordable({
          ...base,
          availableBytes,
          existingShardAllocatedBytes: allocated.map(() => 0),
        });
        const measured = horseJournalShardsAffordable({
          ...base,
          availableBytes,
          existingShardAllocatedBytes: allocated,
        });
        expect(bound).toBeLessThanOrEqual(measured);
      }
    }
  });

  it('reads nothing when no journal is configured', () => {
    expect(
      horseJournalShardCapacity({}, () => {
        throw Error('must not read');
      })
    ).toBeUndefined();
  });

  it('measures existing allocation and nearest parent before a journal exists', () => {
    const dir = directory();
    mkdirSync(join(dir, 'archive'));
    mkdirSync(join(dir, 'archive-shard-1'));
    // Fixed 100 GiB: 16 GiB and 11 GiB shard budgets give distinct answers.
    // A real low-free-space filesystem can round different budget models alike.
    const fs = { ...statfsSync(dir), bsize: 4096, bavail: (100 * GiB) / 4096 };
    vi.mocked(statfsSync).mockReturnValueOnce(fs).mockReturnValueOnce(fs).mockReturnValueOnce(fs);
    const allocated = horseJournalArchiveAllocatedBytes([
      join(dir, 'archive'),
      join(dir, 'archive-shard-1'),
    ]);
    const expected = (bytes: number[]) =>
      horseJournalShardsAffordable({
        existingShardAllocatedBytes: bytes,
        availableBytes: fs.bavail * fs.bsize,
        shardBytes: horseJournalShardDiskBytes(HORSE_JOURNAL_ARCHIVE_BYTES),
        additionalShardBytes: horseJournalShardDiskBytes(HORSE_JOURNAL_ADDITIONAL_ARCHIVE_BYTES),
        reserveBytes: HORSE_JOURNAL_SHARD_DISK_RESERVE_BYTES,
      });
    expect(horseJournalShardCapacity({ HORSE_DECISION_JOURNAL_DIR: dir })).toBe(
      expected(allocated)
    );
    expect(horseJournalCapacityUnreadableReason()).toBeNull();
    expect(
      horseJournalShardCapacity({ HORSE_DECISION_JOURNAL_DIR: join(dir, 'not-yet', 'journal') })
    ).toBe(expected([]));
    expect(
      horseJournalShardCapacity({
        HORSE_DECISION_JOURNAL_DIR: dir,
        HORSE_DECISION_JOURNAL_ARCHIVE_MAX_BYTES: String(1024 ** 2),
      })
    ).toBeGreaterThanOrEqual(expected(allocated));
  });

  it('never raises the legacy default when configured accounting fails', () => {
    const configured = { HORSE_DECISION_JOURNAL_DIR: directory() };
    expect(
      horseJournalShardCapacity(configured, () => {
        throw Error('du timeout');
      })
    ).toBe(2);
    expect(horseJournalShardCapacity(configured, () => [0])).toBe(2); // incomplete/unexpected result
    expect(horseJournalShardCapacity({ HORSE_DECISION_JOURNAL_DIR: 'relative/journal' })).toBe(2);
    expect(
      horseJournalShardCapacity({ ...configured, HORSE_DECISION_JOURNAL_ARCHIVE_MAX_BYTES: 'lots' })
    ).toBe(2);
  });
});
