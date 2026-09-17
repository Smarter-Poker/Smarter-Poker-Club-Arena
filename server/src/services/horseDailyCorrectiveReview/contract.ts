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
});
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
  identityBasis: 'current_profile_is_horse';
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
  fullWindow: false;
  sourcePopulationVerified: false;
  gtoVerified: false;
  activationAllowed: false;
}
