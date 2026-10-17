// Supporting R12 amendment only; root integrates into the existing finite witness.
// No active wait, recovery action, authentication mutation or fabricated frame.
import { resolvePilotTarget } from './lightning-pilot-targets.mjs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unknown = (cause) => ({ status: 'unknown', phase: 'unknown', cause });
const sameOwn = (a, b) =>
  a?.pool_session_id === b?.pool_session_id &&
  a?.state === b?.state &&
  a?.in_hand === b?.in_hand &&
  a?.hand_id === b?.hand_id;
const validOwn = (s, p) =>
  s?.pool_session_id === p.poolSessionId &&
  ['active', 'disconnected'].includes(s.state) &&
  typeof s.in_hand === 'boolean' &&
  (s.hand_id === null || UUID.test(s.hand_id));

/** Classify only actual scoped database rows, never a prior browser render. */
export function classifyRecoveryPhase({ pin, before, after, reservations, instances, slots = [] }) {
  if (
    !validOwn(before, pin) ||
    !validOwn(after, pin) ||
    !sameOwn(before, after) ||
    !Array.isArray(reservations) ||
    !Array.isArray(instances)
  )
    return unknown('OWN_STATE_CHANGED_OR_UNAVAILABLE');
  if (reservations.length === 0)
    return instances.length === 0 && before.in_hand === false && before.hand_id === null
      ? { status: 'observed', phase: 'idle', handId: null, instanceId: null }
      : unknown('HAND_WITHOUT_RESERVATION');
  if (reservations.length !== 1) return unknown('AMBIGUOUS_RESERVATION');
  const r = reservations[0],
    slot = slots.find((s) => s.id === r.pool_slot_id),
    i = instances.find((i) => i.id === r.lightning_instance_id);
  if (
    r.cluster_id !== pin.clusterId ||
    r.player_id !== pin.playerId ||
    !UUID.test(r.id) ||
    !['pending', 'committed'].includes(r.state)
  )
    return unknown('RESERVATION_SCOPE_INVALID');
  if (
    !slot ||
    slot.pool_session_id !== pin.poolSessionId ||
    slot.cluster_id !== pin.clusterId ||
    slot.player_id !== pin.playerId ||
    slot.closed_at !== null
  )
    return unknown('SLOT_SESSION_SCOPE_INVALID');
  if (r.state === 'pending') return unknown('PENDING_RESERVATION_NOT_STABLE_PHASE');
  if (
    !i ||
    i.cluster_id !== pin.clusterId ||
    i.cluster_epoch !== r.cluster_epoch ||
    !before.in_hand
  )
    return unknown('INSTANCE_SCOPE_INVALID');
  if (['forming', 'reserved'].includes(i.state) && before.hand_id === null)
    return {
      status: 'observed',
      phase: 'reservation',
      handId: null,
      instanceId: i.id,
      reservationId: r.id,
    };
  if (
    i.state === 'dealing' &&
    UUID.test(i.hand_id) &&
    i.hand_id === before.hand_id &&
    Number.isFinite(Date.parse(i.started_at))
  )
    return {
      status: 'observed',
      phase: 'dealing',
      handId: i.hand_id,
      instanceId: i.id,
      reservationId: r.id,
    };
  return unknown('INSTANCE_PHASE_UNPROVEN');
}

/** One bounded observation, two own-session reads surrounding scoped rows.
 * This is a bounded timing bracket, not an atomic multi-query snapshot. */
export async function captureRecoveryPhase({ admin, player, pin, remaining, now = Date.now }) {
  try {
    if (!UUID.test(pin?.clusterId) || !UUID.test(pin.playerId) || !UUID.test(pin.poolSessionId))
      return unknown('PIN_INVALID');
    remaining();
    await resolvePilotTarget(admin, pin.clusterId);
    remaining();
    // Target metadata is outside the strict two-second own-state bracket.
    const startedAt = now();
    const first = await player.rpc('fn_lightning_reconnect_state', { p_cluster_id: pin.clusterId });
    if (first.error || !validOwn(first.data, pin)) return unknown('OWN_STATE_UNAVAILABLE');
    remaining();
    const rows = await admin
      .from('lightning_reservation')
      .select('id,cluster_id,cluster_epoch,player_id,state,lightning_instance_id,pool_slot_id', {
        count: 'exact',
      })
      .eq('cluster_id', pin.clusterId)
      .eq('player_id', pin.playerId)
      .in('state', ['pending', 'committed'])
      .limit(2);
    if (
      rows.error ||
      !Array.isArray(rows.data) ||
      !Number.isSafeInteger(rows.count) ||
      rows.count !== rows.data.length ||
      rows.count > 1
    )
      return unknown('RESERVATION_READ_INCOMPLETE');
    let instances = [],
      slots = [];
    if (rows.data.length) {
      if (!UUID.test(rows.data[0].pool_slot_id) || !UUID.test(rows.data[0].lightning_instance_id))
        return unknown('INSTANCE_UNAVAILABLE');
      remaining();
      const slot = await admin
        .from('lightning_pool_slot')
        .select('id,pool_session_id,cluster_id,player_id,closed_at')
        .eq('id', rows.data[0].pool_slot_id)
        .maybeSingle();
      if (slot.error || !slot.data) return unknown('SLOT_UNAVAILABLE');
      slots = [slot.data];
      remaining();
      const result = await admin
        .from('lightning_instance')
        .select('id,cluster_id,cluster_epoch,state,hand_id,started_at')
        .eq('id', rows.data[0].lightning_instance_id)
        .maybeSingle();
      if (result.error || !result.data) return unknown('INSTANCE_UNAVAILABLE');
      instances = [result.data];
    }
    remaining();
    const last = await player.rpc('fn_lightning_reconnect_state', { p_cluster_id: pin.clusterId });
    if (last.error) return unknown('OWN_STATE_UNAVAILABLE');
    const endedAt = now();
    remaining();
    const phase = classifyRecoveryPhase({
      pin,
      before: first.data,
      after: last.data,
      reservations: rows.data,
      instances,
      slots,
    });
    if (endedAt < startedAt || endedAt - startedAt > 2000) return unknown('OBSERVATION_TOO_WIDE');
    return {
      ...phase,
      playerId: pin.playerId,
      poolSessionId: pin.poolSessionId,
      clusterId: pin.clusterId,
      startedAt,
      endedAt,
      scope: 'read_bracket_only_not_atomic_disconnect_instant',
    };
  } catch {
    return unknown('PHASE_READ_UNAVAILABLE');
  }
}

/** Caller records these actual times around its normal offline/online calls.
 * Unknown phases never count. Different hand across reconnect is permitted
 * but recorded separately, never described as same-hand restoration. */
export function phaseReconnectEvidence({ before, after, offlineStartedAt, onlineStartedAt }) {
  if (
    before?.status !== 'observed' ||
    after?.status !== 'observed' ||
    before.poolSessionId !== after.poolSessionId ||
    before.playerId !== after.playerId ||
    before.clusterId !== after.clusterId ||
    ![offlineStartedAt, onlineStartedAt, before.endedAt, after.startedAt].every(Number.isFinite) ||
    offlineStartedAt < before.endedAt ||
    offlineStartedAt - before.endedAt > 250 ||
    onlineStartedAt < offlineStartedAt ||
    after.startedAt < onlineStartedAt
  )
    return unknown('DISCONNECT_PHASE_BRACKET_UNPROVEN');
  return {
    status: 'observed',
    phaseBefore: before.phase,
    phaseAfter: after.phase,
    poolSessionId: before.poolSessionId,
    beforeHandId: before.handId,
    afterHandId: after.handId,
    sameHand: before.handId !== null && before.handId === after.handId,
    offlineStartedAt,
    onlineStartedAt,
    beforeRead: { from: before.startedAt, to: before.endedAt },
    afterRead: { from: after.startedAt, to: after.endedAt },
    scope: 'phase_observed_immediately_before_disconnect_not_atomic_instant',
  };
}

/** Amend the existing disconnect once; never add retries or target-phase waits. */
export async function observeRecoveryPhaseBracket({ capture, disconnect }) {
  const before = await capture();
  const timing = await disconnect();
  const after = await capture();
  const bracket = phaseReconnectEvidence({ before, after, ...timing });
  const coverage = Object.fromEntries(
    ['idle', 'reservation', 'dealing'].map((phase) => [
      phase,
      bracket.status === 'observed' && bracket.phaseBefore === phase ? 'observed' : 'unknown',
    ])
  );
  return { bracket, coverage };
}
