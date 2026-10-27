#!/usr/bin/env node
/** Offline scientific receipt boundary. No database, activation or release writes.
 * Provider attempt identity is captured before dealing; an incomplete first
 * attempt is visible and recoverable, never replaced according to its result.
 * The locked contract owns statistical/trust/coverage decisions. */
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';

export function featureAblationDealSeed(profileId, seed, pairIndex) {
  if (
    typeof profileId !== 'string' ||
    !profileId ||
    !Number.isSafeInteger(seed) ||
    seed < 0 ||
    !Number.isSafeInteger(pairIndex) ||
    pairIndex < 0
  )
    throw new Error('raw_pair_seed_coordinates');
  return (
    createHash('sha256')
      .update('horse-feature-ablation-deal-v1')
      .update(Buffer.from([0]))
      .update(JSON.stringify([profileId, seed, pairIndex]))
      .digest()
      .readUInt32BE(0) || 1
  );
}

export function rawPairTransportFile(dir) {
  const plain = path.join(dir, 'raw-pairs.jsonl'),
    zipped = plain + '.gz';
  if (existsSync(plain) && existsSync(zipped)) throw new Error('raw_pair_transport_ambiguous');
  return existsSync(zipped) ? zipped : plain;
}

export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hex = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const whole = (value) => Number.isSafeInteger(value) && value >= 0;
const same = (a, b) => canonical(a) === canonical(b);
const fields = [
  'policyDigestsDigest',
  'dependencyDigest',
  'storeInputsDigest',
  'admissionDigest',
  'historyDigest',
];
const sums = () => ({ n: 0, s1: 0n, s2: 0n, s3: 0n, s4: 0n });
function add(s, value) {
  const v = BigInt(value);
  s.n++;
  for (let p = 1; p <= 4; p++) s['s' + p] += v ** BigInt(p);
}
const jsonSums = (s) => ({
  n: s.n,
  s1: String(s.s1),
  s2: String(s.s2),
  s3: String(s.s3),
  s4: String(s.s4),
});

/** Stream pair proofs once, independently rebuilding the runner's statistics
 * and deterministic trace digest. The returned object contains no raw cards. */
export async function readRawPairs(
  file,
  cell,
  { allowIncomplete = false, prefixCounts = [] } = {}
) {
  if (prefixCounts.length > 10 || !prefixCounts.every((n) => whole(n) && n <= cell.pairs))
    throw new Error('raw_pair_prefix_bounds');
  const checkpoints = new Set(prefixCounts),
    prefixDigests = {};
  let interruptionReason = null,
    nonterminalCorruption = false;
  const rawHash = createHash('sha256'),
    pairHash = createHash('sha256'),
    source = createReadStream(file),
    stream = file.endsWith('.gz') ? source.pipe(createGunzip()) : source;
  if (stream !== source) source.on('error', (error) => stream.destroy(error));
  stream.on('data', (bytes) => rawHash.update(bytes));
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0,
    candidateNetCents = 0,
    referenceNetCents = 0,
    changedPairs = 0,
    candidateHeroActionContrastPairs = 0,
    rakeCents = 0,
    bbjCents = 0;
  if (![2, 4, 6].includes(cell.seats)) throw new Error('raw_pair_profile_seats');
  const total = sums(),
    strata = new Map(),
    positions = Array(cell.seats).fill(0);
  try {
    for await (const line of lines) {
      if (interruptionReason) {
        nonterminalCorruption = true;
        continue;
      }
      try {
        if (!line || Buffer.byteLength(line) > 1024 * 1024) throw new Error('raw_pair_line_bounds');
        const r = JSON.parse(line);
        const expectedIndex = cell.firstPair + count,
          heroSeat = (expectedIndex % cell.seats) + 1,
          button = (Math.floor(expectedIndex / cell.seats) % cell.seats) + 1;
        if (
          r.index !== expectedIndex ||
          r.index < cell.firstPair ||
          r.index >= cell.firstPair + cell.pairs
        )
          throw new Error('raw_pair_index_or_range');
        if (r.dealSeed !== featureAblationDealSeed(cell.profileId, cell.seed, expectedIndex))
          throw new Error('raw_pair_crn_mismatch');
        if (
          r.heroSeat !== heroSeat ||
          r.button !== button ||
          r.relativePosition !== (heroSeat - button + cell.seats) % cell.seats ||
          !whole(r.dealSeed) ||
          !whole(r.heroSeat) ||
          !whole(r.button) ||
          !whole(r.relativePosition) ||
          !Number.isSafeInteger(r.candidateNetCents) ||
          !Number.isSafeInteger(r.referenceNetCents) ||
          !Number.isSafeInteger(r.differenceCents) ||
          r.differenceCents !== r.candidateNetCents - r.referenceNetCents ||
          !['preflop', 'flop', 'turn', 'river', 'none'].includes(r.street) ||
          !Array.isArray(r.candidateTrace) ||
          !r.candidateTrace.every((x) => typeof x === 'string') ||
          !Array.isArray(r.referenceTrace) ||
          !r.referenceTrace.every((x) => typeof x === 'string') ||
          !r.candidateFees ||
          !r.referenceFees ||
          !['rake', 'bbj'].every(
            (k) =>
              Number.isFinite(r.candidateFees[k]) &&
              r.candidateFees[k] >= 0 &&
              Number.isFinite(r.referenceFees[k]) &&
              r.referenceFees[k] >= 0
          )
        )
          throw new Error('raw_pair_shape_or_coordinate');
        let divergence = 'none';
        for (let i = 0; i < Math.max(r.candidateTrace.length, r.referenceTrace.length); i++) {
          if (r.candidateTrace[i] === r.referenceTrace[i]) continue;
          divergence = (r.candidateTrace[i] ?? r.referenceTrace[i]).split(':')[3];
          break;
        }
        if (divergence !== r.street || (r.street === 'none' && r.differenceCents !== 0))
          throw new Error('raw_pair_divergence');
        const fees = [
          r.candidateFees.rake,
          r.referenceFees.rake,
          r.candidateFees.bbj,
          r.referenceFees.bbj,
        ].map((value) => Math.round(value * 100));
        if (!fees.every(Number.isSafeInteger)) throw new Error('raw_pair_fee_overflow');
        if (
          !Number.isSafeInteger(rakeCents + fees[0] + fees[1]) ||
          !Number.isSafeInteger(bbjCents + fees[2] + fees[3])
        )
          throw new Error('raw_pair_fee_total_overflow');
        if (
          !Number.isSafeInteger(candidateNetCents + r.candidateNetCents) ||
          !Number.isSafeInteger(referenceNetCents + r.referenceNetCents)
        )
          throw new Error('raw_pair_total_overflow');
        if (count >= cell.pairs) throw new Error('raw_pair_count_overflow');
        count++;
        add(total, r.differenceCents);
        const key = r.relativePosition + '|' + r.street,
          stratum = strata.get(key) ?? sums();
        add(stratum, r.differenceCents);
        strata.set(key, stratum);
        positions[r.relativePosition] = (positions[r.relativePosition] ?? 0) + 1;
        rakeCents += fees[0] + fees[1];
        bbjCents += fees[2] + fees[3];
        candidateNetCents += r.candidateNetCents;
        referenceNetCents += r.referenceNetCents;
        changedPairs += Number(r.street !== 'none');
        const heroAction = new RegExp(`^${r.heroSeat}:(fold|check|call|bet|raise|all_in):`);
        candidateHeroActionContrastPairs += Number(
          JSON.stringify(r.candidateTrace.filter((a) => heroAction.test(a))) !==
            JSON.stringify(r.referenceTrace.filter((a) => heroAction.test(a)))
        );
        pairHash.update(
          JSON.stringify([
            r.index,
            r.dealSeed,
            r.heroSeat,
            r.button,
            r.candidateNetCents,
            r.referenceNetCents,
            r.candidateTrace,
            r.referenceTrace,
            r.candidateFees.rake,
            r.referenceFees.rake,
            r.candidateFees.bbj,
            r.referenceFees.bbj,
          ]) + '\n'
        );
        if (checkpoints.has(count)) prefixDigests[String(count)] = pairHash.copy().digest('hex');
      } catch (error) {
        const code =
          error instanceof SyntaxError
            ? 'raw_pair_json_invalid'
            : /^raw_pair_[a-z_]+$/.test(error.message)
              ? error.message
              : 'raw_pair_invalid_record';
        if (!allowIncomplete) throw new Error(code);
        interruptionReason = code;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
    source.destroy();
  }
  return {
    interruptionReason,
    nonterminalCorruption,
    prefixDigests,
    rawPairsSha256: rawHash.digest('hex'),
    rawPairCount: count,
    pairDigest: pairHash.digest('hex'),
    sums: jsonSums(total),
    strata: Object.fromEntries([...strata].sort().map(([k, v]) => [k, jsonSums(v)])),
    positionCounts: positions,
    candidateNetCents,
    referenceNetCents,
    changedPairs,
    candidateHeroActionContrastPairs,
    rakeCents,
    bbjCents,
  };
}
export const operationId = (o) => `${o.providerRunId}:${o.runAttempt}:${o.jobId}`;
function operationReasons(o) {
  if (
    !o ||
    !/^\d+$/.test(String(o.providerRunId)) ||
    !/^\d+$/.test(String(o.jobId)) ||
    !Number.isSafeInteger(o.runAttempt) ||
    o.runAttempt < 1 ||
    !Number.isSafeInteger(o.attemptOrdinal) ||
    o.attemptOrdinal < 1 ||
    typeof o.createdAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(o.createdAt) ||
    !Number.isFinite(Date.parse(o.createdAt)) ||
    !['job.created_at', 'run.created_at'].includes(o.createdAtSource) ||
    typeof o.firstOperationId !== 'string'
  )
    return ['operation_identity'];
  return [];
}
function scientific(receipt) {
  const { operation, execution, ...body } = receipt;
  const { durationMs, ...result } = body.result;
  return { ...body, result };
}

/** Attempts are wrapper metadata plus original receiptText and independently
 * computed rawEvidence. Missing/failed attempts remain in the returned record.
 * summarize and validateCell are imported from the evaluated locked contract
 * by the provider entry point; no configurable callback is accepted there. */
export function assembleFeatureAblation({
  plan,
  planDigest,
  sourceSha,
  attempts,
  authorizedOperations,
  validateCell,
  summarize,
}) {
  const reasons = [],
    retained = [],
    selected = [];
  const refuse = (reason) => {
    reasons.push(reason);
  };
  if (
    plan?.state !== 'heldout_locked' ||
    !hex(planDigest) ||
    !/^([0-9a-f]{40})$/.test(sourceSha ?? '') ||
    !plan.target ||
    !Array.isArray(plan.matrix) ||
    !plan.matrix.length ||
    plan.matrix.length > 256 ||
    !Number.isSafeInteger(plan.maxAttempts) ||
    plan.maxAttempts < 1 ||
    plan.maxAttempts > 10 ||
    !Array.isArray(plan.heldoutSeeds) ||
    plan.heldoutSeeds.length !== 3 ||
    new Set(plan.heldoutSeeds).size !== 3 ||
    !Array.isArray(plan.criticalCells) ||
    !plan.criticalCells.length ||
    !Array.isArray(plan.profiles) ||
    !plan.profiles.length ||
    !plan.profiles.every((p) => p && p.id && Number.isFinite(p.weight) && p.weight > 0) ||
    !fields.every((f) => hex(plan[f])) ||
    typeof validateCell !== 'function' ||
    typeof summarize !== 'function'
  )
    return {
      schema: 'horse-feature-ablation-assembly-v1',
      qualified: false,
      activationAllowed: false,
      reasons: ['unlocked_or_invalid_plan'],
      attempts: [],
      selected: [],
    };
  const cells = new Map();
  for (const c of plan.matrix) {
    if (
      !c?.key ||
      cells.has(c.key) ||
      !plan.profiles.some((p) => p.id === c.profileId) ||
      !plan.heldoutSeeds.includes(c.seed) ||
      !whole(c.firstPair) ||
      !whole(c.pairs) ||
      c.pairs === 0 ||
      !whole(c.shard)
    )
      refuse('invalid_matrix_cell');
    if (c?.key) cells.set(c.key, c);
  }
  const ranges = new Map();
  for (const c of cells.values()) {
    const k = c.profileId + '|' + c.seed;
    const a = ranges.get(k) ?? [];
    a.push(c);
    ranges.set(k, a);
  }
  for (const p of plan.profiles)
    for (const seed of plan.heldoutSeeds) {
      const a = (ranges.get(p.id + '|' + seed) ?? []).sort((x, y) => x.firstPair - y.firstPair);
      let end = 0;
      if (!a.length) refuse('missing_profile_seed');
      for (let i = 0; i < a.length; i++) {
        if (a[i].firstPair !== end || a[i].shard !== i) refuse('overlap_or_gap');
        end = a[i].firstPair + a[i].pairs;
      }
    }
  if (!Array.isArray(authorizedOperations) || !authorizedOperations.length)
    refuse('missing_provider_attempt_inventory');
  if (reasons.length)
    return {
      schema: 'horse-feature-ablation-assembly-v1',
      qualified: false,
      activationAllowed: false,
      reasons,
      attempts: [],
      selected: [],
    };
  const expected = new Map();
  for (const a of authorizedOperations) {
    if (
      !cells.has(a.cellKey) ||
      operationReasons(a.operation).length ||
      expected.has(operationId(a.operation))
    )
      refuse('invalid_provider_attempt_inventory');
    else expected.set(operationId(a.operation), a);
  }
  const byCell = new Map(),
    observed = new Set();
  for (const a of attempts ?? []) {
    const metadata = {
      artifact: a.artifactName ?? null,
      cellKey: a.cellKey,
      operation: a.operation,
      exitCode: a.exitCode,
      rawProofError: a.rawProofError ?? null,
      rawInterruption: a.rawEvidence?.interruptionReason ?? null,
      validRawPrefixPairs: a.rawEvidence?.rawPairCount ?? null,
      receiptSha256: typeof a.receiptText === 'string' ? sha256(a.receiptText) : null,
    };
    retained.push(metadata);
    if (
      !cells.has(a.cellKey) ||
      operationReasons(a.operation).length ||
      (!Number.isInteger(a.exitCode) && a.exitCode !== null)
    ) {
      refuse('unknown_cell_or_attempt_identity');
      continue;
    }
    const authorized = expected.get(operationId(a.operation));
    if (
      !authorized ||
      authorized.cellKey !== a.cellKey ||
      !same(authorized.operation, a.operation)
    ) {
      refuse('unauthorized_provider_attempt:' + a.cellKey);
      continue;
    }
    if (
      a.exitCode === null &&
      !(
        authorized.providerStatus === 'completed' &&
        ['cancelled', 'failure', 'timed_out', 'startup_failure'].includes(
          authorized.providerConclusion
        )
      )
    ) {
      refuse('unknown_attempt_outcome:' + a.cellKey);
      continue;
    }
    observed.add(operationId(a.operation));
    if (a.rawProofError) {
      refuse('raw_pair_transport_or_proof_error:' + a.cellKey);
      continue;
    }
    const id = a.identity;
    if (
      !id ||
      id.planDigest !== planDigest ||
      id.target !== plan.target ||
      id.sourceSha !== sourceSha ||
      !fields.every((f) => id[f] === plan[f]) ||
      !same(id.cell, cells.get(a.cellKey))
    ) {
      refuse('attempt_binding:' + a.cellKey);
      continue;
    }
    const list = byCell.get(a.cellKey) ?? [];
    list.push(a);
    byCell.set(a.cellKey, list);
  }
  for (const id of expected.keys())
    if (!observed.has(id)) refuse('missing_authorized_attempt_artifact:' + id);
  for (const [key, cell] of cells) {
    const list = byCell.get(key) ?? [];
    list.sort(
      (a, b) =>
        a.operation.runAttempt - b.operation.runAttempt ||
        Date.parse(a.operation.createdAt) - Date.parse(b.operation.createdAt) ||
        a.operation.attemptOrdinal - b.operation.attemptOrdinal ||
        operationId(a.operation).localeCompare(operationId(b.operation))
    );
    if (!list.length) {
      refuse('missing_cell:' + key);
      continue;
    }
    const first = list[0],
      root = operationId(first.operation),
      unique = [];
    for (const a of list) {
      const prior = unique.find((x) => operationId(x.operation) === operationId(a.operation));
      if (prior) {
        if (
          a.receiptText !== prior.receiptText ||
          !same(a.rawEvidence, prior.rawEvidence) ||
          !same(a.operation, prior.operation) ||
          a.exitCode !== prior.exitCode
        )
          refuse('conflicting_duplicate_attempt:' + key);
        continue;
      }
      unique.push(a);
    }
    if (
      unique.some(
        (a) =>
          a.operation.providerRunId !== first.operation.providerRunId ||
          a.operation.runAttempt > plan.maxAttempts
      )
    )
      refuse('owning_operation_or_attempt_bound:' + key);
    if (
      first.operation.attemptOrdinal !== 1 ||
      unique.some((a) => a.operation.firstOperationId !== root)
    )
      refuse('first_authorized_attempt_identity:' + key);
    let accepted = null,
      acceptedEvidence = null;
    for (let i = 0; i < unique.length; i++) {
      const a = unique[i];
      let r;
      if (a.operation.attemptOrdinal !== i + 1) refuse('missing_attempt_history:' + key);
      if (
        i > 0 &&
        (a.operation.recoveryOf !== operationId(unique[i - 1].operation) ||
          typeof a.operation.recoveryReason !== 'string' ||
          !a.operation.recoveryReason.trim())
      )
        refuse('unexplained_recovery:' + key);
      if (!a.receiptText) continue;
      try {
        r = JSON.parse(a.receiptText);
      } catch {
        if (a.exitCode === 0) refuse('malformed_receipt:' + key);
        continue;
      }
      if (
        r.schema !== 'horse-feature-ablation-cell-v1' ||
        r.mode !== 'contract' ||
        r.planDigest !== planDigest ||
        r.target !== plan.target ||
        r.cellKey !== key ||
        r.sourceSha !== sourceSha ||
        !same(r.operation, a.operation) ||
        !fields.every((f) => r[f] === plan[f])
      ) {
        refuse('receipt_binding:' + key);
        continue;
      }
      if (r.execution !== undefined) {
        const e = r.execution;
        if (
          !e ||
          typeof e !== 'object' ||
          Array.isArray(e) ||
          !same(Object.keys(e).sort(), [
            'sampledWorkerReceipts',
            'workerReceiptCount',
            'workerReceiptSha256',
          ]) ||
          !hex(e.workerReceiptSha256) ||
          !whole(e.workerReceiptCount) ||
          !Array.isArray(e.sampledWorkerReceipts) ||
          e.sampledWorkerReceipts.length > 8 ||
          e.sampledWorkerReceipts.length > e.workerReceiptCount ||
          !e.sampledWorkerReceipts.every(
            (sample) =>
              sample &&
              typeof sample === 'object' &&
              !Array.isArray(sample) &&
              Buffer.byteLength(JSON.stringify(sample)) <= 65536
          )
        ) {
          refuse('execution_metadata_shape:' + key);
          continue;
        }
      }
      for (const counter of [
        'illegalActions',
        'conservationErrors',
        'cardErrors',
        'settlementMismatches',
        'deductionMismatches',
        'pairedReplayMismatches',
        'protocolErrors',
        'brainExceptions',
      ]) {
        const observed = r.result?.[counter];
        if (
          observed !== undefined &&
          observed !== null &&
          (!Number.isSafeInteger(observed) || observed !== 0)
        )
          refuse('observed_integrity_violation:' + key + ':' + counter);
      }
      if (a.exitCode !== 0 || r.result?.complete !== true) continue;
      if (!Number.isFinite(r.result.durationMs) || r.result.durationMs < 0) {
        refuse('execution_duration_shape:' + key);
        continue;
      }
      const raw = a.rawEvidence;
      if (
        !raw ||
        !hex(raw.rawPairsSha256) ||
        r.rawPairsSha256 !== raw.rawPairsSha256 ||
        r.rawPairCount !== raw.rawPairCount ||
        raw.rawPairCount !== cell.pairs ||
        ![
          'pairDigest',
          'sums',
          'strata',
          'candidateNetCents',
          'referenceNetCents',
          'changedPairs',
          'candidateHeroActionContrastPairs',
          'rakeCents',
          'bbjCents',
        ].every((f) => same(r.result[f], raw[f])) ||
        !same(r.result.positionCounts, raw.positionCounts)
      ) {
        refuse('raw_pair_proof:' + key);
        continue;
      }
      let cellReasons;
      try {
        cellReasons = validateCell(plan, cell, r);
      } catch {
        cellReasons = ['contract_validator_exception'];
      }
      if (!Array.isArray(cellReasons) || cellReasons.length) {
        refuse('contract_cell_refusal:' + key + ':' + canonical(cellReasons));
        continue;
      }
      if (!accepted) {
        accepted = r;
        acceptedEvidence = raw;
      } else if (!same(scientific(accepted), scientific(r)))
        refuse('conflicting_complete_replay:' + key);
    }
    for (const a of unique) {
      const prefix = a.rawEvidence;
      if (prefix?.nonterminalCorruption) refuse('raw_nonterminal_corruption:' + key);
      if (prefix?.interruptionReason && prefix.interruptionReason !== 'raw_pair_json_invalid')
        refuse('observed_raw_integrity_violation:' + key + ':' + prefix.interruptionReason);
      if (!accepted || !prefix || prefix.rawPairCount === 0) continue;
      let complete = false;
      try {
        complete = a.exitCode === 0 && JSON.parse(a.receiptText).result?.complete === true;
      } catch {}
      if (
        !complete &&
        acceptedEvidence.prefixDigests?.[String(prefix.rawPairCount)] !== prefix.pairDigest
      )
        refuse('conflicting_incomplete_prefix:' + key);
    }
    if (!accepted) refuse('no_complete_cell:' + key);
    else selected.push(accepted);
  }
  let summary = null;
  if (!reasons.length) {
    try {
      summary = summarize(plan, selected);
    } catch {
      refuse('contract_summary_exception');
    }
    if (!summary || typeof summary.qualified !== 'boolean') refuse('invalid_contract_summary');
  }
  return {
    schema: 'horse-feature-ablation-assembly-v1',
    target: plan.target,
    planDigest,
    sourceSha,
    qualified: reasons.length === 0 && summary?.qualified === true,
    activationAllowed: false,
    reasons,
    summary,
    attempts: retained,
    selected: selected.map((r) => ({
      cellKey: r.cellKey,
      operation: r.operation,
      receiptSha256: sha256(canonical(r)),
      rawPairsSha256: r.rawPairsSha256,
    })),
  };
}

/** Derive authorization order from provider jobs, never result completion time. */
export function providerOperations(jobs, run, matrix) {
  const keys = new Set(matrix.map((c) => c.key)),
    byCell = new Map(),
    ids = new Set();
  for (const j of jobs) {
    if (typeof j.name !== 'string' || !j.name.startsWith('Cell ')) continue;
    const cellKey = j.name.slice(5);
    if (
      !keys.has(cellKey) ||
      String(j.run_id) !== String(run.id) ||
      !Number.isSafeInteger(j.run_attempt) ||
      j.run_attempt < 1 ||
      ids.has(String(j.id))
    )
      throw new Error('provider_job_binding');
    const createdAt = j.created_at ?? run.created_at;
    if (!Number.isFinite(Date.parse(createdAt))) throw new Error('provider_created_at_unavailable');
    ids.add(String(j.id));
    const a = byCell.get(cellKey) ?? [];
    a.push({ j, createdAt, createdAtSource: j.created_at ? 'job.created_at' : 'run.created_at' });
    byCell.set(cellKey, a);
  }
  const output = [];
  for (const [cellKey, entries] of byCell) {
    entries.sort(
      (a, b) =>
        a.j.run_attempt - b.j.run_attempt ||
        Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
        String(a.j.id).localeCompare(String(b.j.id))
    );
    if (new Set(entries.map((e) => e.j.run_attempt)).size !== entries.length)
      throw new Error('provider_ambiguous_cell_job');
    const root = `${run.id}:${entries[0].j.run_attempt}:${entries[0].j.id}`;
    entries.forEach((e, i) =>
      output.push({
        cellKey,
        providerStatus: e.j.status,
        providerConclusion: e.j.conclusion,
        operation: {
          providerRunId: String(run.id),
          runAttempt: e.j.run_attempt,
          jobId: String(e.j.id),
          createdAt: e.createdAt,
          createdAtSource: e.createdAtSource,
          attemptOrdinal: i + 1,
          firstOperationId: root,
          ...(i
            ? {
                recoveryOf: `${run.id}:${entries[i - 1].j.run_attempt}:${entries[i - 1].j.id}`,
                recoveryReason: `provider replay after prior job ${entries[i - 1].j.conclusion ?? entries[i - 1].j.status}; unchanged registered source and pair range`,
              }
            : {}),
        },
      })
    );
  }
  return output;
}

function argumentsFor(argv) {
  const out = {};
  const allowed = new Set([
    'prepare',
    'finish',
    'assemble',
    'target',
    'source-sha',
    'cell',
    'output',
    'runs',
    'exit-code',
  ]);
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m || !allowed.has(m[1]) || Object.hasOwn(out, m[1]))
      throw new Error('unknown_or_duplicate_argument');
    out[m[1]] = m[2] ?? true;
  }
  if (['prepare', 'finish', 'assemble'].filter((k) => out[k] === true).length !== 1)
    throw new Error('one_command_required');
  return out;
}
const jsonFile = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value, flag = 'w') =>
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag });
async function providerState() {
  const repo = process.env.GITHUB_REPOSITORY,
    runId = process.env.GITHUB_RUN_ID,
    attempt = Number(process.env.GITHUB_RUN_ATTEMPT),
    token = process.env.GITHUB_TOKEN;
  if (
    repo !== 'Smarter-Poker/Smarter-Poker-Club-Arena' ||
    !/^\d+$/.test(runId ?? '') ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    attempt > 10 ||
    !token
  )
    throw new Error('provider_metadata_unavailable');
  const get = async (suffix) => {
    const response = await fetch(`https://api.github.com/repos/${repo}${suffix}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error('provider_read_refused:' + response.status);
    return response.json();
  };
  const run = await get(`/actions/runs/${runId}`);
  if (
    String(run.id) !== runId ||
    run.event !== 'workflow_dispatch' ||
    run.head_branch !== 'main' ||
    run.path !== '.github/workflows/horse-feature-ablation-qualification.yml'
  )
    throw new Error('provider_workflow_identity');
  const jobs = [];
  for (let a = 1; a <= attempt; a++)
    for (let page = 1; page <= 20; page++) {
      const result = await get(
        `/actions/runs/${runId}/attempts/${a}/jobs?per_page=100&page=${page}`
      );
      if (!Array.isArray(result.jobs)) throw new Error('provider_jobs_unreadable');
      jobs.push(...result.jobs);
      if (result.jobs.length < 100) break;
      if (page === 20) throw new Error('provider_jobs_page_bound');
    }
  return { run, jobs, observedAt: new Date().toISOString(), currentAttempt: attempt };
}
function sourceAuthority(sourceSha) {
  if (
    !/^[0-9a-f]{40}$/.test(sourceSha ?? '') ||
    process.env.GITHUB_REF !== 'refs/heads/main' ||
    process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
  )
    throw new Error('protected_manual_source_required');
  const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const gitEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
  );
  const git = (...args) =>
    execFileSync('git', args, { cwd: server, env: gitEnv, encoding: 'utf8' }).trim();
  if (
    git('rev-parse', 'HEAD') !== sourceSha ||
    git('status', '--porcelain', '--untracked-files=no')
  )
    throw new Error('evaluated_source_dirty_or_changed');
  git('merge-base', '--is-ancestor', sourceSha, 'origin/main');
  return server;
}
async function lockedContract(target, sourceSha, cell, assembling = false) {
  if (
    ![
      'plo6_v24',
      'v53_pressure',
      'combo_draw_pressure',
      'targeted_river_bluff',
      'river_position_defense',
      'river_bluff_checkraise',
      'barrel_continuation_outlook',
      'pressure_package',
    ].includes(target)
  )
    throw new Error('unknown_target');
  const server = sourceAuthority(sourceSha),
    contract = await import(
      pathToFileURL(path.join(server, 'src/benchmark/FeatureAblationQualification.ts')).href
    );
  const plan = await contract.qualificationPlan(target),
    planDigest = contract.qualificationPlanDigest(plan);
  if (
    plan.state !== 'heldout_locked' ||
    plan.target !== target ||
    !hex(planDigest) ||
    !Array.isArray(plan.matrix) ||
    !plan.matrix.length ||
    plan.matrix.length > 256
  )
    throw new Error('heldout_contract_not_locked');
  if (
    !Number.isSafeInteger(plan.maxAttempts) ||
    plan.maxAttempts < 1 ||
    plan.maxAttempts > 10 ||
    Number(process.env.GITHUB_RUN_ATTEMPT) > plan.maxAttempts
  )
    throw new Error('contract_attempt_bound');
  let familyCustody;
  if (plan.schema === 'horse-incremental-ablation-plan-v2') {
    const incremental = await import(
      pathToFileURL(path.join(server, 'src/benchmark/IncrementalPressureQualification.ts')).href
    );
    familyCustody = await incremental.authenticateIncrementalPlan(plan, cell, assembling);
  }
  return { contract, plan, planDigest, familyCustody };
}
async function main(argv) {
  const args = argumentsFor(argv),
    out = path.resolve(String(args.output ?? ''));
  if (!args.output) throw new Error('output_required');
  if (args.finish) {
    const file = path.join(out, 'attempt.json'),
      a = jsonFile(file),
      code = Number(args['exit-code']);
    if (!Number.isInteger(code) || code < 0 || code > 255) throw new Error('exit_code_required');
    a.exitCode = code;
    a.finishedAt = new Date().toISOString();
    writeJson(file, a);
    return;
  }
  const sourceSha = args['source-sha'],
    { contract, plan, planDigest, familyCustody } = await lockedContract(
      args.target,
      sourceSha,
      args.cell,
      args.assemble === true
    );
  const provider = await providerState(),
    authorizedOperations = providerOperations(provider.jobs, provider.run, plan.matrix);
  mkdirSync(out, { recursive: true });
  writeJson(path.join(out, 'jobs.json'), {
    ...provider,
    ...(familyCustody ? { familyCustody } : {}),
  });
  if (args.prepare) {
    const cell = plan.matrix.find((c) => c.key === args.cell);
    if (!cell) throw new Error('unknown_contract_cell');
    const matches = authorizedOperations.filter(
      (a) => a.cellKey === cell.key && a.operation.runAttempt === provider.currentAttempt
    );
    if (matches.length !== 1) throw new Error('current_provider_job_missing_or_ambiguous');
    const operation = matches[0].operation;
    writeJson(
      path.join(out, 'attempt.json'),
      {
        schema: 'horse-feature-ablation-attempt-v1',
        cellKey: cell.key,
        operation,
        exitCode: null,
        startedAt: new Date().toISOString(),
        identity: {
          planDigest,
          target: plan.target,
          sourceSha,
          ...Object.fromEntries(fields.map((f) => [f, plan[f]])),
          cell,
        },
      },
      'wx'
    );
    return;
  }
  if (!args.runs) throw new Error('runs_required');
  const runs = path.resolve(String(args.runs)),
    attempts = [];
  if (plan.schema === 'horse-incremental-ablation-plan-v2') {
    const { authenticateFeatureArtifacts } =
      await import('./feature-ablation-artifact-custody.mjs');
    await authenticateFeatureArtifacts(runs, plan.target, provider.run.id);
  }
  // Read metadata first, then incomplete prefixes, then complete runs. Each
  // raw file is streamed once; prior valid-row counts become hash checkpoints.
  const records = readdirSync(runs)
    .sort()
    .map((name) => {
      const dir = path.join(runs, name);
      if (!statSync(dir).isDirectory() || !/^fa-[a-z0-9_-]+-a[1-9][0-9]*$/.test(name))
        throw new Error('unexpected_attempt_artifact');
      const a = jsonFile(path.join(dir, 'attempt.json'));
      const receiptFile = path.join(dir, 'result.json'),
        rawFile = rawPairTransportFile(dir);
      const receiptText = existsSync(receiptFile) ? readFileSync(receiptFile, 'utf8') : null;
      let complete = false;
      try {
        complete = a.exitCode === 0 && JSON.parse(receiptText).result?.complete === true;
      } catch {}
      return { a, name, rawFile, receiptText, complete };
    });
  const prefixCounts = new Map();
  for (const complete of [false, true])
    for (const r of records.filter((r) => r.complete === complete)) {
      const { a, name, rawFile, receiptText } = r;
      const cell = plan.matrix.find((c) => c.key === a.cellKey),
        profile = plan.profiles.find((p) => p.id === cell?.profileId);
      let rawEvidence = null,
        rawProofError = null;
      try {
        rawEvidence =
          existsSync(rawFile) && cell && profile
            ? await readRawPairs(
                rawFile,
                { ...cell, seats: profile.seats },
                {
                  allowIncomplete: !complete,
                  prefixCounts: [...(prefixCounts.get(a.cellKey) ?? [])],
                }
              )
            : null;
      } catch (error) {
        rawProofError = error.message;
      }
      if (!complete && rawEvidence?.rawPairCount) {
        const counts = prefixCounts.get(a.cellKey) ?? new Set();
        counts.add(rawEvidence.rawPairCount);
        prefixCounts.set(a.cellKey, counts);
      }
      attempts.push({ ...a, artifactName: name, receiptText, rawEvidence, rawProofError });
    }
  const assembly = assembleFeatureAblation({
    plan,
    planDigest,
    sourceSha,
    attempts,
    authorizedOperations,
    validateCell: contract.validateFeatureAblationCell,
    summarize: contract.summarizeFeatureAblationQualification,
  });
  sourceAuthority(sourceSha);
  writeJson(path.join(out, 'assembly.json'), {
    ...assembly,
    provider: {
      runId: String(provider.run.id),
      workflowControlSha: provider.run.head_sha,
      attemptsThrough: provider.currentAttempt,
      inventorySha256: sha256(canonical(provider)),
      rawArtifactsRetained: true,
      ...(familyCustody ? { familyCustody } : {}),
    },
  });
  if (assembly.reasons.length) process.exitCode = 2;
  console.log(
    JSON.stringify({
      qualified: assembly.qualified,
      activationAllowed: false,
      reasons: assembly.reasons,
      scope: 'registered after-rake flag contrast only',
    })
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((error) => {
    console.error('Feature ablation assembly refused: ' + error.message);
    process.exitCode = 2;
  });
