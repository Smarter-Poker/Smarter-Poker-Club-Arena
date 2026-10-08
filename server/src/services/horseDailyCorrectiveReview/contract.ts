/** Private retained-diagnostic selection only. No source/signing/policy authority. */
export const DAILY_REVIEW_VERSION = 'horse-daily-corrective-selection-v1' as const;
export const DAILY_LIMITS = Object.freeze({
  pageRows: 8,
  pages: 2,
  rows: 16,
  hands: 8,
  wireBytes: 65536,
  manifestBytes: 32768,
  inputBytes: 3 * 1024 * 1024,
  totalInputBytes: 8 * 1024 * 1024,
  records: 512,
  journalBytes: 16 * 1024 * 1024,
  references: 256,
  outputBytes: 524288,
  timeoutMs: 5000,
  /** fn_horse_commitment_selection_receipt: one bounded reply. */
  selectionWireBytes: 65536,
  selectionPasses: 32,
  /** fn_horse_accepted_source_rows: one hand per call; the exporter bounds the
   * serialized raw row at 1 MiB, plus the reply envelope. */
  sourceRowWireBytes: 1024 * 1024 + 8192,
});
/** How the daily commitment audit classified horse seats for a day or pass
 * (20261008041707): today's profile only (hands accepted before the first
 * accepted roster), the accepted roster only, or both. A label, never an
 * authority. */
export const DAILY_IDENTITY_BASES = Object.freeze([
  'current_profile_is_horse',
  'accepted_roster',
  'current_profile_then_accepted_roster',
] as const);
export type DailyIdentityBasis = (typeof DAILY_IDENTITY_BASES)[number];
export const isDailyIdentityBasis = (v: unknown): v is DailyIdentityBasis =>
  typeof v === 'string' && (DAILY_IDENTITY_BASES as readonly string[]).includes(v);
export interface DailyCursor {
  playedAt: string;
  handId: string;
  horseId: string;
}
export interface DailyRequest {
  day: string;
  after: DailyCursor | null;
}
export interface DailyRow extends DailyCursor {
  tableId: string;
  status: 'retained_diagnostic' | 'payload_unavailable';
  payloadHash: string | null;
  variant: string | null;
  format: string | null;
  eligibility: 'over_10bb' | 'unknown';
  bigBlind: string | null;
  committedBb: string | null;
  reasons: readonly string[];
  gaps: readonly string[];
}
export interface DailyPage {
  version: 1;
  source: 'horse_commitment_reviews';
  limit: 8;
  day: string;
  after: DailyCursor | null;
  readAt: string;
  rows: readonly DailyRow[];
  hasMore: boolean;
  next: DailyCursor | null;
  dayObservation: 'present' | 'missing';
  sourceCoverage: 'not_established';
  identityBasis: DailyIdentityBasis;
  gtoVerified: false;
  activationAllowed: false;
}
export type DailySource = (request: DailyRequest) => Promise<DailyPage>;
export interface DailyMapping {
  handId: string;
  tableId: string;
  handKey: string;
  inputPath: string;
  authorityPath?: string;
}
export interface DailyManifest {
  version: 1;
  day: string;
  after?: DailyCursor | null;
  /** Gap-only resume position in fn_horse_commitment_selection_receipt. */
  selectionAfter?: DailySelectionCursor | null;
  journalDirectory: string;
  mappings: readonly DailyMapping[];
}
export interface DailyRowResult {
  rowRef: string;
  handRef: string;
  queueCursor: DailyCursor;
  tableId: string;
  retryAfter: DailyCursor | null;
  status: 'reviewed_retained_menu' | 'pending';
  reason: string;
  reviewId: string | null;
  evidenceClass: string | null;
  actor: unknown | null;
}
/** Gap-only coordinate order of fn_horse_commitment_selection_receipt. */
export interface DailySelectionCursor {
  playedAt: string;
  handId: string;
}
export interface DailySelectionRequest {
  day: string;
  after: DailySelectionCursor | null;
}
export interface DailyScanCursor {
  createdAt: string;
  handId: string;
}
export interface DailyDayState {
  pass: number;
  startedAt: string;
  lastBatchAt: string | null;
  finishedAt: string | null;
  cursor: DailyScanCursor | null;
  scannedHands: number;
  horseHands: number;
  flaggedHorseHands: number;
  unknownHorseHands: number;
  handGaps: number;
}
/** One immutable public.horse_commitment_audit_passes receipt. */
export interface DailySelectionPass {
  pass: number;
  windowStart: string;
  windowEnd: string;
  cutover: string;
  maxScannedCreatedAt: string | null;
  scannedHands: number;
  horseHands: number;
  flaggedHorseHands: number;
  unknownHorseHands: number;
  handGaps: number;
  handsWithoutCommit: number;
  missingSourceHands: number;
  lateArrivalHands: number;
  finalCursor: DailyScanCursor | null;
  startedAt: string;
  finishedAt: string;
  sourceCoverage: 'not_established';
  identityBasis: DailyIdentityBasis;
}
export interface DailySelectionGap {
  handId: string;
  tableId: string | null;
  playedAt: string;
  reasons: readonly string[];
  kind: 'missing_source' | 'late_arrival' | 'source_gap' | 'reasons_unavailable';
}
export interface DailySelectionReceipt {
  version: 1;
  source: 'horse_commitment_selection_receipt';
  day: string;
  readAt: string;
  after: DailySelectionCursor | null;
  dayState: DailyDayState | null;
  passes: readonly DailySelectionPass[];
  gaps: readonly DailySelectionGap[];
  hasMore: boolean;
  next: DailySelectionCursor | null;
  sourceCoverage: 'not_established';
  identityBasis: DailyIdentityBasis;
  gtoVerified: false;
  activationAllowed: false;
}
export type DailySelectionSource = (
  request: DailySelectionRequest
) => Promise<DailySelectionReceipt>;
/** Explicit pending output for a hand the audit could not turn into a review
 * row: never a silent skip, never a review, never an authority. */
export interface DailySourceGapResult {
  kind: DailySelectionGap['kind'];
  status: 'pending';
  handRef: string;
  handId: string;
  tableId: string | null;
  playedAt: string;
  reasons: string[];
  cursor: DailySelectionCursor;
  retryAfter: DailySelectionCursor | null;
}
export interface DailySelectionSummary {
  status: 'read' | 'unavailable' | 'not_read';
  pages: number;
  snapshots: string[];
  startCursor: DailySelectionCursor | null;
  resumeCursor: DailySelectionCursor | null;
  exhausted: boolean;
  dayState: DailyDayState | null;
  passes: DailySelectionPass[];
  missingSourceRows: number;
  lateArrivalRows: number;
  sourceGapRows: number;
  /** Gap rows whose stored reasons the reader could not return. */
  unreadableGapRows: number;
  sourceCoverage: 'not_established';
}
export interface DailyResult {
  version: typeof DAILY_REVIEW_VERSION;
  scope: 'bounded_private_retained_selection';
  day: string;
  status: 'reviewed_selection' | 'incomplete';
  reasons: string[];
  startCursor: DailyCursor | null;
  resumeCursor: DailyCursor | null;
  pages: number;
  rows: DailyRowResult[];
  snapshots: string[];
  selectionExhausted: boolean;
  selection: DailySelectionSummary;
  sourceGaps: DailySourceGapResult[];
  fullWindow: false;
  sourcePopulationVerified: false;
  gtoVerified: false;
  activationAllowed: false;
}
