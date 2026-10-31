import { GAME_MANAGEMENT_READ_TIMEOUT_MS } from '../lib/gameManagementReadDeadline';

// Use the existing 10-second client authority/read budget (ClubWorkspace and
// gameManagementReadDeadline). This limits waiting, not transaction execution:
// an expired response leaves the original paid request's outcome unknown.
export const TOURNAMENT_REGISTRATION_READ_TIMEOUT_MS = GAME_MANAGEMENT_READ_TIMEOUT_MS;

export async function withTournamentRegistrationReadBoundary<T>(
  read: (signal: AbortSignal) => PromiseLike<T>
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject before aborting: an abort-aware transport may resolve an error
      // synchronously. It must not reach the admission's retry branch.
      reject(
        new Error('Could Not Confirm Tournament Registration. Please Refresh Before Trying Again.')
      );
      controller.abort();
    }, TOURNAMENT_REGISTRATION_READ_TIMEOUT_MS);
  });
  try {
    // Bound each awaited step, not just the outer callback. A late transport
    // result can never continue into roster reads, events or start-time writes.
    return await Promise.race([read(controller.signal), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
