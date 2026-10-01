/**
 * A PLAYER'S LIGHTNING SEAT, AS THE ACTION DOOR SEES IT (Lightning Phase 6, 2026-09-27).
 *
 * POST /action names a table id. For a Lightning player that id is their
 * pool_session_id - the room they are shown their hands in - and the hand
 * behind it changes every time they are dealt a new one. This proxy is the
 * ActionEngine the handler finds for that id: it routes the action to the
 * host currently dealing that room's hand, and refuses anything else.
 *
 * Fast fold arrives as action 'fast_fold' (and 'fold_watch'); the host
 * validates it server-side (action rights, or a fold ahead of the turn while
 * facing a bet). The proxy never decides anything about the hand itself.
 */
import type { ActionEngine } from '../handlers/action.js';
import type { LightningRegistry } from './LightningRegistry.js';

export class LightningSeatProxy implements ActionEngine {
  constructor(
    readonly roomId: string,
    private readonly registry: LightningRegistry
  ) {}

  handlePlayerAction(
    userId: string,
    action: string,
    amount?: number,
    actionContext?: string | null
  ): { success: boolean; error?: string; code?: string } {
    const host = this.registry.hostForRoom(this.roomId);
    if (!host) return { success: false, error: 'No active hand', code: 'NO_ACTIVE_HAND' };
    // The room is one player's: nobody else may act through it.
    if (host.roomOf(userId) !== this.roomId) {
      return { success: false, error: 'Player not found at this table' };
    }
    return host.handlePlayerAction(userId, action, amount, actionContext);
  }

  /** POST /preaction from the room: armed for the named hand only. */
  setPreAction(
    userId: string,
    action: string,
    maxCallAmount?: number,
    handId?: string
  ): { success: boolean; error?: string; code?: string } {
    const host = this.registry.hostForRoom(this.roomId);
    if (!host) return { success: false, error: 'No active hand', code: 'NO_ACTIVE_HAND' };
    if (host.roomOf(userId) !== this.roomId) {
      return { success: false, error: 'Player not found at this table' };
    }
    return host.setPreAction(userId, action, maxCallAmount, handId);
  }

  recordActionPerformance(_userId: string, _action: string, _processingMs: number): void {
    /* The fold leg is measured by the host (fold_ack); nothing else to record. */
  }
}
