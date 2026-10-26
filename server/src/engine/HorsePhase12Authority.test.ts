import { createHash } from 'node:crypto';
import { isHorseOwnerForcedAuthority } from './HorseOwnerForcedActivation.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PREVIOUS_PHASE12_SELECTIONS,
  RETIRED_2026_10_16_PHASE12_SELECTIONS,
  RETIRED_2026_10_17_PHASE12_SELECTIONS,
  RETIRED_2026_10_22_PHASE12_SELECTIONS,
} from './HorsePreviousSelections.test-support.js';
import {
  admitHorsePhase12QualifiedAuthority,
  admitHorsePhase12ReleaseAuthority,
  HORSE_PHASE12_COMPLETION_DEFINITION,
  HORSE_PHASE12_COMPLETION_FLOOR,
  HORSE_PHASE12_COMPLETION_MIN_ELIGIBLE_PER_STREET,
  HORSE_PHASE12_COMPLETION_SCHEMA,
  HORSE_PHASE12_EVIDENCE_DIRECTORY,
  HORSE_PHASE12_FULL_SAMPLES,
  HORSE_PHASE12_QUALIFICATION_KEYS,
  HORSE_PHASE12_QUALIFICATION_SCHEMA,
  HORSE_PHASE12_VARIANTS,
  horsePhase12AdmittedMode,
  horsePhase12CompletionCounts,
  horsePhase12CompletionLowerBound,
  horsePhase12CompletionMeetsFloor,
  horsePhase12CompletionOutcome,
  liveHorsePhase12Authorities,
  PHASE12_PROTECTED_RELEASE_SELECTIONS,
  PHASE12_RUNNING_CONTRACT_DIGESTS,
  selectedHorsePhase12Authority,
  type HorsePhase12AuthoritySelection,
} from './HorsePhase12Authority.js';
import {
  HorsePhase8AuthorityGate,
  HorseQualifiedAuthorityHolder,
  type HorseAuthorityAdmission,
  type HorseAuthorityEvidenceReader,
} from './HorseQualifiedAuthority.js';
import { memoryReader } from './HorseQualifiedAuthority.test-support.js';
import { qualifiedPhase11TestAdmission } from './HorsePhase11Authority.test-support.js';
import {
  p12TestContractDigest,
  P12_TEST_ISSUED_AT,
  P12_TEST_NOW,
  P12_TEST_SOURCE_SHA,
  p12CompletionBytes,
  p12CompletionObject,
  p12CompletionPath,
  p12QualificationBytes,
  p12QualificationObject,
  p12QualificationPath,
  p12Reader,
  p12Selection,
  p12Street,
  p12StrengthPath,
  p12TestStrength,
  qualifiedPhase12TestAdmission,
} from './HorsePhase12Authority.test-support.js';
import {
  REMAINING_VARIANT_STRENGTH_CONTRACT,
  remainingVariantStrengthContractDigest,
  remainingVariantStrengthDomain,
} from '../benchmark/RemainingVariantStrengthContract.js';
import { horsePhase12PolicyDigest } from './HorsePhase12PolicyDigest.js';
import {
  REMAINING_VARIANT_DOMAIN,
  REMAINING_VARIANT_PACKS,
  type RemainingPolicyVariant,
} from './remainingVariants/RemainingVariantPolicyPack.js';
import { OMAHA_VARIANT_PACKS } from './omaha/OmahaVariantPolicyPack.js';
import { evaluateRemainingVariantPolicy } from './remainingVariants/RemainingVariantLivePolicy.js';
import { remainingVariantRequestedSamples } from './remainingVariants/RemainingVariantSampler.js';
import { remainingVariantSpot } from '../benchmark/RemainingVariantPolicyEvidence.js';
import { equityGovernor } from './EquityLoadGovernor.js';
import { restoreFastRandom, saveFastRandom } from './HorseEval.js';
import { slowClock, stalledClock, withoutMeasurements } from './HorseDeclaredWork.test-support.js';

const V: RemainingPolicyVariant = 'flo8';
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');

/** Admit `variant` from a selection over in-memory files. */
function admit(
  variant: RemainingPolicyVariant,
  selection: HorsePhase12AuthoritySelection | null,
  qualification: Buffer = p12QualificationBytes(variant),
  completion: Buffer | null = p12CompletionBytes(variant),
  runningDigest: string | null = p12TestContractDigest(variant),
  runningPolicyDigest?: string | null
): HorseAuthorityAdmission {
  return admitHorsePhase12QualifiedAuthority(
    variant,
    selection,
    p12Reader(variant, qualification, completion),
    P12_TEST_NOW,
    runningDigest,
    runningPolicyDigest
  );
}
/** One pack's evidence with one file replaced, the selection binding the replacement. */
const withQualification = (overrides: Record<string, unknown>, variant = V) => {
  const q = p12QualificationBytes(variant, overrides);
  return admit(variant, p12Selection(variant, q), q);
};
const withQualificationObject = (value: unknown, variant = V) => {
  const q = json(value);
  return admit(variant, p12Selection(variant, q), q);
};
const withCompletion = (overrides: Record<string, unknown>, variant = V) => {
  const c = p12CompletionBytes(variant, overrides);
  return admit(variant, p12Selection(variant, undefined, c), undefined, c);
};
const withCompletionBytes = (c: Buffer, variant = V) =>
  admit(variant, p12Selection(variant, undefined, c), undefined, c);

/** Independent recomputation of the authority key from the stated identity. */
function expectedKey(identity: Record<string, unknown>): string {
  const sorted = Object.fromEntries(
    Object.keys(identity)
      .sort()
      .map((k) => [k, identity[k]])
  );
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

describe('P12.3 maniac pressure (2026-10-22) requires fresh qualification of every pack', () => {
  const selected = HORSE_PHASE12_VARIANTS.filter(
    (v) => PHASE12_PROTECTED_RELEASE_SELECTIONS[v] !== null
  );
  const unselected = HORSE_PHASE12_VARIANTS.filter(
    (v) => PHASE12_PROTECTED_RELEASE_SELECTIONS[v] === null
  );

  it('nothing is selected; Short Deck generation 1, FLH generations 2 to 5 and Crazy Pineapple generations 1 and 2 are retained; each pack keeps its own contract digest, FLH the frozen v1', () => {
    expect(Object.isFrozen(PHASE12_PROTECTED_RELEASE_SELECTIONS)).toBe(true);
    expect([...HORSE_PHASE12_VARIANTS]).toEqual(['short_deck', 'pineapple', 'flh', 'flo8']);
    // FLH's generation-1 selection measured policy digest a55db7fe..., which
    // the round-4 sampler kernels and scoped packs moved: it was re-measured
    // under contract v1 on 9d567463 and selected at generation 2. The PFR
    // repair moved it again; generation 3 requalified the repaired source.
    // The declared-work change (2026-10-16) moved it again; generation 4
    // requalified the declared-work source d9190c9e (2026-10-17), as did
    // Crazy Pineapple generation 1 under contract v2. The VPIP floor
    // call-down (2026-10-17 evening) moved every digest again. FLH generation 5
    // requalified the VPIP-floor source da94e437 (2026-10-19); the other three
    // packs stay unselected until their own matrices finish. Maniac pressure
    // (2026-10-22) moved every digest again: Short Deck generation 1, FLH
    // generation 5 and Crazy Pineapple generation 2 (all da94e437) are
    // retained and every pack plays shadow until its matrix requalifies.
    expect(selected).toEqual([]);
    expect(Object.keys(RETIRED_2026_10_22_PHASE12_SELECTIONS).sort()).toEqual([
      'flh',
      'pineapple',
      'short_deck',
    ]);
    for (const [variant, generation] of [
      ['short_deck', 1],
      ['pineapple', 2],
      ['flh', 5],
    ] as const)
      expect(RETIRED_2026_10_22_PHASE12_SELECTIONS[variant], variant).toMatchObject({
        schema: 'horse-qualified-authority-selection-v1',
        phase: 'phase12',
        variant,
        packVersion: REMAINING_VARIANT_PACKS[variant].version,
        contractDigest: PHASE12_RUNNING_CONTRACT_DIGESTS[variant],
        sourceSha: 'da94e43740fa4940e7d1f6e4488264c2b6ffb58a',
        approvalGeneration: generation,
        expiresAt: null,
        withdrawn: null,
      });
    expect(RETIRED_2026_10_22_PHASE12_SELECTIONS.flh!.approvalGeneration).toBeGreaterThan(
      RETIRED_2026_10_17_PHASE12_SELECTIONS.flh!.approvalGeneration
    );
    expect(RETIRED_2026_10_22_PHASE12_SELECTIONS.pineapple!.approvalGeneration).toBeGreaterThan(
      RETIRED_2026_10_17_PHASE12_SELECTIONS.pineapple!.approvalGeneration
    );
    expect(RETIRED_2026_10_17_PHASE12_SELECTIONS.flh).toMatchObject({
      sourceSha: 'd9190c9ef413abbb38c63128b3532df8f9b4756c',
      contractDigest: PHASE12_RUNNING_CONTRACT_DIGESTS.flh,
      approvalGeneration: 4,
    });
    expect(RETIRED_2026_10_17_PHASE12_SELECTIONS.pineapple).toMatchObject({
      sourceSha: 'd9190c9ef413abbb38c63128b3532df8f9b4756c',
      contractDigest: PHASE12_RUNNING_CONTRACT_DIGESTS.pineapple,
      approvalGeneration: 1,
    });
    expect(RETIRED_2026_10_16_PHASE12_SELECTIONS.flh).toMatchObject({
      sourceSha: 'c92768c85bc53a4a5a5972d09c6ee58561010035',
      contractDigest: PHASE12_RUNNING_CONTRACT_DIGESTS.flh,
      approvalGeneration: 3,
    });
    expect(PREVIOUS_PHASE12_SELECTIONS.flh).toMatchObject({
      sourceSha: '9d5674639f2bd091f2386c75cbd87bec419c5dcd',
      qualificationPath: 'docs/evidence/phase12/9d567463/phase12-qualification-2026-10-12-flh.json',
      completionPath: 'docs/evidence/phase12/9d567463/phase12-completion-2026-10-12-flh.json',
      approvalGeneration: 2,
    });
    expect(Object.isFrozen(PHASE12_RUNNING_CONTRACT_DIGESTS)).toBe(true);
    for (const variant of HORSE_PHASE12_VARIANTS) {
      expect(PHASE12_RUNNING_CONTRACT_DIGESTS[variant], variant).toBe(
        remainingVariantStrengthContractDigest(variant)
      );
      expect(PHASE12_RUNNING_CONTRACT_DIGESTS[variant], variant).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(PHASE12_RUNNING_CONTRACT_DIGESTS.flh).toBe(
      'fafbba8dc23ebc59b5aadf78fdcc47cd6f504baf9bcd10b07970ad7fbea501c0'
    );
    for (const variant of ['short_deck', 'pineapple', 'flo8'] as const)
      expect(PHASE12_RUNNING_CONTRACT_DIGESTS[variant], variant).toBe(
        remainingVariantStrengthContractDigest('short_deck')
      );
    expect(PHASE12_RUNNING_CONTRACT_DIGESTS.short_deck).not.toBe(
      PHASE12_RUNNING_CONTRACT_DIGESTS.flh
    );
    for (const variant of HORSE_PHASE12_VARIANTS) {
      const selection = PHASE12_PROTECTED_RELEASE_SELECTIONS[variant];
      const release = admitHorsePhase12ReleaseAuthority(variant);
      if (selection === null) {
        expect(release, variant).toEqual({
          status: 'refused',
          reason: 'unselected',
          transient: false,
        });
        expect(selectedHorsePhase12Authority(variant, release)).toBeNull();
        continue;
      }
      expect(selection, variant).toMatchObject({
        schema: 'horse-qualified-authority-selection-v1',
        phase: 'phase12',
        variant,
        packVersion: REMAINING_VARIANT_PACKS[variant].version,
        contractDigest: PHASE12_RUNNING_CONTRACT_DIGESTS[variant],
        sourceSha: 'da94e43740fa4940e7d1f6e4488264c2b6ffb58a',
        approvalGeneration: variant === 'flh' ? 5 : variant === 'pineapple' ? 2 : 1,
        expiresAt: null,
        withdrawn: null,
      });
      // 2026-10-19: FLH generation 5 measured the running policy digest, so
      // the committed selection is admitted from its shipped evidence.
      expect(release.status, variant).toBe('admitted');
      expect(selectedHorsePhase12Authority(variant, release), variant).not.toBeNull();
      // An admitted pack is the candidate at cash tables and shadow in
      // tournaments.
      for (const [gameMode, expected] of [
        ['cash', 'candidate'],
        ['tournament', 'shadow'],
      ] as const)
        expect(
          horsePhase12AdmittedMode({
            gameMode,
            variant,
            packVariant: variant,
            verdict: 'usable',
            callerMode: undefined,
          }),
          `${variant} ${gameMode}`
        ).toBe(expected);
    }
  });

  it('retains exact FLH generation-2 to 5, Crazy Pineapple generation-1 and 2 and Short Deck generation-1 qualification and completion hashes but refuses them for the running policy', () => {
    for (const previous of [
      PREVIOUS_PHASE12_SELECTIONS.flh!,
      RETIRED_2026_10_16_PHASE12_SELECTIONS.flh!,
      RETIRED_2026_10_17_PHASE12_SELECTIONS.flh!,
      RETIRED_2026_10_17_PHASE12_SELECTIONS.pineapple!,
      RETIRED_2026_10_22_PHASE12_SELECTIONS.flh!,
      RETIRED_2026_10_22_PHASE12_SELECTIONS.pineapple!,
      RETIRED_2026_10_22_PHASE12_SELECTIONS.short_deck!,
    ]) {
      expect(admitHorsePhase12ReleaseAuthority(previous.variant, Date.now(), previous)).toEqual({
        status: 'refused',
        reason: 'policy_digest_mismatch',
        transient: false,
      });
      for (const [path, digest] of [
        [previous.qualificationPath, previous.qualificationSha256],
        [previous.completionPath!, previous.completionSha256!],
      ]) {
        const bytes = readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)));
        expect(createHash('sha256').update(bytes).digest('hex'), path).toBe(digest);
      }
    }
  });

  it('a fresh qualified generation 4 can renew FLH while generation 3 cannot return after withdrawal', () => {
    const holder = new HorseQualifiedAuthorityHolder(
      'declared-work-flh-renewal',
      REMAINING_VARIANT_PACKS.flh.version
    );
    holder.apply({
      status: 'withdrawn',
      approvalGeneration: 3,
      reason: 'prior_policy_source_changed',
    });
    holder.apply(qualifiedPhase12TestAdmission('flh', 3));
    expect(holder.currentState()).toBe('withdrawn');
    holder.apply(qualifiedPhase12TestAdmission('flh', 4));
    expect(holder.currentState()).toBe('usable');
    expect(holder.receipt().approvalGeneration).toBe(4);
  });

  it('every retained FLH and Crazy Pineapple generation stays shipped with its evidence', () => {
    const retained = [
      RETIRED_2026_10_16_PHASE12_SELECTIONS.flh!,
      RETIRED_2026_10_17_PHASE12_SELECTIONS.flh!,
      RETIRED_2026_10_17_PHASE12_SELECTIONS.pineapple!,
      RETIRED_2026_10_22_PHASE12_SELECTIONS.flh!,
      RETIRED_2026_10_22_PHASE12_SELECTIONS.pineapple!,
      RETIRED_2026_10_22_PHASE12_SELECTIONS.short_deck!,
    ];
    expect(RETIRED_2026_10_16_PHASE12_SELECTIONS.flh!.approvalGeneration).toBeGreaterThan(
      PREVIOUS_PHASE12_SELECTIONS.flh!.approvalGeneration
    );
    expect(RETIRED_2026_10_17_PHASE12_SELECTIONS.flh!.approvalGeneration).toBeGreaterThan(
      RETIRED_2026_10_16_PHASE12_SELECTIONS.flh!.approvalGeneration
    );
    for (const selection of retained)
      for (const [path, digest] of [
        [selection.qualificationPath, selection.qualificationSha256],
        [selection.completionPath!, selection.completionSha256!],
      ]) {
        for (const root of ['../../../', '../../release-evidence/']) {
          const bytes = readFileSync(fileURLToPath(new URL(`${root}${path}`, import.meta.url)));
          expect(createHash('sha256').update(bytes).digest('hex'), `${root}${path}`).toBe(digest);
        }
      }
    for (const variant of unselected)
      expect(PHASE12_PROTECTED_RELEASE_SELECTIONS[variant], variant).toBeNull();
  });

  it('an unselected pack returns unselected before any evidence file is read', () => {
    const reads: string[] = [];
    const tripwire: HorseAuthorityEvidenceReader = {
      read(path) {
        reads.push(path);
        throw Object.assign(new Error('read'), { code: 'EACCES' });
      },
    };
    for (const variant of unselected) {
      expect(
        admitHorsePhase12ReleaseAuthority(variant, P12_TEST_NOW, undefined, tripwire),
        variant
      ).toEqual({ status: 'refused', reason: 'unselected', transient: false });
      expect(
        admitHorsePhase12QualifiedAuthority(variant, null, tripwire, P12_TEST_NOW, null, null)
      ).toEqual({ status: 'refused', reason: 'unselected', transient: false });
    }
    expect(reads).toEqual([]);
  });

  it('the running code refuses a well-formed qualified selection made under another contract', () => {
    const other = 'e'.repeat(64);
    const q = p12QualificationBytes(V, { contractDigest: other });
    const release = admitHorsePhase12ReleaseAuthority(
      V,
      P12_TEST_NOW,
      p12Selection(V, q, undefined, { contractDigest: other }),
      p12Reader(V, q)
    );
    expect(release).toEqual({
      status: 'refused',
      reason: 'contract_digest_mismatch',
      transient: false,
    });
    expect(
      admitHorsePhase12ReleaseAuthority(V, P12_TEST_NOW, p12Selection(V), p12Reader(V), null)
    ).toMatchObject({ status: 'refused', reason: 'contract_unavailable' });
  });

  it('each live main-scheduler gate is usable exactly when its pack is selected; an unselected gate accepts no receipt', () => {
    for (const variant of HORSE_PHASE12_VARIANTS) {
      const gate = liveHorsePhase12Authorities[variant];
      gate.refresh();
      const isSelected = PHASE12_PROTECTED_RELEASE_SELECTIONS[variant] !== null;
      // Dan 2026-10-26, "FORCE ACTIVATE EVERY PHASE NOW WITHOUT QUALIFYING":
      // an unselected pack's gate is usable under the owner's authority, and
      // still accepts no receipt from any other authority.
      expect(gate.mainState(), variant).toBe('usable');
      expect(isHorseOwnerForcedAuthority(gate.mainAuthority()), variant).toBe(!isSelected);
      if (isSelected) continue;
      const worker = new HorseQualifiedAuthorityHolder(
        `p123-null-${variant}`,
        REMAINING_VARIANT_PACKS[variant].version
      );
      worker.apply(qualifiedPhase12TestAdmission(variant));
      expect(worker.currentState()).toBe('usable');
      gate.observeWorker(worker.receipt());
      expect(gate.check(gate.stamp(worker.receipt())), variant).toBe('mismatched');
      gate.forgetWorker(worker.epoch);
    }
  });

  it('withdrawal is a committed record: a selection with withdrawn set is a withdrawal, never a selection', () => {
    // Every pack: its committed selection, or (none committed) the test one.
    for (const variant of HORSE_PHASE12_VARIANTS) {
      const base = PREVIOUS_PHASE12_SELECTIONS[variant] ?? p12Selection(variant);
      const withdrawn = {
        ...base,
        withdrawn: { at: '2026-10-12T12:00:00.000Z', reason: 'condition_b_lost_after_rake' },
      };
      const release = admitHorsePhase12ReleaseAuthority(variant, Date.now(), withdrawn);
      expect(release, variant).toEqual({
        status: 'withdrawn',
        approvalGeneration: base.approvalGeneration,
        reason: 'release_condition_b_lost_after_rake',
      });
      expect(selectedHorsePhase12Authority(variant, release)).toBeNull();
    }
  });

  it('a pack under one contract is refused another contract: FLH v1 evidence never admits Short Deck, v2 evidence never admits FLH', () => {
    const v1 = PHASE12_RUNNING_CONTRACT_DIGESTS.flh;
    const v2 = PHASE12_RUNNING_CONTRACT_DIGESTS.short_deck;
    for (const [variant, foreign] of [
      ['short_deck', v1],
      ['flh', v2],
    ] as const) {
      const q = p12QualificationBytes(variant, { contractDigest: foreign });
      expect(
        admitHorsePhase12ReleaseAuthority(
          variant,
          P12_TEST_NOW,
          p12Selection(variant, q, undefined, { contractDigest: foreign }),
          p12Reader(variant, q)
        ),
        variant
      ).toEqual({ status: 'refused', reason: 'contract_digest_mismatch', transient: false });
      // With its own contract the same pack is admitted from the same files.
      expect(qualifiedPhase12TestAdmission(variant).status, variant).toBe('admitted');
    }
  });

  // A MEASURED PACK IS NOT A PROMOTED PACK (2026-10-05), kept since the FLH
  // selection (2026-10-10): a qualification that says qualified:true is
  // exactly the one its pack's selection names, or (round 4) one whose
  // measured policy digest no longer runs, which no admission can accept.
  // Since the generation-2 FLH selection (2026-10-12) the only qualified:true
  // FLH qualification on the running FLH policy digest is the selected one.
  it('the only qualified:true qualification of each pack is the one its selection names, or one measured on a policy that no longer runs', () => {
    const dir = fileURLToPath(new URL('../../../docs/evidence/phase12/', import.meta.url));
    const files = existsSync(dir)
      ? readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.json'))
      : [];
    const qualifiedSelected: string[] = [];
    for (const file of files) {
      const parsed = JSON.parse(readFileSync(`${dir}${file}`, 'utf8')) as Record<string, unknown>;
      if (parsed.schema === HORSE_PHASE12_QUALIFICATION_SCHEMA && parsed.qualified === true) {
        const variant = parsed.variant as keyof typeof PHASE12_PROTECTED_RELEASE_SELECTIONS;
        const named =
          PHASE12_PROTECTED_RELEASE_SELECTIONS[variant]?.qualificationPath ===
          `docs/evidence/phase12/${file}`;
        if (!named) expect(parsed.policyDigest, file).not.toBe(horsePhase12PolicyDigest(variant));
        else {
          expect(parsed.policyDigest, file).toBe(horsePhase12PolicyDigest(variant));
          qualifiedSelected.push(`${variant}:${file}`);
        }
      }
      if (parsed.schema === HORSE_PHASE12_COMPLETION_SCHEMA)
        expect(HORSE_PHASE12_VARIANTS as readonly string[], file).toContain(parsed.variant);
    }
    // 2026-10-22: nothing is selected, so no qualified:true file is on the
    // running policy until a pack requalifies the maniac-pressure source.
    expect(qualifiedSelected).toEqual([]);
  });
});

describe('P12.3 admission refuses by name unless the pack qualifies and completes on the running policy', () => {
  const eacces = Object.assign(new Error('denied'), { code: 'EACCES' });
  const objectives = p12QualificationObject(V).objectives;
  const withoutKey = (key: string) => {
    const value: Record<string, unknown> = p12QualificationObject(V);
    delete value[key];
    return value;
  };
  it.each([
    ['no selection', () => admit(V, null), 'unselected'],
    [
      'a path outside docs/evidence/phase12/',
      () => admit(V, p12Selection(V, undefined, undefined, { qualificationPath: 'docs/x.json' })),
      'invalid_selection',
    ],
    [
      'a Phase 11 evidence path',
      () =>
        admit(
          V,
          p12Selection(V, undefined, undefined, {
            qualificationPath: 'docs/evidence/phase11/q.json',
          })
        ),
      'invalid_selection',
    ],
    [
      'path traversal in the completion path',
      () =>
        admit(
          V,
          p12Selection(V, undefined, undefined, {
            completionPath: 'docs/evidence/phase12/../phase11/x.json',
          })
        ),
      'invalid_selection',
    ],
    [
      'a completion path without its sha256',
      () => admit(V, p12Selection(V, undefined, undefined, { completionSha256: null })),
      'invalid_selection',
    ],
    [
      'a completion path equal to the qualification path',
      () =>
        admit(
          V,
          p12Selection(V, undefined, undefined, { completionPath: p12QualificationPath(V) })
        ),
      'invalid_selection',
    ],
    [
      'a Phase 11 selection',
      () => admit(V, p12Selection(V, undefined, undefined, { phase: 'phase11' as 'phase12' })),
      'invalid_selection',
    ],
    [
      'a selection for a variant that is not a Phase 12 pack',
      () =>
        admit(
          V,
          p12Selection(V, undefined, undefined, { variant: 'plo8' as RemainingPolicyVariant })
        ),
      'invalid_selection',
    ],
    [
      'a Short Deck selection admitted as the FLO8 pack',
      () => admit(V, p12Selection('short_deck')),
      'continuation_mismatch',
    ],
    [
      'another pack version',
      () =>
        admit(
          V,
          p12Selection(V, undefined, undefined, { packVersion: 'fixed-limit-omaha8-round1-v2' })
        ),
      'continuation_mismatch',
    ],
    [
      'a tournament domain',
      () => admit(V, p12Selection(V, undefined, undefined, { domain: 'flo8-tournament-prize' })),
      'continuation_mismatch',
    ],
    [
      'no running contract digest',
      () => admit(V, p12Selection(V), undefined, undefined, null),
      'contract_unavailable',
    ],
    [
      'a selection for a different contract digest than the running one',
      () => admit(V, p12Selection(V), undefined, undefined, 'e'.repeat(64)),
      'contract_digest_mismatch',
    ],
    [
      'a file for a different contract digest',
      () => withQualification({ contractDigest: 'e'.repeat(64) }),
      'contract_digest_mismatch',
    ],
    [
      'running policy code whose digest cannot be computed',
      () => admit(V, p12Selection(V), undefined, undefined, undefined, null),
      'policy_digest_unavailable',
    ],
    [
      'an expired selection',
      () =>
        admit(
          V,
          p12Selection(V, undefined, undefined, {
            expiresAt: new Date(P12_TEST_NOW - 1).toISOString(),
          })
        ),
      'expired',
    ],
    [
      'no qualification file',
      () =>
        admitHorsePhase12QualifiedAuthority(
          V,
          p12Selection(V),
          memoryReader({}),
          P12_TEST_NOW,
          p12TestContractDigest(V)
        ),
      'missing_evidence',
    ],
    [
      'qualification bytes that differ from the selected sha256',
      () => admit(V, p12Selection(V), p12QualificationBytes(V, { reasons: ['edited'] })),
      'hash_mismatch',
    ],
    [
      'a file that is not JSON',
      () => {
        const q = Buffer.from('not json');
        return admit(V, p12Selection(V, q), q);
      },
      'evidence_mismatch',
    ],
    [
      'a Phase 11 qualification schema',
      () => withQualification({ schema: 'horse-phase11-qualification-v1' }),
      'evidence_mismatch',
    ],
    [
      'a file with a key the assembler never writes',
      () => withQualification({ promoted: true }),
      'evidence_mismatch',
    ],
    [
      'a file missing an assembler key (reasons)',
      () => withQualificationObject(withoutKey('reasons')),
      'evidence_mismatch',
    ],
    [
      'a cash objective without its regression margin',
      () =>
        withQualification({
          objectives: { ...objectives, cash: { qualified: true, status: 'measured' } },
        }),
      'evidence_mismatch',
    ],
    ['qualified:false', () => withQualification({ qualified: false }), 'not_qualified'],
    [
      'a development-mode assembly',
      () => withQualification({ mode: 'development' }),
      'not_qualified',
    ],
    [
      'a top-level qualified:true whose cash objective is not qualified',
      () =>
        withQualification({
          objectives: { ...objectives, cash: { ...objectives.cash, qualified: false } },
        }),
      'not_qualified',
    ],
    [
      'a cash objective that was not measured',
      () =>
        withQualification({
          objectives: { ...objectives, cash: { ...objectives.cash, status: 'pilot' } },
        }),
      'not_qualified',
    ],
    [
      'a qualified file that still names a failure',
      () => withQualification({ reasons: ['cash:primary:regression_margin_exceeded'] }),
      'not_qualified',
    ],
    [
      'a file measured on other policy code',
      () => withQualification({ policyDigest: 'd'.repeat(64) }),
      'policy_digest_mismatch',
    ],
    [
      'a file under another policy digest definition',
      () => withQualification({ policyDigestDefinition: 'horse-phase11-policy-digest-v2' }),
      'policy_digest_mismatch',
    ],
    [
      'running code that differs from the measured code',
      () => admit(V, p12Selection(V), undefined, undefined, undefined, 'e'.repeat(64)),
      'policy_digest_mismatch',
    ],
    [
      'a Short Deck qualification file under a FLO8 selection',
      () => {
        const q = p12QualificationBytes('short_deck');
        return admit(V, p12Selection(V, q), q);
      },
      'policy_digest_mismatch',
    ],
    [
      'a file for a different source SHA',
      () => withQualification({ sourceSha: 'c'.repeat(40) }),
      'source_mismatch',
    ],
    [
      'a file whose variant is another pack',
      () => withQualification({ variant: 'flh' }),
      'continuation_mismatch',
    ],
    [
      'a file whose pack version is another',
      () => withQualification({ packVersion: 'fixed-limit-omaha8-round1-v2' }),
      'continuation_mismatch',
    ],
    [
      'a file whose domain is not the cash domain',
      () => withQualification({ domain: 'flo8-tournament-prize' }),
      'continuation_mismatch',
    ],
    [
      'a file under another contract version',
      () => withQualification({ contractVersion: 'remaining-variant-strength-contract-v0' }),
      'evidence_mismatch',
    ],
    [
      'a cash margin other than the contract margin for the pack',
      () =>
        withQualification({
          objectives: {
            ...objectives,
            cash: { ...objectives.cash, regressionMarginBbPer100: -10 },
          },
        }),
      'evidence_mismatch',
    ],
    [
      'a file that claims the tournament objective',
      () =>
        withQualification({
          objectives: { ...objectives, tournament: { ...objectives.tournament, qualified: true } },
        }),
      'evidence_mismatch',
    ],
    [
      'a file that drops the admission requirement',
      () => withQualification({ admissionAlsoRequires: [] }),
      'evidence_mismatch',
    ],
    [
      'a strength record outside docs/evidence/phase12/',
      () => withQualification({ evidencePath: 'docs/evidence/phase11/strength.json' }),
      'evidence_mismatch',
    ],
    [
      'a missing strength record',
      () =>
        admitHorsePhase12QualifiedAuthority(
          V,
          p12Selection(V),
          memoryReader({
            [p12QualificationPath(V)]: p12QualificationBytes(V),
            [p12CompletionPath(V)]: p12CompletionBytes(V),
          }),
          P12_TEST_NOW,
          p12TestContractDigest(V)
        ),
      'missing_evidence',
    ],
    [
      'a strength record that is not the hashed one',
      () =>
        admitHorsePhase12QualifiedAuthority(
          V,
          p12Selection(V),
          memoryReader({
            [p12QualificationPath(V)]: p12QualificationBytes(V),
            [p12StrengthPath(V)]: Buffer.concat([p12TestStrength(V), Buffer.from(' ')]),
            [p12CompletionPath(V)]: p12CompletionBytes(V),
          }),
          P12_TEST_NOW,
          p12TestContractDigest(V)
        ),
      'hash_mismatch',
    ],
    [
      'a selection that names no completion record',
      () => admit(V, p12Selection(V, undefined, null), undefined, null),
      'completion_evidence_missing',
    ],
    [
      'a named completion record that is not committed',
      () => admit(V, p12Selection(V), undefined, null),
      'completion_evidence_missing',
    ],
    [
      'completion bytes that differ from the selected sha256',
      () =>
        admit(V, p12Selection(V), undefined, p12CompletionBytes(V, { releaseSha: 'd'.repeat(40) })),
      'completion_hash_mismatch',
    ],
    [
      'a completion record that is not JSON',
      () => withCompletionBytes(Buffer.from('[]')),
      'completion_evidence_mismatch',
    ],
    [
      'another completion schema (Phase 11)',
      () => withCompletion({ schema: 'horse-phase11-completion-v1' }),
      'completion_evidence_mismatch',
    ],
    [
      'another completion definition',
      () => withCompletion({ definition: 'horse-phase11-completion-definition-v2' }),
      'completion_evidence_mismatch',
    ],
    [
      'a completion record with an unknown field',
      () => withCompletion({ note: 'extra' }),
      'completion_evidence_mismatch',
    ],
    [
      'a tournament completion record',
      () => withCompletion({ gameMode: 'tournament' }),
      'completion_evidence_mismatch',
    ],
    [
      'a street without the governor-reduced count (the Phase 11 shape)',
      () =>
        withCompletion({
          streets: {
            ...p12CompletionObject(V).streets,
            river: {
              eligible: 200,
              completed: 200,
              workBudget: 0,
              samplerBudgetExhausted: 0,
              sampleUnavailable: 0,
            },
          },
        }),
      'completion_evidence_mismatch',
    ],
    [
      'street counts that do not add up',
      () =>
        withCompletion({
          streets: {
            ...p12CompletionObject(V).streets,
            river: { ...p12Street(), governorReduced: 1 },
          },
        }),
      'completion_evidence_mismatch',
    ],
    [
      'a missing street',
      () =>
        withCompletion({
          streets: { preflop: p12Street(), flop: p12Street(), turn: p12Street() },
        }),
      'completion_evidence_mismatch',
    ],
    [
      'a negative count',
      () =>
        withCompletion({
          streets: {
            ...p12CompletionObject(V).streets,
            flop: { ...p12Street(200, 0, 0, 0, 0), completed: 201, governorReduced: -1 },
          },
        }),
      'completion_evidence_mismatch',
    ],
    [
      'a malformed release SHA',
      () => withCompletion({ releaseSha: 'main' }),
      'completion_evidence_mismatch',
    ],
    [
      'completion measured on another policy digest',
      () => withCompletion({ policyDigest: 'd'.repeat(64) }),
      'completion_release_mismatch',
    ],
    [
      'completion measured under another digest definition',
      () => withCompletion({ policyDigestDefinition: 'horse-phase11-policy-digest-v2' }),
      'completion_release_mismatch',
    ],
    [
      'completion of another pack',
      () => withCompletion({ variant: 'flh', policyDigest: horsePhase12PolicyDigest('flh') }),
      'completion_release_mismatch',
    ],
    [
      'completion of another pack version',
      () => withCompletion({ packVersion: 'fixed-limit-omaha8-round1-v2' }),
      'completion_release_mismatch',
    ],
    [
      'a reversed window',
      () =>
        withCompletion({
          window: { ...p12CompletionObject(V).window, from: '2026-10-19T00:00:00.000Z' },
        }),
      'completion_window_invalid',
    ],
    [
      'a window during which the release changed',
      () =>
        withCompletion({ window: { ...p12CompletionObject(V).window, releaseUnchanged: false } }),
      'completion_window_invalid',
    ],
    [
      'a window that ends after the selection was issued',
      () =>
        withCompletion({
          window: { ...p12CompletionObject(V).window, to: '2026-10-20T00:00:00.001Z' },
        }),
      'completion_window_invalid',
    ],
    [
      'a window that is not an exact ISO timestamp',
      () => withCompletion({ window: { ...p12CompletionObject(V).window, from: '2026-10-12' } }),
      'completion_window_invalid',
    ],
    [
      'a river that falls back to the baseline on 15 of 200 decisions',
      () =>
        withCompletion({
          streets: { ...p12CompletionObject(V).streets, river: p12Street(200, 15) },
        }),
      'completion_below_floor',
    ],
    [
      'a turn whose live samples were cut short on 15 of 200 decisions',
      () =>
        withCompletion({
          streets: { ...p12CompletionObject(V).streets, turn: p12Street(200, 0, 15) },
        }),
      'completion_below_floor',
    ],
    [
      'a flop priced with no live sample on 15 of 200 decisions',
      () =>
        withCompletion({
          streets: { ...p12CompletionObject(V).streets, flop: p12Street(200, 0, 0, 15) },
        }),
      'completion_below_floor',
    ],
    [
      'a river whose samples the governor reduced on 15 of 200 decisions',
      () =>
        withCompletion({
          streets: { ...p12CompletionObject(V).streets, river: p12Street(200, 0, 0, 0, 15) },
        }),
      'completion_below_floor',
    ],
    [
      'a street with no eligible decisions',
      () => withCompletion({ streets: { ...p12CompletionObject(V).streets, flop: p12Street(0) } }),
      'completion_below_floor',
    ],
    [
      'an all-complete street too small to bound the share (126 decisions)',
      () =>
        withCompletion({ streets: { ...p12CompletionObject(V).streets, preflop: p12Street(126) } }),
      'completion_below_floor',
    ],
  ] as const)('%s', (_name, run, reason) => {
    const admission = run();
    expect(admission).toEqual({ status: 'refused', reason, transient: false });
    expect(selectedHorsePhase12Authority(V, admission)).toBeNull();
  });

  it.each([
    ['the qualification file', p12QualificationPath(V)],
    ['the strength record', p12StrengthPath(V)],
    ['the completion record', p12CompletionPath(V)],
  ])('an I/O failure reading %s is a transient refusal, never a withdrawal', (_name, path) => {
    const files: Record<string, Buffer | Error> = {
      [p12QualificationPath(V)]: p12QualificationBytes(V),
      [p12StrengthPath(V)]: p12TestStrength(V),
      [p12CompletionPath(V)]: p12CompletionBytes(V),
      [path]: eacces,
    };
    expect(
      admitHorsePhase12QualifiedAuthority(
        V,
        p12Selection(V),
        memoryReader(files),
        P12_TEST_NOW,
        p12TestContractDigest(V)
      )
    ).toEqual({ status: 'refused', reason: 'unreadable_evidence', transient: true });
  });

  it('a reader that throws outside admission is a transient refusal at the release path', () => {
    const exploding = {
      read() {
        throw new Error('boom');
      },
    } as unknown as HorseAuthorityEvidenceReader;
    expect(
      admitHorsePhase12ReleaseAuthority(V, P12_TEST_NOW, p12Selection(V), exploding)
    ).toMatchObject({ status: 'refused', reason: 'unreadable_evidence', transient: true });
  });

  it('a committed withdrawal is a withdrawal, not a selection', () => {
    const admission = admit(
      V,
      p12Selection(V, undefined, undefined, {
        withdrawn: { at: '2026-10-20T00:30:00.000Z', reason: 'owner' },
      })
    );
    expect(admission).toEqual({
      status: 'withdrawn',
      approvalGeneration: 1,
      reason: 'release_owner',
    });
    expect(selectedHorsePhase12Authority(V, admission)).toBeNull();
  });

  it('the fixture writes exactly the keys the P12.2 assembler writes', () => {
    expect(Object.keys(p12QualificationObject(V)).sort()).toEqual(
      [...HORSE_PHASE12_QUALIFICATION_KEYS].sort()
    );
    const assembler = readFileSync(
      fileURLToPath(new URL('../../scripts/phase12-strength-assemble.mjs', import.meta.url)),
      'utf8'
    );
    const body = assembler.slice(assembler.indexOf('const qualification = {'));
    for (const key of HORSE_PHASE12_QUALIFICATION_KEYS)
      expect(body.slice(0, body.indexOf('\n  };')), key).toMatch(new RegExp(`\\n    ${key}[,:]`));
  });

  it.each(HORSE_PHASE12_VARIANTS)(
    'a valid %s qualification and completion record (test fixture only) select an immutable record bound to both',
    (variant) => {
      const q = p12QualificationBytes(variant);
      const c = p12CompletionBytes(variant);
      const authority = selectedHorsePhase12Authority(
        variant,
        admit(variant, p12Selection(variant, q, c), q, c)
      );
      expect(authority).not.toBeNull();
      expect(Object.isFrozen(authority)).toBe(true);
      const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
      const identity = {
        schema: 'horse-qualified-authority-v1',
        phase: 'phase12',
        variant,
        sourceSha: P12_TEST_SOURCE_SHA,
        continuationVersion: REMAINING_VARIANT_PACKS[variant].version,
        policyDigest: horsePhase12PolicyDigest(variant),
        packId: REMAINING_VARIANT_PACKS[variant].version,
        domain: remainingVariantStrengthDomain(variant),
        evidencePath: p12QualificationPath(variant),
        evidenceSha256: sha(q),
        completionPath: p12CompletionPath(variant),
        completionSha256: sha(c),
        approvalGeneration: 1,
        issuedAt: P12_TEST_ISSUED_AT,
        expiresAt: null,
        contractDigest: p12TestContractDigest(variant),
      };
      expect(authority).toEqual({
        ...identity,
        authorityKey: expectedKey({
          ...identity,
          completionDefinition: HORSE_PHASE12_COMPLETION_DEFINITION,
          completionFloor: HORSE_PHASE12_COMPLETION_FLOOR,
        }),
      });
      // Another completion record is another authority.
      const c2 = p12CompletionBytes(variant, { releaseSha: 'd'.repeat(40) });
      const other = selectedHorsePhase12Authority(
        variant,
        admit(variant, p12Selection(variant, q, c2), q, c2)
      );
      expect(other?.authorityKey).toMatch(/^[0-9a-f]{64}$/);
      expect(other?.authorityKey).not.toBe(authority!.authorityKey);
    }
  );

  it('an all-complete street of exactly the minimum size passes; one decision fewer does not', () => {
    expect(HORSE_PHASE12_COMPLETION_MIN_ELIGIBLE_PER_STREET).toBe(127);
    const n = HORSE_PHASE12_COMPLETION_MIN_ELIGIBLE_PER_STREET;
    const at = (preflop: ReturnType<typeof p12Street>) =>
      withCompletion({ streets: { ...p12CompletionObject(V).streets, preflop } });
    expect(at(p12Street(n)).status).toBe('admitted');
    expect(at(p12Street(n - 1))).toMatchObject({ reason: 'completion_below_floor' });
    // 5% of 2000 decisions not completing is a point share of exactly the
    // floor, which the lower bound refuses; 2.5% clears it, whichever of the
    // four non-completing outcomes it is.
    expect(at(p12Street(2000, 100))).toMatchObject({ reason: 'completion_below_floor' });
    expect(at(p12Street(2000, 0, 0, 0, 100))).toMatchObject({ reason: 'completion_below_floor' });
    expect(at(p12Street(2000, 50)).status).toBe('admitted');
    expect(at(p12Street(2000, 10, 10, 10, 20)).status).toBe('admitted');
  });
});

describe('P12.3 one pack never admits another', () => {
  it('a qualified Short Deck selection and its evidence admit Short Deck only', () => {
    const shortDeck = qualifiedPhase12TestAdmission('short_deck');
    expect(selectedHorsePhase12Authority('short_deck', shortDeck)).not.toBeNull();
    for (const other of ['pineapple', 'flh', 'flo8'] as const) {
      expect(selectedHorsePhase12Authority(other, shortDeck)).toBeNull();
      // The same selection and files, admitted as another pack.
      expect(
        admitHorsePhase12QualifiedAuthority(
          other,
          p12Selection('short_deck'),
          p12Reader('short_deck'),
          P12_TEST_NOW,
          p12TestContractDigest(other)
        )
      ).toMatchObject({ status: 'refused', reason: 'continuation_mismatch' });
      // The release path for another pack reads only its own selection: with
      // that selection null, the Short Deck files do not admit it.
      expect(
        admitHorsePhase12ReleaseAuthority(other, P12_TEST_NOW, null, p12Reader('short_deck'))
      ).toMatchObject({
        reason: 'unselected',
      });
    }
    // A Phase 11 authority is never a Phase 12 one.
    expect(selectedHorsePhase12Authority('flo8', qualifiedPhase11TestAdmission('plo8'))).toBeNull();
  });

  it('each pack holder is usable only for its own pack; Phase 11 and the packs never stand in for each other', () => {
    for (const variant of HORSE_PHASE12_VARIANTS) {
      const own = new HorseQualifiedAuthorityHolder(
        'p123-own',
        REMAINING_VARIANT_PACKS[variant].version
      );
      own.apply(qualifiedPhase12TestAdmission(variant));
      expect(own.verdict(own.receipt(), P12_TEST_NOW), variant).toBe('usable');
      for (const other of HORSE_PHASE12_VARIANTS.filter((v) => v !== variant)) {
        const crossed = new HorseQualifiedAuthorityHolder(
          'p123-crossed',
          REMAINING_VARIANT_PACKS[other].version
        );
        crossed.apply(qualifiedPhase12TestAdmission(variant));
        expect(crossed.verdict(crossed.receipt(), P12_TEST_NOW), `${variant}->${other}`).toBe(
          'mismatched'
        );
      }
      const plo8 = new HorseQualifiedAuthorityHolder('p123-plo8', OMAHA_VARIANT_PACKS.plo8.version);
      plo8.apply(qualifiedPhase12TestAdmission(variant));
      expect(plo8.verdict(plo8.receipt(), P12_TEST_NOW)).toBe('mismatched');
      const fromPhase11 = new HorseQualifiedAuthorityHolder(
        'p123-p11',
        REMAINING_VARIANT_PACKS[variant].version
      );
      fromPhase11.apply(qualifiedPhase11TestAdmission('plo8'));
      expect(fromPhase11.verdict(fromPhase11.receipt(), P12_TEST_NOW)).toBe('mismatched');
    }
  });

  it('a withdrawal, refresh failure or restart of one pack gate never touches another', () => {
    const gates = Object.fromEntries(
      HORSE_PHASE12_VARIANTS.map((variant) => {
        let admission = qualifiedPhase12TestAdmission(variant, 5);
        const gate = new HorsePhase8AuthorityGate(
          () => admission,
          `p123-main-${variant}`,
          REMAINING_VARIANT_PACKS[variant].version
        );
        gate.refresh();
        const worker = new HorseQualifiedAuthorityHolder(
          'p123-worker',
          REMAINING_VARIANT_PACKS[variant].version
        );
        worker.apply(qualifiedPhase12TestAdmission(variant, 5));
        gate.observeWorker(worker.receipt());
        return [
          variant,
          {
            gate,
            worker,
            fail: () => {
              admission = { status: 'refused', reason: 'unreadable_evidence', transient: true };
            },
          },
        ];
      })
    ) as Record<
      RemainingPolicyVariant,
      { gate: HorsePhase8AuthorityGate; worker: HorseQualifiedAuthorityHolder; fail: () => void }
    >;
    const check = (v: RemainingPolicyVariant) =>
      gates[v].gate.check(gates[v].gate.stamp(gates[v].worker.receipt()), P12_TEST_NOW);
    for (const v of HORSE_PHASE12_VARIANTS) expect(check(v)).toBe('usable');
    gates.short_deck.gate.withdraw('controller_fallback_candidate');
    gates.pineapple.fail();
    gates.pineapple.gate.refresh();
    gates.flh.gate.forgetWorker('p123-worker');
    expect([check('short_deck'), check('pineapple'), check('flh'), check('flo8')]).toEqual([
      'withdrawn',
      'refresh_failed',
      'restarted',
      'usable',
    ]);
    // Re-admitting the withdrawn approval is not a renewal.
    gates.short_deck.gate.refresh();
    expect(gates.short_deck.gate.mainState()).toBe('withdrawn');
  });

  it.each([
    ['cash', 'short_deck', 'short_deck', 'usable', undefined, 'candidate'],
    ['cash', 'pineapple', 'pineapple', 'usable', 'shadow', 'candidate'],
    ['cash', 'flh', 'flh', 'usable', undefined, 'candidate'],
    ['cash', 'flo8', 'flo8', 'unselected', undefined, 'shadow'],
    ['cash', 'flo8', 'flo8', 'refused', undefined, 'shadow'],
    ['cash', 'flo8', 'flo8', 'withdrawn', undefined, 'shadow'],
    ['cash', 'flo8', 'flo8', 'stale_generation', undefined, 'shadow'],
    ['cash', 'flh', 'flo8', 'usable', undefined, 'shadow'],
    ['cash', 'plo8', null, 'usable', undefined, 'shadow'],
    ['cash', 'short_deck', 'short_deck', 'usable', 'off', 'off'],
    ['tournament', 'short_deck', 'short_deck', 'usable', undefined, 'shadow'],
    ['tournament', 'flo8', 'flo8', 'usable', 'shadow', 'shadow'],
    [undefined, 'flh', 'flh', 'usable', undefined, 'shadow'],
  ] as const)(
    'a %s %s decision with a %s holder verdict %s and caller %s runs the pack in %s mode',
    (gameMode, variant, packVariant, verdict, callerMode, expected) => {
      expect(
        horsePhase12AdmittedMode({ gameMode, variant, packVariant, verdict, callerMode })
      ).toBe(expected);
    }
  );
});

describe('P12.3 natural completion share: what a record counts', () => {
  afterEach(() => vi.restoreAllMocks());
  const receipt = (overrides: Record<string, unknown> = {}) => ({
    variant: 'flo8',
    version: REMAINING_VARIANT_PACKS.flo8.version,
    eligible: true,
    utilityOwner: 'cash',
    street: 'river',
    reason: 'split_price_call',
    inputs: {
      range: {
        status: 'consumed',
        provenance: {
          work: { requestedSamples: 32, completedSamples: 32, budgetExhausted: false },
        },
      },
    },
    ...overrides,
  });
  const work = (requestedSamples: number, completedSamples: number) => ({
    inputs: {
      range: {
        status: 'consumed',
        provenance: {
          work: {
            requestedSamples,
            completedSamples,
            budgetExhausted: completedSamples < requestedSamples,
          },
        },
      },
    },
  });

  it.each([
    ['a complete full-sample eligible cash decision', receipt(), 'completed'],
    ['a work-budget fallback', receipt({ reason: 'work_budget' }), 'work_budget'],
    ['a consumed live sample cut short', receipt(work(32, 20)), 'sampler_budget_exhausted'],
    [
      'a governor-reduced sample that was also cut short',
      receipt(work(16, 10)),
      'sampler_budget_exhausted',
    ],
    ['a governor-reduced complete sample', receipt(work(16, 16)), 'governor_reduced'],
    ['the smallest governor sample', receipt(work(4, 4)), 'governor_reduced'],
    [
      'a postflop decision with no live sample',
      receipt({ inputs: { range: { status: 'unavailable', provenance: null } } }),
      'sample_unavailable',
    ],
    [
      'a postflop decision on an unattributed sample',
      receipt({ inputs: { range: { status: 'consumed_unattributed', provenance: null } } }),
      'sample_unavailable',
    ],
    [
      'a consumed sample whose work cannot be read',
      receipt({ inputs: { range: { status: 'consumed', provenance: {} } } }),
      'sample_unavailable',
    ],
    ['a postflop decision with no inputs', receipt({ inputs: null }), 'sample_unavailable'],
    [
      'a preflop decision (no sample)',
      receipt({
        street: 'preflop',
        inputs: { range: { status: 'not_consumed_preflop', provenance: null } },
      }),
      'completed',
    ],
    ['an ineligible decision', receipt({ eligible: false }), 'not_counted'],
    ['a tournament decision', receipt({ utilityOwner: 'phase7_evaluated' }), 'not_counted'],
    ['a pending tournament decision', receipt({ utilityOwner: 'phase7_pending' }), 'not_counted'],
    [
      'an eligible-looking Pineapple discard receipt',
      receipt({ variant: 'flo8', street: 'pineapple_discard' }),
      'not_counted',
    ],
    ['another pack', receipt({ variant: 'flh' }), 'not_counted'],
    ['another pack version', receipt({ version: 'fixed-limit-omaha8-round1-v2' }), 'not_counted'],
    [
      'a Phase 11 receipt',
      receipt({ variant: 'plo8', version: 'plo8-split-round1-v2' }),
      'not_counted',
    ],
    ['a receipt that is not an object', null, 'not_counted'],
  ] as const)('%s counts as %s', (_name, value, expected) => {
    expect(horsePhase12CompletionOutcome('flo8', value)).toBe(expected);
  });

  it('the full sample count is the governor-off request of the live sampler', () => {
    expect(HORSE_PHASE12_FULL_SAMPLES).toBe(REMAINING_VARIANT_DOMAIN.defaultSamples);
    expect(remainingVariantRequestedSamples(1)).toBe(HORSE_PHASE12_FULL_SAMPLES);
    expect(remainingVariantRequestedSamples(0.999)).toBeLessThan(HORSE_PHASE12_FULL_SAMPLES);
    expect(remainingVariantRequestedSamples(0.5)).toBe(16);
    expect(remainingVariantRequestedSamples(0)).toBe(4);
  });

  /** A real receipt from the live policy at one spot under one clock. */
  const live = (
    variant: RemainingPolicyVariant,
    street: 'preflop' | 'flop' | 'turn' | 'river',
    clock: () => number,
    mode: 'cash' | 'tournament' = 'cash'
  ) => {
    const s = remainingVariantSpot(variant, street, 2, mode);
    const r = evaluateRemainingVariantPolicy(s.hero, s.state, s.baseline, null, 'shadow', clock);
    // As journaled: the JSON the worker writes.
    return JSON.parse(JSON.stringify(r.receipt)) as Record<string, any>;
  };

  it.each(HORSE_PHASE12_VARIANTS)(
    'counts real %s policy receipts by street, every outcome included',
    (variant) => {
      const seen: unknown[] = [];
      for (const street of ['preflop', 'flop', 'turn', 'river'] as const) {
        const ok = live(variant, street, () => 0);
        expect(ok.eligible, street).toBe(true);
        expect(horsePhase12CompletionOutcome(variant, ok), street).toBe('completed');
        // 2026-10-16: the clock is a measurement only. A slow or stalled host
        // makes the decision the fixed clock makes, from the same random state.
        const rng = saveFastRandom();
        const fixed = withoutMeasurements(live(variant, street, () => 0));
        for (const clock of [slowClock(5), stalledClock()]) {
          restoreFastRandom(rng);
          const late = live(variant, street, clock);
          expect(late.reason, street).not.toBe('work_budget');
          expect(withoutMeasurements(late), street).toEqual(fixed);
        }
        // A receipt of an earlier release that fell back on the old 4 ms
        // budget is still classified as one.
        const slow = { ...structuredClone(ok), reason: 'work_budget', fired: false };
        seen.push(ok, slow);
        if (street === 'preflop') continue;
        // No live sample drawn (sampleWhenMissing false; no clock can starve
        // the sampler any more): sample unavailable.
        const s = remainingVariantSpot(variant, street, 2, 'cash');
        const none = JSON.parse(
          JSON.stringify(
            evaluateRemainingVariantPolicy(
              s.hero,
              s.state,
              s.baseline,
              null,
              'shadow',
              () => 0,
              1,
              false
            ).receipt
          )
        ) as Record<string, any>;
        expect(none.inputs.range.status, street).toBe('unavailable');
        expect(horsePhase12CompletionOutcome(variant, none), street).toBe('sample_unavailable');
        // An earlier release's sample cut short by the old sampler deadline.
        const cut = structuredClone(ok);
        expect(cut.inputs.range.status, street).toBe('consumed');
        cut.inputs.range.provenance.work.budgetExhausted = true;
        cut.inputs.range.provenance.work.completedSamples = 9;
        expect(horsePhase12CompletionOutcome(variant, cut), street).toBe(
          'sampler_budget_exhausted'
        );
        // Under load the live sampler still prices the measured policy's full
        // sample (2026-10-09): the governor no longer scales it, so a loaded
        // engine does not make the decision governor-reduced.
        const governor = vi.spyOn(equityGovernor, 'current').mockReturnValue(0.5);
        const loaded = live(variant, street, () => 0);
        governor.mockRestore();
        expect(loaded.inputs.range.provenance.work, street).toEqual({
          requestedSamples: HORSE_PHASE12_FULL_SAMPLES,
          completedSamples: HORSE_PHASE12_FULL_SAMPLES,
          budgetExhausted: false,
        });
        expect(horsePhase12CompletionOutcome(variant, loaded), street).toBe('completed');
        // A journaled receipt from an earlier release that requested fewer is
        // still governor-reduced, never completed.
        const reduced = structuredClone(loaded);
        reduced.inputs.range.provenance.work.requestedSamples = 16;
        reduced.inputs.range.provenance.work.completedSamples = 16;
        expect(horsePhase12CompletionOutcome(variant, reduced), street).toBe('governor_reduced');
        seen.push(none, cut, reduced);
      }
      // A tournament decision is never counted (Pineapple has no tournament
      // format and is refused before it is eligible).
      const tournament = live(variant, 'river', () => 0, 'tournament');
      expect(horsePhase12CompletionOutcome(variant, tournament)).toBe('not_counted');
      seen.push(tournament);
      const counts = horsePhase12CompletionCounts(variant, seen);
      expect(counts.preflop).toEqual({
        eligible: 2,
        completed: 1,
        workBudget: 1,
        samplerBudgetExhausted: 0,
        sampleUnavailable: 0,
        governorReduced: 0,
      });
      for (const street of ['flop', 'turn', 'river'] as const)
        expect(counts[street], street).toEqual({
          eligible: 5,
          completed: 1,
          workBudget: 1,
          samplerBudgetExhausted: 1,
          sampleUnavailable: 1,
          governorReduced: 1,
        });
      // Another pack's counting reads none of them.
      const other = HORSE_PHASE12_VARIANTS.find((v) => v !== variant)!;
      expect(horsePhase12CompletionCounts(other, seen).river.eligible).toBe(0);
    }
  );

  it('a real Pineapple discard is never counted', () => {
    const s = remainingVariantSpot('pineapple', 'flop', 2);
    const discard = evaluateRemainingVariantPolicy(
      s.hero,
      { ...s.state, stage: 'pineapple_discard' as never },
      s.baseline,
      null,
      'shadow',
      () => 0
    );
    expect(discard.receipt).toMatchObject({ reason: 'discard_owned_by_worker', eligible: false });
    expect(horsePhase12CompletionOutcome('pineapple', discard.receipt)).toBe('not_counted');
    // Even relabelled eligible, a discard street is not a betting street.
    expect(horsePhase12CompletionOutcome('pineapple', { ...discard.receipt, eligible: true })).toBe(
      'not_counted'
    );
    expect(horsePhase12CompletionCounts('pineapple', [discard.receipt]).flop.eligible).toBe(0);
  });

  it('the floor is judged on the Wilson lower bound at the contract interval z', () => {
    const z = REMAINING_VARIANT_STRENGTH_CONTRACT.interval.z;
    expect(z).toBeCloseTo(2.5758293035489004, 15);
    expect(HORSE_PHASE12_COMPLETION_FLOOR).toBe(0.95);
    expect(horsePhase12CompletionLowerBound(200, 200)).toBeCloseTo(200 / (200 + z * z), 12);
    const n = 1000;
    const p = 0.97;
    const wilson =
      (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) /
      (1 + (z * z) / n);
    expect(horsePhase12CompletionLowerBound(970, 1000)).toBeCloseTo(wilson, 12);
    expect(horsePhase12CompletionLowerBound(0, 0)).toBe(0);
    // 126 all-complete is just below the floor, 127 just above.
    expect(horsePhase12CompletionLowerBound(126, 126)).toBeLessThan(0.95);
    expect(horsePhase12CompletionLowerBound(127, 127)).toBeGreaterThanOrEqual(0.95);
    const streets = p12CompletionObject(V).streets as Parameters<
      typeof horsePhase12CompletionMeetsFloor
    >[0];
    expect(horsePhase12CompletionMeetsFloor(streets)).toBe(true);
    expect(
      horsePhase12CompletionMeetsFloor({ ...streets, river: p12Street(1000, 0, 0, 0, 30) } as never)
    ).toBe(true);
    expect(
      horsePhase12CompletionMeetsFloor({ ...streets, river: p12Street(1000, 0, 0, 0, 40) } as never)
    ).toBe(false);
  });

  it('the evidence directory, schema names and admission requirement are the P12.2 ones', () => {
    expect(HORSE_PHASE12_EVIDENCE_DIRECTORY).toBe('docs/evidence/phase12/');
    expect(HORSE_PHASE12_QUALIFICATION_SCHEMA).toBe('horse-phase12-qualification-v1');
    expect(HORSE_PHASE12_COMPLETION_SCHEMA).toBe('horse-phase12-completion-v1');
    expect(HORSE_PHASE12_COMPLETION_DEFINITION).toBe('horse-phase12-completion-definition-v1');
    expect(REMAINING_VARIANT_STRENGTH_CONTRACT.liveConditions.admissionAlsoRequires[0]).toContain(
      'P12.3 must state and meet its own floor'
    );
    expect(json(p12QualificationObject('pineapple').admissionAlsoRequires).toString()).toBe(
      json([...REMAINING_VARIANT_STRENGTH_CONTRACT.liveConditions.admissionAlsoRequires]).toString()
    );
  });
});
