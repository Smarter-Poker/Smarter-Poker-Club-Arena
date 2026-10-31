import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COHORT = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, 'scripts/ci/fixtures/tournament-recovery20/cohort-membership.json'),
    'utf8'
  )
);
const ORIGIN = 'https://engine.smarter.poker';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Responses stay transient for strict control validation. The sole return
// boundary emits explicit public fields, never a recursively copied receipt.
const SHA = /^[a-f0-9]{40}$/;
const MONEY_HASH = /^[a-f0-9]{32}$/;
const INSTANCE = /^[1-9][0-9]*-[0-9a-f]{8}$/;
const enums =
  (...values) =>
  (value) =>
    values.includes(value);
const uuid = (value) => typeof value === 'string' && UUID.test(value);
const bool = (value) => typeof value === 'boolean';
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const amount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const matches = (pattern) => (value) => typeof value === 'string' && pattern.test(value);
function fields(value, spec) {
  const output = {};
  for (const [key, valid] of Object.entries(spec))
    if (valid(value?.[key])) output[key] = value[key];
  return output;
}
function responseDigest(value) {
  return {
    kind: 'serialized_response_sha256_not_economic_validation',
    sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
  };
}
const publicTuple = {
  operation_id: uuid,
  tournament_id: uuid,
  nonce: uuid,
  current_generation: (v) => v === null || uuid(v),
  quiescence_generation: uuid,
  instance_id: matches(INSTANCE),
  release_sha: matches(SHA),
};
function publicRuntime(value) {
  return {
    ...fields(value, {
      ...publicTuple,
      state: enums('prepared', 'acknowledged', 'stop_requested', 'quiesced', 'settled'),
      abort_fenced: bool,
      custody_certified: bool,
      disposition_committed: bool,
      runtime_retired: bool,
    }),
    response_digest: responseDigest(value),
  };
}
function publicCanonical(value) {
  const output = {
    ...fields(value, {
      ...publicTuple,
      ok: bool,
      state: enums('stop_requested', 'quiesced', 'settled'),
      tournament_status: enums(
        'RUNNING',
        'BREAK',
        'COMPLETED',
        'CANCELLED',
        'REGISTERING',
        'LATE_REG'
      ),
      current_boundary_valid: bool,
      money_hash: matches(MONEY_HASH),
      pending: bool,
    }),
    response_digest: responseDigest(value),
  };
  if (value.receipt === null) output.receipt = null;
  else if (value.receipt && typeof value.receipt === 'object')
    output.receipt = publicSettlement(value.receipt);
  return output;
}
function publicSettlement(value) {
  const output = {
    ...fields(value, {
      ...publicTuple,
      ok: bool,
      success: bool,
      fully_settled: bool,
      receipt_version: (v) => v === 3,
      mode: enums('started_operator_abort'),
      status: enums('CANCELLED'),
      asset: enums('chips', 'diamonds'),
      total_refunded: amount,
      unused_overlay_returned: amount,
      refunded_count: count,
    }),
    response_digest: responseDigest(value),
  };
  if (value?.financial && typeof value.financial === 'object')
    output.financial = fields(value.financial, {
      fully_settled: bool,
      asset: enums('chips', 'diamonds'),
      total_refunded: amount,
      unused_overlay_returned: amount,
    });
  if (value?.quiescence && typeof value.quiescence === 'object')
    output.quiescence = fields(value.quiescence, {
      generation: uuid,
      money_hash: matches(MONEY_HASH),
    });
  return output;
}
function publicResult(result) {
  const output = {
    request: fields(result.request, {
      action: enums('prepare', 'read', 'abort_read', 'abort_ack', 'abort_settle'),
      tournamentId: uuid,
      operationId: uuid,
      nonce: uuid,
      generation: uuid,
      sha: matches(SHA),
      instance: matches(INSTANCE),
      moneyHash: matches(MONEY_HASH),
    }),
    outcome: result.outcome,
  };
  for (const key of ['before', 'after']) {
    if (!result[key]) continue;
    output[key] = fields(result[key], {
      releaseSha: matches(SHA),
      version: matches(/^[a-f0-9]{8}$/),
      instanceId: matches(INSTANCE),
      running: bool,
      status: enums('ok'),
    });
    output[key].maintenance = fields(result[key].maintenance, {
      phase: enums('idle'),
      active: bool,
    });
  }
  for (const key of ['canonicalBefore', 'canonicalAfter'])
    if (result[key]) output[key] = publicCanonical(result[key]);
  if (result.settlement) output.settlement = publicSettlement(result.settlement);
  if (result.runtime) output.runtime = publicRuntime(result.runtime);
  if (result.mutationAcknowledgement === 'unknown') output.mutationAcknowledgement = 'unknown';
  if (result.reason)
    output.reason =
      'Outcome Unknown. Read Same Operation And Canonical Disposition Before Any Repeat';
  return output;
}
export async function controlOriginalRecovery(
  input,
  { fetchImpl = fetch, serviceIdentity, supabaseUrl } = {}
) {
  const abort = ['abort_read', 'abort_ack', 'abort_settle'].includes(input.action);
  const allowed = abort ? COHORT.unchanged_other69 : COHORT.natural_finish_twenty;
  if (
    (!abort && !['prepare', 'read'].includes(input.action)) ||
    !allowed.includes(input.tournamentId) ||
    !UUID.test(input.nonce ?? '') ||
    !UUID.test(input.generation ?? '') ||
    !/^[0-9a-f]{40}$/.test(input.sha ?? '') ||
    input.sha === 'eed06fe51dea622069c661a6213d5b031ff3a9e3' ||
    !/^[1-9][0-9]*-[0-9a-f]{8}$/.test(input.instance ?? '') ||
    !serviceIdentity
  )
    throw Error('Exact Original Recovery Identity And Configured Service Required');
  const result = {
    request: { ...input, operationId: COHORT.original_operation_id },
    outcome: 'unknown',
  };
  async function health() {
    const response = await fetchImpl(`${ORIGIN}/health?original_recovery=${Date.now()}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error('Current Engine Identity Unreadable');
    const value = await response.json();
    if (
      value.releaseSha !== input.sha ||
      value.instanceId !== input.instance ||
      value.version !== input.sha.slice(0, 8) ||
      value.running !== true ||
      value.status !== 'ok' ||
      value.maintenance?.phase !== 'idle' ||
      value.maintenance?.active !== false
    )
      throw Error('Current Engine Identity Or Healthy Release Changed');
    return value;
  }
  try {
    result.before = await health();
    if (abort) {
      const database = new URL(supabaseUrl);
      if (
        database.origin !== 'https://kuklfnapbkmacvwxktbh.supabase.co' ||
        (input.action === 'abort_settle' && !/^[a-f0-9]{32}$/.test(input.moneyHash ?? ''))
      )
        throw Error('Canonical Database Or Reviewed Money Hash Required');
      async function rpc(name, args) {
        const response = await fetchImpl(`${database.origin}/rest/v1/rpc/${name}`, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(30000),
          headers: {
            authorization: `Bearer ${serviceIdentity}`,
            apikey: serviceIdentity,
            'content-type': 'application/json',
          },
          body: JSON.stringify(args),
        });
        if (!response.ok) throw Error('Canonical Operation Readback Not Established');
        return response.json();
      }
      const ids = {
        p_operation_id: COHORT.original_operation_id,
        p_tournament_id: input.tournamentId,
      };
      function canonical(value) {
        if (
          !['stop_requested', 'quiesced', 'settled'].includes(value?.state) ||
          (value.state === 'settled' &&
            (value.tournament_status !== 'CANCELLED' ||
              value.receipt?.receipt_version !== 3 ||
              value.receipt?.fully_settled !== true ||
              value.receipt?.mode !== 'started_operator_abort' ||
              value.receipt?.operation_id !== ids.p_operation_id ||
              value.receipt?.tournament_id !== input.tournamentId)) ||
          value?.ok !== true ||
          value.operation_id !== ids.p_operation_id ||
          value.tournament_id !== input.tournamentId ||
          (value.current_generation !== input.generation &&
            !(
              value.state === 'settled' &&
              value.current_generation === null &&
              value.receipt?.quiescence?.generation === input.generation
            ))
        )
          throw Error('Canonical Original Operation Or Generation Changed');
        return value;
      }
      result.canonicalBefore = canonical(await rpc('fn_ca_tournament_abort_stop_state', ids));
      let mutationAttempted = false;
      try {
        if (input.action === 'abort_ack') {
          mutationAttempted = true;
          const response = await fetchImpl(`${ORIGIN}/admin/tournament-abort-boundary`, {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(30000),
            headers: {
              authorization: `Bearer ${serviceIdentity}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              operationId: COHORT.original_operation_id,
              tournamentId: input.tournamentId,
            }),
          });
          if (!response.ok) throw Error('Abort Boundary Acknowledgement Unknown');
          const body = await response.json();
          if (body.success !== true || body.runtime?.operation_id !== COHORT.original_operation_id)
            throw Error('Abort Boundary Receipt Unknown');
          result.runtime = body.runtime;
        } else if (input.action === 'abort_settle' && result.canonicalBefore.state !== 'settled') {
          if (
            result.canonicalBefore.state !== 'quiesced' ||
            result.canonicalBefore.current_boundary_valid !== true ||
            result.canonicalBefore.quiescence_generation !== input.generation ||
            result.canonicalBefore.money_hash !== input.moneyHash
          )
            throw Error('Reviewed Original Boundary And Money Hash Not Current');
          mutationAttempted = true;
          result.settlement = await rpc('fn_ca_settle_tournament_abort', {
            ...ids,
            p_expected_money_hash: input.moneyHash,
          });
        }
      } catch {
        result.mutationAcknowledgement = 'unknown';
      }
      // This one read is a durable observation, never another mutation/retry.
      result.canonicalAfter = canonical(await rpc('fn_ca_tournament_abort_stop_state', ids));
      result.after = await health();
      if (result.mutationAcknowledgement === 'unknown') return publicResult(result);
      if (input.action === 'abort_read') result.outcome = 'original_abort_readback';
      else if (
        input.action === 'abort_settle' &&
        result.canonicalAfter.state === 'settled' &&
        result.canonicalAfter.tournament_status === 'CANCELLED' &&
        result.canonicalAfter.receipt?.fully_settled === true &&
        result.canonicalAfter.receipt?.mode === 'started_operator_abort' &&
        result.canonicalAfter.receipt?.operation_id === ids.p_operation_id
      )
        result.outcome = mutationAttempted
          ? 'original_abort_settled_readback'
          : 'original_abort_already_settled';
      else if (
        input.action === 'abort_ack' &&
        result.canonicalAfter.current_boundary_valid === true &&
        result.canonicalAfter.quiescence_generation === input.generation
      )
        result.outcome = 'original_abort_boundary_readback';
      else if (
        input.action === 'abort_ack' &&
        result.canonicalAfter.state === 'settled' &&
        result.runtime?.runtime_retired === true
      )
        result.outcome = 'original_abort_runtime_retired';
      return publicResult(result);
    }
    // Exactly one explicit control request; timeout/ACK loss never retries.
    const response = await fetchImpl(`${ORIGIN}/admin/tournament-original-recovery-prepare`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      headers: { authorization: `Bearer ${serviceIdentity}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        operationId: COHORT.original_operation_id,
        tournamentId: input.tournamentId,
        nonce: input.nonce,
        action: input.action,
      }),
    });
    if (!response.ok) throw Error('Preparation Outcome Not Established');
    const body = await response.json();
    const runtime = body.runtime;
    if (
      body.success !== true ||
      runtime?.state !== 'prepared' ||
      runtime.operation_id !== COHORT.original_operation_id ||
      runtime.tournament_id !== input.tournamentId ||
      runtime.nonce !== input.nonce ||
      runtime.current_generation !== input.generation ||
      runtime.instance_id !== input.instance ||
      runtime.release_sha !== input.sha ||
      runtime.abort_fenced !== true ||
      runtime.custody_certified !== false ||
      runtime.disposition_committed !== false
    )
      throw Error('Exact Prepared Runtime Receipt Not Established');
    result.runtime = runtime;
    result.after = await health();
    result.outcome = 'prepared_readback';
    return publicResult(result);
  } catch {
    // Never serialize error/request objects: they can carry authorization.
    result.reason =
      'Outcome Unknown. Read Same Operation And Canonical Disposition Before Any Repeat';
    return publicResult(result);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = {
    action: process.env.RECOVERY_ACTION,
    tournamentId: process.env.RECOVERY_EVENT,
    nonce: process.env.RECOVERY_NONCE,
    generation: process.env.EXPECTED_GENERATION,
    sha: process.env.EXPECTED_ENGINE_SHA,
    instance: process.env.EXPECTED_INSTANCE,
    moneyHash: process.env.EXPECTED_MONEY_HASH,
  };
  const output = process.env.RECOVERY_RECEIPT_PATH;
  if (!output || !path.isAbsolute(output)) throw Error('Owned Absolute Receipt Path Required');
  const result = await controlOriginalRecovery(input, {
    serviceIdentity: process.env.SUPABASE_SERVICE_ROLE_KEY,
    supabaseUrl: process.env.SUPABASE_URL,
  });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(
    JSON.stringify({
      action: input.action,
      tournamentId: input.tournamentId,
      nonce: input.nonce,
      outcome: result.outcome,
    })
  );
  if (result.outcome === 'unknown') process.exitCode = 1;
}
