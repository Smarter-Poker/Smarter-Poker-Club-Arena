/**
 * scale/ — horizontal-scale + zero-downtime-deploy foundation.
 *
 * Barrel export. See README.md in this folder for the full architecture,
 * integration plan, and the infra decisions the platform owner must make.
 *
 * Status: standalone, tsc-clean, unit-tested foundation. NOT yet wired into the
 * live GameServer/ServerTableEngine — integration is a documented, additive step.
 */

export { TableRouter } from './TableRouter.js';
export type { WorkerSpec } from './TableRouter.js';

export { InMemoryCrossNodeBus, Topics } from './CrossNodeBus.js';
export type {
  CrossNodeBus,
  BusEnvelope,
  BusHandler,
  Subscription,
  BusTransport,
  InMemoryBusOptions,
} from './CrossNodeBus.js';

export {
  InProcessShardManager,
  InlineWorkerFactory,
  NodeWorkerFactory,
  DrainFailedError,
} from './ShardManager.js';
export type {
  ShardManager,
  WorkerFactory,
  WorkerChannel,
  WorkerHealth,
  WorkerStatus,
  DrainResult,
  Reassignment,
  ShardEvent,
  TableHost,
  InProcessShardManagerOptions,
} from './ShardManager.js';

export { ShardWorkerRuntime, NoopTableHost } from './ShardWorkerRuntime.js';
export type { ShardWorkerRuntimeOptions } from './ShardWorkerRuntime.js';

export type {
  ManagerToWorker,
  WorkerToManager,
  WorkerId,
  WorkerGeneration,
  OwnershipEpoch,
  TableId,
  TableLease,
  TableCloseFailure,
  ShardWorkerData,
} from './protocol.js';
