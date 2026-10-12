/**
 * Phase 14.4 (plan package P14-D, inactive slice): the corrective candidate
 * catalog. Pure and in memory. It reads corrective review outputs and a
 * declared selection protocol, and returns a digest-bound list of candidates
 * that are ALL `proposed_inactive` with `activationAllowed: false`.
 *
 * What it does:
 * - keys each candidate by a stable id derived from its binding (original
 *   decision, execution, accepted hand, input, read frame, source release), its
 *   domain and its from/to actions, so the same proposal has the same id
 *   whatever its measured gain was;
 * - requires an explicit selection window and an explicit holdout window, each
 *   a set of hands named by committed hand id AND journal hand key, and refuses
 *   `holdout_leakage` when any holdout hand or hand key appears in the selection
 *   window or in any selection review;
 * - requires a finite selection protocol declared before the holdout window
 *   opens, refuses a protocol that names the selection window as its validation
 *   (`selection_window_reused_as_validation`) and caps its candidates;
 * - requires a complete baseline policy distribution for every covered
 *   information set (`incomplete_policy_distribution`): a probability for every
 *   action of the reference's complete legal menu, nothing outside it, summing
 *   to 1 within `CORRECTIVE_CATALOG_LIMITS.probabilityTolerance`;
 * - refuses mixed synthetic and reviewed evidence anywhere in its input.
 *
 * What it does not do: evaluate the holdout, select, promote, sign, persist or
 * apply anything. `holdoutEvaluated` and `activationAllowed` are false in every
 * result. A built catalog is input to an independent holdout evaluation and a
 * Phase 14 qualification, neither of which exists in this repository.
 */
import { horseJournalJson, journalHash } from '../horseDecisionJournal/record.js';
import { actorIdValid } from './eligibility.js';
import { sha256 } from './authority.js';
import {
  correctiveDomainIsValid,
  correctiveDomainKey,
  type CorrectiveReferenceDomain,
} from './domain.js';
import type {
  CorrectiveAction,
  CorrectiveHandReview,
  CorrectiveReferenceBinding,
  InactiveCorrectiveCandidate,
} from './contract.js';

export const CORRECTIVE_CATALOG_VERSION = 'horse-corrective-candidate-catalog-v1' as const;
export const CORRECTIVE_SELECTION_PROTOCOL_VERSION = 'horse-corrective-selection-protocol-v1';
export const CORRECTIVE_CATALOG_LIMITS = Object.freeze({
  reviews: 4096,
  windowHands: 65536,
  candidates: 1024,
  distributions: 4096,
  probabilityTolerance: 1e-9,
  minimumConservativeGain: 0.01,
});

export interface CorrectiveWindowHand {
  /** Committed hand id (UUID). */
  handId: string;
  /** SHA256 journal hand coordinate. */
  handKey: string;
}
export interface CorrectiveEvidenceWindow {
  from: string;
  to: string;
  hands: CorrectiveWindowHand[];
}

/** Declared, finite and fixed before any holdout hand is looked at. */
export interface CorrectiveSelectionProtocol {
  version: typeof CORRECTIVE_SELECTION_PROTOCOL_VERSION;
  protocolId: string;
  declaredAt: string;
  /** The window candidates are chosen on. */
  selectionWindow: CorrectiveEvidenceWindow;
  /** The window validation will use. Disjoint from the selection window. */
  holdoutWindow: CorrectiveEvidenceWindow;
  /** The domains the protocol may propose candidates in. */
  domains: CorrectiveReferenceDomain[];
  /** Hard cap on catalogued candidates. */
  maxCandidates: number;
  /** A candidate below this conservative gain is not selected. At least 0.01. */
  minimumConservativeGain: number;
  /** Which window validates. Only the holdout is accepted. */
  validationWindow: 'holdout';
}

/** The baseline policy at one covered information set. */
export interface CorrectivePolicyDistribution {
  domain: CorrectiveReferenceDomain;
  /** The binding's `inputDigest`: the complete original decision input. */
  informationSetDigest: string;
  probabilities: Array<{ choice: CorrectiveAction; probability: number }>;
}

export interface CorrectiveCatalogInput {
  protocol: CorrectiveSelectionProtocol;
  /** Selection-window reviews, each declared with the committed hand it reviewed. */
  reviews: ReadonlyArray<{ handId: string; review: CorrectiveHandReview }>;
  distributions: readonly CorrectivePolicyDistribution[];
}

export interface CorrectiveCatalogEntry {
  id: string;
  status: 'proposed_inactive';
  activationAllowed: false;
  domain: CorrectiveReferenceDomain;
  domainKey: string;
  binding: CorrectiveReferenceBinding;
  informationSetDigest: string;
  handId: string;
  handKey: string;
  reviewId: string;
  sourceCandidateId: string;
  qualificationId: string;
  samplingContractDigest: string;
  producerDigest: string;
  utilityUnit: InactiveCorrectiveCandidate['utilityUnit'];
  from: CorrectiveAction;
  to: CorrectiveAction;
  conservativeGain: number;
  maximumProbabilityDelta: 0.05;
  baselineDistribution: Array<{ choice: CorrectiveAction; probability: number }>;
  /** The baseline moved by at most `maximumProbabilityDelta` from `from` to `to`. Never applied. */
  proposedDistribution: Array<{ choice: CorrectiveAction; probability: number }>;
  requiredBeforeActivation: InactiveCorrectiveCandidate['requiredBeforeActivation'];
}

export interface CorrectiveCandidateCatalog {
  version: typeof CORRECTIVE_CATALOG_VERSION;
  status: 'built' | 'refused';
  reasons: string[];
  protocolDigest: string | null;
  selectionWindowDigest: string | null;
  holdoutDigest: string | null;
  evidenceClass: 'synthetic_fixture' | 'reviewed_reference' | null;
  domains: string[];
  entries: CorrectiveCatalogEntry[];
  /** Reviews that contributed no candidates, with the reason. Never dropped silently. */
  excludedReviews: Array<{ reviewId: string; reason: string }>;
  /** Candidates the protocol did not select, with the reason. */
  unselectedCandidates: Array<{ candidateId: string; reason: string }>;
  catalogDigest: string | null;
  holdoutEvaluated: false;
  activationAllowed: false;
}

const ID = /^[a-zA-Z0-9_.:-]{1,128}$/;
const isoMs = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
};
const ACTIONS = ['fold', 'check', 'call', 'bet', 'raise', 'all_in'];
const actionIsWellFormed = (a: unknown): a is CorrectiveAction =>
  !!a &&
  typeof a === 'object' &&
  Object.keys(a).sort().join(',') === 'action,amount' &&
  ACTIONS.includes((a as CorrectiveAction).action) &&
  Number.isFinite((a as CorrectiveAction).amount) &&
  (a as CorrectiveAction).amount >= 0;
const actionKey = (a: CorrectiveAction) => horseJournalJson({ action: a.action, amount: a.amount });
const BINDING_KEYS = [
  'acceptedHandDigest',
  'decisionDigest',
  'decisionEventId',
  'executionDigest',
  'inputDigest',
  'readFrameDigest',
  'sourceRelease',
];
const bindingIsWellFormed = (b: unknown): b is CorrectiveReferenceBinding => {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return false;
  const x = b as Record<string, unknown>;
  return (
    Object.keys(x).sort().join(',') === BINDING_KEYS.join(',') &&
    typeof x.decisionEventId === 'string' &&
    x.decisionEventId.length > 0 &&
    x.decisionEventId.length <= 128 &&
    ['decisionDigest', 'executionDigest', 'acceptedHandDigest', 'inputDigest', 'readFrameDigest']
      .map((k) => x[k])
      .every(sha256) &&
    typeof x.sourceRelease === 'string' &&
    /^[0-9a-f]{40}$/.test(x.sourceRelease)
  );
};

function windowIsWellFormed(w: unknown): w is CorrectiveEvidenceWindow {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return false;
  const x = w as CorrectiveEvidenceWindow;
  const from = isoMs(x.from),
    to = isoMs(x.to);
  return (
    Object.keys(x).sort().join(',') === 'from,hands,to' &&
    from !== null &&
    to !== null &&
    from < to &&
    Array.isArray(x.hands) &&
    x.hands.length > 0 &&
    x.hands.length <= CORRECTIVE_CATALOG_LIMITS.windowHands &&
    x.hands.every(
      (h) =>
        !!h &&
        Object.keys(h).sort().join(',') === 'handId,handKey' &&
        actorIdValid(h.handId) &&
        sha256(h.handKey)
    ) &&
    new Set(x.hands.map((h) => h.handId.toLowerCase())).size === x.hands.length &&
    new Set(x.hands.map((h) => h.handKey)).size === x.hands.length
  );
}

/** Canonical window identity: bounds plus the sorted hand set. */
export function correctiveWindowDigest(window: CorrectiveEvidenceWindow): string {
  return journalHash(
    horseJournalJson([
      CORRECTIVE_CATALOG_VERSION,
      'window',
      window.from,
      window.to,
      window.hands
        .map((h) => [h.handId.toLowerCase(), h.handKey])
        .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0)),
    ])
  );
}

/** Stable candidate identity: domain, binding and the proposed move only. */
export function correctiveCatalogCandidateId(
  domain: CorrectiveReferenceDomain,
  binding: CorrectiveReferenceBinding,
  from: CorrectiveAction,
  to: CorrectiveAction
): string {
  return journalHash(
    horseJournalJson([
      CORRECTIVE_CATALOG_VERSION,
      'candidate',
      domain,
      binding,
      { action: from.action, amount: from.amount },
      { action: to.action, amount: to.amount },
    ])
  );
}

/** Structural validity of the protocol. Ordering and leakage are judged separately. */
function protocolIsWellFormed(p: unknown): p is CorrectiveSelectionProtocol {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  const x = p as CorrectiveSelectionProtocol;
  return (
    x.version === CORRECTIVE_SELECTION_PROTOCOL_VERSION &&
    typeof x.protocolId === 'string' &&
    ID.test(x.protocolId) &&
    isoMs(x.declaredAt) !== null &&
    windowIsWellFormed(x.selectionWindow) &&
    windowIsWellFormed(x.holdoutWindow) &&
    Array.isArray(x.domains) &&
    x.domains.length > 0 &&
    x.domains.every(correctiveDomainIsValid) &&
    new Set(x.domains.map(correctiveDomainKey)).size === x.domains.length &&
    Number.isSafeInteger(x.maxCandidates) &&
    x.maxCandidates > 0 &&
    x.maxCandidates <= CORRECTIVE_CATALOG_LIMITS.candidates &&
    Number.isFinite(x.minimumConservativeGain) &&
    x.minimumConservativeGain >= CORRECTIVE_CATALOG_LIMITS.minimumConservativeGain
  );
}

function candidateIsInactive(c: unknown): c is InactiveCorrectiveCandidate {
  if (!c || typeof c !== 'object') return false;
  const x = c as InactiveCorrectiveCandidate;
  return (
    x.status === 'proposed_inactive' &&
    x.activationAllowed === false &&
    x.kind === 'bounded_action_preference' &&
    x.scope === 'exact_original_information_set' &&
    x.maximumProbabilityDelta === 0.05 &&
    sha256(x.id) &&
    correctiveDomainIsValid(x.domain) &&
    bindingIsWellFormed(x.binding) &&
    actionIsWellFormed(x.from) &&
    actionIsWellFormed(x.to) &&
    actionKey(x.from) !== actionKey(x.to) &&
    Array.isArray(x.menu) &&
    x.menu.length >= 2 &&
    x.menu.every(actionIsWellFormed) &&
    new Set(x.menu.map(actionKey)).size === x.menu.length &&
    x.menu.some((a) => actionKey(a) === actionKey(x.from)) &&
    x.menu.some((a) => actionKey(a) === actionKey(x.to)) &&
    sha256(x.samplingContractDigest) &&
    sha256(x.producerDigest) &&
    typeof x.qualificationId === 'string' &&
    ID.test(x.qualificationId) &&
    ['synthetic_fixture', 'reviewed_reference'].includes(x.evidenceClass) &&
    Number.isFinite(x.conservativeGain) &&
    ['net_chip_bb', 'net_tournament_utility'].includes(x.utilityUnit)
  );
}

/**
 * Build the inactive catalog. Refusals that make the whole catalog unsafe to
 * evaluate (leakage, protocol, mixed evidence, distribution) refuse it with
 * every reason named and no entries. An incomplete review contributes nothing
 * and is listed in `excludedReviews`.
 */
export function buildCorrectiveCandidateCatalog(
  input: CorrectiveCatalogInput
): CorrectiveCandidateCatalog {
  const out: CorrectiveCandidateCatalog = {
    version: CORRECTIVE_CATALOG_VERSION,
    status: 'refused',
    reasons: [],
    protocolDigest: null,
    selectionWindowDigest: null,
    holdoutDigest: null,
    evidenceClass: null,
    domains: [],
    entries: [],
    excludedReviews: [],
    unselectedCandidates: [],
    catalogDigest: null,
    holdoutEvaluated: false,
    activationAllowed: false,
  };
  const reason = (r: string) => {
    if (!out.reasons.includes(r)) out.reasons.push(r);
  };
  const refuse = () => {
    out.status = 'refused';
    out.entries = [];
    out.catalogDigest = null;
    return out;
  };
  try {
    const p = input?.protocol;
    if (!protocolIsWellFormed(p)) {
      reason('selection_protocol_invalid');
      return refuse();
    }
    // The validation window is named explicitly and is never the selection window.
    const selectionDigest = correctiveWindowDigest(p.selectionWindow);
    const holdoutDigest = correctiveWindowDigest(p.holdoutWindow);
    const sFrom = isoMs(p.selectionWindow.from)!,
      sTo = isoMs(p.selectionWindow.to)!,
      hFrom = isoMs(p.holdoutWindow.from)!,
      hTo = isoMs(p.holdoutWindow.to)!;
    if (
      p.validationWindow !== 'holdout' ||
      selectionDigest === holdoutDigest ||
      (hFrom < sTo && sFrom < hTo)
    )
      reason('selection_window_reused_as_validation');
    // Declared before validation: fixed before the holdout window opens.
    if (isoMs(p.declaredAt)! > hFrom) reason('selection_protocol_declared_after_validation');
    out.protocolDigest = journalHash(horseJournalJson([CORRECTIVE_CATALOG_VERSION, 'protocol', p]));
    out.selectionWindowDigest = selectionDigest;
    out.holdoutDigest = holdoutDigest;

    const holdoutIds = new Set(p.holdoutWindow.hands.map((h) => h.handId.toLowerCase()));
    const holdoutKeys = new Set(p.holdoutWindow.hands.map((h) => h.handKey));
    if (
      p.selectionWindow.hands.some(
        (h) => holdoutIds.has(h.handId.toLowerCase()) || holdoutKeys.has(h.handKey)
      )
    )
      reason('holdout_leakage');

    const reviews = Array.isArray(input.reviews) ? input.reviews : null;
    const distributions = Array.isArray(input.distributions) ? input.distributions : null;
    if (
      !reviews ||
      reviews.length > CORRECTIVE_CATALOG_LIMITS.reviews ||
      !distributions ||
      distributions.length > CORRECTIVE_CATALOG_LIMITS.distributions
    ) {
      reason('catalog_input_bounds');
      return refuse();
    }
    const selectionByKey = new Map(
      p.selectionWindow.hands.map((h) => [h.handKey, h.handId.toLowerCase()])
    );
    const protocolDomains = new Set(p.domains.map(correctiveDomainKey));
    const classes = new Set<string>();
    const proposed: Array<{
      handId: string;
      review: CorrectiveHandReview;
      candidate: InactiveCorrectiveCandidate;
    }> = [];
    const seenReviews = new Set<string>();
    for (const item of reviews) {
      const review = item?.review;
      const handId = typeof item?.handId === 'string' ? item.handId.toLowerCase() : '';
      const reviewId = typeof review?.reviewId === 'string' ? review.reviewId : '';
      // Leakage is judged on every supplied review, incomplete ones included:
      // the selection evidence is everything the selector was shown.
      if (holdoutIds.has(handId) || holdoutKeys.has(review?.handKey)) reason('holdout_leakage');
      if (!review || !sha256(reviewId) || !sha256(review.handKey) || !actorIdValid(handId)) {
        reason('selection_review_invalid');
        continue;
      }
      if (seenReviews.has(reviewId)) {
        reason('duplicate_selection_review');
        continue;
      }
      seenReviews.add(reviewId);
      if (selectionByKey.get(review.handKey) !== handId) {
        out.excludedReviews.push({ reviewId, reason: 'review_outside_selection_window' });
        reason('review_outside_selection_window');
        continue;
      }
      if (review.activationAllowed !== false || review.gtoVerified !== false) {
        reason('selection_review_invalid');
        continue;
      }
      if (
        review.evidenceClass === 'synthetic_fixture' ||
        review.evidenceClass === 'reviewed_reference'
      )
        classes.add(review.evidenceClass);
      if (review.status !== 'reviewed') {
        out.excludedReviews.push({ reviewId, reason: 'review_incomplete' });
        continue;
      }
      const actors: CorrectiveHandReview['actors'] = Array.isArray(review.actors)
        ? review.actors
        : [];
      const candidates: unknown[] = actors.flatMap((a) =>
        (Array.isArray(a?.decisions) ? a.decisions : []).flatMap((d) =>
          d?.candidate ? [d.candidate] : []
        )
      );
      if (!candidates.length) {
        out.excludedReviews.push({ reviewId, reason: 'review_has_no_candidate' });
        continue;
      }
      for (const candidate of candidates) {
        if (!candidateIsInactive(candidate)) {
          reason('candidate_invalid');
          continue;
        }
        classes.add(candidate.evidenceClass);
        proposed.push({ handId, review, candidate });
      }
    }
    if (classes.size > 1) reason('mixed_synthetic_and_reviewed_evidence');
    out.evidenceClass =
      classes.size === 1
        ? (classes.values().next().value as CorrectiveCandidateCatalog['evidenceClass'])
        : classes.size > 1
          ? 'synthetic_fixture'
          : null;

    // One distribution per (domain, information set), well formed.
    const distributionByKey = new Map<string, CorrectivePolicyDistribution>();
    for (const d of distributions) {
      if (
        !d ||
        !correctiveDomainIsValid(d.domain) ||
        !sha256(d.informationSetDigest) ||
        !Array.isArray(d.probabilities)
      ) {
        reason('incomplete_policy_distribution');
        continue;
      }
      const key = `${correctiveDomainKey(d.domain)}:${d.informationSetDigest}`;
      if (distributionByKey.has(key)) {
        reason('duplicate_policy_distribution');
        continue;
      }
      distributionByKey.set(key, d);
    }

    const byId = new Map<string, CorrectiveCatalogEntry>();
    const eligible: CorrectiveCatalogEntry[] = [];
    for (const { handId, review, candidate } of proposed) {
      const domainKey = correctiveDomainKey(candidate.domain);
      const id = correctiveCatalogCandidateId(
        candidate.domain,
        candidate.binding,
        candidate.from,
        candidate.to
      );
      if (byId.has(id)) {
        reason('duplicate_candidate_binding');
        continue;
      }
      // Per domain completeness: every covered information set carries a
      // probability for every action of its complete legal menu and sums to 1.
      const distribution = distributionByKey.get(`${domainKey}:${candidate.binding.inputDigest}`);
      const menuKeys = new Set(candidate.menu.map(actionKey));
      const probabilities = distribution?.probabilities ?? [];
      const keys = probabilities.map((x) =>
        actionIsWellFormed(x?.choice) ? actionKey(x.choice) : ''
      );
      const total = probabilities.reduce(
        (sum, x) => sum + (Number.isFinite(x?.probability) ? x.probability : NaN),
        0
      );
      if (
        !distribution ||
        probabilities.length !== menuKeys.size ||
        new Set(keys).size !== keys.length ||
        keys.some((k) => !menuKeys.has(k)) ||
        probabilities.some(
          (x) => !Number.isFinite(x?.probability) || x.probability < 0 || x.probability > 1
        ) ||
        !(Math.abs(total - 1) <= CORRECTIVE_CATALOG_LIMITS.probabilityTolerance)
      ) {
        reason('incomplete_policy_distribution');
        continue;
      }
      const ordered = [...probabilities]
        .map((x) => ({
          choice: { action: x.choice.action, amount: x.choice.amount },
          probability: x.probability,
        }))
        .sort((a, b) => (actionKey(a.choice) < actionKey(b.choice) ? -1 : 1));
      const fromKey = actionKey(candidate.from),
        toKey = actionKey(candidate.to);
      const moved = Math.min(
        candidate.maximumProbabilityDelta,
        ordered.find((x) => actionKey(x.choice) === fromKey)!.probability
      );
      const entry: CorrectiveCatalogEntry = {
        id,
        status: 'proposed_inactive',
        activationAllowed: false,
        domain: { ...candidate.domain },
        domainKey,
        binding: { ...candidate.binding },
        informationSetDigest: candidate.binding.inputDigest,
        handId,
        handKey: review.handKey,
        reviewId: review.reviewId,
        sourceCandidateId: candidate.id,
        qualificationId: candidate.qualificationId,
        samplingContractDigest: candidate.samplingContractDigest,
        producerDigest: candidate.producerDigest,
        utilityUnit: candidate.utilityUnit,
        from: { action: candidate.from.action, amount: candidate.from.amount },
        to: { action: candidate.to.action, amount: candidate.to.amount },
        conservativeGain: candidate.conservativeGain,
        maximumProbabilityDelta: 0.05,
        baselineDistribution: ordered,
        proposedDistribution: ordered.map((x) => ({
          choice: { ...x.choice },
          probability:
            actionKey(x.choice) === fromKey
              ? x.probability - moved
              : actionKey(x.choice) === toKey
                ? x.probability + moved
                : x.probability,
        })),
        requiredBeforeActivation: [...candidate.requiredBeforeActivation],
      };
      byId.set(id, entry);
      if (!protocolDomains.has(domainKey))
        out.unselectedCandidates.push({ candidateId: id, reason: 'domain_outside_protocol' });
      else if (!(candidate.conservativeGain >= p.minimumConservativeGain))
        out.unselectedCandidates.push({ candidateId: id, reason: 'below_protocol_minimum_gain' });
      else eligible.push(entry);
    }
    // Finite: more eligible candidates than declared is a protocol violation,
    // never a silent truncation that would choose by order.
    if (eligible.length > p.maxCandidates) reason('selection_protocol_exceeded');
    if (out.reasons.length) return refuse();

    out.entries = eligible.sort((a, b) => (a.id < b.id ? -1 : 1));
    out.domains = [...new Set(out.entries.map((e) => e.domainKey))].sort();
    out.excludedReviews.sort((a, b) =>
      a.reviewId < b.reviewId ? -1 : a.reviewId > b.reviewId ? 1 : a.reason < b.reason ? -1 : 1
    );
    out.unselectedCandidates.sort((a, b) => (a.candidateId < b.candidateId ? -1 : 1));
    out.status = 'built';
    out.catalogDigest = correctiveCatalogDigest(out);
    return out;
  } catch {
    reason('catalog_evidence_invalid');
    return refuse();
  }
}

/** The digest a Phase 14 qualification must name. Covers everything but itself. */
export function correctiveCatalogDigest(catalog: CorrectiveCandidateCatalog): string {
  const { catalogDigest: _omit, ...rest } = catalog;
  return journalHash(horseJournalJson([CORRECTIVE_CATALOG_VERSION, 'catalog', rest]));
}
