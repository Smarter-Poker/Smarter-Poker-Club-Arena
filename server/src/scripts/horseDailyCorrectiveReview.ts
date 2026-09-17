import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DAILY_LIMITS } from '../services/horseDailyCorrectiveReview/contract.js';
import { parseDailyManifest } from '../services/horseDailyCorrectiveReview/validation.js';
import { createDailyReviewSource } from '../services/horseDailyCorrectiveReview/source.js';
import {
  reviewDailySelection,
  type DailyTrust,
} from '../services/horseDailyCorrectiveReview/batch.js';
import type { DailySource } from '../services/horseDailyCorrectiveReview/contract.js';
export interface DailyExecutionDependencies {
  source?: DailySource;
  trust?: DailyTrust;
}
/** Explicit local private batch. No default path, dotenv load or client on import.
 * Tests may inject source/trust; direct production execution has no synthetic flag. */
export async function runHorseDailyCorrectiveReview(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  injected: DailyExecutionDependencies = {}
): Promise<{ code: number; output: string }> {
  if (args.length !== 2 || !isAbsolute(args[0]!) || !isAbsolute(args[1]!))
    return {
      code: 64,
      output:
        'Usage: horseDailyCorrectiveReview <absolute-private-mapping-manifest> <new-absolute-private-output>\n',
    };
  const manifestPath = args[0]!,
    outputPath = args[1]!;
  const capturedEnvironment = Object.freeze({
    SUPABASE_URL: environment.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: environment.SUPABASE_SERVICE_ROLE_KEY,
  });
  const suppliedSource = injected.source;
  const suppliedTrust = injected.trust;
  const trust = Object.freeze(
    suppliedTrust
      ? {
          correctiveKeyDigest: suppliedTrust.correctiveKeyDigest,
          rosterKeyDigest: suppliedTrust.rosterKeyDigest,
          rosterProducerDigest: suppliedTrust.rosterProducerDigest,
          allowSynthetic: suppliedTrust.allowSynthetic === true,
        }
      : {
          correctiveKeyDigest: environment.HORSE_CORRECTIVE_REVIEW_TRUSTED_KEY_SHA256,
          rosterKeyDigest: environment.HORSE_ROSTER_REVIEW_TRUSTED_KEY_SHA256,
          rosterProducerDigest: environment.HORSE_ROSTER_REVIEW_PRODUCER_SHA256,
          allowSynthetic: false,
        }
  );
  try {
    const { readPrivateCorrectiveJson, writePrivateCorrectiveResult } =
      await import('../services/horseCorrectiveReview/privateFiles.js');
    const manifest = parseDailyManifest(
      readPrivateCorrectiveJson(manifestPath, DAILY_LIMITS.manifestBytes)
    );
    const source = suppliedSource ?? createDailyReviewSource(capturedEnvironment);
    const result = await reviewDailySelection(manifest, source, trust);
    writePrivateCorrectiveResult(outputPath, JSON.stringify(result) + '\n');
    return {
      code: result.status === 'reviewed_selection' ? 0 : 2,
      output:
        JSON.stringify({
          status: result.status,
          scope: result.scope,
          pages: result.pages,
          rows: result.rows.length,
          outputWritten: true,
          fullWindow: false,
          sourcePopulationVerified: false,
          gtoVerified: false,
          activationAllowed: false,
        }) + '\n',
    };
  } catch {
    return {
      code: 3,
      output:
        'Private daily Horse review unavailable; no completed review or activation claimed.\n',
    };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runHorseDailyCorrectiveReview(process.argv.slice(2), process.env);
  process.stdout.write(result.output);
  process.exitCode = result.code;
}
