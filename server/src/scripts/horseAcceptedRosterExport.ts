/** Prepared private unsigned export CLI; no database/network or policy write. */
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HorseDecisionJournalStore } from '../services/horseDecisionJournal/store.js';
import { readonlyHorseJournalStoreOptions } from '../services/horseDecisionJournal/config.js';
import {
  readPrivateCorrectiveJson,
  writePrivateCorrectiveResult,
} from '../services/horseCorrectiveReview/privateFiles.js';
import { createUnsignedAcceptedCommitmentExport } from '../services/horseAcceptedRoster/exporter.js';
import { SHA } from '../services/horseAcceptedRoster/schema.js';
import type { CliResult, UnknownObject } from '../services/horseAcceptedRoster/contract.js';
const MAX_INPUT = 1048576;
const object = (v: unknown): v is UnknownObject =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
function fail(reason: string): never {
  throw Error(reason);
}
export function runUnsignedAcceptedSourceExport(args: readonly string[]): CliResult {
  if (
    args.length !== 5 ||
    !isAbsolute(args[0]) ||
    !SHA.test(args[1]) ||
    !SHA.test(args[2]) ||
    !isAbsolute(args[3]) ||
    !isAbsolute(args[4])
  )
    return {
      code: 64,
      output:
        'Usage: accepted-horse-roster-r1 <absolute-private-journal> <hand-SHA256> <accepted-record-SHA256> <absolute-private-raw-rows-json> <new-absolute-private-output-json>\n',
    };
  let store: HorseDecisionJournalStore | undefined;
  try {
    const input: unknown = readPrivateCorrectiveJson(args[3], MAX_INPUT);
    if (!object(input) || input.version !== 1 || !Array.isArray(input.rows)) fail('invalid_input');
    store = new HorseDecisionJournalStore(args[0], readonlyHorseJournalStoreOptions(args[0]));
    const result = createUnsignedAcceptedCommitmentExport({
      records: store.readHand(args[1]),
      handKey: args[1],
      acceptedHandRecordDigest: args[2],
      rows: input.rows,
    });
    store.close();
    store = undefined;
    writePrivateCorrectiveResult(args[4], JSON.stringify(result) + '\n');
    return {
      code: result.sourceExport.status === 'unsigned_export' ? 0 : 2,
      output:
        JSON.stringify({
          status: result.sourceExport.status,
          outputWritten: true,
          authorityQualified: false,
          completePopulation: false,
        }) + '\n',
    };
  } catch {
    return { code: 3, output: 'Private unsigned Horse source export unavailable.\n' };
  } finally {
    try {
      store?.close();
    } catch {
      /* readonly close */
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runUnsignedAcceptedSourceExport(process.argv.slice(2));
  process.stdout.write(result.output);
  process.exitCode = result.code;
}
