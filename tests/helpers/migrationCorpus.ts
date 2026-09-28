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
