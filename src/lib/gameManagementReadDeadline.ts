// Match the existing ClubWorkspace authorization budget. An unreadable
// authority is a recoverable failure, never a grant or a membership verdict.
export const GAME_MANAGEMENT_READ_TIMEOUT_MS = 10_000;

export async function withGameManagementReadDeadline<T>(
  read: (signal: AbortSignal) => PromiseLike<T>
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Management Access Could Not Be Verified'));
    }, GAME_MANAGEMENT_READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([read(controller.signal), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
