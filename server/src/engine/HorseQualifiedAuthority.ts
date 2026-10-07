/**
 * Phase 8.3 (shared package S4): the one generation-bound authority path that
 * may let a qualified Horse candidate policy change real play.
 *
 * Authority is SELECTED AT A PROTECTED CODE RELEASE. There is no runtime
 * approval issuer: the only way to select, renew or withdraw it at release is a
 * reviewed change to `PHASE8_PROTECTED_RELEASE_SELECTION` below, which names a
 * committed qualification file under `docs/evidence/phase8/` and its exact
 * sha256. Nothing here reads a request, an IPC message, an environment variable
 * or a database row to obtain authority, so a caller can never supply candidate
 * control. A local process may only lose authority (withdrawal, refresh
 * failure, restart); it can never gain it except by admitting that committed
 * selection again.
 *
 * Two holders exist per process: the decision worker's (worker-owned admission
 * derives candidate mode from it) and the main scheduler's gate (rechecked
 * immediately before action and effect acceptance). Each holder has a random
 * epoch and a monotonic local generation. A local generation is a cache
 * generation: it proves what THIS process admitted, not that every other
 * process has stopped. No instantaneous global withdrawal is claimed.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASE8_POLICY } from './HorseTournamentPostflop.js';
import { CONTINUATION_POLICY } from './HorseTournamentContinuation.js';

export const HORSE_PHASE8_EVIDENCE_DIRECTORY = 'docs/evidence/phase8/';
/** The only domain the Phase 8 continuation implements. */
export const HORSE_PHASE8_DOMAIN = 'nlh-single-board-tournament-postflop';

/** Committed at a protected release. Never constructed from runtime input. */
export interface HorseQualifiedAuthoritySelection {
  readonly schema: 'horse-qualified-authority-selection-v1';
  readonly phase: 'phase8';
  /** Exact 40-hex source revision the qualification evidence was produced from. */
  readonly sourceSha: string;
  readonly continuationVersion: string;
  readonly packId: string;
  readonly domain: string;
  /** Repository-relative path under docs/evidence/phase8/. */
  readonly evidencePath: string;
  readonly evidenceSha256: string;
  /** Positive, strictly increasing across renewals; a withdrawn generation never returns. */
  readonly approvalGeneration: number;
  readonly issuedAt: string;
  readonly expiresAt: string | null;
  /** An explicit withdrawal committed at a protected release. */
  readonly withdrawn: Readonly<{ at: string; reason: string }> | null;
}

/** Immutable admitted record. `authorityKey` digests every identity field.
 * Phase 10 (P10.3) admits the same record shape through
 * `HorsePhase10Authority.ts`; it adds the P10.2 contract digest, which a
 * Phase 8 record never carries (its identity and key are unchanged). Phase 11
 * (P11.3) admits it per pack through `HorsePhase11Authority.ts`, adding the
 * P11.2 contract digest, the pack variant and the natural completion evidence
 * it was admitted on. Phase 12 (P12.3) admits it per pack through
 * `HorsePhase12Authority.ts` with the same three additions (the P12.2
 * contract digest, the pack variant, its natural completion evidence). Phase 13
 * (P13.3) admits it per variant through `HorsePhase13Authority.ts` for the
 * joint multiway owner, with the same three additions. Phase 14 (P14-D, inactive
 * slice) admits it per corrective domain through `HorsePhase14Authority.ts`,
 * adding the inactive catalog digest and holdout digest; nothing selects it. */
export interface HorseQualifiedAuthority {
  readonly schema: 'horse-qualified-authority-v1';
  readonly phase: 'phase8' | 'phase10' | 'phase11' | 'phase12' | 'phase13' | 'phase14';
  readonly sourceSha: string;
  readonly continuationVersion: string;
  readonly policyDigest: string;
  readonly packId: string;
  readonly domain: string;
  readonly evidencePath: string;
  readonly evidenceSha256: string;
  readonly approvalGeneration: number;
  readonly issuedAt: string;
  readonly expiresAt: string | null;
  /** Phases 10 to 13: the strength contract digest the qualification binds. */
  readonly contractDigest?: string;
  /** Phases 11 to 13: the pack variant (plo5, plo6, plo8; short_deck,
   * pineapple, flh, flo8; any of the nine joint variants). */
  readonly variant?: string;
  /** Phases 11 to 13: the committed natural completion evidence admitted with it. */
  readonly completionPath?: string;
  readonly completionSha256?: string;
  /** Phase 14: the inactive corrective catalog and holdout the qualification binds. */
  readonly catalogDigest?: string;
  readonly holdoutDigest?: string;
  readonly authorityKey: string;
}

/**
 * THE PROTECTED RELEASE SELECTION. Null: no qualified Phase 8 authority exists,
 * so every live decision stays in shadow. Selecting requires the P8.2
 * qualification file committed under docs/evidence/phase8/, its sha256 here,
 * and the protected merge and engine release of this exact change. That
 * release must also ship the evidence file inside the engine image; a missing
 * file is refused, so a release that forgets it stays in shadow.
 */
export const PHASE8_PROTECTED_RELEASE_SELECTION: HorseQualifiedAuthoritySelection | null = null;

export type HorseAuthorityRefusal =
  | 'unselected'
  | 'invalid_selection'
  | 'missing_evidence'
  | 'unreadable_evidence'
  | 'hash_mismatch'
  | 'evidence_mismatch'
  | 'continuation_mismatch'
  | 'expired'
  // Phase 10 (P10.3) qualification-file refusals, named by what failed.
  | 'not_qualified'
  | 'contract_unavailable'
  | 'contract_digest_mismatch'
  | 'policy_digest_unavailable'
  | 'policy_digest_mismatch'
  | 'source_mismatch'
  // Phase 11 (P11.3) natural completion-share refusals (P11.2
  // `liveConditions.admissionAlsoRequires`), named by what failed. Phase 12
  // (P12.3) reuses the same names for its own completion record.
  | 'completion_evidence_missing'
  | 'completion_hash_mismatch'
  | 'completion_evidence_mismatch'
  | 'completion_release_mismatch'
  | 'completion_window_invalid'
  | 'completion_below_floor'
  // Phase 14 (P14-D) corrective catalog refusals, named by what failed.
  | 'catalog_digest_mismatch'
  | 'holdout_digest_mismatch';

export type HorseAuthorityAdmission =
  | { readonly status: 'admitted'; readonly authority: HorseQualifiedAuthority }
  | {
      readonly status: 'withdrawn';
      readonly approvalGeneration: number;
      readonly reason: string;
    }
  | {
      readonly status: 'refused';
      readonly reason: HorseAuthorityRefusal;
      /** True only for an I/O failure that may succeed on the next refresh. */
      readonly transient: boolean;
    };

export type HorseAuthorityState =
  | 'unselected'
  | 'usable'
  | 'refused'
  | 'refresh_failed'
  | 'withdrawn';

/** Copied into the decision ledger, execution witness and journal record. */
export interface HorseAuthorityReceipt {
  readonly version: 'horse-qualified-authority-receipt-v1';
  readonly epoch: string;
  readonly generation: number;
  readonly state: HorseAuthorityState;
  readonly reason: string | null;
  /** The running code's continuation (Phase 8) or pack version (Phase 10,
   * and the pack's own version for each Phase 11 and Phase 12 holder), always bound even
   * without authority. */
  readonly continuationVersion: string;
  readonly approvalGeneration: number | null;
  readonly authorityKey: string | null;
  readonly evidenceSha256: string | null;
  readonly sourceSha: string | null;
  readonly expiresAt: string | null;
  /** Main gate generation when the client received this result; null in the worker. */
  readonly mainGeneration: number | null;
}

export type HorseAuthorityVerdict =
  | 'usable'
  | 'unselected'
  | 'refused'
  | 'refresh_failed'
  | 'withdrawn'
  | 'restarted'
  | 'stale_generation'
  | 'mismatched'
  | 'expired'
  | 'missing_receipt';

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort())
      out[key] = canonical((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}
export const sha256 = (text: string | Buffer): string =>
  createHash('sha256').update(text).digest('hex');

/** Digest of the running continuation's declared boundaries. A boundary edit
 * without a version bump still changes this, so old evidence cannot cover it. */
export function horsePhase8PolicyDigest(): string {
  return sha256(
    JSON.stringify(canonical({ phase8: PHASE8_POLICY, continuation: CONTINUATION_POLICY }))
  );
}

export function isoMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
}

function selectionIsWellFormed(s: HorseQualifiedAuthoritySelection): boolean {
  const path = s.evidencePath;
  return (
    s.schema === 'horse-qualified-authority-selection-v1' &&
    s.phase === 'phase8' &&
    typeof s.sourceSha === 'string' &&
    HEX40.test(s.sourceSha) &&
    typeof s.continuationVersion === 'string' &&
    typeof s.packId === 'string' &&
    s.packId.length > 0 &&
    typeof s.domain === 'string' &&
    typeof path === 'string' &&
    path.startsWith(HORSE_PHASE8_EVIDENCE_DIRECTORY) &&
    path.endsWith('.json') &&
    posix.normalize(path) === path &&
    !path.split('/').includes('..') &&
    typeof s.evidenceSha256 === 'string' &&
    HEX64.test(s.evidenceSha256) &&
    Number.isSafeInteger(s.approvalGeneration) &&
    s.approvalGeneration > 0 &&
    isoMs(s.issuedAt) !== null &&
    (s.expiresAt === null || (isoMs(s.expiresAt) ?? -1) > (isoMs(s.issuedAt) ?? Infinity)) &&
    (s.withdrawn === null ||
      (isoMs(s.withdrawn?.at) !== null &&
        typeof s.withdrawn?.reason === 'string' &&
        s.withdrawn.reason.length > 0))
  );
}

export interface HorseAuthorityEvidenceReader {
  /** Reads a repository-relative path. Throws with `code` on failure. */
  read(relativePath: string): Buffer;
}

/** Repository root in source and test runs; the engine image root in production. */
export const repositoryEvidenceReader: HorseAuthorityEvidenceReader = {
  read: (relativePath) =>
    readFileSync(fileURLToPath(new URL(`../../../${relativePath}`, import.meta.url))),
};

/**
 * Admit a committed selection. Pure apart from the injected read. Refuses a
 * missing, unreadable, differently hashed or mismatched file, a selection for
 * another continuation, policy digest, domain or pack, and an expired one.
 */
export function admitHorseQualifiedAuthority(
  selection: HorseQualifiedAuthoritySelection | null,
  reader: HorseAuthorityEvidenceReader,
  nowMs: number
): HorseAuthorityAdmission {
  const refuse = (reason: HorseAuthorityRefusal, transient = false): HorseAuthorityAdmission => ({
    status: 'refused',
    reason,
    transient,
  });
  if (selection === null) return refuse('unselected');
  if (!selectionIsWellFormed(selection)) return refuse('invalid_selection');
  if (selection.withdrawn !== null)
    return {
      status: 'withdrawn',
      approvalGeneration: selection.approvalGeneration,
      reason: `release_${selection.withdrawn.reason}`,
    };
  if (
    selection.continuationVersion !== PHASE8_POLICY.version ||
    selection.domain !== HORSE_PHASE8_DOMAIN
  )
    return refuse('continuation_mismatch');
  if (selection.expiresAt !== null && nowMs >= (isoMs(selection.expiresAt) ?? -Infinity))
    return refuse('expired');
  let bytes: Buffer;
  try {
    bytes = reader.read(selection.evidencePath);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? refuse('missing_evidence')
      : refuse('unreadable_evidence', true);
  }
  if (sha256(bytes) !== selection.evidenceSha256) return refuse('hash_mismatch');
  let evidence: Record<string, unknown>;
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('not object');
    evidence = parsed as Record<string, unknown>;
  } catch {
    return refuse('evidence_mismatch');
  }
  const policyDigest = horsePhase8PolicyDigest();
  if (
    evidence.schema !== 'horse-phase8-qualification-v1' ||
    evidence.qualified !== true ||
    evidence.sourceSha !== selection.sourceSha ||
    evidence.continuationVersion !== selection.continuationVersion ||
    evidence.packId !== selection.packId ||
    evidence.domain !== selection.domain
  )
    return refuse('evidence_mismatch');
  if (evidence.policyDigest !== policyDigest) return refuse('continuation_mismatch');
  const identity = {
    schema: 'horse-qualified-authority-v1' as const,
    phase: 'phase8' as const,
    sourceSha: selection.sourceSha,
    continuationVersion: selection.continuationVersion,
    policyDigest,
    packId: selection.packId,
    domain: selection.domain,
    evidencePath: selection.evidencePath,
    evidenceSha256: selection.evidenceSha256,
    approvalGeneration: selection.approvalGeneration,
    issuedAt: selection.issuedAt,
    expiresAt: selection.expiresAt,
  };
  return {
    status: 'admitted',
    authority: Object.freeze({
      ...identity,
      authorityKey: sha256(JSON.stringify(canonical(identity))),
    }),
  };
}

/** Admit the committed release selection from the repository/image files. */
export function admitHorsePhase8ReleaseAuthority(
  nowMs = Date.now(),
  selection: HorseQualifiedAuthoritySelection | null = PHASE8_PROTECTED_RELEASE_SELECTION,
  reader: HorseAuthorityEvidenceReader = repositoryEvidenceReader
): HorseAuthorityAdmission {
  try {
    return admitHorseQualifiedAuthority(selection, reader, nowMs);
  } catch {
    return { status: 'refused', reason: 'unreadable_evidence', transient: true };
  }
}

/**
 * One local authority cache. States are distinct on purpose:
 * - `refresh_failed`: a transient re-read failed; unusable, NOT a withdrawal,
 *   and a later successful refresh of the same approval restores it under a
 *   new generation (work issued before the failure stays stale);
 * - `withdrawn`: explicit and sticky; only an admission whose approval
 *   generation is GREATER than the withdrawn one (a renewed approval committed
 *   at a protected release) makes it usable again;
 * - `refused`/`unselected`: no admissible selection.
 * Every usable-state change increments `generation`.
 */
export class HorseQualifiedAuthorityHolder {
  readonly epoch: string;
  /** The version the running code admits: Phase 8 continuation by default;
   * the Phase 10 holders pass the running PLO4 pack version, and each Phase 11
   * and Phase 12 holder its own pack version. */
  readonly runningVersion: string;
  private generation = 0;
  private state: HorseAuthorityState = 'unselected';
  private reason: string | null = 'unselected';
  private authority: HorseQualifiedAuthority | null = null;
  private withdrawnApproval: number | null = null;

  constructor(epoch: string = randomUUID(), runningVersion: string = PHASE8_POLICY.version) {
    this.epoch = epoch;
    this.runningVersion = runningVersion;
  }

  apply(admission: HorseAuthorityAdmission): void {
    if (admission.status === 'withdrawn') {
      this.withdrawnApproval = Math.max(this.withdrawnApproval ?? 0, admission.approvalGeneration);
      this.transition('withdrawn', admission.reason, null);
      return;
    }
    if (admission.status === 'admitted') {
      const next = admission.authority;
      if (this.withdrawnApproval !== null && next.approvalGeneration <= this.withdrawnApproval) {
        // Re-admitting the withdrawn approval is not a renewal.
        if (this.state !== 'withdrawn') this.transition('withdrawn', 'withdrawn_approval', null);
        return;
      }
      if (this.state === 'usable' && this.authority?.authorityKey === next.authorityKey) return;
      const restored =
        this.state === 'refresh_failed' && this.authority?.authorityKey === next.authorityKey;
      this.transition(
        'usable',
        restored
          ? 'refresh_restored'
          : this.authority || this.withdrawnApproval
            ? 'renewed'
            : 'admitted',
        next
      );
      return;
    }
    if (admission.transient && (this.state === 'usable' || this.state === 'refresh_failed')) {
      if (this.state === 'usable')
        this.transition('refresh_failed', admission.reason, this.authority);
      return;
    }
    if (this.state === 'withdrawn') return;
    const state = admission.reason === 'unselected' ? 'unselected' : 'refused';
    if (this.state !== state || this.reason !== admission.reason)
      this.transition(state, admission.reason, null);
  }

  /** Explicit local withdrawal. Sticky for this holder's lifetime. */
  withdraw(reason: string): void {
    if (this.state === 'withdrawn') return;
    this.withdrawnApproval = Math.max(
      this.withdrawnApproval ?? 0,
      this.authority?.approvalGeneration ?? 0
    );
    this.transition('withdrawn', reason, null);
  }

  current(): HorseQualifiedAuthority | null {
    return this.state === 'usable' ? this.authority : null;
  }

  currentState(): HorseAuthorityState {
    return this.state;
  }

  currentGeneration(): number {
    return this.generation;
  }

  receipt(mainGeneration: number | null = null): HorseAuthorityReceipt {
    const a = this.authority;
    return Object.freeze({
      version: 'horse-qualified-authority-receipt-v1',
      epoch: this.epoch,
      generation: this.generation,
      state: this.state,
      reason: this.reason,
      continuationVersion: this.runningVersion,
      approvalGeneration: a?.approvalGeneration ?? null,
      authorityKey: a?.authorityKey ?? null,
      evidenceSha256: a?.evidenceSha256 ?? null,
      sourceSha: a?.sourceSha ?? null,
      expiresAt: a?.expiresAt ?? null,
      mainGeneration,
    });
  }

  /** Is the authority named by `receipt` still this holder's usable authority? */
  verdict(receipt: HorseAuthorityReceipt | null | undefined, nowMs: number): HorseAuthorityVerdict {
    if (!receipt) return 'missing_receipt';
    if (receipt.epoch !== this.epoch) return 'restarted';
    return this.usableVerdict(
      receipt.generation,
      receipt.authorityKey,
      receipt.continuationVersion,
      nowMs
    );
  }

  usableVerdict(
    generation: number,
    authorityKey: string | null,
    continuationVersion: string,
    nowMs: number
  ): HorseAuthorityVerdict {
    if (this.state !== 'usable' || !this.authority)
      return this.state === 'usable' ? 'refused' : this.state;
    if (generation !== this.generation) return 'stale_generation';
    if (
      authorityKey !== this.authority.authorityKey ||
      continuationVersion !== this.runningVersion ||
      this.authority.continuationVersion !== this.runningVersion
    )
      return 'mismatched';
    if (this.authority.expiresAt !== null && nowMs >= Date.parse(this.authority.expiresAt))
      return 'expired';
    return 'usable';
  }

  private transition(
    state: HorseAuthorityState,
    reason: string | null,
    authority: HorseQualifiedAuthority | null
  ): void {
    this.state = state;
    this.reason = reason;
    this.authority = authority;
    this.generation += 1;
  }
}

function receiptIsWellFormed(value: unknown): value is HorseAuthorityReceipt {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    r.version === 'horse-qualified-authority-receipt-v1' &&
    typeof r.epoch === 'string' &&
    r.epoch.length > 0 &&
    Number.isSafeInteger(r.generation) &&
    (r.generation as number) >= 0 &&
    ['unselected', 'usable', 'refused', 'refresh_failed', 'withdrawn'].includes(
      r.state as string
    ) &&
    typeof r.continuationVersion === 'string'
  );
}
export { receiptIsWellFormed as horseAuthorityReceiptIsWellFormed };

/**
 * Main-scheduler gate. It admits the same committed selection independently of
 * the worker, mirrors each worker's reported receipt (FIFO order makes those
 * monotonic), and answers the acceptance-time question for a returned ledger.
 * A worker it has not heard from, or one that exited, is `restarted`.
 * Phase 10 reuses this class with its own admission and running pack version
 * (`liveHorsePhase10Authority` in `HorsePhase10Authority.ts`), and Phase 11
 * with one instance per pack (`liveHorsePhase11Authorities` in
 * `HorsePhase11Authority.ts`), as does Phase 12 (`liveHorsePhase12Authorities`
 * in `HorsePhase12Authority.ts`).
 */
export class HorsePhase8AuthorityGate {
  private readonly main: HorseQualifiedAuthorityHolder;
  private readonly workers = new Map<string, HorseAuthorityReceipt>();
  private admittedOnce = false;

  constructor(
    private readonly admit: () => HorseAuthorityAdmission = () =>
      admitHorsePhase8ReleaseAuthority(),
    epoch?: string,
    runningVersion?: string
  ) {
    this.main = new HorseQualifiedAuthorityHolder(epoch, runningVersion);
  }

  /** First call admits; later calls are refreshes (a worker lane start). */
  refresh(): void {
    let admission: HorseAuthorityAdmission;
    try {
      admission = this.admit();
    } catch {
      admission = { status: 'refused', reason: 'unreadable_evidence', transient: true };
    }
    this.main.apply(admission);
    this.admittedOnce = true;
  }

  ensureAdmitted(): void {
    if (!this.admittedOnce) this.refresh();
  }

  withdraw(reason: string): void {
    this.main.withdraw(reason);
  }

  mainGeneration(): number {
    return this.main.currentGeneration();
  }

  mainState(): HorseAuthorityState {
    return this.main.currentState();
  }

  /** Record a worker's latest receipt. A worker withdrawal withdraws main too,
   * so a replacement worker cannot re-promote what its predecessor withdrew. */
  observeWorker(receipt: unknown): void {
    if (!receiptIsWellFormed(receipt)) return;
    const known = this.workers.get(receipt.epoch);
    if (known && known.generation > receipt.generation) return;
    this.workers.set(receipt.epoch, receipt);
    if (receipt.state === 'withdrawn')
      this.main.withdraw(`worker_${receipt.reason ?? 'withdrawn'}`);
  }

  forgetWorker(epoch: string | null): void {
    if (epoch !== null) this.workers.delete(epoch);
  }

  /** Stamp a received receipt with the main generation current on receipt. */
  stamp(receipt: HorseAuthorityReceipt): HorseAuthorityReceipt {
    return Object.freeze({ ...receipt, mainGeneration: this.main.currentGeneration() });
  }

  /** The acceptance-time recheck for authority carried by a returned ledger. */
  check(
    receipt: HorseAuthorityReceipt | null | undefined,
    nowMs = Date.now()
  ): HorseAuthorityVerdict {
    if (!receipt || !receiptIsWellFormed(receipt)) return 'missing_receipt';
    const mainAuthority = this.main.current();
    if (!mainAuthority) {
      const state = this.main.currentState();
      return state === 'usable' ? 'refused' : state;
    }
    if (receipt.state !== 'usable') return 'mismatched';
    if (receipt.mainGeneration !== null && receipt.mainGeneration !== this.main.currentGeneration())
      return 'stale_generation';
    const mainVerdict = this.main.usableVerdict(
      this.main.currentGeneration(),
      receipt.authorityKey,
      receipt.continuationVersion,
      nowMs
    );
    if (mainVerdict !== 'usable') return mainVerdict;
    const worker = this.workers.get(receipt.epoch);
    if (!worker) return 'restarted';
    if (worker.state !== 'usable') return worker.state;
    if (worker.generation !== receipt.generation || worker.authorityKey !== receipt.authorityKey)
      return 'stale_generation';
    return 'usable';
  }
}

/** Main-thread gate for this engine process. The worker thread owns its own holder. */
export const liveHorsePhase8Authority = new HorsePhase8AuthorityGate();
