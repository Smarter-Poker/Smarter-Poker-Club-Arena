import { publicReleaseJSON } from './engine-readiness.mjs';
import { operationPolicyDigest } from './operation-policy.mjs';
import { validateComponentTuple, requireCertificate as need } from './component-certificate.mjs';
import {
  proveExistingArtifact,
  requirePriorPublication,
  publicDocuments,
} from './frontend-artifact-proof.mjs';

// Uses the bridge's exact native manifest and public-document proof. Identity
// labels below are returned only after independently reading those bytes and
// the native engine image. No SHA inferred from a moving repository head.
export function componentReadback({
  readNativeFrontend,
  readNativeEngine,
  github,
  readPublic = publicDocuments,
  publicJSON = publicReleaseJSON,
}) {
  need(
    typeof readNativeFrontend === 'function' &&
      typeof readNativeEngine === 'function' &&
      typeof github === 'function',
    'RELEASE_COMPONENT_READBACK_NOT_INSTALLED'
  );
  return async (request, operation, client) => {
    validateComponentTuple(request.component_tuple);
    const engine = request.component_tuple['club-arena-engine'],
      web = request.component_tuple['club-arena-web'];
    const nativeEngine = await readNativeEngine(request, operation, client);
    need(
      nativeEngine.source_sha === engine.source_sha && nativeEngine.image_id === engine.identity
    );
    const frontend = await proveExistingArtifact({
      readNative: readNativeFrontend,
      readPublic,
      priorPublication: async (proof) =>
        requirePriorPublication(
          await github(`/repos/${request.repository}/actions/runs/${proof.build_info.run_id}`),
          await github(
            `/repos/${request.repository}/actions/runs/${proof.build_info.run_id}/jobs?filter=latest&per_page=100`
          ),
          proof
        ),
    });
    need(
      frontend.native.source_sha === web.source_sha &&
        frontend.native.manifest_sha256 === web.manifest_digest
    );
    const health = await publicJSON('https://engine.smarter.poker/health');
    need(
      health.running === true &&
        health.liveness === 'ok' &&
        health.releaseSha === engine.source_sha &&
        /^[1-9][0-9]*-[0-9a-f]{8}$/.test(health.instanceId) &&
        health.maintenance?.policyVersion === 2 &&
        health.maintenance.policyDigest === operationPolicyDigest &&
        typeof health.maintenance.activationReceipt === 'string' &&
        health.maintenance.activationReceipt.length > 0
    );
    if (engine.mode === 'changed')
      need(
        request.maintenance_operation_id &&
          health.maintenance.operation?.operationId === request.maintenance_operation_id &&
          health.maintenance.operation.phase === 'resumed'
      );
    const finalEngine = await readNativeEngine(request, operation, client);
    need(
      finalEngine.source_sha === nativeEngine.source_sha &&
        finalEngine.image_id === nativeEngine.image_id
    );
    return {
      served_components: request.component_tuple,
      engine_instance: health.instanceId,
      maintenance_activation_receipt: health.maintenance.activationReceipt,
      native_frontend: frontend.native,
      observed_at: new Date().toISOString(),
    };
  };
}
