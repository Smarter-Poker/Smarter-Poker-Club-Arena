/** Bounded, explicitly invoked read-only witness. A sample never certifies
 * every hand or substitutes for the retained 5,000-hand launch workload. */
export async function collectReplaySample({ admin, player, clusterId, from, to }) {
  const source = 'fn_lightning_operator_hand_replay:first_and_last_three_recorded_hands';
  const unknown = (errorCode) => ({ status: 'unknown', source, errorCode });
  const uuid = (v) =>
    typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  if (
    !uuid(clusterId) ||
    !Number.isFinite(Date.parse(from)) ||
    !Number.isFinite(Date.parse(to)) ||
    Date.parse(from) >= Date.parse(to)
  )
    return unknown('INVALID_REPLAY_SCOPE');
  try {
    const selected = new Map();
    for (const ascending of [true, false]) {
      const r = await admin
        .from('lightning_hand')
        .select('hand_id,cluster_id,hand_history_id,settled_at')
        .eq('cluster_id', clusterId)
        .gte('formed_at', from)
        .lte('formed_at', to)
        .not('settled_at', 'is', null)
        .not('hand_history_id', 'is', null)
        .order('formed_at', { ascending })
        .order('hand_id', { ascending })
        .limit(3);
      if (r.error || !Array.isArray(r.data) || r.data.length > 3)
        return unknown('REPLAY_SELECTION_UNAVAILABLE');
      for (const h of r.data) {
        if (
          !uuid(h.hand_id) ||
          h.cluster_id !== clusterId ||
          !uuid(h.hand_history_id) ||
          !Number.isFinite(Date.parse(h.settled_at))
        )
          return unknown('REPLAY_SELECTION_INVALID');
        selected.set(h.hand_id, h);
      }
    }
    const hands = [];
    for (const h of selected.values()) {
      const r = await player.rpc('fn_lightning_operator_hand_replay', {
        p_cluster_id: clusterId,
        p_hand_id: h.hand_id,
      });
      const d = r.data,
        check = d?.replay;
      if (
        r.error ||
        d?.ok !== true ||
        d.cluster_id !== clusterId ||
        d.hand_id !== h.hand_id ||
        d.hand?.hand_id !== h.hand_id ||
        d.hand?.hand_history_id !== h.hand_history_id ||
        d.hand?.settled_at !== h.settled_at ||
        check?.hand_id !== h.hand_id ||
        check?.cluster_id !== clusterId ||
        check?.settled !== true ||
        typeof check?.ok !== 'boolean' ||
        !Array.isArray(check.defects) ||
        check.defects.length > 200 ||
        check.defects.some((x) => typeof x?.code !== 'string' || !/^[a-z_]{1,60}$/.test(x.code)) ||
        check.ok !== (check.defects.length === 0)
      )
        return unknown('REPLAY_RESULT_INVALID_OR_UNAVAILABLE');
      hands.push({
        handId: h.hand_id,
        historyId: h.hand_history_id,
        settledAt: h.settled_at,
        passed: check.ok,
        defects: check.defects.map((x) => x.code),
      });
    }
    const passed = hands.filter((h) => h.passed).length;
    return {
      status: 'known',
      source,
      data: {
        scope: 'sample_only',
        selection: 'first_and_last_three',
        checked: hands.length,
        passed,
        verdict:
          hands.length === 0
            ? 'no_samples'
            : passed === hands.length
              ? 'sample_passed'
              : 'sample_failed',
        hands,
      },
    };
  } catch {
    return unknown('REPLAY_READ_UNAVAILABLE');
  }
}
