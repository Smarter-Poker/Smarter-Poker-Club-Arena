import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';
import {
  readHorseJournalHand,
  readHorsePlanEffects,
} from '../services/horseDecisionJournal/review.js';
import { HorseDecisionJournalStore } from '../services/horseDecisionJournal/store.js';
import {
  horseJournalArchiveDirectoryNames,
  readonlyHorseJournalStoreOptions,
} from '../services/horseDecisionJournal/config.js';

/** Explicit private local inspection only. Arguments never select a remote
 * service, create a spool, update a review or activate a policy. */
export function runHorseJournalReview(args: readonly string[]): { code: number; output: string } {
  if (args[0] === '--storage-status') {
    if (args.length !== 2 || !isAbsolute(args[1]!))
      return {
        code: 64,
        output: 'Usage: horseJournalReview --storage-status <absolute-private-journal-directory>\n',
      };
    let store: HorseDecisionJournalStore | undefined;
    try {
      store = new HorseDecisionJournalStore(args[1]!, readonlyHorseJournalStoreOptions(args[1]!));
      const storage = store.storageStats();
      // One archive per decision-shard writer (2026-09-28): shard 0's stats
      // are `storage`, unchanged from before sharding existed; every archive
      // directory this journal actually has on disk (shard 0's plus any
      // later shards') is named here too, so an operator knows to inspect
      // `archive-shard-1`, `archive-shard-2`, ... with their own runs of this
      // same flag rather than assuming `storage` is the whole picture.
      const archiveDirectories = horseJournalArchiveDirectoryNames(args[1]!);
      return {
        code: 0,
        output:
          JSON.stringify({
            version: 1,
            scope: 'private_storage_resources',
            status: 'observed',
            storage,
            archiveDirectories,
            completePopulation: false,
          }) + '\n',
      };
    } catch {
      return {
        code: 3,
        output: JSON.stringify({ status: 'unavailable', gaps: ['storage_unavailable'] }) + '\n',
      };
    } finally {
      try {
        store?.close();
      } catch {
        // Closing a read-only observer cannot certify missing capture.
      }
    }
  }
  if (args[0] === '--plan-effects') {
    // Phase 15.1: one retained hand's plan-effect ledger, read-only.
    if (args.length !== 3 || !isAbsolute(args[1]!) || !/^[0-9a-f]{64}$/.test(args[2]!))
      return {
        code: 64,
        output:
          'Usage: horseJournalReview --plan-effects <absolute-private-journal-directory> <SHA256-hand-coordinate>\n',
      };
    const result = readHorsePlanEffects(args[1]!, args[2]!);
    return {
      code: result.gaps.includes('invalid_records') ? 3 : result.gaps.length ? 2 : 0,
      output: JSON.stringify(result) + '\n',
    };
  }
  if (args.length !== 2 || !isAbsolute(args[0]!) || !/^[0-9a-f]{64}$/.test(args[1]!))
    return {
      code: 64,
      output:
        'Usage: horseJournalReview <absolute-private-journal-directory> <SHA256-hand-coordinate>\n',
    };
  const result = readHorseJournalHand(args[0]!, args[1]!);
  return {
    code: result.status === 'reconciled' ? 0 : result.status === 'incomplete' ? 2 : 3,
    output: JSON.stringify(result) + '\n',
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runHorseJournalReview(process.argv.slice(2));
  process.stdout.write(result.output);
  process.exitCode = result.code;
}
