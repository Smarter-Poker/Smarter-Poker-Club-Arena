import {
  DAILY_LIMITS,
  DAILY_REVIEW_VERSION,
  type DailyManifest,
  type DailyResult,
  type DailyRow,
  type DailySelectionCursor,
  type DailySelectionSource,
  type DailySource,
} from './contract.js';
import { object, sha, parseDailyManifest, parseDailyPage } from './validation.js';
import { parseSelectionReceipt } from './selection.js';
import type {
  CorrectiveHandReview,
  CorrectiveReviewInput,
} from '../horseCorrectiveReview/contract.js';
import type { HorseDecisionJournalStore } from '../horseDecisionJournal/store.js';
export interface DailyTrust {
  correctiveKeyDigest?: string;
  rosterKeyDigest?: string;
  rosterProducerDigest?: string;
  /** Test dependency injection only; production CLI always supplies false. */
  allowSynthetic?: boolean;
}
/** The queue-row screen shared with the mapping producer: null means the
 * row may be joined to private evidence; otherwise the named pending reason. */
export function dailyRowScreen(row: DailyRow): string | null {
  if (row.status !== 'retained_diagnostic') return 'daily_payload_unavailable';
  if (
    row.eligibility !== 'over_10bb' ||
    row.bigBlind === null ||
    Number(row.bigBlind) <= 0 ||
    row.committedBb === null ||
    Number(row.committedBb) <= 10
  )
    return 'monetary_eligibility_unknown';
  if (
    row.gaps.length ||
    row.reasons.some((r) => !['decision_replay_not_matched', 'reference_not_matched'].includes(r))
  )
    return 'daily_source_gap';
  return null;
}
/** Explicit offline invocation. The queue selects work; only the unchanged
 * signature/reference/core contracts can qualify that work. No database writes.
 * The selection receipt (fn_horse_commitment_selection_receipt) adds explicit
 * pending missing-source / late-arrival / gap rows for hands the review page
 * cannot show; without it no selection can be reported as reviewed. */
export async function reviewDailySelection(
  rawManifest: DailyManifest,
  source: DailySource,
  rawTrust: DailyTrust = {},
  selectionSource?: DailySelectionSource
): Promise<DailyResult> {
  const manifest = parseDailyManifest(rawManifest);
  const { correctiveKeyDigest, rosterKeyDigest, rosterProducerDigest, allowSynthetic } = rawTrust;
  const trust = Object.freeze({
    correctiveKeyDigest: sha(correctiveKeyDigest) ? correctiveKeyDigest : undefined,
    rosterKeyDigest: sha(rosterKeyDigest) ? rosterKeyDigest : undefined,
    rosterProducerDigest: sha(rosterProducerDigest) ? rosterProducerDigest : undefined,
    allowSynthetic: allowSynthetic === true,
  });
  const out: DailyResult = {
    version: DAILY_REVIEW_VERSION,
    scope: 'bounded_private_retained_selection',
    day: manifest.day,
    status: 'incomplete',
    reasons: [],
    startCursor: manifest.after ?? null,
    resumeCursor: manifest.after ?? null,
    pages: 0,
    rows: [],
    snapshots: [],
    selectionExhausted: false,
    selection: {
      status: 'not_read',
      pages: 0,
      snapshots: [],
      startCursor: manifest.selectionAfter ?? null,
      resumeCursor: manifest.selectionAfter ?? null,
      exhausted: false,
      dayState: null,
      passes: [],
      missingSourceRows: 0,
      lateArrivalRows: 0,
      sourceGapRows: 0,
      unreadableGapRows: 0,
      sourceCoverage: 'not_established',
    },
    sourceGaps: [],
    fullWindow: false,
    sourcePopulationVerified: false,
    gtoVerified: false,
    activationAllowed: false,
  };
  const reason = (s: string) => {
    if (!out.reasons.includes(s)) out.reasons.push(s);
  };
  // Dynamic imports keep worker/store/config construction off module import.
  const [
    { HorseDecisionJournalStore: Store },
    { verifyCorrectiveAuthority },
    { reviewHorseCorrectiveHand },
    { readPrivateCorrectiveJson },
    { journalHash },
    { chipCents },
    { horseCompletedHandKey },
  ] = await Promise.all([
    import('../horseDecisionJournal/store.js'),
    import('../horseCorrectiveReview/authority.js'),
    import('../horseCorrectiveReview/review.js'),
    import('../horseCorrectiveReview/privateFiles.js'),
    import('../horseDecisionJournal/record.js'),
    import('../horseCorrectiveReview/eligibility.js'),
    import('../../engine/HorseDecisionHandBinding.js'),
  ]);
  let store: HorseDecisionJournalStore | undefined;
  const cache = new Map<
    string,
    {
      review: CorrectiveHandReview | null;
      commitments: Record<string, unknown> | null;
      reason: string;
    }
  >();
  let reservedInputs = 0,
    reservedJournal = 0,
    reservedRecords = 0,
    reservedReferences = 0;
  async function hand(row: DailyRow) {
    const mapping = manifest.mappings.find((m) => m.handId === row.handId);
    if (!mapping || mapping.tableId !== row.tableId)
      return { review: null, commitments: null, reason: 'private_mapping_unavailable' };
    const prior = cache.get(mapping.handId);
    if (prior) {
      if (
        prior.commitments &&
        (prior.commitments.payloadDigest !== row.payloadHash ||
          chipCents(prior.commitments.bigBlind) !== chipCents(Number(row.bigBlind)))
      )
        return { review: null, commitments: null, reason: 'queued_source_changed' };
      return prior;
    }
    const no = (r: string) => {
      const v = { review: null, commitments: null, reason: r };
      cache.set(mapping.handId, v);
      return v;
    };
    // Existing APIs cap one input at3MiB and one hand at8MiB/256 records.
    // Reserve their full possible read before materialization (including whitespace).
    const inputReservation = DAILY_LIMITS.inputBytes + 65536;
    if (
      reservedInputs + inputReservation > DAILY_LIMITS.totalInputBytes ||
      reservedJournal + 8 * 1024 * 1024 > DAILY_LIMITS.journalBytes ||
      reservedRecords + 256 > DAILY_LIMITS.records ||
      reservedReferences + 128 > DAILY_LIMITS.references
    )
      return no('batch_evidence_budget_exhausted');
    reservedInputs += inputReservation;
    reservedJournal += 8 * 1024 * 1024;
    reservedRecords += 256;
    reservedReferences += 128;
    try {
      const input = readPrivateCorrectiveJson(mapping.inputPath, DAILY_LIMITS.inputBytes);
      if (
        !object(input) ||
        (input.version !== 1 && input.version !== 2) ||
        !object(input.commitments) ||
        !Array.isArray(input.references) ||
        input.references.length > 128
      )
        return no('private_input_invalid');
      const commitments = input.commitments;
      if (
        commitments.version !== input.version ||
        commitments.committedHandId !== row.handId ||
        commitments.payloadDigest !== row.payloadHash ||
        chipCents(commitments.bigBlind) === null ||
        chipCents(commitments.bigBlind) !== chipCents(Number(row.bigBlind))
      )
        return no('queued_source_changed');
      const authority = mapping.authorityPath
        ? verifyCorrectiveAuthority(
            readPrivateCorrectiveJson(mapping.authorityPath, 65536),
            trust.correctiveKeyDigest
          )
        : null;
      if (!authority || (!trust.allowSynthetic && authority.evidenceClass === 'synthetic_fixture'))
        return no('qualified_authority_unavailable');
      store ??= new Store(manifest.journalDirectory, { readOnly: true });
      const records = store.readHand(mapping.handKey);
      const accepted = records.filter((r) => r.kind === 'accepted_hand');
      if (!accepted.length) return no('accepted_hand_unavailable');
      for (const record of accepted) {
        const body: unknown = JSON.parse(record.body);
        if (
          !object(body) ||
          body.committedHandId !== row.handId ||
          typeof body.fence !== 'string' ||
          typeof body.generation !== 'number' ||
          typeof body.handKey !== 'string' ||
          body.bigBlind !== commitments.bigBlind
        )
          return no('accepted_hand_identity_mismatch');
        const coordinate = horseCompletedHandKey({
          fence: body.fence,
          generation: body.generation,
          handKey: body.handKey,
          bigBlind: body.bigBlind as number,
          actions: undefined,
        });
        if (
          !coordinate ||
          journalHash(coordinate) !== mapping.handKey ||
          coordinate.split(':')[0] !== row.tableId
        )
          return no('accepted_hand_identity_mismatch');
      }
      if (!accepted.some((r) => r.sha256 === commitments.acceptedHandRecordDigest))
        return no('accepted_hand_digest_mismatch');
      let rosterSource: CorrectiveReviewInput['rosterSource'];
      if (input.version === 2) {
        if (
          !object(input.rosterSource) ||
          input.rosterSource.version !== 1 ||
          !Array.isArray(input.rosterSource.rows) ||
          input.rosterSource.rows.length > 1
        )
          return no('private_roster_input_invalid');
        rosterSource = {
          version: 1,
          rows: input.rosterSource.rows,
          authorityEnvelope: input.rosterSource.authorityEnvelope,
        };
      }
      const review = reviewHorseCorrectiveHand(
        {
          records,
          handKey: mapping.handKey,
          commitments,
          references: input.references,
          authority,
          rosterSource,
        },
        {
          rosterTrust: {
            publicKeyDigest: trust.rosterKeyDigest,
            producerSourceDigest: trust.rosterProducerDigest,
            allowSynthetic: trust.allowSynthetic === true,
          },
        }
      );
      const v = { review, commitments, reason: '' };
      cache.set(mapping.handId, v);
      return v;
    } catch {
      return no('private_hand_evidence_unavailable');
    }
  }
  try {
    let after: import('./contract.js').DailyCursor | null = manifest.after ?? null;
    for (let pageIndex = 0; pageIndex < DAILY_LIMITS.pages; pageIndex++) {
      const request = Object.freeze({
        day: manifest.day,
        after: after ? Object.freeze({ ...after }) : null,
      });
      // Injected transports cannot skip the same detached wire validator.
      const received = await source({
        day: request.day,
        after: request.after ? { ...request.after } : null,
      });
      const page = parseDailyPage(received, request);
      out.pages++;
      out.snapshots.push(page.readAt);
      if (page.dayObservation !== 'present') reason('daily_source_observation_missing');
      let previous = request.after;
      for (const row of page.rows) {
        const queueCursor = { playedAt: row.playedAt, handId: row.handId, horseId: row.horseId };
        const retryAfter = previous;
        previous = queueCursor;
        const result = {
          rowRef: journalHash(JSON.stringify(row)),
          handRef: journalHash(row.handId),
          queueCursor,
          tableId: row.tableId,
          retryAfter,
          status: 'pending' as const,
          reason: 'private_evidence_pending',
          reviewId: null as string | null,
          evidenceClass: null as string | null,
          actor: null as unknown,
        };
        const screened = dailyRowScreen(row);
        if (screened) result.reason = screened;
        else {
          const reviewed = await hand(row);
          result.reason = reviewed.reason || 'retained_review_incomplete';
          const review = reviewed.review;
          if (review) {
            result.reviewId = review.reviewId;
            result.evidenceClass = review.evidenceClass;
            const actor = review.actors.find((a) => a.actorRef === journalHash(row.horseId));
            if (!actor) result.reason = 'queued_actor_unavailable';
            else if (
              actor.eligibility !== 'over_10bb' ||
              actor.grossCommittedBb === null ||
              Math.abs(actor.grossCommittedBb - Number(row.committedBb)) >
                1e-9 * Math.max(1, actor.grossCommittedBb)
            )
              result.reason = 'queued_commitment_changed';
            else if (
              review.status === 'reviewed' &&
              review.requestLifecycleVerified &&
              actor.decisions.length > 0 &&
              actor.decisions.every(
                (d) => d.disposition === 'finding' || d.disposition === 'non_finding'
              )
            ) {
              out.rows.push({
                ...result,
                status: 'reviewed_retained_menu',
                reason: 'qualified_retained_menu_only',
                actor: JSON.parse(JSON.stringify(actor)),
              });
              continue;
            } else if (!review.requestLifecycleVerified)
              result.reason = 'retained_request_lifecycle_unavailable';
          }
        }
        out.rows.push(result);
      }
      out.resumeCursor = page.next;
      if (!page.hasMore) {
        out.selectionExhausted = true;
        break;
      }
      after = page.next;
    }
    if (!out.selectionExhausted) reason('daily_selection_page_limit');
  } catch {
    reason('daily_source_unavailable');
  } finally {
    try {
      store?.close();
    } catch {
      reason('private_reader_cleanup_unavailable');
    }
  }
  // Gap-only hands are invisible to the review page. Read them, bounded and
  // resumable, and emit every one as an explicit pending row; never a skip.
  const selection = out.selection;
  if (!selectionSource) reason('daily_selection_receipt_not_read');
  else {
    try {
      let after: DailySelectionCursor | null = manifest.selectionAfter ?? null;
      let passesSeen: string | null = null;
      for (let pageIndex = 0; pageIndex < DAILY_LIMITS.pages; pageIndex++) {
        const request = Object.freeze({
          day: manifest.day,
          after: after ? Object.freeze({ ...after }) : null,
        });
        const received = await selectionSource({
          day: request.day,
          after: request.after ? { ...request.after } : null,
        });
        // Injected transports cannot skip the same detached receipt validator.
        const receipt = parseSelectionReceipt(received, request);
        selection.pages++;
        selection.snapshots.push(receipt.readAt);
        const passes = JSON.stringify(receipt.passes);
        if (passesSeen !== null && passesSeen !== passes)
          reason('daily_selection_changed_between_pages');
        passesSeen = passes;
        selection.dayState = JSON.parse(JSON.stringify(receipt.dayState));
        selection.passes = JSON.parse(passes);
        let previous = request.after;
        for (const gap of receipt.gaps) {
          const cursor = { playedAt: gap.playedAt, handId: gap.handId };
          out.sourceGaps.push({
            kind: gap.kind,
            status: 'pending',
            handRef: journalHash(gap.handId),
            handId: gap.handId,
            tableId: gap.tableId,
            playedAt: gap.playedAt,
            reasons: [...gap.reasons],
            cursor,
            retryAfter: previous ? { ...previous } : null,
          });
          previous = cursor;
          if (gap.kind === 'missing_source') selection.missingSourceRows++;
          else if (gap.kind === 'late_arrival') selection.lateArrivalRows++;
          else if (gap.kind === 'reasons_unavailable') selection.unreadableGapRows++;
          else selection.sourceGapRows++;
        }
        selection.resumeCursor = receipt.next ? { ...receipt.next } : selection.resumeCursor;
        if (!receipt.hasMore) {
          selection.exhausted = true;
          break;
        }
        after = receipt.next;
      }
      selection.status = 'read';
      if (!selection.exhausted) reason('daily_selection_receipt_page_limit');
      if (!selection.dayState) reason('daily_selection_day_missing');
      else if (selection.dayState.finishedAt === null) reason('daily_selection_pass_in_progress');
      if (!selection.passes.length) reason('daily_selection_no_completed_pass');
      if (selection.missingSourceRows) reason('daily_missing_source_rows');
      if (selection.lateArrivalRows) reason('daily_late_arrival_rows');
      if (selection.sourceGapRows) reason('daily_source_gap_rows');
      if (selection.unreadableGapRows) reason('daily_gap_reasons_unavailable');
    } catch {
      selection.status = 'unavailable';
      reason('daily_selection_unavailable');
    }
  }
  if (!out.rows.length) reason('no_retained_review_rows');
  if (out.rows.some((r) => r.status === 'pending')) reason('pending_private_reviews');
  if (out.reasons.length === 0 && out.selectionExhausted && out.rows.length > 0)
    out.status = 'reviewed_selection';
  if (Buffer.byteLength(JSON.stringify(out) + '\n') > DAILY_LIMITS.outputBytes) {
    out.status = 'incomplete';
    reason('daily_output_bounds');
    out.rows = out.rows.map((r) => ({
      ...r,
      status: 'pending',
      reason: 'daily_output_bounds',
      actor: null,
    }));
  }
  return JSON.parse(JSON.stringify(out)) as DailyResult;
}
