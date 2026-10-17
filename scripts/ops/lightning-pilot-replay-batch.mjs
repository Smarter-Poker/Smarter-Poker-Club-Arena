/** Explicit finite read-only replay page. Never activates play or retries.
 * Keep the same closed time interval when continuing with nextCursor.
 * A page certifies only its selected settled, history-linked hands; complete
 * means no further selected rows after this cursor, never universal launch GO.
 */
import { resolvePilotTarget } from './lightning-pilot-targets.mjs';
import { PILOT } from './prepare-lightning-private-pilot.mjs';
const uuid = (x) =>
  typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x);
const time = (x) => (typeof x === 'string' ? Date.parse(x) : NaN);

export async function collectReplayBatch({
  admin,
  player,
  clusterId,
  from,
  to,
  cursor = null,
  maxBatch = 1000,
}) {
  const source = 'fn_lightning_operator_hand_replay:bounded_settled_history_linked_page';
  const hands = [];
  const unknown = (errorCode) => ({
    status: 'unknown',
    source,
    errorCode,
    hands,
    complete: false,
    nextCursor: null,
  });
  if (
    !uuid(clusterId) ||
    !Number.isFinite(time(from)) ||
    !Number.isFinite(time(to)) ||
    time(from) >= time(to) ||
    time(to) > Date.now() ||
    (cursor !== null && !uuid(cursor)) ||
    !Number.isSafeInteger(maxBatch) ||
    maxBatch < 1 ||
    maxBatch > 1000
  )
    return unknown('INVALID_REPLAY_SCOPE');
  try {
    await resolvePilotTarget(admin, clusterId, { active: false });
    const session = await player.auth.getSession();
    if (session.error || session.data?.session?.user?.id !== PILOT.ownerId)
      return unknown('REPLAY_OWNER_SESSION_UNAVAILABLE');
    let query = admin
      .from('lightning_hand')
      .select('hand_id,cluster_id,lightning_instance_id,hand_history_id,formed_at,settled_at', {
        count: 'exact',
      })
      .eq('cluster_id', clusterId)
      .gte('formed_at', from)
      .lte('formed_at', to)
      .not('settled_at', 'is', null)
      .lte('settled_at', to)
      .not('hand_history_id', 'is', null);
    if (cursor !== null) query = query.gt('hand_id', cursor);
    const selected = await query.order('hand_id', { ascending: true }).limit(maxBatch);
    if (
      selected.error ||
      !Array.isArray(selected.data) ||
      !Number.isSafeInteger(selected.count) ||
      selected.count < 0 ||
      selected.data.length !== Math.min(maxBatch, selected.count)
    )
      return unknown('REPLAY_SELECTION_INCOMPLETE_OR_UNAVAILABLE');
    let previous = cursor;
    for (const h of selected.data) {
      if (
        !uuid(h.hand_id) ||
        h.cluster_id !== clusterId ||
        !uuid(h.lightning_instance_id) ||
        !uuid(h.hand_history_id) ||
        (previous !== null && h.hand_id <= previous) ||
        !Number.isFinite(time(h.formed_at)) ||
        time(h.formed_at) < time(from) ||
        time(h.formed_at) > time(to) ||
        !Number.isFinite(time(h.settled_at)) ||
        time(h.settled_at) < time(h.formed_at) ||
        time(h.settled_at) > time(to)
      )
        return unknown('REPLAY_SELECTION_INVALID');
      previous = h.hand_id;
      const r = await player.rpc('fn_lightning_operator_hand_replay', {
        p_cluster_id: clusterId,
        p_hand_id: h.hand_id,
      });
      const d = r.data,
        c = d?.replay;
      if (
        r.error ||
        d?.ok !== true ||
        d.cluster_id !== clusterId ||
        d.hand_id !== h.hand_id ||
        d.hand?.hand_id !== h.hand_id ||
        d.hand?.hand_history_id !== h.hand_history_id ||
        d.hand?.lightning_instance_id !== h.lightning_instance_id ||
        time(d.hand?.settled_at) !== time(h.settled_at) ||
        c?.hand_id !== h.hand_id ||
        c?.cluster_id !== clusterId ||
        c?.settled !== true ||
        typeof c?.ok !== 'boolean' ||
        !Array.isArray(c.defects) ||
        c.defects.length > 200 ||
        c.defects.some((x) => typeof x?.code !== 'string' || !/^[a-z_]{1,60}$/.test(x.code)) ||
        c.ok !== (c.defects.length === 0)
      )
        return unknown('REPLAY_RESULT_INVALID_OR_UNAVAILABLE');
      hands.push({
        handId: h.hand_id,
        historyId: h.hand_history_id,
        instanceId: h.lightning_instance_id,
        settledAt: h.settled_at,
        passed: c.ok,
        conservation: c.defects.some((x) => x.code === 'conservation') ? 'failed' : 'passed',
        defects: c.defects.map((x) => x.code),
      });
    }
    const complete = selected.count <= maxBatch;
    return {
      status: 'known',
      source,
      scope: { clusterId, from, to, cursor, maxBatch },
      selection: 'settled_history_linked_hands_formed_in_closed_interval',
      remainingAtSelection: selected.count,
      checked: hands.length,
      passed: hands.filter((h) => h.passed).length,
      complete,
      nextCursor: complete ? null : previous,
      verdict:
        hands.length === 0
          ? 'no_hands'
          : hands.every((h) => h.passed)
            ? 'batch_passed'
            : 'batch_failed',
      hands,
    };
  } catch {
    return unknown('REPLAY_READ_UNAVAILABLE');
  }
}
