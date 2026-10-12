/**
 * LIGHTNING PHASE 6: sending LIGHTNING FOLD and FOLD & WATCH.
 *
 * Both go through the one action door every table uses, POST /action, with
 * the pool session's id as the table id: the engine serves a Lightning room
 * exactly like a table room. The shared sender brings the per-table spacing,
 * the 429 retries and the idempotency key with it.
 */
import { submitAction, type ActionResult } from '../services/GameServerAPI';
import { lightningActionPayload } from './lightningHand';

export type LightningFoldKind = 'fast_fold' | 'fold_watch';

export type ActionSender = (
  tableId: string,
  userId: string,
  action: string,
  amount?: number
) => Promise<ActionResult>;

export async function sendLightningFold(
  poolSessionId: string,
  userId: string,
  kind: LightningFoldKind,
  send: ActionSender = submitAction
): Promise<ActionResult> {
  const payload = lightningActionPayload(poolSessionId, kind);
  return send(payload.tableId, userId, payload.action, payload.amount);
}
