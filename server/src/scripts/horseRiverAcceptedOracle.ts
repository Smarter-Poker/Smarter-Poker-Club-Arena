import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lstatSync } from 'node:fs';
import {
  readPrivateCorrectiveJson,
  writePrivateCorrectiveResult,
} from '../services/horseCorrectiveReview/privateFiles.js';
import {
  createRiverAcceptedOracleReader,
  type RiverAcceptedOracleRequest,
} from '../services/horseCorrectiveReview/riverAcceptedOracle.js';

type OracleReader = ReturnType<typeof createRiverAcceptedOracleReader>;
const USAGE =
  'Usage: horseRiverAcceptedOracle <absolute-private-input-json> <new-absolute-private-output-json>\n';
/** Explicit one-shot private ingress. No default paths, dotenv, signing,
 * scheduling, runtime strategy changes or network operation on import.
 * The optional reader is a trusted in-process test seam, never a CLI option. */
export async function runHorseRiverAcceptedOracle(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
  injectedReader?: OracleReader
): Promise<{ code: number; output: string }> {
  if (args.length !== 2 || !isAbsolute(args[0]!) || !isAbsolute(args[1]!))
    return { code: 64, output: USAGE };
  try {
    // An existing result cannot be overwritten. Refuse it before an otherwise
    // unnecessary private source query; atomic publication also checks races.
    try {
      lstatSync(args[1]!);
      throw Error('private_output_exists');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw Error('private_output_unavailable');
    }
    const value = readPrivateCorrectiveJson(args[0]!, 16 * 1024 * 1024);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw Error('private_input_invalid');
    const input = value as Record<string, unknown>;
    if (
      Object.keys(input).sort().join(',') !== 'handKey,input,records,version' ||
      input.version !== 1 ||
      typeof input.handKey !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.handKey) ||
      !Array.isArray(input.records) ||
      input.records.length > 256 ||
      !input.input ||
      typeof input.input !== 'object' ||
      Array.isArray(input.input)
    )
      throw Error('private_input_invalid');
    const captured = Object.freeze({ DATABASE_URL: environment.DATABASE_URL });
    const reader = injectedReader ?? createRiverAcceptedOracleReader(captured);
    const result = await reader({
      records: input.records,
      handKey: input.handKey,
      input: input.input,
    } as RiverAcceptedOracleRequest);
    if (
      !result ||
      !['accepted_source_oracle', 'unavailable'].includes(result.status) ||
      result.qualified !== false ||
      result.completePopulation !== false ||
      result.activationAllowed !== false
    )
      throw Error('private_result_invalid');
    writePrivateCorrectiveResult(args[1]!, JSON.stringify(result) + '\n', 512 * 1024);
    return {
      code: result.status === 'accepted_source_oracle' ? 0 : 2,
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
        'Private accepted river oracle unavailable; no qualification or activation claimed.\n',
    };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A finite operator command does not own the engine's lobby publisher.
  // Keep cleanup inside direct execution so importing helpers leaves it live.
  const { channelHub } = await import('../hub/ChannelHub.js');
  channelHub.close();
  const result = await runHorseRiverAcceptedOracle(process.argv.slice(2));
  process.stdout.write(result.output);
  process.exitCode = result.code;
}
