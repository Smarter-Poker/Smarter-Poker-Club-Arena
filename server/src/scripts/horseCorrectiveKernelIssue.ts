import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lstatSync } from 'node:fs';
import { probeCorrectiveKernelSignerIdentity } from '../services/horseCorrectiveReview/kernelSignerIdentity.js';
import {
  readPrivateCorrectiveJson,
  writePrivateCorrectiveResult,
} from '../services/horseCorrectiveReview/privateFiles.js';
import {
  readCorrectivePredeclaration,
  type CorrectivePredeclarationRequest,
} from '../services/horseCorrectiveReview/kernelPredeclaration.js';
import {
  createAuthenticatedHorseJournalReader,
  isAuthenticatedHorseJournalBatch,
} from '../services/horseCorrectiveReview/journalTransport.js';
import {
  createCorrectiveKernelIssuer,
  produceCorrectiveKernelSource,
  type CorrectiveKernelIssueRequest,
} from '../services/horseCorrectiveReview/kernelIssuer.js';
const USAGE =
  'Usage: horseCorrectiveKernelIssue context|produce|issue|identity <absolute-private-input-json> <new-absolute-private-output-json>\n';
/** All ingress is explicit and private. No arbitrary source/cases/catalog,
 * source query on import, env-file loading, key generation or activation. */
export async function runHorseCorrectiveKernelIssue(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env
): Promise<{ code: number; output: string }> {
  if (
    args.length !== 3 ||
    !['context', 'produce', 'issue', 'identity'].includes(args[0]!) ||
    !isAbsolute(args[1]!) ||
    !isAbsolute(args[2]!)
  )
    return { code: 64, output: USAGE };
  try {
    try {
      lstatSync(args[2]!);
      throw Error();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw Error();
    }
    const value = readPrivateCorrectiveJson(args[1]!, 512 * 1024);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    const input = value as Record<string, unknown>,
      mode = args[0];
    if (mode === 'identity') {
      if (input.version !== 1 || Object.keys(input).join(',') !== 'version') throw Error();
      const identity = probeCorrectiveKernelSignerIdentity(environment);
      writePrivateCorrectiveResult(args[2]!, JSON.stringify(identity) + '\n', 512 * 1024);
      return {
        code: identity.status === 'signer_identity_verified' ? 0 : 2,
        output:
          JSON.stringify({
            status: identity.status,
            outputWritten: true,
            qualified: false,
            activationAllowed: false,
          }) + '\n',
      };
    }
    const keys =
      mode === 'issue'
        ? 'predeclaration,producerRequestsDigest,scratchRoot,version'
        : 'predeclaration,version';
    if (
      input.version !== 1 ||
      Object.keys(input).sort().join(',') !== keys ||
      !input.predeclaration ||
      typeof input.predeclaration !== 'object' ||
      Array.isArray(input.predeclaration)
    )
      throw Error();
    if (
      mode === 'issue' &&
      (typeof input.scratchRoot !== 'string' ||
        !isAbsolute(input.scratchRoot) ||
        typeof input.producerRequestsDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(input.producerRequestsDigest))
    )
      throw Error();
    let result: Record<string, unknown>,
      published: unknown,
      success = false;
    if (mode === 'context') {
      const declared = readCorrectivePredeclaration(
        input.predeclaration as unknown as CorrectivePredeclarationRequest
      );
      if (declared.status !== 'authenticated_predeclaration')
        result = {
          status: 'unavailable',
          reason: declared.reason,
          qualified: false,
          activationAllowed: false,
        };
      else {
        const remote = await createAuthenticatedHorseJournalReader(environment)([]);
        if (
          !isAuthenticatedHorseJournalBatch(remote) ||
          remote.sourceRelease !== declared.predeclaration.plan.sourceRelease ||
          remote.recordsByHand.length !== 0
        )
          result = {
            status: 'unavailable',
            reason: 'context_canonical_runtime_unavailable',
            qualified: false,
            activationAllowed: false,
          };
        else {
          result = {
            status: 'qualification_context',
            sourceRelease: remote.sourceRelease,
            runtime: remote.runtime,
            predeclarationDigest: declared.predeclaration.custodyDigest,
            qualified: false,
            activationAllowed: false,
          };
          success = true;
        }
      }
      published = result;
    } else if (mode === 'produce') {
      result = await produceCorrectiveKernelSource(
        environment,
        input.predeclaration as unknown as CorrectivePredeclarationRequest
      );
      published = result;
      success = result.status === 'produced_unsigned_population';
    } else {
      const issued = await createCorrectiveKernelIssuer(environment)({
        predeclaration: input.predeclaration,
        scratchRoot: input.scratchRoot,
        producerRequestsDigest: input.producerRequestsDigest,
      } as CorrectiveKernelIssueRequest);
      result = { status: issued.status, activationAllowed: false };
      success = issued.status === 'issued_qualification';
      published = issued.status === 'issued_qualification' ? issued.qualification : issued;
    }
    writePrivateCorrectiveResult(args[2]!, JSON.stringify(published) + '\n', 512 * 1024);
    return {
      code: success ? 0 : 2,
      output:
        JSON.stringify({ status: result.status, outputWritten: true, activationAllowed: false }) +
        '\n',
    };
  } catch {
    return {
      code: 3,
      output: 'Private corrective qualification unavailable; no activation claimed.\n',
    };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A finite operator command does not own the engine's lobby publisher.
  // Keep cleanup inside direct execution so importing helpers leaves it live.
  const { channelHub } = await import('../hub/ChannelHub.js');
  channelHub.close();
  const result = await runHorseCorrectiveKernelIssue(process.argv.slice(2));
  process.stdout.write(result.output);
  process.exitCode = result.code;
}
