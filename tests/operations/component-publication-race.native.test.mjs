import test from 'node:test';
import assert from 'node:assert/strict';
import { staticArtifactFixture } from './static-artifact-fixture.mjs';
import { componentReadback } from '../../operations/release/component-readback.mjs';
import { operationPolicyDigest } from '../../operations/release/operation-policy.mjs';

// Negative installed-ownership witness reported by the sole parent operator:
// Autopilot merged PR4327 (2b3afab51e291227ec690810a2ae9a01d5a9640d)
// at 2026-09-11T20:46:12Z while certificate34645068983 was active; new static
// publisher34645957332 overlapped verification. This fixture does not claim
// local code retires that installed writer. It proves the certificate refuses
// a different real native frontend artifact even when the engine is unchanged.
test('independent static publication during an active certificate refuses component success despite unchanged engine', async () => {
  const old = await staticArtifactFixture('a'.repeat(40), '34645000000');
  const next = await staticArtifactFixture(
    '2b3afab51e291227ec690810a2ae9a01d5a9640d',
    '34645957332'
  );
  const receipt = '11111111-1111-4111-8111-111111111111';
  const engine = {
    mode: 'retained',
    source_sha: 'b'.repeat(40),
    identity: `sha256:${'c'.repeat(64)}`,
    verified_receipt_id: receipt,
    compatibility_receipt_id: receipt,
  };
  const request = {
    repository: 'Smarter-Poker/Smarter-Poker-Club-Arena',
    component_tuple: {
      'club-arena-engine': engine,
      'club-arena-web': {
        mode: 'changed',
        source_sha: old.source,
        identity: `sha256:${old.manifestDigest}`,
        manifest_digest: old.manifestDigest,
        publication_operation_id: receipt,
      },
    },
  };
  let serving = old;
  const read = componentReadback({
    readNativeFrontend: (source) => serving.readNative(source),
    readPublic: () => serving.readPublic(),
    readNativeEngine: async () => ({ source_sha: engine.source_sha, image_id: engine.identity }),
    publicJSON: async () => ({
      running: true,
      liveness: 'ok',
      releaseSha: engine.source_sha,
      instanceId: '1-abcdef12',
      maintenance: {
        policyVersion: 2,
        policyDigest: operationPolicyDigest,
        activationReceipt: 'native-existing',
      },
    }),
    github: async (route) =>
      route.includes('/jobs?')
        ? {
            total_count: 1,
            jobs: [
              {
                id: 123,
                name: 'publish-to-origin',
                status: 'completed',
                conclusion: 'success',
                steps: [
                  {
                    name: 'Verify the origin serves this bundle',
                    status: 'completed',
                    conclusion: 'success',
                  },
                ],
              },
            ],
          }
        : {
            id: Number(serving.runId),
            path: '.github/workflows/publish-club-arena.yml',
            head_branch: 'main',
            event: 'push',
            status: 'completed',
            run_attempt: 1,
            repository: { full_name: request.repository },
            head_repository: { full_name: request.repository },
          },
  });
  try {
    assert.equal((await read(request, { id: receipt })).served_components, request.component_tuple);
    serving = next;
    await assert.rejects(read(request, { id: receipt }), /RELEASE_COMPONENT_CERTIFICATE_REFUSED/);
    serving = old;
    assert.equal((await read(request, { id: receipt })).served_components, request.component_tuple);
  } finally {
    await old.close();
    await next.close();
  }
});
