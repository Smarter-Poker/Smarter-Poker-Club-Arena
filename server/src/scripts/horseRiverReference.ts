import { reviewCorrectiveKernelNumerics } from '../services/horseCorrectiveReview/kernelIndependentReview.js';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  readPrivateCorrectiveJson,
  writePrivateCorrectiveResult,
} from '../services/horseCorrectiveReview/privateFiles.js';
import {
  produceRiverCallFoldReference,
  type RiverReferenceInput,
  type RiverDecisionInput,
} from '../services/horseCorrectiveReview/riverReference.js';
import {
  evaluateRiverHoldout,
  type RiverHoldoutPlan,
  type RiverHoldoutCase,
} from '../services/horseCorrectiveReview/riverHoldout.js';
import { reviewRiverEnumeration } from '../services/horseCorrectiveReview/riverIndependentReview.js';
import type { AlternativeActionReference } from '../services/horseCorrectiveReview/contract.js';
import { buildOriginalRiverDecision } from '../services/horseCorrectiveReview/riverDecisionModel.js';
import {
  evaluateRiverDecisionModelHoldout,
  type RiverModelHoldoutPlan,
  type RiverModelHoldoutCase,
} from '../services/horseCorrectiveReview/riverModelHoldout.js';

/** Explicit bounded offline operation. No default live paths, key access,
 * scheduler, signing, evidence promotion or engine activation. */
export function runHorseRiverReference(args: readonly string[]): { code: number; output: string } {
  if (
    args.length !== 3 ||
    !['produce', 'holdout', 'verify', 'model', 'model-holdout', 'verify-batch'].includes(
      args[0]!
    ) ||
    !isAbsolute(args[1]!) ||
    !isAbsolute(args[2]!)
  )
    return {
      code: 64,
      output:
        'Usage: horseRiverReference <produce|holdout|verify|model|model-holdout|verify-batch> <absolute-private-input-json> <new-absolute-private-output-json>\n',
    };
  try {
    const value = readPrivateCorrectiveJson(args[1]!, 16 * 1024 * 1024) as {
      version: unknown;
      input: RiverReferenceInput;
      inputs: RiverReferenceInput[];
      plan: RiverHoldoutPlan & RiverModelHoldoutPlan;
      rows: RiverModelHoldoutCase[];
      reference: AlternativeActionReference;
      original: RiverDecisionInput['original'];
    };
    if (!value || value.version !== 1) throw Error('unsupported_input_version');
    const result =
      args[0] === 'verify-batch'
        ? reviewCorrectiveKernelNumerics(value.inputs)
        : args[0] === 'model'
          ? buildOriginalRiverDecision(value.original)
          : args[0] === 'model-holdout'
            ? evaluateRiverDecisionModelHoldout(value.plan, value.rows)
            : args[0] === 'produce'
              ? produceRiverCallFoldReference(value.input)
              : args[0] === 'verify'
                ? reviewRiverEnumeration(value.input, value.reference)
                : evaluateRiverHoldout(value.plan, value.rows);
    writePrivateCorrectiveResult(
      args[2]!,
      JSON.stringify(result) + '\n',
      args[0] === 'model' ? 1024 * 1024 : undefined
    );
    return {
      code: result.status === 'unavailable' || result.status === 'mismatch' ? 2 : 0,
      output:
        JSON.stringify({
          status: result.status,
          outputWritten: true,
          qualified: false,
          activationAllowed: false,
        }) + '\n',
    };
  } catch {
    return {
      code: 3,
      output: 'Private river evaluation unavailable; no qualification or activation claimed.\n',
    };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A finite operator command does not own the engine's lobby publisher.
  // Keep cleanup inside direct execution so importing helpers leaves it live.
  const { channelHub } = await import('../hub/ChannelHub.js');
  channelHub.close();
  const result = runHorseRiverReference(process.argv.slice(2));
  process.stdout.write(result.output);
  process.exitCode = result.code;
}
