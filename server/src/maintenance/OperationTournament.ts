import type { OperationMaintenanceState } from './operationPolicy.js';

/** A committed operation readback, scoped to this runtime and manager lifecycle. */
export interface OperationTournamentProof {
  state: OperationMaintenanceState;
  /** Read after the tournament row; never use a cached or pre-ACK snapshot. */
  readback(): Promise<OperationMaintenanceState>;
  isCurrent(): boolean;
  now(): number;
}

export interface OperationTournament {
  getTableIds(): string[];
  adoptOperationMaintenance(state: OperationMaintenanceState): void;
  operationMaintenanceDrain(): {
    ready: boolean;
    pending: readonly string[];
    failed: readonly string[];
  };
  reconcileOperationHold(proof: OperationTournamentProof): Promise<void>;
  resumeOperationClock(proof: OperationTournamentProof): Promise<void>;
  resumeOperationGlobal(proof: OperationTournamentProof): Promise<void>;
}
