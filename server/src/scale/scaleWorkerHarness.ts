/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * scaleWorkerHarness — real worker_threads entry point for an engine worker
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This file is what `NodeWorkerFactory` runs inside each `worker_threads.Worker`.
 * It is engine-AGNOSTIC on purpose: it wires the transport (parentPort) to a
 * `ShardWorkerRuntime`, and obtains its `TableHost` from the module named in
 * `workerData.hostModule`. That host module is the ONE place the engine-owning
 * code plugs `ServerTableEngine` in (see README "Integration") — this scale
 * package never imports the engine, keeping the two workstreams decoupled.
 *
 * If no `hostModule` is provided it falls back to a `NoopTableHost`, so the
 * harness "works today" as runnable scaffolding you can spawn and drain end-to-
 * end before the engine host is written.
 *
 * A host module must default-export or named-export `createTableHost`:
 *
 *   // engineTableHost.ts  (owned by the engine agent, NOT in this package)
 *   export function createTableHost(): TableHost { ... wraps ServerTableEngine ... }
 */

import { parentPort, workerData } from 'node:worker_threads';
import { ShardWorkerRuntime, NoopTableHost, type TableHost } from './ShardWorkerRuntime.js';
import type { ManagerToWorker, WorkerToManager, ShardWorkerData } from './protocol.js';

async function main(): Promise<void> {
  // Not running inside a worker thread → nothing to do (keeps tsc/import safe).
  if (!parentPort) return;
  const port = parentPort;
  const data = workerData as ShardWorkerData;

  let host: TableHost = new NoopTableHost();
  if (data.hostModule) {
    const mod = (await import(data.hostModule)) as {
      createTableHost?: (data: ShardWorkerData) => TableHost | Promise<TableHost>;
      default?: (data: ShardWorkerData) => TableHost | Promise<TableHost>;
    };
    const factory = mod.createTableHost ?? mod.default;
    if (typeof factory !== 'function') {
      throw new Error(
        `hostModule "${data.hostModule}" must export createTableHost(data): TableHost`
      );
    }
    host = await factory(data);
  }

  const runtime = new ShardWorkerRuntime({
    workerId: data.workerId,
    workerGeneration: data.workerGeneration,
    host,
    heartbeatMs: data.heartbeatMs,
    send: (msg: WorkerToManager) => port.postMessage(msg),
  });

  port.on('message', (msg: ManagerToWorker) => {
    void runtime.handle(msg);
  });

  runtime.begin();
}

void main().catch((err) => {
  // Surface fatal boot errors to the manager if we can, else crash the worker.
  const message = err instanceof Error ? err.message : String(err);
  const id = (workerData as ShardWorkerData | undefined)?.workerId ?? 'unknown';
  const workerGeneration =
    (workerData as ShardWorkerData | undefined)?.workerGeneration ?? 'unknown';
  parentPort?.postMessage({
    type: 'ERROR',
    workerId: id,
    workerGeneration,
    message,
  } satisfies WorkerToManager);
  throw err;
});
