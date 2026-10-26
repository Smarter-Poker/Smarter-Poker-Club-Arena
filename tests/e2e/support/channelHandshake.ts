export type ChannelAttempt = {
  opened: boolean;
  index: number;
  status: number | null;
  closeCode: number | null;
};

/** Retry only a positively observed pre-upgrade 503, never a protocol outcome. */
export async function openChannelWithUnavailableRetry(
  attempt: () => Promise<ChannelAttempt>,
  report: (diagnostic: {
    attempt: number;
    status: number | null;
    closeCode: number | null;
  }) => void,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<number> {
  for (let number = 1; number <= 3; number++) {
    const result = await attempt(); // Each attempt must close and await a failed socket.
    report({ attempt: number, status: result.status, closeCode: result.closeCode });
    if (result.opened) return result.index;
    if (result.status !== 503 || result.closeCode !== 1006 || number === 3)
      throw new Error(
        `Channel handshake refused: attempt=${number} status=${result.status ?? 'unknown'} closeCode=${result.closeCode ?? 'unknown'}`
      );
    await sleep(500);
  }
  throw new Error('Channel handshake attempts exhausted');
}

/** Chromium reports rejected upgrades here instead of a handshake response. */
export function rejectedHandshakeStatus(message: string): number | null {
  const match =
    /^(?:Error during WebSocket handshake: )?Unexpected response code: ([1-5][0-9]{2})$/.exec(
      message
    );
  return match ? Number(match[1]) : null;
}
