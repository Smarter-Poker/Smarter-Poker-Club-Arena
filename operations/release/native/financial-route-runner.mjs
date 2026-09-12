import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { startFixtureActors } from '../fixture/actors.mjs';
import { FINANCIAL_MS } from './component-observation-protocol.mjs';
import { createFinancialCheckpointObserver } from './financial-checkpoint-observer.mjs';

/** Run in the independent observer with two ordinary synthetic Auth sessions.
 * The fixed observation client stays owned by the caller. No DB credentials,
 * fixture writes, publication, retries, or product certificate are granted.
 * startActors is injectable for lifecycle tests; native callers use the pinned
 * implementation, whose only endpoints are the isolated engine service.
 */
export async function runFinancialRoute({
  owner,
  users,
  observations,
  readEngineIdentity,
  startActors = startFixtureActors,
  now = () => performance.now(),
  sleep,
}) {
  const bound = structuredClone(owner);
  const sessions = structuredClone(users);
  assert.deepEqual(
    sessions.map((user) => user.id),
    bound.actorIds,
    'FINANCIAL_RUNNER_ACTORS'
  );
  const controller = new AbortController();
  const started = now();
  let actors, resolveActors, finish, fail, timer;
  const available = new Promise((resolve) => {
    resolveActors = resolve;
  });
  const completion = new Promise((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  // A startup failure may arrive while the original identity read is pending.
  // Attach the rejection observer before any callbacks can run.
  completion.catch(() => {});
  let closed = false;
  const observer = createFinancialCheckpointObserver({
    owner: bound,
    observations,
    readEngineIdentity,
    now,
    ...(sleep ? { sleep } : {}),
    sampleFelt: async () => {
      const current = await available;
      assert.ok(!closed, 'FINANCIAL_RUNNER_CLOSED');
      return current.stateObservations();
    },
  });
  try {
    timer = setTimeout(() => fail(new Error('FINANCIAL_RUNNER_DEADLINE')), FINANCIAL_MS);
    await Promise.race([observer.start(), completion]);
    assert.ok(!closed && now() - started < FINANCIAL_MS, 'FINANCIAL_RUNNER_DEADLINE');
    const starting = Promise.resolve().then(() =>
      startActors({
        tableId: bound.tableId,
        users: sessions,
        signal: controller.signal,
        onFailure: fail,
        financialProof: {
          opId: bound.opId,
          async checkpoint(entry) {
            try {
              assert.ok(!closed, 'FINANCIAL_RUNNER_CLOSED');
              const saved = structuredClone(entry);
              await observer.checkpoint(saved);
              if (saved.phase === 'settlement.observed') finish();
            } catch (error) {
              fail(error);
              throw error;
            }
          },
        },
      })
    );
    // Even a late startup result belongs to this run and must be closed.
    const prepared = starting.then((value) => {
      assert.equal(typeof value?.close, 'function', 'FINANCIAL_RUNNER_ACTOR_HANDLE');
      assert.equal(typeof value?.stateObservations, 'function', 'FINANCIAL_RUNNER_ACTOR_HANDLE');
      actors = value;
      if (closed) value.close();
      else resolveActors(value);
      return value;
    });
    prepared.catch(fail);
    await Promise.race([prepared, completion]);
    await completion;
    assert.ok(now() - started < FINANCIAL_MS, 'FINANCIAL_RUNNER_DEADLINE');
    return observer.observations();
  } finally {
    closed = true;
    clearTimeout(timer);
    controller.abort();
    actors?.close();
  }
}
