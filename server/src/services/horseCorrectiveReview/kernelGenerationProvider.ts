/** Read the current protected provider generation floor, never historical
 * checkout selection constants. This is qualification-time only. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { correctiveReviewerChildEnvironment } from './reviewerEnvironment.js';
import {
  PHASE14_GENERATION_LEDGER_PATH,
  parsePhase14GenerationLedger,
} from './kernelGenerationLedger.js';
const REPOSITORY = 'Smarter-Poker/Smarter-Poker-Club-Arena';
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export interface CorrectiveGenerationReceipt {
  version: 'horse-phase14-current-generation-v1';
  mainSha: string;
  ledgerSha256: string;
  domain: string;
  highestPublishedGeneration: number;
  retiredGenerations: readonly number[];
  nextGeneration: number;
}
export type CorrectiveGenerationRead =
  | { status: 'current_generation'; receipt: Readonly<CorrectiveGenerationReceipt> }
  | { status: 'unavailable'; reason: string };
function github(path: string): unknown {
  return JSON.parse(
    execFileSync('gh', ['api', path], {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      env: correctiveReviewerChildEnvironment('github'),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  );
}
export function readCurrentCorrectiveGeneration(
  domain: string,
  api: (path: string) => unknown = github
): CorrectiveGenerationRead {
  const no = (reason: string): CorrectiveGenerationRead => ({ status: 'unavailable', reason });
  try {
    const main = api(`repos/${REPOSITORY}/branches/main`);
    if (
      !object(main) ||
      main.name !== 'main' ||
      main.protected !== true ||
      !object(main.commit) ||
      typeof main.commit.sha !== 'string' ||
      !/^[a-f0-9]{40}$/.test(main.commit.sha)
    )
      return no('generation_current_main_unknown');
    const file = api(
      `repos/${REPOSITORY}/contents/${PHASE14_GENERATION_LEDGER_PATH}?ref=${main.commit.sha}`
    );
    if (
      !object(file) ||
      file.type !== 'file' ||
      file.path !== PHASE14_GENERATION_LEDGER_PATH ||
      file.encoding !== 'base64' ||
      typeof file.content !== 'string' ||
      !Number.isSafeInteger(file.size) ||
      Number(file.size) < 1 ||
      Number(file.size) > 512 * 1024
    )
      return no('generation_current_ledger_unknown');
    const encoded = file.content.replace(/\s/g, ''),
      bytes = Buffer.from(encoded, 'base64');
    if (bytes.length !== file.size || bytes.toString('base64') !== encoded)
      return no('generation_current_ledger_unknown');
    const ledger = parsePhase14GenerationLedger(JSON.parse(bytes.toString('utf8'))),
      entry = ledger?.domains[domain];
    if (!entry || !Number.isSafeInteger(entry.highestPublishedGeneration + 1))
      return no('generation_current_ledger_invalid');
    return {
      status: 'current_generation',
      receipt: Object.freeze({
        version: 'horse-phase14-current-generation-v1',
        mainSha: main.commit.sha,
        ledgerSha256: createHash('sha256').update(bytes).digest('hex'),
        domain,
        highestPublishedGeneration: entry.highestPublishedGeneration,
        retiredGenerations: entry.retiredGenerations,
        nextGeneration: entry.highestPublishedGeneration + 1,
      }),
    };
  } catch {
    return no('generation_provider_unavailable');
  }
}
