import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';
import { readHorseJournalHand } from '../services/horseDecisionJournal/review.js';

/** Explicit private local inspection only. Arguments never select a remote
 * service, create a spool, update a review or activate a policy. */
export function runHorseJournalReview(args: readonly string[]): { code: number; output: string } {
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
