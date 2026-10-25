/**
 * LIGHTNING PHASE 6: sending LIGHTNING FOLD and FOLD & WATCH.
 *
 * Both go through the one action door every table uses, POST /action, with
 * the pool session's id as the table id: the engine serves a Lightning room
 * exactly like a table room. The shared sender brings the per-table spacing,
 * the 429 retries and the idempotency key with it.
 */
import { submitAction, type ActionResult } from '../services/GameServerAPI';
import {
  lightningActionPayload,
  lightningHandId,
  type LightningSnapshotFields,
} from './lightningHand';

export type LightningFoldKind = 'fast_fold' | 'fold_watch';

/** Off-turn preflop Fold uses the visible Fold/Check-Fold pre-action rule. */
export function lightningFoldOnTurn(
  snapshot: Record<string, unknown> | null,
  userId: string,
  kind: LightningFoldKind
): { handId: string; toCall: number } | { error: string } | null {
  if (kind !== 'fast_fold') return null;
  const unavailable = { error: 'This Hand Is Not Available. Wait For The Table To Update.' };
  if (!snapshot || typeof snapshot.stage !== 'string') return unavailable;
  if (snapshot.stage !== 'preflop' || snapshot.current_player === userId) return null;
  // A null actor during a turn handoff is not proof of our own turn.
  if (!Array.isArray(snapshot.players)) return unavailable;
  const hero = snapshot.players.find((p) => p?.user_id === userId);
  const handId = lightningHandId(snapshot as LightningSnapshotFields);
  const price = snapshot.current_bet;
  if (
    !handId ||
    !hero ||
    hero.is_folded ||
    hero.is_all_in ||
    typeof price !== 'number' ||
    !Number.isFinite(price) ||
    typeof hero.bet !== 'number' ||
    !Number.isFinite(hero.bet)
  )
    return unavailable;
  const toCall = Math.max(0, price - hero.bet);
  return { handId, toCall };
}

export type ActionSender = (
  tableId: string,
  userId: string,
  action: string,
  amount?: number,
  actionContext?: string
) => Promise<ActionResult>;

export async function sendLightningFold(
  poolSessionId: string,
  userId: string,
  kind: LightningFoldKind,
  renderedHandId: string | null | undefined,
  send: ActionSender = submitAction
): Promise<ActionResult> {
  // Capture only the actual hand on the rendered felt, before the shared
  // sender awaits authentication, per-table spacing or a retry. Turns may
  // advance while an early fold remains valid; hands may never do so.
  if (
    typeof renderedHandId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(renderedHandId)
  ) {
    return {
      success: false,
      code: 'ACTION_CONTEXT_REQUIRED',
      error: 'This Hand Is Not Available. Wait For The Next Hand.',
    };
  }
  const actionContext = `lightning-hand:${renderedHandId.toLowerCase()}`;
  const payload = lightningActionPayload(poolSessionId, kind);
  return send(payload.tableId, userId, payload.action, payload.amount, actionContext);
}
