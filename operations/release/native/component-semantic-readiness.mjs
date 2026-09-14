import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

export const ENGINE_READINESS_TIMEOUT_MS = 90000;

// Observe only the already-started exact engine. This does not create an
// engine, restart it, retry a product test or select another hand/source.
export async function waitForExactEngineReady({
  request,
  healthUrl,
  sourceSha,
  now = () => performance.now(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  assert.match(sourceSha, /^[0-9a-f]{40}$/);
  const started = now();
  const deadline = started + ENGINE_READINESS_TIMEOUT_MS;
  let observations = 0;
  const timeout = () => {
    throw new Error('RELEASE_SEMANTIC_ENGINE_READINESS_TIMEOUT');
  };
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) timeout();
    let response, health;
    observations++;
    try {
      response = await request.get(healthUrl, { timeout: Math.min(3000, remaining) });
    } catch {
      // A bounded startup transport failure is only another observation of
      // this same engine. It is never evidence of successful readiness.
    }
    if (response) {
      try {
        health = await response.json();
      } catch {
        // The local proxy can return a non-JSON startup response.
      }
    }
    if (health?.releaseSha != null && health.releaseSha !== '' && health.releaseSha !== sourceSha)
      throw new Error('RELEASE_SEMANTIC_ENGINE_SOURCE_MISMATCH');
    // Even a correct response arriving outside this original budget is late.
    const observedAt = now();
    if (observedAt >= deadline) timeout();
    if (response?.status() === 200 && health?.releaseSha === sourceSha && health.running === true) {
      return {
        timeout_ms: ENGINE_READINESS_TIMEOUT_MS,
        elapsed_ms: Math.ceil(observedAt - started),
        observations,
        source_sha: sourceSha,
        running: true,
      };
    }
    const sleepBudget = deadline - now();
    if (sleepBudget <= 0) timeout();
    await sleep(Math.min(200, sleepBudget));
  }
}
