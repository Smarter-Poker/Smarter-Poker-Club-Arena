/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  READ THE MIGRATION DIRECTORY ONCE PER TEST FILE, NOT ONCE PER QUESTION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A great many laws are proved by reading `supabase/migrations` and asserting
 * on what is in there. That is the right technique. What is not right is
 * reading all of it again for every question the file asks - three retired
 * functions, four table names, six needles - because the directory is the one
 * thing in this repo that only ever grows.
 *
 * Measured 2026-09-10 at 2,849 files: four law tests crossed vitest's 5-second
 * default in one run and passed in the next, on work that had not changed a
 * character. A guard that fails on a busy machine and passes on an idle one is
 * not a guard, it is a coin flip - and it teaches everyone to re-run CI instead
 * of reading it.
 *
 * So: one pass, memoised for the life of the module (vitest gives each test
 * file its own module registry, so this is one pass per file), and every
 * question answered from the array. `migrationsMentioning` is the shape most
 * of these tests actually want.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyMigration, loadManifest } from '../../scripts/ci/recording-only.mjs';

export const MIGRATIONS_DIR = resolve(__dirname, '..', '..', 'supabase', 'migrations');

export interface MigrationFile {
  /** File name, e.g. `20260910124023_a_player_id_is_a_uuid_not_a_uuid_version.sql`. */
  name: string;
  /** Its complete text. */
  sql: string;
}

let namesCache: string[] | null = null;
let corpusCache: MigrationFile[] | null = null;

/** Every applied migration file name, ascending - which is version order. */
export const migrationNames = (): string[] =>
  (namesCache ??= readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort());

/** Every migration, read once. Ascending by version. */
export const migrationCorpus = (): MigrationFile[] =>
  (corpusCache ??= migrationNames().map((name) => ({
    name,
    sql: readFileSync(resolve(MIGRATIONS_DIR, name), 'utf8'),
  })));

/** Every migration whose text contains `needle`, in version order. */
export const migrationsMentioning = (needle: string): MigrationFile[] =>
  migrationCorpus().filter((migration) => migration.sql.includes(needle));

/** The text of one migration, by exact file name. */
export const migrationText = (name: string): string => {
  const hit = migrationCorpus().find((migration) => migration.name === name);
  if (!hit) throw new Error(`migrationText: ${name} is not in supabase/migrations`);
  return hit.sql;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE LATEST DEFINITION OF A NAMED FUNCTION, WITHOUT READING THE WHOLE
 *  DIRECTORY (2026-10-04)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `migrationCorpus()` reads every file. That is the right shape for a law
 * that asks "does ANY migration do X", and the wrong shape for the commoner
 * question "what does the LATEST definition of these few functions look
 * like", because the answer is always in the newest handful of files and the
 * directory only grows.
 *
 * Measured on this repository on 2026-10-04 at 5,093 files (62 MB): reading
 * the corpus costs 1,960 ms and the regex passes over it another 213 ms, so a
 * test that asks this question through `migrationCorpus()` spends 2.2 s
 * before its first assertion. `tests/unit/diamondStaffDeskService.test.ts`
 * was doing exactly that and finished in 4,652 ms of vitest's 5,000 ms
 * default - 93% of its budget - so it passed alone and timed out in a shard
 * alongside other files. A timed-out test is not a failed assertion; the
 * assertion never ran at all (CLAUDE.md 10.86 rule 1), and raising the budget
 * to the ceiling just read is the trap rule 4 names. The fix is to stop doing
 * the work.
 *
 * So: walk the names NEWEST FIRST, read a file only while a name is still
 * unanswered, and skip the regex on any file whose text does not mention the
 * function at all. The first (newest) file that defines a name holds its
 * latest definition, which is the same answer an ascending whole-corpus pass
 * gives. The same measurement, through this helper: 103 ms, 242 files read.
 *
 * Nothing is memoised across calls, because the caller asks once.
 */
export const latestFunctionParams = (names: readonly string[]): Map<string, string[]> => {
  const wanted = new Set(names);
  const found = new Map<string, string[]>();
  const all = migrationNames();
  for (let i = all.length - 1; i >= 0 && wanted.size > 0; i -= 1) {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, all[i]), 'utf8');
    for (const fn of [...wanted]) {
      if (!sql.includes(`public.${fn}(`)) continue;
      const head = new RegExp(
        `CREATE (?:OR REPLACE )?FUNCTION public\\.${fn}\\(([^)]*(?:\\([^)]*\\)[^)]*)*)\\)`,
        'g'
      );
      let list: string | null = null;
      for (const match of sql.matchAll(head)) list = match[1];
      if (list === null) continue;
      found.set(
        fn,
        list
          .split(',')
          .map((part) => part.trim().split(/\s+/)[0])
          .filter(Boolean)
      );
      wanted.delete(fn);
    }
  }
  return found;
};

/**
 * IS THIS FILE A VERIFIED RECORDING OF SQL PRODUCTION ALREADY RAN? (2026-09-28)
 *
 * A law that asks "does this migration INTRODUCE X" has already had its answer
 * from the database when the file is a byte-exact recording of an applied
 * migration: the SQL ran before the file existed, so refusing the file protects
 * nothing and only keeps the repository unable to describe its own database.
 * scripts/ci/recording-only.mjs is the one place that decides this for the
 * file-text guards (manifest row + md5 of the file bytes, checked live by
 * check-recorded-migrations-evidence.mjs; or the legacy marker below its frozen
 * cutoff). Laws that scan the corpus for newly introduced shapes use the same
 * answer, so a recording is judged the same way everywhere. 'unknown' (an
 * unreadable manifest) is never a recording.
 */
let recordingManifest: ReturnType<typeof loadManifest> | null = null;
const recordingVerdicts = new Map<string, boolean>();
export const isVerifiedRecording = (name: string): boolean => {
  const cached = recordingVerdicts.get(name);
  if (cached !== undefined) return cached;
  recordingManifest ??= loadManifest();
  const verdict =
    classifyMigration(`supabase/migrations/${name}`, { manifest: recordingManifest }).state ===
    'recorded';
  recordingVerdicts.set(name, verdict);
  return verdict;
};
