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
