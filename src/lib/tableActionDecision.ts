import type { ActionResult } from '../services/GameServerAPI';

/** An absent token means input is not ready, never that a context-free tap is safe.
 * Refresh once and return the choice to the player. Never rebind or replay an
 * old choice against a different decision, even when it was only a fold.
 */
export async function submitTableDecision(input: {
  actionContext: string | undefined;
  allowContextless: boolean;
  send: (context: string | undefined) => Promise<ActionResult>;
  refresh: () => Promise<void>;
}): Promise<ActionResult> {
  if (!input.allowContextless && !input.actionContext) {
    await input.refresh();
    return {
      success: false,
      code: 'CLIENT_DECISION_REFRESHED',
      error: 'Your Action Was Not Sent. Please Review The Table And Try Again.',
    };
  }
  const result = await input.send(input.actionContext);
  if (
    result.code === 'ACTION_CONTEXT_REQUIRED' ||
    result.code === 'STALE_ACTION' ||
    result.code === 'ACTION_NOT_DELIVERED' ||
    result.code === 'ACTION_STATE_PENDING'
  ) {
    await input.refresh();
  }
  if (result.code === 'ACTION_CONTEXT_REQUIRED') {
    return {
      ...result,
      error: 'Your Action Was Not Sent. Please Review The Table And Try Again.',
    };
  }
  return result;
}
