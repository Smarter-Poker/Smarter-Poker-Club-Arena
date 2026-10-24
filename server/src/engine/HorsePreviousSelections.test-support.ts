/** Historical selected generations used only to prove retained evidence refusal. */
import type { HorsePhase10AuthoritySelection } from './HorsePhase10Authority.js';
import type { HorsePhase11AuthoritySelection } from './HorsePhase11Authority.js';
import type { HorsePhase12AuthoritySelection } from './HorsePhase12Authority.js';
import type { HorsePhase13AuthoritySelection } from './HorsePhase13Authority.js';
import type { JointVariant } from './multiway/JointInputBinding.js';
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

/**
 * The selections committed on main until 2026-10-16 (PLO4 and PLO5/PLO6/PLO8
 * generation 2, FLH generation 3, all measured on c92768c8). The packs now do
 * their declared work (docs/changelog/2026-10-16-packs-do-declared-work.md),
 * every policy digest moved, and the committed selections are null until the
 * combined requalification; these retained records must be refused.
 */
export const RETIRED_2026_10_16_PHASE10_SELECTION: HorsePhase10AuthoritySelection = Object.freeze({
  schema: 'horse-qualified-authority-selection-v1',
  phase: 'phase10',
  sourceSha: 'c92768c85bc53a4a5a5972d09c6ee58561010035',
  packVersion: 'plo4-policy-round3-v2',
  contractVersion: 'plo4-strength-contract-v1',
  contractDigest: '83ab185b2a2df72876b73d61ece6ea8c2f03f364ce252deecbfcde392ae5f838',
  domain: 'plo4-cash-single-board-after-rake-horse-population',
  qualificationPath: 'docs/evidence/phase10/c92768c8/phase10-qualification-2026-10-15.json',
  qualificationSha256: 'e4161a38a272241d1b1522461c2964f3bf0d0f463e0d8b45871be79f3b7bf4b9',
  approvalGeneration: 2,
  issuedAt: '2026-10-15T02:45:00.000Z',
  expiresAt: null,
  withdrawn: null,
} as const);

export const RETIRED_2026_10_16_PHASE11_SELECTIONS: Readonly<
  Record<'plo5' | 'plo6' | 'plo8', HorsePhase11AuthoritySelection>
> = Object.freeze({
  plo5: Object.freeze({
    schema: 'horse-qualified-authority-selection-v1',
    phase: 'phase11',
    variant: 'plo5',
    sourceSha: 'c92768c85bc53a4a5a5972d09c6ee58561010035',
    packVersion: 'plo5-high-round3-v2',
    contractVersion: 'omaha-variant-strength-contract-v1',
    contractDigest: '5b93ae20962ff79798b998f437ed43d2bd224a64995d86e34ed63d7bb22057fc',
    domain: 'plo5-cash-single-board-after-rake-horse-population',
    qualificationPath: 'docs/evidence/phase11/c92768c8/phase11-qualification-2026-10-15-plo5.json',
    qualificationSha256: '69c0db872ddcd9b86bd00d410ba2f2458f8797baab9fe1e2944a1f20556b45f1',
    completionPath: 'docs/evidence/phase11/c92768c8/phase11-completion-2026-10-15-plo5.json',
    completionSha256: 'b4928081d22bac9a144e37482be3a6ee29e8bb1e4bb130fb69dc4cd6749dd631',
    approvalGeneration: 2,
    issuedAt: '2026-10-15T07:35:00.000Z',
    expiresAt: null,
    withdrawn: null,
  } as const),
  plo6: Object.freeze({
    schema: 'horse-qualified-authority-selection-v1',
    phase: 'phase11',
    variant: 'plo6',
    sourceSha: 'c92768c85bc53a4a5a5972d09c6ee58561010035',
    packVersion: 'plo6-high-round3-v2',
    contractVersion: 'omaha-variant-strength-contract-v1',
    contractDigest: '5b93ae20962ff79798b998f437ed43d2bd224a64995d86e34ed63d7bb22057fc',
    domain: 'plo6-cash-single-board-after-rake-horse-population',
    qualificationPath: 'docs/evidence/phase11/c92768c8/phase11-qualification-2026-10-15-plo6.json',
    qualificationSha256: '6b12daa4157047af0429798f67f1f2333b6d6f1053eebf11afc881cadd0d34f8',
    completionPath: 'docs/evidence/phase11/c92768c8/phase11-completion-2026-10-15-plo6.json',
    completionSha256: '0360a0cf58e331b7866e38e3b632f0bb55db6fa7b7705b7195ca0fd494651e3c',
    approvalGeneration: 2,
    issuedAt: '2026-10-15T07:35:00.000Z',
    expiresAt: null,
    withdrawn: null,
  } as const),
  plo8: Object.freeze({
    schema: 'horse-qualified-authority-selection-v1',
    phase: 'phase11',
    variant: 'plo8',
    sourceSha: 'c92768c85bc53a4a5a5972d09c6ee58561010035',
    packVersion: 'plo8-split-round3-v2',
    contractVersion: 'omaha-variant-strength-contract-v1',
    contractDigest: '5b93ae20962ff79798b998f437ed43d2bd224a64995d86e34ed63d7bb22057fc',
    domain: 'plo8-cash-single-board-after-rake-horse-population',
    qualificationPath: 'docs/evidence/phase11/c92768c8/phase11-qualification-2026-10-15-plo8.json',
    qualificationSha256: '5cf937a8a7cada1fd72200546c72b71f844c66e2273dbb66ee7c1074e2309456',
    completionPath: 'docs/evidence/phase11/c92768c8/phase11-completion-2026-10-15-plo8.json',
    completionSha256: 'fbeec6201c664c1e8ba93ca4ca745fede9999a1603745c06228783d74925fa59',
    approvalGeneration: 2,
    issuedAt: '2026-10-15T04:20:00.000Z',
    expiresAt: null,
    withdrawn: null,
  } as const),
});

export const RETIRED_2026_10_16_PHASE12_SELECTIONS: Readonly<
  Record<RemainingPolicyVariant, HorsePhase12AuthoritySelection | null>
> = Object.freeze({
  short_deck: null,
  pineapple: null,
  flh: Object.freeze({
    schema: 'horse-qualified-authority-selection-v1',
    phase: 'phase12',
    variant: 'flh',
    sourceSha: 'c92768c85bc53a4a5a5972d09c6ee58561010035',
    packVersion: 'fixed-limit-holdem-round3-v1',
    contractVersion: 'remaining-variant-strength-contract-v1',
    contractDigest: 'fafbba8dc23ebc59b5aadf78fdcc47cd6f504baf9bcd10b07970ad7fbea501c0',
    domain: 'flh-cash-single-board-after-rake-horse-population',
    qualificationPath: 'docs/evidence/phase12/c92768c8/phase12-qualification-2026-10-15-flh.json',
    qualificationSha256: '0b349ec894b1d5f0db47c052abf87a336b9fb4aa087265a96acb613083cb315d',
    completionPath: 'docs/evidence/phase12/c92768c8/phase12-completion-2026-10-15-flh.json',
    completionSha256: '55c641c6f3c6818311be024b005a01136a7a37507991f2d6c33be6170c1641c2',
    approvalGeneration: 3,
    issuedAt: '2026-10-15T01:05:00.000Z',
    expiresAt: null,
    withdrawn: null,
  } as const),
  flo8: null,
});

/**
 * The selections committed on main until the evening of 2026-10-17 (PLO4, PLO5
 * and PLO8 generation 3, FLH generation 4 and Crazy Pineapple generation 1, all
 * measured on d9190c9e). The VPIP floor call-down
 * (docs/changelog/2026-10-17-horses-reach-the-vpip-floor.md) changed
 * HorseLogic.ts, every policy digest moved, and the committed selections are
 * null until requalification; these retained records must be refused.
 */
export const RETIRED_2026_10_17_PHASE10_SELECTION: HorsePhase10AuthoritySelection = Object.freeze({
  schema: 'horse-qualified-authority-selection-v1',
  phase: 'phase10',
  sourceSha: 'd9190c9ef413abbb38c63128b3532df8f9b4756c',
  packVersion: 'plo4-policy-round3-v2',
  contractVersion: 'plo4-strength-contract-v1',
  contractDigest: '83ab185b2a2df72876b73d61ece6ea8c2f03f364ce252deecbfcde392ae5f838',
  domain: 'plo4-cash-single-board-after-rake-horse-population',
  qualificationPath: 'docs/evidence/phase10/d9190c9e/phase10-qualification-2026-10-17.json',
  qualificationSha256: '142db2fb671a27a9b684fa49da61d5dd638ddda6b90380a77a2331052648251e',
  approvalGeneration: 3,
  issuedAt: '2026-10-17T12:15:00.000Z',
  expiresAt: null,
  withdrawn: null,
} as const);

export const RETIRED_2026_10_17_PHASE11_SELECTIONS: Readonly<
  Partial<Record<'plo5' | 'plo6' | 'plo8', HorsePhase11AuthoritySelection>>
> = Object.freeze({
  plo5: Object.freeze({
    schema: 'horse-qualified-authority-selection-v1',
    phase: 'phase11',
    variant: 'plo5',
    sourceSha: 'd9190c9ef413abbb38c63128b3532df8f9b4756c',
    packVersion: 'plo5-high-round3-v2',
    contractVersion: 'omaha-variant-strength-contract-v1',
    contractDigest: '0716bb254de73014914ca086aa26b6ffe499bb2e50897432de6a9e855da5ee05',
    domain: 'plo5-cash-single-board-after-rake-horse-population',
    qualificationPath: 'docs/evidence/phase11/d9190c9e/phase11-qualification-2026-10-17-plo5.json',
    qualificationSha256: '205a57fbcd3e24ea8ce5e9da8a3db799a543e063cebdae6a63aef577ae79de67',
    completionPath: 'docs/evidence/phase11/d9190c9e/phase11-completion-2026-10-17-plo5.json',
    completionSha256: '1d2d6ba92528485c85e3cca84538efb47b35db3f8923b693050fa4e6831e245e',
    approvalGeneration: 3,
    issuedAt: '2026-10-17T17:30:00.000Z',
    expiresAt: null,
    withdrawn: null,
  } as const),
  plo8: Object.freeze({
    schema: 'horse-qualified-authority-selection-v1',
    phase: 'phase11',
    variant: 'plo8',
    sourceSha: 'd9190c9ef413abbb38c63128b3532df8f9b4756c',
    packVersion: 'plo8-split-round3-v2',
    contractVersion: 'omaha-variant-strength-contract-v1',
    contractDigest: '0716bb254de73014914ca086aa26b6ffe499bb2e50897432de6a9e855da5ee05',
    domain: 'plo8-cash-single-board-after-rake-horse-population',
    qualificationPath: 'docs/evidence/phase11/d9190c9e/phase11-qualification-2026-10-17-plo8.json',
    qualificationSha256: 'f35f0f776c6d1590038b0a9b1f00e8595281523ba20aa9f7bb423493d3621693',
    completionPath: 'docs/evidence/phase11/d9190c9e/phase11-completion-2026-10-17-plo8.json',
    completionSha256: '28922822cca6818ede19db54936fcf0fa3eebcc647d06e5b6d14634c861e0361',
    approvalGeneration: 3,
    issuedAt: '2026-10-17T12:15:00.000Z',
    expiresAt: null,
    withdrawn: null,
  } as const),
});

export const RETIRED_2026_10_17_PHASE12_SELECTIONS: Readonly<
  Partial<Record<RemainingPolicyVariant, HorsePhase12AuthoritySelection>>
> = Object.freeze({
  pineapple: Object.freeze({
    schema: 'horse-qualified-authority-selection-v1',
    phase: 'phase12',
    variant: 'pineapple',
    sourceSha: 'd9190c9ef413abbb38c63128b3532df8f9b4756c',
    packVersion: 'crazy-pineapple-round4-v1',
    contractVersion: 'remaining-variant-strength-contract-v2',
    contractDigest: '0abc9fa4e6e850989e0007a8f5be682ac1a14725c11a6272641533a2000884e2',
    domain: 'pineapple-cash-single-board-after-rake-horse-population',
    qualificationPath:
      'docs/evidence/phase12/d9190c9e/phase12-qualification-2026-10-17-pineapple.json',
    qualificationSha256: '9eaa78356b405c334a3cf843fbf13bc4480a2a72de71af2b2d7be08de19ad32a',
    completionPath: 'docs/evidence/phase12/d9190c9e/phase12-completion-2026-10-17-pineapple.json',
    completionSha256: '94e579b0ef8b6e69a3f373d9444377c66e81235fde823df6b9a9f404d98f36fa',
    approvalGeneration: 1,
    issuedAt: '2026-10-17T18:00:00.000Z',
    expiresAt: null,
    withdrawn: null,
  } as const),
  flh: Object.freeze({
    schema: 'horse-qualified-authority-selection-v1',
    phase: 'phase12',
    variant: 'flh',
    sourceSha: 'd9190c9ef413abbb38c63128b3532df8f9b4756c',
    packVersion: 'fixed-limit-holdem-round3-v1',
    contractVersion: 'remaining-variant-strength-contract-v1',
    contractDigest: 'fafbba8dc23ebc59b5aadf78fdcc47cd6f504baf9bcd10b07970ad7fbea501c0',
    domain: 'flh-cash-single-board-after-rake-horse-population',
    qualificationPath: 'docs/evidence/phase12/d9190c9e/phase12-qualification-2026-10-17-flh.json',
    qualificationSha256: '13d6347f44e9ee5d80371d57f5917e71d9db25ab0618dd193156fed152b6a78e',
    completionPath: 'docs/evidence/phase12/d9190c9e/phase12-completion-2026-10-17-flh.json',
    completionSha256: '5d8be703c635218b1bc42bd47a103dcd1465e78440105c828a92795396a178a8',
    approvalGeneration: 4,
    issuedAt: '2026-10-17T05:45:00.000Z',
    expiresAt: null,
    withdrawn: null,
  } as const),
});

/**
 * The selections committed on main until 2026-10-22 (all measured on the
 * VPIP-floor source da94e437): PLO4 generation 4 (Phase 10); PLO5 and PLO8
 * generation 4 and PLO6 generation 3 (Phase 11); the Phase 12 packs; and the
 * Phase 13 PLO4 and PLO8 joint generation 1. MANIAC PRESSURE
 * (docs/changelog/2026-10-22-horses-adjust-to-maniacs.md) changed hashed
 * policy files, every policy digest moved, and the committed selections are
 * null until requalification; these retained records must be refused.
 */
export const RETIRED_2026_10_22_PHASE10_SELECTION: HorsePhase10AuthoritySelection = Object.freeze({
  schema: 'horse-qualified-authority-selection-v1',
  phase: 'phase10',
  sourceSha: 'da94e43740fa4940e7d1f6e4488264c2b6ffb58a',
  packVersion: 'plo4-policy-round3-v2',
  contractVersion: 'plo4-strength-contract-v1',
  contractDigest: '83ab185b2a2df72876b73d61ece6ea8c2f03f364ce252deecbfcde392ae5f838',
  domain: 'plo4-cash-single-board-after-rake-horse-population',
  qualificationPath: 'docs/evidence/phase10/da94e437/phase10-qualification-2026-10-19.json',
  qualificationSha256: '927a604127800a8b36352f8d48ce616c308e351367c847789e18492eac85fcc4',
  approvalGeneration: 4,
  issuedAt: '2026-10-19T02:56:00.000Z',
  expiresAt: null,
  withdrawn: null,
} as const);

/**
 * PLO4 generation 5 (8ea7564b, selected 2026-10-22 in #7706), retired the same
 * day when the second maniac-pressure pass (style-change window, postflop-only
 * aggressor, thicker value into stations, short-stack jam into a maniac)
 * moved the hashed policy digest again. Its evidence stays committed.
 */
export const RETIRED_2026_10_22B_PHASE10_SELECTION: HorsePhase10AuthoritySelection = Object.freeze({
  schema: 'horse-qualified-authority-selection-v1',
  phase: 'phase10',
  sourceSha: '8ea7564bc44ddead3189e76dd0b4c00d5dbcc3d8',
  packVersion: 'plo4-policy-round3-v2',
  contractVersion: 'plo4-strength-contract-v1',
  contractDigest: '83ab185b2a2df72876b73d61ece6ea8c2f03f364ce252deecbfcde392ae5f838',
  domain: 'plo4-cash-single-board-after-rake-horse-population',
  qualificationPath: 'docs/evidence/phase10/8ea7564b/phase10-qualification-2026-10-22.json',
  qualificationSha256: '6d49906c6c60ad4651d217ff82c440a92b66cfa1e047a0a4094feb14df9fe9b5',
  approvalGeneration: 5,
  issuedAt: '2026-10-22T16:00:00.000Z',
  expiresAt: null,
  withdrawn: null,
} as const);

export const RETIRED_2026_10_22_PHASE11_SELECTIONS: Readonly<
  Record<'plo5' | 'plo6' | 'plo8', HorsePhase11AuthoritySelection>
> = Object.freeze({
  plo5: Object.freeze({
    schema: 'horse-qualified-authority-selection-v1',
    phase: 'phase11',
    variant: 'plo5',
    sourceSha: 'da94e43740fa4940e7d1f6e4488264c2b6ffb58a',
    packVersion: 'plo5-high-round3-v2',
    contractVersion: 'omaha-variant-strength-contract-v1',
    contractDigest: '0716bb254de73014914ca086aa26b6ffe499bb2e50897432de6a9e855da5ee05',
    domain: 'plo5-cash-single-board-after-rake-horse-population',
    qualificationPath: 'docs/evidence/phase11/da94e437/phase11-qualification-2026-10-19-plo5.json',
    qualificationSha256: 'ddd51c436feff9833c7a62f4e52858ba890a51a01068285f6ebe5fbe7e0b2dd0',
    completionPath: 'docs/evidence/phase11/da94e437/phase11-completion-2026-10-18-plo5.json',
    completionSha256: 'f3a67c8bba9c6d915a4e4e946cddcb9a3a3fdfbf2f1f3bdd8e71d63064ed346b',
    approvalGeneration: 4,
    issuedAt: '2026-10-19T14:58:00.000Z',
    expiresAt: null,
    withdrawn: null,
  } as const),
  plo6: Object.freeze({
    schema: 'horse-qualified-authority-selection-v1',
    phase: 'phase11',
    variant: 'plo6',
    sourceSha: 'da94e43740fa4940e7d1f6e4488264c2b6ffb58a',
    packVersion: 'plo6-high-round3-v2',
    contractVersion: 'omaha-variant-strength-contract-v1',
    contractDigest: '0716bb254de73014914ca086aa26b6ffe499bb2e50897432de6a9e855da5ee05',
    domain: 'plo6-cash-single-board-after-rake-horse-population',
    qualificationPath: 'docs/evidence/phase11/da94e437/phase11-qualification-2026-10-20-plo6.json',
    qualificationSha256: '6588eb2e99b33f9c7c6597c6cb223612b4a23aacd44c018629cf713e14e751db',
    completionPath: 'docs/evidence/phase11/da94e437/phase11-completion-2026-10-18-plo6.json',
    completionSha256: 'f4a91ae0ced6e07f937cec2bce897b181dba805d72da01a38e407f15f8ffe37a',
    approvalGeneration: 3,
    issuedAt: '2026-10-20T00:50:00.000Z',
    expiresAt: null,
    withdrawn: null,
  } as const),
  plo8: Object.freeze({
    schema: 'horse-qualified-authority-selection-v1',
    phase: 'phase11',
    variant: 'plo8',
    sourceSha: 'da94e43740fa4940e7d1f6e4488264c2b6ffb58a',
    packVersion: 'plo8-split-round3-v2',
    contractVersion: 'omaha-variant-strength-contract-v1',
    contractDigest: '0716bb254de73014914ca086aa26b6ffe499bb2e50897432de6a9e855da5ee05',
    domain: 'plo8-cash-single-board-after-rake-horse-population',
    qualificationPath: 'docs/evidence/phase11/da94e437/phase11-qualification-2026-10-19-plo8.json',
    qualificationSha256: '4d7530d0ee7438d2f114cd031c99f9afe1119e00478c3c4d793e2a5d2fc7b502',
    completionPath: 'docs/evidence/phase11/da94e437/phase11-completion-2026-10-18-plo8.json',
    completionSha256: 'dfb058688e44a25710420d07ab706599794e3ee3b06ff10e2ce3efcf407fa1c9',
    approvalGeneration: 4,
    issuedAt: '2026-10-19T05:15:00.000Z',
    expiresAt: null,
    withdrawn: null,
  } as const),
});

export const RETIRED_2026_10_22_PHASE12_SELECTIONS: Readonly<
  Partial<Record<RemainingPolicyVariant, HorsePhase12AuthoritySelection>>
> = Object.freeze({
  short_deck: Object.freeze({
    schema: 'horse-qualified-authority-selection-v1',
    phase: 'phase12',
    variant: 'short_deck',
    sourceSha: 'da94e43740fa4940e7d1f6e4488264c2b6ffb58a',
    packVersion: 'short-deck-round4-v1',
    contractVersion: 'remaining-variant-strength-contract-v2',
    contractDigest: '0abc9fa4e6e850989e0007a8f5be682ac1a14725c11a6272641533a2000884e2',
    domain: 'short_deck-cash-single-board-after-rake-horse-population',
    qualificationPath: 'docs/evidence/phase12/phase12-qualification-2026-10-20-short_deck.json',
    qualificationSha256: 'ac82168403f0dcd7843a373e42c9dff27f57235c2a83b538182f4b017ec7137d',
    completionPath: 'docs/evidence/phase12/da94e437/phase12-completion-2026-10-18-short_deck.json',
    completionSha256: '021458012fe61c50a3b0f54ccf724929fe215757a5486ac8c0dba5723a29f590',
    approvalGeneration: 1,
    issuedAt: '2026-10-20T14:45:00.000Z',
    expiresAt: null,
    withdrawn: null,
  } as const),
  pineapple: Object.freeze({
    schema: 'horse-qualified-authority-selection-v1',
    phase: 'phase12',
    variant: 'pineapple',
    sourceSha: 'da94e43740fa4940e7d1f6e4488264c2b6ffb58a',
    packVersion: 'crazy-pineapple-round4-v1',
    contractVersion: 'remaining-variant-strength-contract-v2',
    contractDigest: '0abc9fa4e6e850989e0007a8f5be682ac1a14725c11a6272641533a2000884e2',
    domain: 'pineapple-cash-single-board-after-rake-horse-population',
    qualificationPath:
      'docs/evidence/phase12/da94e437/phase12-qualification-2026-10-20-pineapple.json',
    qualificationSha256: '486e10c30f91608f2edffaca0eedd0c90934dd6ea23d0b0d6895d1e7b236bb4b',
    completionPath: 'docs/evidence/phase12/da94e437/phase12-completion-2026-10-18-pineapple.json',
    completionSha256: 'a418ca7168fc5c19462b43a42acbc79743ed867b631dd757bcf0fa599d1f7d98',
    approvalGeneration: 2,
    issuedAt: '2026-10-20T01:10:00.000Z',
    expiresAt: null,
    withdrawn: null,
  } as const),
  flh: Object.freeze({
    schema: 'horse-qualified-authority-selection-v1',
    phase: 'phase12',
    variant: 'flh',
    sourceSha: 'da94e43740fa4940e7d1f6e4488264c2b6ffb58a',
    packVersion: 'fixed-limit-holdem-round3-v1',
    contractVersion: 'remaining-variant-strength-contract-v1',
    contractDigest: 'fafbba8dc23ebc59b5aadf78fdcc47cd6f504baf9bcd10b07970ad7fbea501c0',
    domain: 'flh-cash-single-board-after-rake-horse-population',
    qualificationPath: 'docs/evidence/phase12/da94e437/phase12-qualification-2026-10-19-flh.json',
    qualificationSha256: 'f73fc3a73d22d7d054896aa87bea4f12a61de26d4933d7e9ba8f51ee21105d27',
    completionPath: 'docs/evidence/phase12/da94e437/phase12-completion-2026-10-18-flh.json',
    completionSha256: 'ebcfe429ba70a20377f51716154ca908b556a9e9e0eb77630edec41be1ef589e',
    approvalGeneration: 5,
    issuedAt: '2026-10-19T00:25:00.000Z',
    expiresAt: null,
    withdrawn: null,
  } as const),
});

export const RETIRED_2026_10_22_PHASE13_SELECTIONS: Readonly<
  Partial<Record<JointVariant, HorsePhase13AuthoritySelection>>
> = Object.freeze({
  plo4: Object.freeze({
    schema: 'horse-qualified-authority-selection-v1',
    phase: 'phase13',
    variant: 'plo4',
    sourceSha: 'da94e43740fa4940e7d1f6e4488264c2b6ffb58a',
    packVersion: 'joint-multiway-round1-v4',
    contractVersion: 'joint-strength-contract-v1',
    contractDigest: '0cd88d970c600fb64933337672af349e9d106402d4edfcc3510e1f26374741f8',
    domain: 'plo4-cash-joint-multiway-after-rake-horse-population',
    qualificationPath: 'docs/evidence/phase13/phase13-qualification-2026-10-20-plo4.json',
    qualificationSha256: '099eea8275df9642c244179c480e94453d8137716d033e3df86eb94ce0f91c00',
    completionPath: 'docs/evidence/phase13/da94e437/phase13-completion-2026-10-19-plo4.json',
    completionSha256: '34990e77cb3f59413b209b6d2864f19889e578af0f4e099fe3b17e0be32ccd2c',
    approvalGeneration: 1,
    issuedAt: '2026-10-20T18:28:00.000Z',
    expiresAt: null,
    withdrawn: null,
  } as const),
  plo8: Object.freeze({
    schema: 'horse-qualified-authority-selection-v1',
    phase: 'phase13',
    variant: 'plo8',
    sourceSha: 'da94e43740fa4940e7d1f6e4488264c2b6ffb58a',
    packVersion: 'joint-multiway-round1-v4',
    contractVersion: 'joint-strength-contract-v1',
    contractDigest: '0cd88d970c600fb64933337672af349e9d106402d4edfcc3510e1f26374741f8',
    domain: 'plo8-cash-joint-multiway-after-rake-horse-population',
    qualificationPath: 'docs/evidence/phase13/phase13-qualification-2026-10-20-plo8.json',
    qualificationSha256: '2f474919d34ad6dcd69a3a5729743ed38ec6d725e4a4e498c4dab59d785b4db6',
    completionPath: 'docs/evidence/phase13/da94e437/phase13-completion-2026-10-19-plo8.json',
    completionSha256: 'ea223f0f4a5604d35c72f6209ebddf34c6c34a2e96fe2870446ddcd3f0a16e83',
    approvalGeneration: 1,
    issuedAt: '2026-10-20T14:45:00.000Z',
    expiresAt: null,
    withdrawn: null,
  } as const),
});
