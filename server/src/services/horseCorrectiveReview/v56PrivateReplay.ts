import { bindHorseDecisionToCommittedHand } from '../../engine/HorseDecisionHandBinding.js';
import { reconcileHorseJournalHand } from '../horseDecisionJournal/review.js';
import { resolveKernelOriginalInput } from './kernelOriginalInput.js';
import type { HorseJournalRecord } from '../horseDecisionJournal/record.js';
/** Explicit private replay orchestration; source authentication stays with the
 * pinned transport and provider metadata. No authority or signing is issued. */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, unlinkSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import {
  createAuthenticatedHorseJournalReader,
  isAuthenticatedHorseJournalBatch,
} from './journalTransport.js';
import { readPrivateCorrectiveJson, writePrivateCorrectiveResult } from './privateFiles.js';
import { correctiveReviewerChildEnvironment } from './reviewerEnvironment.js';
import { checkCurrentCorrectiveIssuerControl } from './kernelIssuerControl.js';
import { evidenceDigest } from './authority.js';
const SHA = /^[a-f0-9]{40}$/,
  HASH = /^[a-f0-9]{64}$/;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
export interface V56PrivateRequest {
  version: 1;
  sourceRelease: string;
  cases: Array<{ handKey: string; actionOrdinal: number; decisionSha256?: string }>;
  providerRunId: string;
}
export function v56PrivateRequestIsValid(v: unknown): v is V56PrivateRequest {
  return (
    object(v) &&
    Object.keys(v).sort().join(',') === 'cases,providerRunId,sourceRelease,version' &&
    v.version === 1 &&
    typeof v.sourceRelease === 'string' &&
    SHA.test(v.sourceRelease) &&
    typeof v.providerRunId === 'string' &&
    /^[1-9][0-9]{0,19}$/.test(v.providerRunId) &&
    Array.isArray(v.cases) &&
    v.cases.length >= 1 &&
    v.cases.length <= 6 &&
    v.cases.every(
      (c) =>
        object(c) &&
        ['actionOrdinal,handKey', 'actionOrdinal,decisionSha256,handKey'].includes(
          Object.keys(c).sort().join(',')
        ) &&
        typeof c.handKey === 'string' &&
        HASH.test(c.handKey) &&
        Number.isSafeInteger(c.actionOrdinal) &&
        Number(c.actionOrdinal) >= 0 &&
        Number(c.actionOrdinal) <= 4095 &&
        (c.decisionSha256 === undefined ||
          (typeof c.decisionSha256 === 'string' && HASH.test(c.decisionSha256)))
    ) &&
    new Set(v.cases.map((c) => c.handKey + ':' + c.actionOrdinal)).size === v.cases.length
  );
}
/** Full-list ordinal is returned by the maintained binder, never derived from
 * a filtered action list or the first private decision. Caller SHA only narrows. */
export function selectV56AcceptedCases(
  batch: readonly { handKey: string; records: readonly HorseJournalRecord[] }[],
  selectors: V56PrivateRequest['cases']
) {
  return selectors.map((c) => {
    const records = batch.find((h) => h.handKey === c.handKey)?.records;
    if (
      !records ||
      records.length > 256 ||
      reconcileHorseJournalHand(records, c.handKey).status !== 'reconciled'
    )
      throw Error();
    const matches: HorseJournalRecord[] = [];
    for (const hand of records.filter((r) => r.kind === 'accepted_hand'))
      for (const execution of records.filter((r) => r.kind === 'execution')) {
        const w = JSON.parse(execution.body),
          h = JSON.parse(hand.body);
        if (w.executionStatus !== 'intended') continue;
        const bound = bindHorseDecisionToCommittedHand(w, h);
        if (bound.status !== 'bound' || bound.actionOrdinal !== c.actionOrdinal) continue;
        for (const decision of records.filter(
          (r) => r.kind === 'decision' && r.turnKey === execution.turnKey
        )) {
          if (resolveKernelOriginalInput(records, decision, execution, hand).status === 'resolved')
            matches.push(decision);
        }
      }
    if (
      matches.length !== 1 ||
      (c.decisionSha256 !== undefined && matches[0]!.sha256 !== c.decisionSha256)
    )
      throw Error();
    return { decisionSha256: matches[0]!.sha256, records };
  });
}
export function v56PublicReplayIsSanitized(v: unknown, decisions: readonly string[]): boolean {
  if (
    !object(v) ||
    Object.keys(v).sort().join(',') !== 'results,sourceSha256,version' ||
    v.version !== 'horse-v56-private-process-batch-v1' ||
    typeof v.sourceSha256 !== 'string' ||
    !HASH.test(v.sourceSha256) ||
    !Array.isArray(v.results) ||
    v.results.length !== decisions.length
  )
    return false;
  const hashes = ['decisionSha256', 'readFrameSha256', 'onActionSha256', 'offActionSha256'];
  const booleans = [
    'originalExact',
    'originalAccepted',
    'v56Observed',
    'offComputed',
    'sameAdmissions',
    'actionChanged',
    'offAccepted',
    'activationAllowed',
  ];
  return v.results.every((row, i) => {
    if (
      !object(row) ||
      Object.keys(row).sort().join(',') !== 'isolation,result,status,version' ||
      row.version !== 'horse-v56-private-process-v1' ||
      row.status !== 'computed' ||
      !object(row.result) ||
      !object(row.isolation)
    )
      return false;
    const r = row.result,
      iso = row.isolation;
    return (
      Object.keys(r).sort().join(',') ===
        [...hashes, ...booleans, 'version', 'reason'].sort().join(',') &&
      r.version === 'horse-v56-private-counterfactual-v1' &&
      r.decisionSha256 === decisions[i] &&
      hashes.every(
        (k) => r[k] === null || (typeof r[k] === 'string' && HASH.test(r[k] as string))
      ) &&
      booleans.every((k) => typeof r[k] === 'boolean') &&
      r.offAccepted === false &&
      r.activationAllowed === false &&
      [
        'bounds',
        'busy',
        'invalid_records',
        'case_unbound',
        'unsupported_deep',
        'outside_domain',
        'original_v56_off',
        'pins_missing',
        'hand_not_reconciled',
        'execution_unbound',
        'baseline_not_exact',
        'baseline_not_accepted',
        'v56_witness_unavailable',
        'v56_not_observed',
        'off_arm_unavailable',
        'admission_changed',
        'original_mutated',
        'executed_no_difference',
        'causal_application_observed',
      ].includes(String(r.reason)) &&
      Object.keys(iso).sort().join(',') === 'networkAttempts,pid' &&
      Number.isSafeInteger(iso.pid) &&
      Number(iso.pid) > 0 &&
      object(iso.networkAttempts) &&
      Object.keys(iso.networkAttempts).sort().join(',') === 'fetch,socket' &&
      iso.networkAttempts.fetch === 0 &&
      iso.networkAttempts.socket === 0
    );
  });
}
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const git = (args: string[]) =>
  execFileSync('git', ['--no-optional-locks', '-C', root, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: correctiveReviewerChildEnvironment('git'),
  }).trim();
/** Current main is an authenticated provider API response, not input JSON. */
function protectedMain(): string {
  const raw = execFileSync(
    'gh',
    ['api', 'repos/Smarter-Poker/Smarter-Poker-Club-Arena/branches/main'],
    {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: correctiveReviewerChildEnvironment('github'),
    }
  );
  const v: unknown = JSON.parse(raw);
  if (
    !object(v) ||
    v.protected !== true ||
    !object(v.commit) ||
    typeof v.commit.sha !== 'string' ||
    !SHA.test(v.commit.sha)
  )
    throw Error();
  return v.commit.sha;
}
function control(source: string) {
  const main = protectedMain();
  if (!checkCurrentCorrectiveIssuerControl(main)) throw Error();
  git(['merge-base', '--is-ancestor', source, main]);
  // New orchestration must already exist byte-for-byte in the replay source.
  for (const path of [
    'server/src/services/horseCorrectiveReview/v56PrivateReplay.ts',
    'server/src/scripts/horseV56PrivateReplay.ts',
    'server/scripts/phase15-exact-replay.mjs',
  ]) {
    const committed = execFileSync('git', ['-C', root, 'show', source + ':' + path], {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: correctiveReviewerChildEnvironment('git'),
    });
    if (!committed.equals(readFileSync(join(root, path)))) throw Error();
  }
  return main;
}
const inside = (path: string) => {
  const r = relative(realpathSync(root), realpathSync(path));
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};
export async function runV56PrivateReplay(
  mode: string,
  inputPath: string,
  outputPath: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<{ code: number; output: string }> {
  const no = (reason: string) => ({
    version: 1,
    status: 'unavailable',
    reason,
    qualified: false,
    activationAllowed: false,
  });
  let result: Record<string, unknown> = no('private_replay_unavailable');
  try {
    if (
      !['context', 'replay', 'finalize'].includes(mode) ||
      inside(inputPath) ||
      inside(join(outputPath, '..'))
    )
      throw Error();
    try {
      lstatSync(outputPath);
      throw Error('existing_output');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw Error();
    }
    const ingress = readPrivateCorrectiveJson(inputPath, 512 * 1024);
    const request = mode === 'finalize' && object(ingress) ? ingress.request : ingress;
    if (!v56PrivateRequestIsValid(request) || request.providerRunId !== env.GITHUB_RUN_ID)
      throw Error();
    const beforeMain = control(request.sourceRelease);
    const reader = createAuthenticatedHorseJournalReader(env),
      keys = [...new Set(request.cases.map((c) => c.handKey))];
    const before = await reader(mode === 'replay' ? keys : []);
    if (
      !isAuthenticatedHorseJournalBatch(before) ||
      before.sourceRelease !== request.sourceRelease ||
      before.runtime.arch !== 'x64'
    )
      throw Error();
    const instance = (before as unknown as { instanceId?: string }).instanceId;
    if (!instance || !/^[A-Za-z0-9-]{1,100}$/.test(instance)) throw Error();
    if (mode === 'finalize') {
      if (
        !object(ingress) ||
        Object.keys(ingress).sort().join(',') !== 'pending,request' ||
        !object(ingress.pending)
      )
        throw Error();
      const pending = ingress.pending;
      if (
        pending.version !== 1 ||
        pending.qualified !== false ||
        pending.activationAllowed !== false ||
        !['beforeMainSha256', 'custodyDigest', 'instanceSha256', 'sourceSha256'].every(
          (k) => typeof pending[k] === 'string' && HASH.test(pending[k] as string)
        ) ||
        !Array.isArray(pending.decisionDigests) ||
        pending.decisionDigests.length !== request.cases.length ||
        pending.decisionDigests.some((v) => typeof v !== 'string' || !HASH.test(v)) ||
        pending.status !== 'v56_private_replay_pending_postcheck' ||
        pending.providerRunId !== request.providerRunId ||
        pending.sourceSha256 !== createHash('sha256').update(request.sourceRelease).digest('hex') ||
        pending.instanceSha256 !== evidenceDigest(instance) ||
        !v56PublicReplayIsSanitized(pending.replay, pending.decisionDigests as string[]) ||
        Object.keys(pending).sort().join(',') !==
          'activationAllowed,beforeMainSha256,custodyDigest,decisionDigests,instanceSha256,providerRunId,qualified,replay,sourceSha256,status,version'
      )
        throw Error();
      result = {
        ...pending,
        status: 'v56_private_replay_completed',
        postMainSha256: evidenceDigest(beforeMain),
      };
    } else if (mode === 'context')
      result = {
        version: 1,
        status: 'v56_replay_context',
        sourceRelease: before.sourceRelease,
        runtime: before.runtime,
        instanceSha256: evidenceDigest(instance),
        qualified: false,
        activationAllowed: false,
      };
    else {
      if (
        git(['rev-parse', 'HEAD']) !== request.sourceRelease ||
        git(['status', '--porcelain', '--untracked-files=normal']) ||
        before.runtime.node !== process.version ||
        before.runtime.v8 !== process.versions.v8 ||
        before.runtime.arch !== process.arch
      )
        throw Error();
      const cases = selectV56AcceptedCases(before.recordsByHand, request.cases);
      // Second authenticated snapshot is acquired before permanently dropping the
      // job's SSH key. No credential is available to the offline replay child.
      const after = await reader([]);
      if (
        !isAuthenticatedHorseJournalBatch(after) ||
        after.sourceRelease !== before.sourceRelease ||
        (after as unknown as { instanceId?: string }).instanceId !== instance ||
        evidenceDigest(after.runtime) !== evidenceDigest(before.runtime)
      )
        throw Error();
      const key = env.HORSE_REVIEW_SSH_KEY_PATH;
      if (!key) throw Error();
      unlinkSync(key);
      const privateInput = join(outputPath + '.input.json');
      writePrivateCorrectiveResult(
        privateInput,
        JSON.stringify({ version: 1, cases }),
        48 * 1024 * 1024
      );
      try {
        const childEnv: NodeJS.ProcessEnv = { TZ: 'UTC' };
        for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG']) if (env[k]) childEnv[k] = env[k];
        const output = execFileSync(
          process.execPath,
          ['server/scripts/phase15-exact-replay.mjs', '--v56-cases'],
          {
            cwd: root,
            input: readFileSync(privateInput),
            encoding: 'utf8',
            timeout: 210000,
            maxBuffer: 512 * 1024,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: childEnv,
          }
        );
        const parsed: unknown = JSON.parse(output);
        if (
          !v56PublicReplayIsSanitized(
            parsed,
            cases.map((c) => c.decisionSha256)
          ) ||
          !object(parsed) ||
          parsed.sourceSha256 !== createHash('sha256').update(request.sourceRelease).digest('hex')
        )
          throw Error();
        // The maintained CLI validates each closed sanitized child result. Its
        // whole output is committed privately; never raw input or driver errors.
        if (
          git(['rev-parse', 'HEAD']) !== request.sourceRelease ||
          git(['status', '--porcelain', '--untracked-files=normal'])
        )
          throw Error();
        control(request.sourceRelease);
        result = {
          version: 1,
          status: 'v56_private_replay_pending_postcheck',
          providerRunId: request.providerRunId,
          sourceSha256: createHash('sha256').update(request.sourceRelease).digest('hex'),
          instanceSha256: evidenceDigest(instance),
          beforeMainSha256: evidenceDigest(beforeMain),
          custodyDigest: before.batchDigest,
          decisionDigests: cases.map((c) => c.decisionSha256),
          replay: parsed,
          qualified: false,
          activationAllowed: false,
        };
      } finally {
        unlinkSync(privateInput);
      }
    }
  } catch {
    result = no('private_replay_unavailable');
  }
  try {
    writePrivateCorrectiveResult(outputPath, JSON.stringify(result) + '\n', 512 * 1024);
  } catch {
    return { code: 3, output: '{"status":"private_failure"}\n' };
  }
  return {
    code: result.status === 'unavailable' ? 2 : 0,
    output:
      JSON.stringify({ status: result.status, qualified: false, activationAllowed: false }) + '\n',
  };
}
