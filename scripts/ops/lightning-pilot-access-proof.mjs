/** Read-only verification of a retained private-pilot access proof (the
 * `lightning-pilot-stage.yml` stage=access artifact). It never runs the proof,
 * never assumes a pass and never widens what the proof showed: anything absent,
 * stale, from the wrong workflow, branch or run outcome, for another outsider or
 * another Cluster, or short of a refusal on every observed surface stays a
 * blocker with its own code. */
export const ACCESS_PROOF_WORKFLOW = '.github/workflows/lightning-pilot-stage.yml';
export const ACCESS_PROOF_MAX_AGE_MS = 72 * 3600 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const time = (v) =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;

/**
 * @param {object} input
 * @param {unknown} input.run   GitHub run metadata the workflow read (id, path, headBranch, event, status, conclusion)
 * @param {unknown} input.proof The run's lightning-pilot-stage.json artifact
 * @param {string}  input.outsiderId The designated outsider this report names
 * @param {string[]} input.clusterIds The pilot Clusters this report qualifies
 * @param {string}  input.observedAt This report's observation time
 */
export function verifyAccessProof({ run, proof, outsiderId, clusterIds, observedAt }) {
  const source = 'lightning-pilot-stage.yml:stage=access:retained_artifact';
  const refuse = (code, detail = {}) => ({ status: 'unknown', source, verdict: code, ...detail });
  if (!object(run) && !object(proof)) return refuse('ACCESS_PROOF_NOT_SUPPLIED');
  if (!object(run) || !object(proof)) return refuse('ACCESS_PROOF_UNREADABLE');
  const runId = /^[0-9]{1,20}$/.test(String(run.id ?? '')) ? String(run.id) : null;
  if (
    !runId ||
    run.path !== ACCESS_PROOF_WORKFLOW ||
    run.headBranch !== 'main' ||
    run.event !== 'workflow_dispatch' ||
    run.status !== 'completed' ||
    run.conclusion !== 'success'
  )
    return refuse('ACCESS_PROOF_RUN_NOT_A_SUCCESSFUL_MAIN_ACCESS_STAGE', { runId });
  const a = proof.access;
  if (proof.stage !== 'access' || !object(a) || proof.error)
    return refuse('ACCESS_PROOF_NOT_AN_ACCESS_STAGE_RESULT', { runId });
  const completed = time(proof.completedAt);
  const observed = time(observedAt);
  if (completed === null || observed === null || completed > observed)
    return refuse('ACCESS_PROOF_TIME_UNVERIFIED', { runId });
  if (observed - completed > ACCESS_PROOF_MAX_AGE_MS)
    return refuse('ACCESS_PROOF_STALE', { runId, completedAt: proof.completedAt });
  if (
    a.verdict !== 'passed' ||
    a.scope !== 'designated_private_pilot_only' ||
    !UUID.test(outsiderId ?? '') ||
    a.outsiderId !== outsiderId ||
    a.operationId !== proof.operationId ||
    !UUID.test(a.operationId ?? '') ||
    a.cleanup?.outsiderSession !== 'local_signout_confirmed' ||
    !['removed_and_absence_verified', 'absent'].includes(a.cleanup?.pendingRequest) ||
    proof.serviceSessionCleanup !== 'local_signout_confirmed'
  )
    return refuse('ACCESS_PROOF_NOT_PASSED_FOR_DESIGNATED_OUTSIDER', { runId });
  const wanted = [...new Set(clusterIds)];
  const covered = list(proof.clusters).map((c) => c?.clusterId);
  if (wanted.length === 0 || wanted.some((id) => !covered.includes(id)))
    return refuse('ACCESS_PROOF_DOES_NOT_COVER_EVERY_PILOT', { runId });
  // Every surface, re-checked from the retained observations, not the verdict alone.
  const ownerSockets = list(a.states).filter((s) => s?.state === 'owner');
  const tableIds = ownerSockets.map((s) => s.tableId);
  const ownerOk =
    ownerSockets.length > 0 &&
    ownerSockets.every((s) => UUID.test(s.tableId ?? '') && s.socket?.outcome === 'opened') &&
    wanted.every((id) =>
      list(a.poolStatusOwner).some((p) => p?.clusterId === id && p.outcome === 'positive')
    ) &&
    wanted.every((id) =>
      list(a.browserOwner).some(
        (b) =>
          b?.clusterId === id &&
          b.authenticated === true &&
          b.discovery === 'visible' &&
          b.entry === 'rendered' &&
          b.browserSocket?.opened === true
      )
    );
  if (!ownerOk) return refuse('ACCESS_PROOF_OWNER_POSITIVE_CONTROL_MISSING', { runId });
  const outsiderState = (name) => {
    const s = list(a.states).filter((x) => x?.state === name);
    if (s.length !== 1) return false;
    const st = s[0];
    return (
      st.approved === false &&
      st.funded === false &&
      wanted.every((id) =>
        list(st.browser).some(
          (b) =>
            b?.clusterId === id &&
            b.actor === 'outsider' &&
            b.authenticated === true &&
            b.discovery === 'hidden' &&
            b.entry === 'refused' &&
            b.browserSocket?.opened === false &&
            b.browserSocket.messages === 0
        )
      ) &&
      tableIds.every((t) =>
        list(st.sockets).some(
          (x) => x?.tableId === t && x.outcome === 'refused' && x.status === 403
        )
      ) &&
      wanted.every((id) =>
        list(st.joins).some((j) => j?.clusterId === id && j.refused === true && j.ok !== true)
      ) &&
      wanted.every((id) =>
        list(st.poolStatus).some((p) => p?.clusterId === id && p.outcome === 'refused')
      )
    );
  };
  if (!outsiderState('nonmember'))
    return refuse('ACCESS_PROOF_NONMEMBER_REFUSAL_INCOMPLETE', { runId });
  if (!outsiderState('pending'))
    return refuse('ACCESS_PROOF_PENDING_REFUSAL_INCOMPLETE', { runId });
  return {
    status: 'known',
    source,
    verdict: 'PROVED',
    data: {
      runId,
      operationId: a.operationId,
      completedAt: proof.completedAt,
      outsiderId,
      clusterIds: wanted,
      liveTablesProbed: tableIds.length,
      states: ['owner', 'nonmember', 'pending'],
    },
  };
}
