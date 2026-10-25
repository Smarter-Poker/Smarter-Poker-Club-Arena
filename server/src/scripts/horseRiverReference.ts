import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  readPrivateCorrectiveJson,
  writePrivateCorrectiveResult,
} from '../services/horseCorrectiveReview/privateFiles.js';
import {
  produceRiverCallFoldReference,
  type RiverReferenceInput,
} from '../services/horseCorrectiveReview/riverReference.js';
import {
  evaluateRiverHoldout,
  type RiverHoldoutPlan,
  type RiverHoldoutCase,
} from '../services/horseCorrectiveReview/riverHoldout.js';

/** Explicit bounded offline operation. No default live paths, key access,
 * scheduler, signing, evidence promotion or engine activation. */
export function runHorseRiverReference(args: readonly string[]): { code: number; output: string } {
  if (
    args.length !== 3 ||
    !['produce', 'holdout'].includes(args[0]!) ||
    !isAbsolute(args[1]!) ||
    !isAbsolute(args[2]!)
  )
    return {
      code: 64,
      output:
        'Usage: horseRiverReference <produce|holdout> <absolute-private-input-json> <new-absolute-private-output-json>\n',
    };
  try {
    const value = readPrivateCorrectiveJson(args[1]!, 16 * 1024 * 1024) as {
      version: unknown;
      input: RiverReferenceInput;
      plan: RiverHoldoutPlan;
      rows: RiverHoldoutCase[];
    };
    if (!value || value.version !== 1) throw Error('unsupported_input_version');
    const result =
      args[0] === 'produce'
        ? produceRiverCallFoldReference(value.input)
        : evaluateRiverHoldout(value.plan, value.rows);
    writePrivateCorrectiveResult(args[2]!, JSON.stringify(result) + '\n');
    return {
      code: result.status === 'unavailable' ? 2 : 0,
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
  const result = runHorseRiverReference(process.argv.slice(2));
  process.stdout.write(result.output);
  process.exitCode = result.code;
}
