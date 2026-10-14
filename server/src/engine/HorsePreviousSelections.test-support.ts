/** Historical selected generations used only to prove retained evidence refusal. */
import type { HorsePhase10AuthoritySelection } from './HorsePhase10Authority.js';
import type { HorsePhase11AuthoritySelection } from './HorsePhase11Authority.js';
import type { HorsePhase12AuthoritySelection } from './HorsePhase12Authority.js';
import type { RemainingPolicyVariant } from './remainingVariants/RemainingVariantPolicyPack.js';

export const PREVIOUS_PHASE10_SELECTION: HorsePhase10AuthoritySelection | null = Object.freeze({
  schema: 'horse-qualified-authority-selection-v1',
  phase: 'phase10',
  sourceSha: 'c8bfc6171ddfabdfa8d8ca55f4e13fc7e2466400',
  packVersion: 'plo4-policy-round3-v2',
  contractVersion: 'plo4-strength-contract-v1',
  contractDigest: '83ab185b2a2df72876b73d61ece6ea8c2f03f364ce252deecbfcde392ae5f838',
  domain: 'plo4-cash-single-board-after-rake-horse-population',
  qualificationPath: 'docs/evidence/phase10/phase10-qualification-2026-10-09.json',
  qualificationSha256: '3d88e47fcd8a526295f32bdf7688c72110ebc79b0a495740f2a2b0b6e2f4d3c0',
  approvalGeneration: 1,
  issuedAt: '2026-10-09T15:20:00.000Z',
  expiresAt: null,
  withdrawn: null,
} as const);

export const PREVIOUS_PHASE11_SELECTIONS: Readonly<
  Record<'plo5' | 'plo6' | 'plo8', HorsePhase11AuthoritySelection | null>
> = Object.freeze({
  plo5: Object.freeze({
    schema: 'horse-qualified-authority-selection-v1',
    phase: 'phase11',
    variant: 'plo5',
    sourceSha: '1235b47a63c439da9bdf8427148bc0818499378c',
    packVersion: 'plo5-high-round3-v2',
    contractVersion: 'omaha-variant-strength-contract-v1',
    contractDigest: '5b93ae20962ff79798b998f437ed43d2bd224a64995d86e34ed63d7bb22057fc',
    domain: 'plo5-cash-single-board-after-rake-horse-population',
    qualificationPath: 'docs/evidence/phase11/1235b47a/phase11-qualification-2026-10-09-plo5.json',
    qualificationSha256: 'fdf10caa5d8fd9539951d3a55802861e5d6afc609d52a01c290d669cafdbb699',
    completionPath: 'docs/evidence/phase11/1235b47a/phase11-completion-2026-10-09-plo5.json',
    completionSha256: 'a1020b0a7e24f925f782e16b62482160bd30006a1daf80dc24966bbbe0ce1b7d',
    approvalGeneration: 1,
    issuedAt: '2026-10-09T21:45:00.000Z',
    expiresAt: null,
    withdrawn: null,
  } as const),
  plo6: Object.freeze({
    schema: 'horse-qualified-authority-selection-v1',
    phase: 'phase11',
    variant: 'plo6',
    sourceSha: '1235b47a63c439da9bdf8427148bc0818499378c',
    packVersion: 'plo6-high-round3-v2',
    contractVersion: 'omaha-variant-strength-contract-v1',
    contractDigest: '5b93ae20962ff79798b998f437ed43d2bd224a64995d86e34ed63d7bb22057fc',
    domain: 'plo6-cash-single-board-after-rake-horse-population',
    qualificationPath: 'docs/evidence/phase11/1235b47a/phase11-qualification-2026-10-09-plo6.json',
    qualificationSha256: 'dbb0ecec5bdf94d52d789fc398d6b6b1cce965edbcecb5f68273defcaa47f7b2',
    completionPath: 'docs/evidence/phase11/1235b47a/phase11-completion-2026-10-09-plo6.json',
    completionSha256: 'e57364725b4b107de6dc813c4f6e33af693c85b1da3bd39789b6da4e2d7c0ae2',
    approvalGeneration: 1,
    issuedAt: '2026-10-09T21:45:00.000Z',
    expiresAt: null,
    withdrawn: null,
  } as const),
  plo8: Object.freeze({
    schema: 'horse-qualified-authority-selection-v1',
    phase: 'phase11',
    variant: 'plo8',
    sourceSha: '1235b47a63c439da9bdf8427148bc0818499378c',
    packVersion: 'plo8-split-round3-v2',
    contractVersion: 'omaha-variant-strength-contract-v1',
    contractDigest: '5b93ae20962ff79798b998f437ed43d2bd224a64995d86e34ed63d7bb22057fc',
    domain: 'plo8-cash-single-board-after-rake-horse-population',
    qualificationPath: 'docs/evidence/phase11/1235b47a/phase11-qualification-2026-10-09-plo8.json',
    qualificationSha256: 'eff1eb7a6005979cfc86066c3607cf63197d264dd38455f52187f1254ab95e7b',
    completionPath: 'docs/evidence/phase11/1235b47a/phase11-completion-2026-10-09-plo8.json',
    completionSha256: '7ffd07ce649140e7871e9b31be22de2632445bdfab2de6a10399e240b6ee7a95',
    approvalGeneration: 1,
    issuedAt: '2026-10-09T20:20:00.000Z',
    expiresAt: null,
    withdrawn: null,
  } as const),
});

export const PREVIOUS_PHASE12_SELECTIONS: Readonly<
  Record<RemainingPolicyVariant, HorsePhase12AuthoritySelection | null>
> = Object.freeze({
  short_deck: null,
  pineapple: null,
  flh: Object.freeze({
    schema: 'horse-qualified-authority-selection-v1',
    phase: 'phase12',
    variant: 'flh',
    sourceSha: '9d5674639f2bd091f2386c75cbd87bec419c5dcd',
    packVersion: 'fixed-limit-holdem-round3-v1',
    contractVersion: 'remaining-variant-strength-contract-v1',
    contractDigest: 'fafbba8dc23ebc59b5aadf78fdcc47cd6f504baf9bcd10b07970ad7fbea501c0',
    domain: 'flh-cash-single-board-after-rake-horse-population',
    qualificationPath: 'docs/evidence/phase12/9d567463/phase12-qualification-2026-10-12-flh.json',
    qualificationSha256: '01e91eb38a73dadc9fa2aff7ee4980f64b8b8d8c07a44ec18f50d6bfbccf3f8f',
    completionPath: 'docs/evidence/phase12/9d567463/phase12-completion-2026-10-12-flh.json',
    completionSha256: 'b42fb264780ea75bcc89b6d2f700d875fd68b49bf3600329f85f2a624499fbdf',
    approvalGeneration: 2,
    issuedAt: '2026-10-12T11:00:00.000Z',
    expiresAt: null,
    withdrawn: null,
  } as const),
  flo8: null,
});
