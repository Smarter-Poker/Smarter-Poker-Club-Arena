import { isHorseOwnerForcedAuthority } from '../../engine/HorseOwnerForcedActivation.js';
import type { HorseDecision } from '../../types.js';
import type { HorseExecutionWitness } from '../../engine/HorseExecutionWitness.js';
import type {
  FastHorseDecisionRequest,
  DeepHorseDecisionRequest,
} from '../../engine/horseDecision/protocol.js';
import {
  decodeHorseDecisionReads,
  type HorseDecisionReadFrame,
} from '../../engine/HorseDecisionReadFrame.js';
import {
  HorseQualifiedAuthorityHolder,
  type HorseAuthorityAdmission,
} from '../../engine/HorseQualifiedAuthority.js';
import {
  horseCanonicalMaterialSha256,
  horseTournamentUtilityEvidenceSha256,
} from '../../engine/HorseTournamentUtilityEvidence.js';
import { horsePlanHandKey } from '../../engine/HorseDecisionEffects.js';
import { horseTournamentProvenanceMatchesSnapshot } from '../../engine/HorseTournamentContextProvenance.js';
import { horseRetainedPlanContext } from './effects.js';
import { PHASE11_PROTECTED_RELEASE_SELECTIONS } from '../../engine/HorsePhase11Authority.js';
import { PHASE12_PROTECTED_RELEASE_SELECTIONS } from '../../engine/HorsePhase12Authority.js';
import { PHASE13_PROTECTED_RELEASE_SELECTIONS } from '../../engine/HorsePhase13Authority.js';
import { HORSE_PHASE14_DOMAINS } from '../../engine/HorsePhase14Authority.js';
import { isHorseDecisionReplayState } from '../../engine/horseDecision/replayState.js';
import {
  horseDecisionReceiptIsValid,
  horseSamplingStateIsValid,
  horseTournamentUtilityReceiptIsValid,
  horsePhase7EvidenceMismatch,
} from '../../engine/horseDecision/responseValidation.js';
import {
  qualifiedReplayAdmissions,
  qualifiedReplayAuthorityHolders,
} from '../../engine/horseDecision/replay/qualifiedAuthority.js';
import { correctiveKernelReceiptIsValid } from '../horseCorrectiveReview/kernelReceipt.js';
import { correctiveRiverSnapshotRefusal } from '../horseCorrectiveReview/kernelEligibility.js';
import { classifyTournamentRiverSnapshot } from '../horseCorrectiveReview/kernelTournamentEligibility.js';
import {
  isValidatedFunctionalKernelCatalog,
  functionalKernelSnapshotRefusal,
  functionalKernelCatalogDigest,
} from '../horseCorrectiveReview/kernelObjective.js';
import { horseJournalJson, journalHash } from './record.js';
import type { HorsePlanEffectsReview } from './review.js';

const baselineDomains = Object.freeze({
  phase11: Object.freeze(Object.keys(PHASE11_PROTECTED_RELEASE_SELECTIONS)),
  phase12: Object.freeze(Object.keys(PHASE12_PROTECTED_RELEASE_SELECTIONS)),
  phase13: Object.freeze(Object.keys(PHASE13_PROTECTED_RELEASE_SELECTIONS)),
});
const admissionKeys = new Set([
  'features',
  'phase8',
  'phase8_guard',
  'phase10',
  ...Object.entries(baselineDomains).flatMap(([owner, domains]) =>
    domains.map((domain) => `${owner}:${domain}`)
  ),
  ...HORSE_PHASE14_DOMAINS.map((domain) => `phase14:${domain}`),
]);
/** Closed maintained registries, not packet-provided keys or an arbitrary cap. */
export const HORSE_FLEET_ADMISSION_BOUND = admissionKeys.size;
const correctiveAdmissionKey = (domain: string) => {
  if (typeof domain !== 'string' || !HORSE_PHASE14_DOMAINS.includes(domain))
    throw Error('unsupported_qualification_domain');
  return `phase14:${domain}`;
};
export const HORSE_PHASE_KEYS = Object.freeze(
  Array.from({ length: 15 }, (_, i) => `phase${i + 1}`)
);
export type HorsePhaseStatus =
  | 'applicable-active'
  | 'shadow'
  | 'refused'
  | 'outside-domain'
  | 'unobserved'
  | 'unknown';
export const HORSE_PHASE_STATUS_ORDER: readonly HorsePhaseStatus[] = Object.freeze([
  'applicable-active',
  'shadow',
  'refused',
  'outside-domain',
  'unobserved',
  'unknown',
]);
export interface HorsePhaseProof {
  status: HorsePhaseStatus;
  capability: 'captured' | 'unobserved';
  eligibility: 'eligible' | 'outside-domain' | 'unknown';
  qualification: 'verified' | 'owner-forced' | 'unknown' | 'refused';
  application: 'accepted' | 'not-selected' | 'shadow' | 'refused' | 'not-applicable' | 'unknown';
  /** Closed local vocabulary only: never an exception, path, actor or payload. */
  reason: string;
}
export type HorsePhaseProofs = Record<string, HorsePhaseProof>;
export interface HorsePhaseCapture {
  snapshot: FastHorseDecisionRequest | DeepHorseDecisionRequest;
  decision: HorseDecision;
  readFrame: HorseDecisionReadFrame;
  effects?: readonly unknown[];
  rngBefore?: number;
  originalFastBinding?: { inputDigest: string; readFrameDigest: string };
  /** Reader-supplied validated envelope, never trusted from the body itself. */
  recordEnvelope?: HorsePhaseRecordEnvelope;
  replayState?: {
    admission?: Record<string, unknown>;
    corrective?: { mode?: unknown; domain?: unknown; catalogDigest?: unknown };
  };
  readiness?: unknown;
}
export interface HorsePhaseRecordEnvelope {
  producerId: string;
  sourceRelease: string | null;
  handKey: string;
  sequence: number;
}
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const sha256 = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const same = (a: unknown, b: unknown) => horseJournalJson(a) === horseJournalJson(b);
const digest = (v: unknown) => journalHash(horseJournalJson(v));
const unknown = (reason: string, captured = false): HorsePhaseProof => ({
  status: 'unknown',
  capability: captured ? 'captured' : 'unobserved',
  eligibility: 'unknown',
  qualification: 'unknown',
  application: 'unknown',
  reason,
});
const outside = (): HorsePhaseProof => ({
  status: 'outside-domain',
  capability: 'captured',
  eligibility: 'outside-domain',
  qualification: 'unknown',
  application: 'not-applicable',
  reason: 'outside_declared_runtime_domain',
});
const refused = (reason: string): HorsePhaseProof => ({
  status: 'refused',
  capability: 'captured',
  eligibility: 'eligible',
  qualification: 'refused',
  application: 'refused',
  reason,
});
const active = (
  reason: string,
  application: HorsePhaseProof['application'] = 'accepted'
): HorsePhaseProof => ({
  status: 'applicable-active',
  capability: 'captured',
  eligibility: 'eligible',
  qualification: 'verified',
  application,
  reason,
});

/** One private bounded read owns this cache. It can admit only the protected
 * release's maintained evidence; packet/capture fields never supply admission.
 * The existing offline verifier restores original epochs only after ordinary
 * source/qualification admission. No live gate or policy is changed. */
export class HorseFleetPhaseInterpreter {
  private readonly admissions = new Map<string, unknown>();
  private readonly replayAdmissions: typeof qualifiedReplayAdmissions;
  constructor(private readonly checkBudget: () => void) {
    const once = (key: string, read: () => unknown) => {
      this.checkBudget();
      if (!admissionKeys.has(key)) throw Error('unsupported_qualification_domain');
      if (!this.admissions.has(key)) {
        if (this.admissions.size >= HORSE_FLEET_ADMISSION_BOUND) throw Error('qualification_bound');
        this.admissions.set(key, read());
        this.checkBudget();
      }
      return this.admissions.get(key);
    };
    this.replayAdmissions = {
      admitFeatureAuthority: () =>
        once('features', qualifiedReplayAdmissions.admitFeatureAuthority) as ReturnType<
          typeof qualifiedReplayAdmissions.admitFeatureAuthority
        >,
      admitPhase8Authority: () =>
        once('phase8', qualifiedReplayAdmissions.admitPhase8Authority) as ReturnType<
          typeof qualifiedReplayAdmissions.admitPhase8Authority
        >,
      admitPhase8GuardAuthority: () =>
        once('phase8_guard', qualifiedReplayAdmissions.admitPhase8GuardAuthority) as ReturnType<
          typeof qualifiedReplayAdmissions.admitPhase8GuardAuthority
        >,
      admitPhase10Authority: () =>
        once('phase10', qualifiedReplayAdmissions.admitPhase10Authority) as ReturnType<
          typeof qualifiedReplayAdmissions.admitPhase10Authority
        >,
      admitPhase11Authority: (v) =>
        once(`phase11:${v}`, () =>
          qualifiedReplayAdmissions.admitPhase11Authority(v)
        ) as ReturnType<typeof qualifiedReplayAdmissions.admitPhase11Authority>,
      admitPhase12Authority: (v) =>
        once(`phase12:${v}`, () =>
          qualifiedReplayAdmissions.admitPhase12Authority(v)
        ) as ReturnType<typeof qualifiedReplayAdmissions.admitPhase12Authority>,
      admitPhase13Authority: (v) =>
        once(`phase13:${v}`, () =>
          qualifiedReplayAdmissions.admitPhase13Authority(v)
        ) as ReturnType<typeof qualifiedReplayAdmissions.admitPhase13Authority>,
      admitPhase14Attachment: (d) =>
        once(correctiveAdmissionKey(d), () =>
          qualifiedReplayAdmissions.admitPhase14Attachment(d)
        ) as ReturnType<typeof qualifiedReplayAdmissions.admitPhase14Attachment>,
    };
  }

  /** Called only after the original hand/source/window reconciliation and exact
   * accepted-action binding. This is applicability evidence, never an activation
   * command, an offline-phase certificate or a declaration of full population. */
  interpret(
    c: HorsePhaseCapture,
    w: HorseExecutionWitness,
    plans: HorsePlanEffectsReview,
    originalCaptures: readonly HorsePhaseCapture[] = [],
    currentRecord?: HorsePhaseRecordEnvelope
  ): HorsePhaseProofs {
    const out = Object.fromEntries(
      HORSE_PHASE_KEYS.map((p) => [p, unknown('phase_capture_unavailable')])
    );
    const d = c.decision,
      gs = c.snapshot.gameState;
    if (!horseDecisionReceiptIsValid(d, gs.gameVariant) || w.executionStatus !== 'intended')
      return out;
    let originalFast: HorsePhaseCapture | undefined =
      c.snapshot.type === 'DECIDE_FAST' ? c : undefined;
    if (c.snapshot.type === 'DECIDE_DEEP') {
      const reject = (missing: boolean, reason: string) =>
        Object.fromEntries(
          HORSE_PHASE_KEYS.map((p) => [
            p,
            p === 'phase9'
              ? unknown('offline_programme_qualification_required')
              : missing
                ? unknown(reason, true)
                : refused(reason),
          ])
        );
      if (
        c.originalFastBinding === undefined ||
        c.effects === undefined ||
        c.replayState === undefined
      )
        return reject(true, 'deep_original_metadata_unavailable');
      const pins = c.originalFastBinding;
      if (
        !isObject(pins) ||
        Object.keys(pins).sort().join(',') !== 'inputDigest,readFrameDigest' ||
        !sha256(pins.inputDigest) ||
        !sha256(pins.readFrameDigest) ||
        !Array.isArray(c.effects) ||
        c.effects.length !== 0 ||
        !isHorseDecisionReplayState(c.replayState) ||
        !horseSamplingStateIsValid(c.rngBefore) ||
        c.snapshot.rngBefore !== c.rngBefore ||
        digest(c.readFrame) !== pins.readFrameDigest
      )
        return reject(false, 'deep_original_metadata_invalid');
      if (
        !currentRecord ||
        !Number.isSafeInteger(currentRecord.sequence) ||
        currentRecord.sequence <= 0 ||
        typeof currentRecord.sourceRelease !== 'string' ||
        !/^[a-f0-9]{40}$/.test(currentRecord.sourceRelease) ||
        !sha256(currentRecord.handKey)
      )
        return reject(true, 'deep_record_envelope_unavailable');
      const matches: HorsePhaseCapture[] = [];
      for (const prior of originalCaptures) {
        this.checkBudget();
        const envelope = prior.recordEnvelope;
        if (
          prior.snapshot.type === 'DECIDE_FAST' &&
          envelope &&
          envelope.producerId === currentRecord.producerId &&
          envelope.sourceRelease === currentRecord.sourceRelease &&
          envelope.handKey === currentRecord.handKey &&
          Number.isSafeInteger(envelope.sequence) &&
          envelope.sequence > 0 &&
          envelope.sequence < currentRecord.sequence &&
          prior.snapshot.fence === c.snapshot.fence &&
          prior.snapshot.generation === c.snapshot.generation &&
          prior.snapshot.player.user_id === c.snapshot.player.user_id &&
          prior.snapshot.decisionKey === c.snapshot.decisionKey &&
          prior.rngBefore === c.rngBefore &&
          digest(prior.snapshot) === pins.inputDigest &&
          digest(prior.readFrame) === pins.readFrameDigest
        )
          matches.push(prior);
      }
      if (matches.length !== 1) return reject(false, 'deep_original_binding_mismatch');
      originalFast = matches[0];
    }
    out.phase1 = unknown('qualified_artifact_provenance_not_verified', !!c.readiness);
    out.phase2 = unknown('qualified_chart_use_not_verified', !!c.readiness);
    out.phase3 = active('original_accepted_hand_reconciled');
    out.phase4 = unknown('certified_corpus_use_not_verified', !!c.readiness);
    out.phase5 = active('controller_accepted_action_bound');
    out.phase9 = unknown('offline_programme_qualification_required');
    out.phase15 = {
      ...unknown('exact_historical_replay_not_verified', !!d.policyGraph),
      eligibility: 'eligible',
      application:
        Array.isArray(c.effects) && c.effects.length === 0
          ? 'not-applicable'
          : plans.applicationVerified
            ? 'accepted'
            : 'unknown',
    };
    const preflop = gs.stage === 'preflop';
    out.phase6 = !preflop
      ? outside()
      : d.tournamentPreflopAttribution
        ? {
            ...unknown('atlas_qualification_not_verified', true),
            eligibility: 'eligible',
            application: 'accepted',
          }
        : unknown('preflop_attribution_missing');
    const tournament = gs.gameMode === 'tournament';
    if (!tournament)
      out.phase7 = gs.gameMode === 'cash' ? outside() : unknown('utility_domain_unavailable');
    else if (c.snapshot.opts?.phase7Utility === false)
      out.phase7 = refused('utility_disabled_by_request');
    else if (d.tournamentUtilityRefusal) out.phase7 = refused('utility_refused');
    else if (
      gs.tournament?.schemaVersion !== 1 ||
      gs.tournament.contextStatus !== 'complete' ||
      !horseTournamentProvenanceMatchesSnapshot(c.snapshot)
    )
      out.phase7 = refused('utility_context_unsupported');
    else if (!d.tournamentUtility) out.phase7 = unknown('utility_receipt_missing');
    else {
      const ledger = d.tournamentUtility,
        evidence = ledger.evidence,
        accepted = w.phase7Evidence;
      if (!evidence || !accepted) out.phase7 = unknown('utility_original_evidence_missing', true);
      else
        try {
          this.checkBudget();
          const plan = horseRetainedPlanContext(c, c.snapshot);
          if (plan.kind === 'invalid') throw Error();
          decodeHorseDecisionReads(
            c.readFrame,
            gs.players,
            horsePlanHandKey(gs.actionHistory, plan.kind === 'current' ? plan.context : undefined),
            plan.kind === 'current' ? plan.context : undefined
          );
          if (
            !horseTournamentUtilityReceiptIsValid(ledger, {
              action: ledger.selectedAction,
              amount: ledger.selectedAmount ?? undefined,
            }) ||
            horsePhase7EvidenceMismatch(d, c.snapshot) !== null ||
            accepted.version !== 'horse-phase7-accepted-evidence-v1' ||
            ledger.readFrameSha256 !== c.readFrame.sha256 ||
            accepted.readFrameSha256 !== c.readFrame.sha256 ||
            accepted.inputSha256 !== evidence.inputSha256 ||
            accepted.evidenceSha256 !== horseTournamentUtilityEvidenceSha256(evidence) ||
            accepted.selectedAction !== ledger.selectedAction ||
            accepted.selectedAmount !== ledger.selectedAmount
          )
            throw Error();
          out.phase7 = active(
            'supported_uncalibrated_utility_baseline',
            w.selected.action === ledger.selectedAction &&
              w.selected.amount === ledger.selectedAmount
              ? 'accepted'
              : 'not-selected'
          );
        } catch {
          this.checkBudget();
          out.phase7 = refused('utility_original_evidence_mismatch');
        }
    }

    const variant = gs.gameVariant;
    // Tournament metadata has three outcomes: a genuine missing capture must
    // not be silently counted as a known outside-family hand. DEEP uses its
    // uniquely reconciled retained FAST information set, never a later state.
    const tournamentCorrectiveFamily = tournament
      ? classifyTournamentRiverSnapshot(originalFast?.snapshot ?? c.snapshot)
      : null;
    const guardMode = c.replayState?.admission?.phase8CatastropheGuard;
    const guardPhase8 =
      d.tournamentCatastropheGuard !== undefined ||
      guardMode === 'candidate' ||
      guardMode === 'shadow';
    const guardDomain =
      tournament &&
      !preflop &&
      variant === 'nlh' &&
      (gs.boardCount ?? 1) === 1 &&
      !gs.communityCards2?.length &&
      !gs.communityCards3?.length;
    const policies = [
      [
        'phase8',
        guardPhase8 ? d.tournamentCatastropheGuard : d.tournamentPostflop,
        guardPhase8 ? w.phase8GuardAuthority : w.phase8Authority,
        guardPhase8 ? 'phase8CatastropheGuard' : 'phase8Postflop',
        null,
        guardPhase8 ? guardDomain : tournament && !preflop,
      ],
      ['phase10', d.plo4Policy, w.phase10Authority, 'phase10Plo4', null, variant === 'plo4'],
      [
        'phase11',
        d.omahaVariantPolicy,
        w.phase11Authority,
        'phase11Omaha',
        variant,
        ['plo5', 'plo6', 'plo8'].includes(variant),
      ],
      [
        'phase12',
        d.remainingVariantPolicy,
        w.phase12Authority,
        'phase12Remaining',
        variant,
        ['short_deck', 'pineapple', 'flh', 'flo8'].includes(variant),
      ],
      ['phase13', d.jointPolicy, w.phase13Authority, 'phase13Joint', variant, true],
      [
        'phase14',
        d.correctivePolicy,
        w.phase14Authority,
        null,
        d.correctivePolicy?.domain ?? '',
        // This owner reads only player/gameState, shared by both request lanes.
        tournamentCorrectiveFamily
          ? tournamentCorrectiveFamily.status === 'eligible'
          : correctiveRiverSnapshotRefusal(c.snapshot as FastHorseDecisionRequest) === null,
      ],
    ] as const;
    for (const [owner, receipt, binding, option, pack, domain] of policies) {
      if (owner === 'phase14' && tournamentCorrectiveFamily?.status === 'gap') {
        out[owner] = unknown('corrective_original_metadata_unavailable', true);
        continue;
      }
      if (!domain) {
        out[owner] = outside();
        continue;
      }
      if (!receipt || !binding) {
        out[owner] = unknown('owner_receipt_missing');
        continue;
      }
      const r = receipt as unknown as Record<string, any>;
      if (binding.mode === 'shadow') {
        out[owner] = {
          ...unknown('owner_in_shadow', true),
          status: 'shadow',
          eligibility: r.eligible === false ? 'unknown' : 'eligible',
          application: 'shadow',
        };
        continue;
      }
      const mode = option ? c.replayState?.admission?.[option] : c.replayState?.corrective?.mode;
      if (mode !== 'candidate') {
        out[owner] = unknown('candidate_admission_not_captured', true);
        continue;
      }
      if (
        owner !== 'phase14' &&
        (r.eligible !== true || r.fired !== true || (owner === 'phase8' && r.completed !== true))
      ) {
        out[owner] = {
          ...refused('eligible_owner_did_not_complete'),
          eligibility: r.eligible === true ? 'eligible' : 'unknown',
        };
        continue;
      }
      if (
        owner === 'phase10' &&
        (r.readFrameSha256 !== c.readFrame.sha256 ||
          w.phase10Inputs?.readFrameSha256 !== c.readFrame.sha256)
      ) {
        out[owner] = refused('original_read_frame_mismatch');
        continue;
      }
      if (['phase10', 'phase11', 'phase12', 'phase13'].includes(owner)) {
        const input =
          owner === 'phase10'
            ? w.phase10Inputs
            : owner === 'phase11'
              ? w.phase11Inputs
              : owner === 'phase12'
                ? w.phase12Inputs
                : w.phase13Inputs;
        if (!r.inputs || !input || input.inputSha256 !== horseCanonicalMaterialSha256(r.inputs)) {
          out[owner] = refused('original_owner_input_binding_missing');
          continue;
        }
      }
      if (owner === 'phase14') {
        const input = w.phase14Inputs;
        const original = originalFast;

        if (
          !correctiveKernelReceiptIsValid(d) ||
          !input ||
          !original ||
          input.inputDigest !== digest(original.snapshot) ||
          input.readFrameDigest !== digest(c.readFrame) ||
          ![
            'domain',
            'catalogDigest',
            'policyDigest',
            'baselineSelectionsDigest',
            'inputDigest',
            'readFrameDigest',
            'samplingContractDigest',
          ].every((key) => (input as any)[key] === r[key]) ||
          c.replayState?.corrective?.domain !== r.domain ||
          c.replayState?.corrective?.catalogDigest !== r.catalogDigest ||
          (r.version === 'horse-corrective-live-kernel-v2' &&
            r.tournamentContextDigest !== digest(original.snapshot.gameState.tournament))
        ) {
          out[owner] = refused('corrective_original_input_mismatch');
          continue;
        }
      }
      try {
        const receiptAuthority = r.authority;
        if (
          !receiptAuthority ||
          !binding.authority ||
          !same(
            { ...receiptAuthority, mainGeneration: null },
            { ...binding.authority, mainGeneration: null }
          )
        )
          throw Error();
        const restore = qualifiedReplayAuthorityHolders(d, variant, this.replayAdmissions);
        const correctiveAttachment =
          owner === 'phase14' ? this.replayAdmissions.admitPhase14Attachment(pack ?? '') : null;
        if (
          owner === 'phase14' &&
          (!correctiveAttachment ||
            !isValidatedFunctionalKernelCatalog(correctiveAttachment.catalog) ||
            !originalFast ||
            functionalKernelSnapshotRefusal(
              originalFast.snapshot as FastHorseDecisionRequest,
              correctiveAttachment.catalog
            ) !== null ||
            functionalKernelCatalogDigest(correctiveAttachment.catalog) !== r.catalogDigest ||
            ('objective' in correctiveAttachment.catalog &&
              (correctiveAttachment.catalog.objective !== r.objective ||
                correctiveAttachment.catalog.utilityUnit !== r.utilityUnit)))
        )
          throw Error();
        const admission: HorseAuthorityAdmission =
          owner === 'phase8'
            ? guardPhase8
              ? this.replayAdmissions.admitPhase8GuardAuthority()
              : this.replayAdmissions.admitPhase8Authority()
            : owner === 'phase10'
              ? this.replayAdmissions.admitPhase10Authority()
              : owner === 'phase11'
                ? this.replayAdmissions.admitPhase11Authority(variant as any)
                : owner === 'phase12'
                  ? this.replayAdmissions.admitPhase12Authority(variant as any)
                  : owner === 'phase13'
                    ? this.replayAdmissions.admitPhase13Authority(variant as any)
                    : correctiveAttachment!.admission;
        const holder = HorseQualifiedAuthorityHolder.fromReplayReceipt(
          receiptAuthority,
          admission,
          receiptAuthority.continuationVersion
        );
        let forcedBaseline = false;
        // Corrective composition also binds every selected baseline owner,
        // including an admitted baseline whose proposal did not apply here.
        if (owner === 'phase14')
          for (const [baseline, value] of Object.entries(r.baselineAuthorities ?? {})) {
            const authority = value as any;
            const h = restore(
              baseline as any,
              baseline === 'phase8' || baseline === 'phase8_guard' || baseline === 'phase10'
                ? null
                : variant,
              authority.continuationVersion,
              authority.epoch
            );
            if (!h.current() || h.currentState() !== 'usable') throw Error();
            if (isHorseOwnerForcedAuthority(h.current())) forcedBaseline = true;
          }
        if (
          !holder.current() ||
          holder.currentState() !== 'usable' ||
          (receiptAuthority.expiresAt !== null &&
            Date.now() >= Date.parse(receiptAuthority.expiresAt))
        )
          throw Error();
        if (
          binding.selection === 'withdrawn_before_acceptance' ||
          (binding.verdict !== null && binding.verdict !== 'usable')
        ) {
          out[owner] = refused('authority_withdrawn_before_acceptance');
          continue;
        }
        const selected = r.applied === true;
        if (
          selected &&
          (binding.selection !== 'controller_accepted' || binding.verdict !== 'usable')
        ) {
          out[owner] = refused('candidate_not_controller_accepted');
          continue;
        }
        const forced =
          (admission.status === 'admitted' && isHorseOwnerForcedAuthority(admission.authority)) ||
          forcedBaseline;
        out[owner] = {
          ...active(
            forced
              ? 'owner_forced_not_independently_qualified'
              : 'protected_owner_independently_qualified',
            selected ? 'accepted' : 'not-selected'
          ),
          qualification: forced ? 'owner-forced' : 'verified',
        };
      } catch {
        this.checkBudget();
        out[owner] = {
          ...unknown('protected_qualification_unavailable', true),
          eligibility: 'eligible',
          application: 'unknown',
        };
      }
    }
    return out;
  }
}
