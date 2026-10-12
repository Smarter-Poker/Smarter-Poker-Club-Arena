/** LIGHTNING PHASE 8: the decision queue, for components (see lightning/lightningDecisionQueue). */
import { useSyncExternalStore } from 'react';
import {
  lightningDecisions,
  subscribeLightningDecisions,
  type LightningDecisionEntry,
} from '../../lightning/lightningDecisionQueue';

export function useLightningDecisions(): LightningDecisionEntry[] {
  return useSyncExternalStore(subscribeLightningDecisions, lightningDecisions, lightningDecisions);
}
