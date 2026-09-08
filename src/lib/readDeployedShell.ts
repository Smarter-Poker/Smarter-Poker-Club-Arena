/** Bound the complete shell read so an interrupted PWA request can be retried. */
export const SHELL_READ_TIMEOUT_MS = 8000;

export async function readDeployedShell(url: string): Promise<string | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, SHELL_READ_TIMEOUT_MS);
  });
  const read = (async () => {
    try {
      const response = await fetch(url, { cache: 'no-cache', signal: controller.signal });
      return response.ok ? await response.text() : null;
    } catch {
      // Offline, HTTP failure and timeout cannot establish a newer build.
      return null;
    }
  })();
  try {
    // The deadline also covers a body that stalls after headers arrive.
    return await Promise.race([read, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
