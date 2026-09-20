import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';
import { readHorseJournalHand } from '../services/horseDecisionJournal/review.js';
import { HorseDecisionJournalStore } from '../services/horseDecisionJournal/store.js';
import { readonlyHorseJournalStoreOptions } from '../services/horseDecisionJournal/config.js';

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
      return {
        code: 0,
        output:
          JSON.stringify({
            version: 1,
            scope: 'private_storage_resources',
            status: 'observed',
            storage,
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
