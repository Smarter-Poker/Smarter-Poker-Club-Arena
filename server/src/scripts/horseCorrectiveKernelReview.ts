import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lstatSync } from 'node:fs';
import {
  readPrivateCorrectiveJson,
  writePrivateCorrectiveResult,
} from '../services/horseCorrectiveReview/privateFiles.js';
import {
  createCorrectiveKernelEvidenceReviewer,
  CORRECTIVE_KERNEL_REVIEW_VERSION,
  CORRECTIVE_KERNEL_UNRESOLVED_GATES,
  type CorrectiveKernelEvidenceReview,
} from '../services/horseCorrectiveReview/kernelQualificationReview.js';
import {
  readCorrectivePredeclaration,
  isAuthenticatedCorrectivePredeclaration,
  type CorrectivePredeclarationRequest,
} from '../services/horseCorrectiveReview/kernelPredeclaration.js';
import type { RiverAcceptedOracleRequest } from '../services/horseCorrectiveReview/riverAcceptedOracle.js';
const USAGE =
  'Usage: horseCorrectiveKernelReview <absolute-private-input-json> <new-absolute-private-output-json>\n';
type Reviewer = ReturnType<typeof createCorrectiveKernelEvidenceReviewer>;
/** One explicit bounded operation. Protected plan custody is read directly
 * through configured authenticated gh. No input/output defaults, env-file
 * loading, import-time queries, signing, schedule, publication or selection.
 * Injected functions are trusted local test seams, never CLI/JSON options. */
export async function runHorseCorrectiveKernelReview(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
  injectedReviewer?: Reviewer,
  predeclarationReader: typeof readCorrectivePredeclaration = readCorrectivePredeclaration
): Promise<{ code: number; output: string }> {
  if (args.length !== 2 || !isAbsolute(args[0]!) || !isAbsolute(args[1]!))
    return { code: 64, output: USAGE };
  try {
    try {
      lstatSync(args[1]!);
      throw Error('private_output_exists');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw Error('private_output_unavailable');
    }
    const value = readPrivateCorrectiveJson(args[0]!, 256 * 1024 * 1024);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw Error('private_input_invalid');
    const input = value as Record<string, unknown>;
    if (
      Object.keys(input).sort().join(',') !== 'predeclaration,requests,version' ||
      input.version !== 1 ||
      !input.predeclaration ||
      typeof input.predeclaration !== 'object' ||
      Array.isArray(input.predeclaration) ||
      !Array.isArray(input.requests) ||
      input.requests.length < 2 ||
      input.requests.length > 10000
    )
      throw Error('private_input_invalid');
    const custody = predeclarationReader(
      input.predeclaration as unknown as CorrectivePredeclarationRequest
    );
    let result: CorrectiveKernelEvidenceReview;
    if (custody.status === 'unavailable')
      result = {
        version: CORRECTIVE_KERNEL_REVIEW_VERSION,
        status: 'unavailable',
        reason: custody.reason,
        checkedCases: 0,
        reviewDigest: null,
        sourceCustodyDigest: null,
        numericReviewDigest: null,
        predeclarationDigest: null,
        measurement: null,
        requiredBeforeIssuance: CORRECTIVE_KERNEL_UNRESOLVED_GATES,
        qualified: false,
        completePopulation: false,
        activationAllowed: false,
      };
    else {
      if (!isAuthenticatedCorrectivePredeclaration(custody.predeclaration))
        throw Error('private_predeclaration_invalid');
      const reviewer =
        injectedReviewer ??
        createCorrectiveKernelEvidenceReviewer(
          Object.freeze({ DATABASE_URL: environment.DATABASE_URL })
        );
      result = await reviewer(
        custody.predeclaration.plan,
        input.requests as RiverAcceptedOracleRequest[],
        custody.predeclaration
      );
    }
    if (
      !result ||
      !['reviewed_unsigned', 'unavailable'].includes(result.status) ||
      result.qualified !== false ||
      result.completePopulation !== false ||
      result.activationAllowed !== false ||
      !Array.isArray(result.requiredBeforeIssuance) ||
      result.requiredBeforeIssuance.length < 1
    )
      throw Error('private_result_invalid');
    writePrivateCorrectiveResult(args[1]!, JSON.stringify(result) + '\n', 512 * 1024);
    return {
      code: result.status === 'reviewed_unsigned' ? 0 : 2,
      output:
        JSON.stringify({
          status: result.status,
          outputWritten: true,
          qualified: false,
          completePopulation: false,
          activationAllowed: false,
        }) + '\n',
    };
  } catch {
    return {
      code: 3,
      output:
        'Private corrective kernel review unavailable; no qualification or activation claimed.\n',
    };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runHorseCorrectiveKernelReview(process.argv.slice(2));
  process.stdout.write(result.output);
  process.exitCode = result.code;
}
