/**
 * Horse (AI opponent) decision shape.
 *
 * Extracted 2026-04-23 (Phase U2 Stage A.4) from `src/engine/HorseLogic.ts`
 * so that services (HydraService, telemetry) can reference the decision
 * shape without pulling in the client-side horse engine. The Hetzner game
 * server runs the real HorseFleetManager; this type just mirrors what the
 * server emits or what downstream consumers ingest.
 */

import type { ActionType } from '../database.types';

export interface HorseDecision {
  action: ActionType;
  amount?: number;
  thinkTime: number;
}
