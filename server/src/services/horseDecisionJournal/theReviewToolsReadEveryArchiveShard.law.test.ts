/* THE REVIEW TOOLS READ EVERY ARCHIVE SHARD (2026-09-29).
 *
 * #5541 gave each Horse decision-shard writer its own archive catalog: shard 0
 * keeps 'archive', later shards are 'archive-shard-N', and a hand's records live
 * in exactly one of them. The three Phase 6 review tools were written when there
 * was one catalog and each hard-coded `<journal>/archive/...`. From #5541 on they
 * opened shard 0 only: half of the fleet's hands could never be selected into a
 * population, the capture continuity of half of its producers was never
 * measured, and the route proof counted half of the receipts, all with a clean
 * exit and well-formed output. Nothing said "you did not look".
 *
 * The law: a review tool builds a path into the archive only through the three
 * helpers below, and takes the shard names from the journal's own listing. It
 * fails at the source (a literal path, a missing listing call, a helper that has
 * drifted from the others) and on a two-shard fixture (a shard that exists must
 * be a shard that is named). Red on the tools as they were before this change:
 * each one joined 'archive' by hand and none listed the shards. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as config from './config.js';
import { HorseDecisionJournalStore } from './store.js';
import { journalHash, makeHorseJournalRecord } from './record.js';
// @ts-expect-error The selector is a plain ES module script with no emitted declaration.
import * as population from '../../../scripts/phase6d-population.mjs';

const TOOLS = ['phase6b-route-proof.mjs', 'phase6d-population.mjs', 'phase6d-chain-export.mjs'];
const scriptPath = (name: string) => new URL(`../../../scripts/${name}`, import.meta.url);
const code = (name: string) =>
  readFileSync(scriptPath(name), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('no review tool builds an archive path by hand', () => {
  for (const tool of TOOLS) {
    it(`${tool} names the archive only through the shard helpers`, () => {
      const source = code(tool);
      // The only literal path pieces are inside the three helpers.
      const outside = source
        .replace(/function archiveShardNames[\s\S]*?\n}\n/, '')
        .replace(/(export )?const shardCatalogPath[\s\S]*?;\n/, '')
        .replace(/(export )?const shardSegmentPath[\s\S]*?;\n/, '');
      expect(outside).not.toMatch(/['"`]\/?archive\/?['"`]/);
      expect(outside).not.toMatch(/\/archive\//);
      expect(outside).not.toContain('horse-journal-archive.sqlite');
      expect(outside).not.toMatch(/segments\/\$\{|\/segments\//);
      expect(source).toContain('horseJournalArchiveDirectoryNames');
      expect(source).toMatch(/archiveShardNames\(config, /);
      expect(source).toContain('shardCatalogPath(');
    });
  }

  it('keeps the three copies of the helpers identical', () => {
    const helpers = (tool: string) => {
      const source = code(tool).replace(/export /g, '');
      const pick = (re: RegExp) => {
        const m = re.exec(source);
        if (!m) throw Error(`${tool}: helper missing`);
        return m[0].replace(/\s+/g, ' ');
      };
      return [
        pick(/function archiveShardNames[\s\S]*?\n}\n/),
        pick(/const shardCatalogPath[\s\S]*?;\n/),
        pick(/const shardSegmentPath[\s\S]*?;\n/),
      ].join('\n');
    };
    const [first, ...rest] = TOOLS.map(helpers);
    for (const other of rest) expect(other).toBe(first);
  });
});

describe('a shard that exists is a shard that is read', () => {
  const dirs: string[] = [];
  const stores: HorseDecisionJournalStore[] = [];
  afterEach(() => {
    for (const s of stores.splice(0))
      try {
        s.close();
      } catch {
        /* closed */
      }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const writeShard = (dir: string, index: number, hand: string) => {
    const store = new HorseDecisionJournalStore(dir, {
      archive: config.runtimeHorseJournalArchiveOptions(dir, {}, { index }),
    });
    stores.push(store);
    store.appendBatch([
      makeHorseJournalRecord(
        {
          producerId: `10000000-0000-4000-8000-00000000000${index + 1}`,
          sequence: 1,
          atMs: 1_000 + index,
          sourceRelease: null,
          kind: 'decision',
          handKey: hand,
          turnKey: journalHash(`turn-${index}`),
        },
        { schema: 'decision', shard: index }
      ),
    ]);
  };

  it('lists both shards, and a helper-built path opens the catalog of each', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'horse-shards-'));
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const hand0 = journalHash('hand-in-shard-zero');
    const hand1 = journalHash('hand-in-shard-one');
    writeShard(dir, 0, hand0);
    writeShard(dir, 1, hand1);

    const names = population.archiveShardNames(config, dir);
    expect(names).toEqual(['archive', 'archive-shard-1']);

    const { DatabaseSync } = await import('node:sqlite');
    const seen: string[] = [];
    for (const name of names) {
      const db = new DatabaseSync(population.shardCatalogPath(dir, name), { readOnly: true });
      try {
        const rows = db.prepare('SELECT hand_key FROM archive_events').all() as Array<{ hand_key: string }>;
        seen.push(...rows.map((r) => r.hand_key));
      } finally {
        db.close();
      }
    }
    // Each hand is in exactly one catalog, and only reading both finds both.
    expect(seen.sort()).toEqual([hand0, hand1].sort());
    const shardZeroOnly = new DatabaseSync(population.shardCatalogPath(dir, 'archive'), { readOnly: true });
    try {
      const rows = shardZeroOnly.prepare('SELECT hand_key FROM archive_events').all() as Array<{ hand_key: string }>;
      expect(rows.map((r) => r.hand_key)).not.toContain(hand1);
    } finally {
      shardZeroOnly.close();
    }
  });

  it('refuses to answer empty when the journal has no archive at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'horse-shards-none-'));
    dirs.push(dir);
    expect(() => population.archiveShardNames(config, dir)).toThrow('archive_custody_unavailable');
  });
});
