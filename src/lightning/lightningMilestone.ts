/** Presentation only: distinct named hand_started events during this room visit.
 * Snapshots, baselines, settings changes and reconnects never award a milestone.
 * This room owns the tracker and its replay identities until it unmounts. */
export function createLightningMilestoneTracker() {
  const seen = new Set<string>();
  let room: string | null = null;
  let hands = 0;
  return {
    note(poolSessionId: string, event: Record<string, unknown>, every: number): boolean {
      // Existing Lightning hand_started names the immutable hand number and
      // start timestamp. It does not carry hand_id; never infer it from a snapshot.
      const number = Number(event.hand_number),
        started = Number(event.timestamp);
      if (
        event.type !== 'hand_started' ||
        !Number.isInteger(number) ||
        number <= 0 ||
        !Number.isFinite(started) ||
        started <= 0
      )
        return false;
      if (room !== poolSessionId) {
        room = poolSessionId;
        hands = 0;
        seen.clear();
      }
      const key = `${number}:${started}`;
      if (seen.has(key)) return false;
      seen.add(key);
      hands++;
      return Number.isInteger(every) && every >= 100 && hands % every === 0;
    },
  };
}
