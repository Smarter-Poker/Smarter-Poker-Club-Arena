export interface Phase14GenerationEntry {
  readonly highestPublishedGeneration: number;
  readonly authorityDigest: string | null;
  readonly retiredGenerations: readonly number[];
}
export interface Phase14GenerationLedger {
  readonly schema: 'horse-phase14-generation-ledger-v1';
  readonly domains: Readonly<Record<string, Phase14GenerationEntry>>;
}
export const PHASE14_GENERATION_LEDGER_PATH: 'docs/evidence/phase14/generation-ledger.json';
export const PHASE14_GENERATION_LEDGER_SCHEMA: 'horse-phase14-generation-ledger-v1';
export const PHASE14_GENERATION_DOMAINS: readonly string[];
export function phase14SelectionIdentityDigest(selection: object): string;
export function parsePhase14GenerationLedger(value: unknown): Phase14GenerationLedger | null;
export function phase14LedgerSelectionAllowed(
  ledger: Phase14GenerationLedger | null,
  domain: string,
  selection: unknown
): boolean;
export function phase14GenerationTransitionAllowed(
  before: Phase14GenerationLedger | null,
  after: Phase14GenerationLedger | null
): boolean;
