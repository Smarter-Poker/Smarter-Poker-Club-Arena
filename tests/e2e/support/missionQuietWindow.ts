export type MissionQuietSnapshot = { sockets: number; cursorReads: number };

/** Require one uninterrupted observation; a real reconnect invalidates the
 * quiet-window premise, but never excuses polling on a stable connection. */
export async function observeMissionQuietWindow({
  snapshot,
  waitUntilLive,
  waitWindow,
}: {
  snapshot: () => MissionQuietSnapshot;
  waitUntilLive: () => Promise<unknown>;
  waitWindow: () => Promise<unknown>;
}) {
  for (let interruptions = 0; interruptions < 3; interruptions += 1) {
    await waitUntilLive();
    const before = snapshot();
    await waitWindow();
    const after = snapshot();
    if (after.sockets !== before.sockets) continue;
    const cursorReads = after.cursorReads - before.cursorReads;
    if (cursorReads !== 0) {
      throw new Error(
        `A stable Daily Missions socket issued ${cursorReads} revision cursor reads.`
      );
    }
    return { interruptions, sockets: after.sockets, cursorReads };
  }
  throw new Error('Daily Missions never held one uninterrupted no-poll observation window.');
}
