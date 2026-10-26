/**
 * THE ONE ANSWER TO "WILL THE APPLIER TAKE THIS FILE?" (2026-10-26)
 *
 * apply-recorded-migration.mjs sends a migration as a single simple query, so
 * CLAUDE.md section 2 rule 1 (one migration = one transaction) is enforced
 * there: a file must open with `BEGIN;` and END with `COMMIT;` - nothing may
 * follow the transaction, not even a comment (the 2026-10-19 packaging ruling,
 * docs/changelog/2026-10-19-lightning-fold-custody-and-receipts.md, pinned by
 * tests/unit/applyMergedMigrationVerdict.test.ts) - apart from the sanctioned
 * CREATE INDEX CONCURRENTLY preamble (migration-concurrent-preamble.mjs).
 *
 * What was missing was the question at merge time. On 2026-10-25
 * 20261025143717_digest_counts_original_alerts_rather_than_source_updates
 * merged with its `-- @live-proof:` lines after COMMIT;, the merger dispatched
 * it, the applier refused it (run 40215906092), and the refusal reached
 * nobody - the same packaging mistake the 2026-10-19 change had already been
 * corrected for once. Both callers - the applier and
 * tests/unit/aMergedMigrationIsInstallable.test.ts - use this function, so the
 * merge check and the applier cannot disagree.
 */
import { splitConcurrentPreamble } from './migration-concurrent-preamble.mjs';

/**
 * @param {string} file  the migration's file name, for the message
 * @param {string} sql   the file's full text
 * @returns {{ ok: true, indexes: unknown[], body: string } | { ok: false, reason: string }}
 */
export function migrationTransactionShape(file, sql) {
  if (!/^\s*BEGIN\s*;/im.test(sql) || !/COMMIT\s*;\s*$/i.test(sql.trim())) {
    return {
      ok: false,
      reason: `${file} does not open with BEGIN; and close with COMMIT; - refusing to apply it outside one transaction`,
    };
  }
  const shape = splitConcurrentPreamble(sql);
  if (!shape.ok) return { ok: false, reason: `${file}: ${shape.reason}` };
  return { ok: true, indexes: shape.indexes, body: shape.body };
}
