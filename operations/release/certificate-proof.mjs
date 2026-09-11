#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicReleaseJSON } from './engine-readiness.mjs';
import { operationPolicyDigest } from './operation-policy.mjs';
import { certificateAuthority } from './certification-client.mjs';
import {
  validateComponentRequest,
  certificateReports,
  reportFact,
  reportsPassed,
  sameFacts,
} from './component-certificate.mjs';

const need = (v) => {
  if (!v) throw new Error('RELEASE_CERTIFICATE_PROOF_REFUSED');
};
export function certificateRequest(request, operation, env) {
  if (request?.certificate_version === 2) return validateComponentRequest(request, operation, env);
  need(
    /^[0-9a-f-]{36}$/.test(operation) &&
      request?.phase === 'CERTIFY' &&
      request.repository === env.GITHUB_REPOSITORY &&
      request.control_sha === env.GITHUB_SHA &&
      /^[0-9a-f]{40}$/.test(request.source_sha) &&
      /^[0-9a-f]{40}$/.test(request.frontend_source_sha) &&
      /^[0-9a-f]{64}$/.test(request.manifest_digest) &&
      /^sha256:[0-9a-f]{64}$/.test(request.artifact_image_id) &&
      request.target === 'club-arena-engine' &&
      request.operation_policy_digest === operationPolicyDigest
  );
}
export async function certificateSnapshot(request, publicJSON = publicReleaseJSON) {
  const engine = await publicJSON('https://engine.smarter.poker/health');
  const origin = await publicJSON('https://ca-static.smarter.poker/build-info.json');
  const website = await publicJSON('https://smarter.poker/hub/club-arena/build-info.json');
  need(
    engine.running === true &&
      engine.liveness === 'ok' &&
      engine.releaseSha === request.source_sha &&
      /^[1-9][0-9]*-[0-9a-f]{8}$/.test(engine.instanceId) &&
      origin.ca_sha === request.frontend_source_sha &&
      website.ca_sha === request.frontend_source_sha &&
      engine.maintenance?.policyVersion === 2 &&
      engine.maintenance.policyDigest === operationPolicyDigest &&
      typeof engine.maintenance.activationReceipt === 'string' &&
      engine.maintenance.activationReceipt.length > 0
  );
  if (request.maintenance_operation_id)
    need(
      engine.maintenance.operation?.operationId === request.maintenance_operation_id &&
        engine.maintenance.operation.phase === 'resumed'
    );
  return {
    engine_instance: engine.instanceId,
    source_sha: engine.releaseSha,
    frontend_source_sha: origin.ca_sha,
    maintenance_activation_receipt: engine.maintenance.activationReceipt,
    observed_at: new Date().toISOString(),
  };
}
export async function certificateProof({
  phase,
  request,
  operation,
  env,
  directory,
  publicJSON,
  authority = certificateAuthority,
  reportDirectory = 'e2e-report',
}) {
  certificateRequest(request, operation, env);
  await mkdir(directory, { recursive: true });
  if (request.certificate_version === 2) {
    need(env.GITHUB_RUN_ATTEMPT === '1');
    if (phase === 'start') {
      const current = await authority({ action: 'snapshot' }, { environment: env });
      need(
        current.operation_id === operation &&
          current.run_id === env.GITHUB_RUN_ID &&
          current.run_attempt === 1 &&
          sameFacts(current.served_components, request.component_tuple)
      );
      await writeFile(
        path.join(directory, 'start.json'),
        JSON.stringify({ operation, request, current }),
        { flag: 'wx' }
      );
      return current;
    }
    need(phase === 'finish');
    const reports = await Promise.all(
      certificateReports.map(async (name) => {
        try {
          return reportFact(name, await readFile(path.join(reportDirectory, `${name}.json`)));
        } catch {
          return { name, complete: false, missing_or_unreadable: true };
        }
      })
    );
    let start, current, cleanup;
    try {
      start = JSON.parse(await readFile(path.join(directory, 'start.json'), 'utf8'));
    } catch {
      /* retained failure */
    }
    try {
      cleanup = JSON.parse(await readFile(path.join(directory, 'cleanup.json'), 'utf8'));
    } catch {
      /* unresolved cleanup */
    }
    try {
      current = await authority({ action: 'snapshot' }, { environment: env });
    } catch {
      /* changed/unreadable is red */
    }
    const cleanupComplete =
      cleanup?.operation_id === operation &&
      cleanup?.run_id === env.GITHUB_RUN_ID &&
      cleanup.run_attempt === 1 &&
      typeof cleanup.cleanup_receipt === 'string';
    const unchanged = Boolean(
      start?.operation === operation &&
      sameFacts(start.request, request) &&
      current &&
      sameFacts(start.current.served_components, request.component_tuple) &&
      sameFacts(current.served_components, request.component_tuple) &&
      start.current.engine_instance === current.engine_instance &&
      start.current.maintenance_activation_receipt === current.maintenance_activation_receipt
    );
    const success =
      env.CERTIFICATE_JOB_STATUS === 'success' &&
      env.CERTIFICATE_HONESTY === 'success' &&
      env.CERTIFICATE_UNCHANGED === 'success' &&
      env.CERTIFICATE_CLEANUP === 'success' &&
      reportsPassed(reports) &&
      cleanupComplete &&
      unchanged;
    const proof = {
      certificate_version: 2,
      operation_id: operation,
      request,
      control_sha: env.GITHUB_SHA,
      run_id: env.GITHUB_RUN_ID,
      run_attempt: 1,
      success,
      cleanup_complete: cleanupComplete,
      cleanup_receipt: cleanup?.cleanup_receipt ?? null,
      unchanged_release: unchanged,
      served_components: current?.served_components ?? null,
      engine_instance: current?.engine_instance ?? null,
      reports,
      started_at: start?.current?.observed_at ?? null,
      completed_at: new Date().toISOString(),
    };
    // A red receipt is retained too. A missing cleanup receipt cannot be promoted
    // by the adapter or the private journal's terminal guard.
    await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(proof), { flag: 'wx' });
    return proof;
  }
  const current = await certificateSnapshot(request, publicJSON);
  if (phase === 'start') {
    await writeFile(
      path.join(directory, 'start.json'),
      JSON.stringify({ operation, request, current }),
      { flag: 'wx' }
    );
    return current;
  }
  need(
    phase === 'finish' &&
      env.CERTIFICATE_JOB_STATUS === 'success' &&
      env.CERTIFICATE_CLEANUP === 'success' &&
      env.CERTIFICATE_HONESTY === 'success' &&
      env.CERTIFICATE_UNCHANGED === 'success'
  );
  const start = JSON.parse(await readFile(path.join(directory, 'start.json'), 'utf8'));
  need(
    start.operation === operation &&
      JSON.stringify(start.request) === JSON.stringify(request) &&
      start.current.engine_instance === current.engine_instance &&
      start.current.frontend_source_sha === current.frontend_source_sha &&
      start.current.maintenance_activation_receipt === current.maintenance_activation_receipt
  );
  const proof = {
    operation_id: operation,
    request,
    control_sha: env.GITHUB_SHA,
    run_id: env.GITHUB_RUN_ID,
    success: true,
    cleanup_complete: true,
    unchanged_release: true,
    served_components: { 'club-arena-engine': { identity: request.artifact_image_id } },
    engine_instance: current.engine_instance,
    frontend_source_sha: current.frontend_source_sha,
    started_at: start.current.observed_at,
    completed_at: current.observed_at,
  };
  await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(proof), { flag: 'wx' });
  return proof;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await certificateProof({
    phase: process.argv[2],
    directory: process.argv[3],
    request: JSON.parse(process.env.RELEASE_CERTIFICATE_REQUEST),
    operation: process.env.RELEASE_CERTIFICATE_OPERATION,
    env: process.env,
  });
