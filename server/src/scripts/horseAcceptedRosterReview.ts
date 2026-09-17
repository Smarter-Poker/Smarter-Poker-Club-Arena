/** PREPARED, UNEXECUTED explicit offline private CLI. No DB/network/writeback. */
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HorseDecisionJournalStore } from '../services/horseDecisionJournal/store.js';
import {
  readPrivateCorrectiveJson,
  writePrivateCorrectiveResult,
} from '../services/horseCorrectiveReview/privateFiles.js';
import { createUnsignedAcceptedCommitmentExport } from '../services/horseAcceptedRoster/exporter.js';
import { acceptedRosterEligibility } from '../services/horseAcceptedRoster/eligibility.js';
import { sha } from '../services/horseAcceptedRoster/schema.js';
import type { CliResult, UnknownObject } from '../services/horseAcceptedRoster/contract.js';
const object = (v: unknown): v is UnknownObject =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
export function runPrivateRosterReview(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env
): CliResult {
  if (
    ![5, 6].includes(args.length) ||
    !isAbsolute(args[0]) ||
    !sha(args[1]) ||
    !sha(args[2]) ||
    !isAbsolute(args[3]) ||
    !isAbsolute(args[4]) ||
    (args[5] && !isAbsolute(args[5]))
  )
    return {
      code: 64,
      output:
        'Usage: private-roster-review <absolute-private-journal> <hand-SHA256> <accepted-record-SHA256> <absolute-private-raw-rows-json> <new-absolute-private-output-json> [absolute-private-signed-roster-authority-json]\n',
    };
  let store: HorseDecisionJournalStore | undefined;
  try {
    const raw: unknown = readPrivateCorrectiveJson(args[3], 1048576);
    if (!object(raw) || raw.version !== 1 || !Array.isArray(raw.rows)) throw Error();
    const envelope = args[5] ? readPrivateCorrectiveJson(args[5], 16384) : undefined;
    // Never obtain these independent pins from either input file. Synthetic
    // fixture qualification is available to tests through the library only.
    const trust = {
      publicKeyDigest: environment.HORSE_ROSTER_REVIEW_TRUSTED_KEY_SHA256,
      producerSourceDigest: environment.HORSE_ROSTER_REVIEW_PRODUCER_SHA256,
      allowSynthetic: false,
    };
    store = new HorseDecisionJournalStore(args[0], { readOnly: true });
    const input = {
      records: store.readHand(args[1]),
      handKey: args[1],
      acceptedHandRecordDigest: args[2],
      rows: raw.rows,
    };
    store.close();
    store = undefined;
    const exported = createUnsignedAcceptedCommitmentExport(input);
    const eligibility = acceptedRosterEligibility(input, envelope, trust);
    writePrivateCorrectiveResult(
      args[4],
      JSON.stringify({ version: 1, exported, eligibility }) + '\n'
    );
    return {
      code: eligibility.status === 'qualified_monetary_eligibility' ? 0 : 2,
      output:
        JSON.stringify({
          status: eligibility.status,
          outputWritten: true,
          completePopulation: false,
          gtoVerified: false,
          activationAllowed: false,
        }) + '\n',
    };
  } catch {
    return { code: 3, output: 'Private Horse roster review unavailable.\n' };
  } finally {
    try {
      store?.close();
    } catch {
      /* read-only store */
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runPrivateRosterReview(process.argv.slice(2));
  process.stdout.write(result.output);
  process.exitCode = result.code;
}
