/** OUTSIDE-TREE, PREPARED/UNEXECUTED private v2 ingress. */
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HorseDecisionJournalStore } from '../services/horseDecisionJournal/store.js';
import { readonlyHorseJournalStoreOptions } from '../services/horseDecisionJournal/config.js';
import { verifyCorrectiveAuthority, sha256 } from '../services/horseCorrectiveReview/authority.js';
import { reviewHorseCorrectiveHand } from '../services/horseCorrectiveReview/review.js';
import {
  readPrivateCorrectiveJson,
  writePrivateCorrectiveResult,
} from '../services/horseCorrectiveReview/privateFiles.js';

/** Explicit offline reader. Trusted-key configuration is independent of the
 * untrusted input/authority files. The installed production source exporter and
 * trust authority are not created or inferred by this entrypoint. */
export function runHorseCorrectiveReview(args: readonly string[]): {
  code: number;
  output: string;
} {
  if (
    (args.length !== 4 && args.length !== 5) ||
    !isAbsolute(args[0]!) ||
    !sha256(args[1]) ||
    !isAbsolute(args[2]!) ||
    !isAbsolute(args[3]!) ||
    (args[4] !== undefined && !isAbsolute(args[4]))
  )
    return {
      code: 64,
      output:
        'Usage: horseCorrectiveReview <absolute-private-journal-directory> <SHA256-hand-coordinate> <absolute-private-input-json> <new-absolute-private-output-json> [absolute-private-signed-authority-json]\n',
    };
  let store: HorseDecisionJournalStore | undefined;
  try {
    const input = readPrivateCorrectiveJson(args[2]!, 3 * 1024 * 1024) as {
      version?: unknown;
      commitments?: unknown;
      references?: unknown[];
      rosterSource?: import('../services/horseCorrectiveReview/contract.js').CorrectiveReviewInput['rosterSource'];
    };
    if (
      !input ||
      (input.version !== 1 && input.version !== 2) ||
      (input.references !== undefined && !Array.isArray(input.references))
    )
      throw Error('invalid_input');
    const authority = args[4]
      ? verifyCorrectiveAuthority(
          readPrivateCorrectiveJson(args[4], 65536),
          process.env.HORSE_CORRECTIVE_REVIEW_TRUSTED_KEY_SHA256
        )
      : null;
    store = new HorseDecisionJournalStore(args[0]!, readonlyHorseJournalStoreOptions(args[0]!));
    const result = reviewHorseCorrectiveHand(
      {
        records: store.readHand(args[1]!),
        handKey: args[1]!,
        commitments: input.commitments,
        references: input.references,
        authority: authority ?? undefined,
        rosterSource: input.version === 2 ? input.rosterSource : undefined,
      },
      {
        rosterTrust: {
          publicKeyDigest: process.env.HORSE_ROSTER_REVIEW_TRUSTED_KEY_SHA256,
          producerSourceDigest: process.env.HORSE_ROSTER_REVIEW_PRODUCER_SHA256,
          allowSynthetic: false,
        },
      }
    );
    store.close();
    store = undefined;
    writePrivateCorrectiveResult(args[3]!, JSON.stringify(result) + '\n');
    return {
      code: result.status === 'reviewed' || result.status === 'known_empty_census' ? 0 : 2,
      output:
        JSON.stringify({
          status: result.status,
          ...(result.status === 'known_empty_census' ? { scope: result.scope } : {}),
          reviewId: result.reviewId,
          outputWritten: true,
          gtoVerified: false,
          activationAllowed: false,
        }) + '\n',
    };
  } catch {
    return {
      code: 3,
      output: 'Private Horse review unavailable; no success or policy activation claimed.\n',
    };
  } finally {
    try {
      store?.close();
    } catch {
      /* readonly connection cleanup */
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runHorseCorrectiveReview(process.argv.slice(2));
  process.stdout.write(result.output);
  process.exitCode = result.code;
}
