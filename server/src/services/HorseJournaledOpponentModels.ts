import { createHash, randomUUID } from 'node:crypto';
import { supabase } from './supabase.js';
import {
  decodeScopedAdaptiveJournalObservations,
  ADAPTIVE_JOURNAL_LIMITS,
} from './HorseAdaptiveObservationJournal.js';
import { buildJournaledOpponentStudy } from '../engine/HorseScopedOpponentHoldout.js';
import { resolveReleaseIdentity } from '../releaseIdentity.js';

const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const refusal = (reason: string) => Object.freeze({ status: 'unavailable' as const, reason });
export const JOURNALED_MODEL_PRIOR = Object.freeze({
  version: 'uniform-five-action-diagnostic-v1',
  probabilities: Object.freeze({ fold: 0.2, check: 0.2, call: 0.2, bet: 0.2, raise: 0.2 }),
});
const call = (name: string, args: Record<string, unknown>) =>
  supabase.rpc(name, args).abortSignal(AbortSignal.timeout(5000));

/** No identifiers, observations, predictions or digests leave the isolated
 * worker over IPC. These counters say only whether a private report landed. */
export type JournaledModelCycle =
  | 'disabled'
  | 'recorded'
  | 'refused'
  | 'idle'
  | 'unknown'
  | 'lease_lost'
  | 'capacity_full';

/** Validate the entire bounded snapshot before fitting either cohort. The
 * journal snapshot has its own complete population; source coverage stays
 * explicitly unestablished and is never passed to the source-window fitter. */
export function buildJournaledOpponentReport(
  claim: Record<string, unknown>,
  token: string,
  releaseSha: string
) {
  if (
    claim.version !== 1 ||
    claim.status !== 'claimed' ||
    claim.leaseToken !== token ||
    !sha(claim.actorKey) ||
    !sha(claim.scopeKey) ||
    !sha(claim.evidenceDigest) ||
    !integer(claim.fromMs) ||
    !integer(claim.toMs) ||
    claim.fromMs < 0 ||
    claim.toMs <= claim.fromMs ||
    claim.toMs - claim.fromMs !== 2592000000 ||
    typeof claim.snapshotId !== 'string' ||
    !/^[0-9]+:[0-9]+:(?:[0-9]+(?:,[0-9]+)*)?$/.test(claim.snapshotId) ||
    claim.snapshotId.length > 8192 ||
    !/^[a-f0-9]{40}$/.test(releaseSha) ||
    !Array.isArray(claim.rows) ||
    claim.rows.length > ADAPTIVE_JOURNAL_LIMITS.observations ||
    !integer(claim.observations) ||
    claim.observations < 0 ||
    !integer(claim.bytes) ||
    claim.bytes < 0 ||
    !['snapshot', 'observation_budget_exceeded', 'byte_budget_exceeded'].includes(
      String(claim.populationStatus)
    )
  )
    return refusal('invalid_claim');
  const base = {
    version: 'horse-journaled-model-report-v1',
    sourceRelease: releaseSha,
    population: 'journaled_qualified_observations',
    sourceCoverage: 'not_established',
    activationAuthorized: false,
    causalEvEstablished: false,
    actorKey: claim.actorKey,
    scopeKey: claim.scopeKey,
    fromMs: claim.fromMs,
    toMs: claim.toMs,
    snapshotId: claim.snapshotId,
    evidenceDigest: claim.evidenceDigest,
    prior: JOURNALED_MODEL_PRIOR,
    // The prior diagnoses captured action frequencies. It is not a legal
    // action policy, population calibration, solver distribution or EV.
    priorPurpose: 'unconditional_action_frequency_diagnostic',
    holdoutUse: 'repeated_diagnostic_no_selection_correction',
  };
  if (claim.populationStatus !== 'snapshot') {
    if (
      claim.rows.length !== 0 ||
      (claim.populationStatus === 'observation_budget_exceeded'
        ? claim.observations <= ADAPTIVE_JOURNAL_LIMITS.observations
        : claim.bytes <= ADAPTIVE_JOURNAL_LIMITS.batchBytes)
    )
      return refusal('invalid_claim');
    return {
      status: 'prepared' as const,
      report: { ...base, status: 'refused', reason: claim.populationStatus },
    };
  }
  if (claim.observations !== claim.rows.length) return refusal('invalid_claim');
  const raw = claim.rows as unknown[];
  if (raw.some((r) => typeof r !== 'string')) return refusal('invalid_claim');
  const rows = raw as string[];
  if (
    rows.reduce((sum, r) => sum + Buffer.byteLength(r), 0) !== claim.bytes ||
    claim.bytes > ADAPTIVE_JOURNAL_LIMITS.batchBytes ||
    hash(rows.join('\n')) !== claim.evidenceDigest
  )
    return refusal('invalid_claim');
  try {
    const observations = decodeScopedAdaptiveJournalObservations(rows, claim.scopeKey);
    let previous = '';
    for (const o of observations) {
      if (
        o.actorKey !== claim.actorKey ||
        o.scopeKey !== claim.scopeKey ||
        o.observedAtMs < claim.fromMs ||
        o.observedAtMs >= claim.toMs ||
        o.observationId <= previous
      )
        return refusal('invalid_claim');
      previous = o.observationId;
    }
    const cohorts = (['human', 'horse_policy'] as const).map((cohort) => {
      const input = {
        observations,
        opponentKey: claim.actorKey as string,
        scopeKey: claim.scopeKey as string,
        cohort,
        window: {
          fromMs: claim.fromMs as number,
          toMs: claim.toMs as number,
          journalComplete: true,
        },
        prior: JOURNALED_MODEL_PRIOR,
      };
      return {
        cohort,
        ...buildJournaledOpponentStudy(input),
      };
    });
    return {
      status: 'prepared' as const,
      report: { ...base, status: 'computed', observations: observations.length, cohorts },
    };
  } catch {
    return refusal('invalid_claim');
  }
}

/** Durable lease, exact snapshot, deterministic fit and fenced publication.
 * The cursor advances only with its private result. Retrying a lost response
 * cannot fit an update twice or complete the next worker's lease. */
export async function processJournaledOpponentModels(): Promise<JournaledModelCycle> {
  const enabled = process.env.HORSE_JOURNALED_MODELS;
  if (enabled === 'off') return 'disabled';
  if (enabled !== undefined && enabled !== 'on') return 'unknown';
  const release = resolveReleaseIdentity().releaseSha;
  if (!release) return 'unknown';
  const token = randomUUID();
  try {
    const { data, error } = await call('fn_claim_horse_journaled_model', { p_lease_token: token });
    if (error || !data || typeof data !== 'object' || Array.isArray(data)) return 'unknown';
    if (data.version === 1 && data.status === 'idle') return 'idle';
    const built = buildJournaledOpponentReport(data, token, release);
    if (built.status !== 'prepared') return 'unknown';
    const payload = JSON.stringify(built.report);
    if (Buffer.byteLength(payload) > 65536) return 'unknown';
    const result = await call('fn_finish_horse_journaled_model', {
      p_lease_token: token,
      p_report: payload,
    });
    if (result.error || result.data?.version !== 1) return 'unknown';
    if (result.data.status === 'lease_lost') return 'lease_lost';
    if (result.data.status === 'capacity_full') return 'capacity_full';
    return result.data.status === 'recorded' && result.data.reportDigest === hash(payload)
      ? built.report.status === 'refused'
        ? 'refused'
        : 'recorded'
      : 'unknown';
  } catch {
    return 'unknown';
  }
}
