import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  admitHorsePhase13QualifiedAuthority,
  admitHorsePhase13ReleaseAuthority,
  HORSE_PHASE13_COMPLETION_DEFINITION,
  HORSE_PHASE13_COMPLETION_FLOOR,
  HORSE_PHASE13_COMPLETION_MIN_ELIGIBLE_PER_STREET,
  HORSE_PHASE13_COMPLETION_SCHEMA,
  HORSE_PHASE13_COMPLETION_STREET_KEYS,
  HORSE_PHASE13_CONTRACT_VERSION,
  HORSE_PHASE13_EVIDENCE_DIRECTORY,
  HORSE_PHASE13_PACK_VERSION,
  HORSE_PHASE13_QUALIFICATION_KEYS,
  HORSE_PHASE13_QUALIFICATION_SCHEMA,
  HORSE_PHASE13_VARIANTS,
  horsePhase13AdmittedMode,
  horsePhase13CompletionBoardCounts,
  horsePhase13CompletionCounts,
  horsePhase13CompletionLowerBound,
  horsePhase13CompletionMeetsFloor,
  horsePhase13CompletionRecordMeetsFloor,
  horsePhase13CompletionOutcome,
  horsePhase13ContractAdmissionRequires,
  horsePhase13ContractMargin,
  horsePhase13ContinuationVersion,
  liveHorsePhase13Authorities,
  PHASE13_PROTECTED_RELEASE_SELECTIONS,
  PHASE13_RUNNING_CONTRACT_DIGEST,
  selectedHorsePhase13Authority,
  type HorsePhase13AuthoritySelection,
} from './HorsePhase13Authority.js';
import { HORSE_PHASE12_QUALIFICATION_KEYS } from './HorsePhase12Authority.js';
import {
  HorsePhase8AuthorityGate,
  HorseQualifiedAuthorityHolder,
  type HorseAuthorityAdmission,
  type HorseAuthorityEvidenceReader,
} from './HorseQualifiedAuthority.js';
import { memoryReader } from './HorseQualifiedAuthority.test-support.js';
import { qualifiedPhase12TestAdmission } from './HorsePhase12Authority.test-support.js';
import {
  P13_TEST_CONTRACT_DIGEST,
  P13_TEST_ISSUED_AT,
  P13_TEST_NOW,
  P13_TEST_SOURCE_SHA,
  p13CompletionBytes,
  p13CompletionObject,
  p13CompletionPath,
  p13QualificationBytes,
  p13QualificationObject,
  p13QualificationPath,
  p13Reader,
  p13Selection,
  p13Street,
  p13StrengthPath,
  p13TestStrength,
  qualifiedPhase13TestAdmission,
} from './HorsePhase13Authority.test-support.js';
import {
  JOINT_STRENGTH_CONTRACT,
  JOINT_STRENGTH_VARIANTS,
  JOINT_STRENGTH_Z99,
  jointStrengthContractDigest,
  jointStrengthDomain,
} from '../benchmark/JointStrengthContract.js';
import { horsePhase13PolicyDigest } from './HorsePhase13PolicyDigest.js';
import { JOINT_VARIANTS, type JointVariant } from './multiway/JointInputBinding.js';
import { evaluateJointLivePolicy, JOINT_LIVE_DOMAIN } from './multiway/JointLivePolicy.js';
import { jointFullSamples, jointRequestedSamples } from './multiway/JointSampleAcquisition.js';
import { jointPolicyFixture } from './multiway/JointRangeFixture.test-support.js';
import { REMAINING_VARIANT_PACKS } from './remainingVariants/RemainingVariantPolicyPack.js';
import { equityGovernor } from './EquityLoadGovernor.js';
import { KNOWN_VARIANTS } from './VariantRules.js';

const V: JointVariant = 'plo4';
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');

/** Admit `variant` from a selection over in-memory files. */
function admit(
  variant: JointVariant,
  selection: HorsePhase13AuthoritySelection | null,
  qualification: Buffer = p13QualificationBytes(variant),
  completion: Buffer | null = p13CompletionBytes(variant),
  runningDigest: string | null = P13_TEST_CONTRACT_DIGEST,
  runningPolicyDigest?: string | null
): HorseAuthorityAdmission {
  return admitHorsePhase13QualifiedAuthority(
    variant,
    selection,
    p13Reader(variant, qualification, completion),
    P13_TEST_NOW,
    runningDigest,
    runningPolicyDigest
  );
}
const withQualification = (overrides: Record<string, unknown>, variant = V) => {
  const q = p13QualificationBytes(variant, overrides);
  return admit(variant, p13Selection(variant, q), q);
};
const withQualificationObject = (value: unknown, variant = V) => {
  const q = json(value);
  return admit(variant, p13Selection(variant, q), q);
};
const withCompletion = (overrides: Record<string, unknown>, variant = V) => {
  const c = p13CompletionBytes(variant, overrides);
  return admit(variant, p13Selection(variant, undefined, c), undefined, c);
};
const withCompletionBytes = (c: Buffer, variant = V) =>
  admit(variant, p13Selection(variant, undefined, c), undefined, c);

/** Independent recomputation of the authority key from the stated identity. */
function expectedKey(identity: Record<string, unknown>): string {
  const sorted = Object.fromEntries(
    Object.keys(identity)
      .sort()
      .map((k) => [k, identity[k]])
  );
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

describe('P13.3 null proof: no Phase 13 authority is selected today', () => {
  it('the committed release selections are all null for all nine variants and the running digest is the P13.2 contract digest', () => {
    expect([...HORSE_PHASE13_VARIANTS].sort()).toEqual([...KNOWN_VARIANTS].sort());
    // The load-time literals are the joint owner's own values.
    expect([...HORSE_PHASE13_VARIANTS]).toEqual([...JOINT_VARIANTS]);
    expect(HORSE_PHASE13_PACK_VERSION).toBe(JOINT_LIVE_DOMAIN.version);
    expect(horsePhase13ContinuationVersion('nlh')).toBe(`${JOINT_LIVE_DOMAIN.version}/nlh`);
    expect(Object.keys(PHASE13_PROTECTED_RELEASE_SELECTIONS).sort()).toEqual(
      [...KNOWN_VARIANTS].sort()
    );
    expect(Object.values(PHASE13_PROTECTED_RELEASE_SELECTIONS).every((s) => s === null)).toBe(true);
    expect(Object.isFrozen(PHASE13_PROTECTED_RELEASE_SELECTIONS)).toBe(true);
    expect(PHASE13_RUNNING_CONTRACT_DIGEST).toBe(jointStrengthContractDigest());
    expect(PHASE13_RUNNING_CONTRACT_DIGEST).toMatch(/^[0-9a-f]{64}$/);
    for (const variant of HORSE_PHASE13_VARIANTS) {
      const release = admitHorsePhase13ReleaseAuthority(variant);
      expect(release, variant).toEqual({
        status: 'refused',
        reason: 'unselected',
        transient: false,
      });
      expect(selectedHorsePhase13Authority(variant, release)).toBeNull();
    }
  });

  it('with every selection null, admission returns unselected before any evidence file is read', () => {
    const reads: string[] = [];
    const tripwire: HorseAuthorityEvidenceReader = {
      read(path) {
        reads.push(path);
        throw Object.assign(new Error('read'), { code: 'EACCES' });
      },
    };
    for (const variant of HORSE_PHASE13_VARIANTS) {
      expect(
        admitHorsePhase13ReleaseAuthority(variant, P13_TEST_NOW, undefined, tripwire),
        variant
      ).toEqual({ status: 'refused', reason: 'unselected', transient: false });
      expect(
        admitHorsePhase13QualifiedAuthority(variant, null, tripwire, P13_TEST_NOW, null, null)
      ).toEqual({ status: 'refused', reason: 'unselected', transient: false });
    }
    expect(reads).toEqual([]);
  });

  it('the running code refuses a well-formed qualified selection made under another contract', () => {
    const other = 'e'.repeat(64);
    const q = p13QualificationBytes(V, { contractDigest: other });
    expect(
      admitHorsePhase13ReleaseAuthority(
        V,
        P13_TEST_NOW,
        p13Selection(V, q, undefined, { contractDigest: other }),
        p13Reader(V, q)
      )
    ).toEqual({ status: 'refused', reason: 'contract_digest_mismatch', transient: false });
    expect(
      admitHorsePhase13ReleaseAuthority(V, P13_TEST_NOW, p13Selection(V), p13Reader(V), null)
    ).toMatchObject({ status: 'refused', reason: 'contract_unavailable' });
  });

  it('every live main-scheduler gate is unselected and accepts no receipt', () => {
    for (const variant of HORSE_PHASE13_VARIANTS) {
      const gate = liveHorsePhase13Authorities[variant];
      gate.refresh();
      expect(gate.mainState(), variant).toBe('unselected');
      const worker = new HorseQualifiedAuthorityHolder(
        `p133-null-${variant}`,
        horsePhase13ContinuationVersion(variant)
      );
      worker.apply(qualifiedPhase13TestAdmission(variant));
      expect(worker.currentState()).toBe('usable');
      gate.observeWorker(worker.receipt());
      expect(gate.check(gate.stamp(worker.receipt())), variant).toBe('unselected');
      gate.forgetWorker(worker.epoch);
    }
  });

  // The Phase 12 corrected null proof: a completion record may exist only
  // while its own variant is unpromoted. Select one and this case fails until
  // somebody updates it deliberately.
  it('while the selections are null, nothing is promoted: no qualification says qualified:true, and a completion record exists only for an unpromoted variant', () => {
    const dir = fileURLToPath(new URL('../../../docs/evidence/phase13/', import.meta.url));
    const files = existsSync(dir)
      ? readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.json'))
      : [];
    for (const file of files) {
      const parsed = JSON.parse(readFileSync(`${dir}${file}`, 'utf8')) as Record<string, unknown>;
      if (parsed.schema === HORSE_PHASE13_QUALIFICATION_SCHEMA)
        expect(parsed.qualified, file).not.toBe(true);
      if (parsed.schema === HORSE_PHASE13_COMPLETION_SCHEMA) {
        const variant = parsed.variant as JointVariant;
        expect(HORSE_PHASE13_VARIANTS as readonly string[], file).toContain(variant);
        expect(PHASE13_PROTECTED_RELEASE_SELECTIONS[variant] ?? null, file).toBeNull();
      }
    }
  });
});

describe('P13.3 the contract sections admission reads (merge guard for the P13.2 contract)', () => {
  it('resolve for every one of the nine variants on the running contract', () => {
    expect(JOINT_STRENGTH_CONTRACT.schema).toBe('horse-phase13-strength-contract');
    expect(JOINT_STRENGTH_CONTRACT.version).toBe('joint-strength-contract-v1');
    expect(JOINT_STRENGTH_CONTRACT.phase).toBe('P13.2');
    expect(HORSE_PHASE13_CONTRACT_VERSION).toBe('joint-strength-contract-v1');
    expect([...JOINT_STRENGTH_VARIANTS].sort()).toEqual([...JOINT_VARIANTS].sort());
    for (const variant of JOINT_VARIANTS) {
      expect(horsePhase13ContractMargin(variant), variant).toEqual(expect.any(Number));
      expect(horsePhase13ContractMargin(variant)!, variant).toBeLessThanOrEqual(0);
      expect(jointStrengthDomain(variant)).toBe(
        `${variant}-cash-joint-multiway-after-rake-horse-population`
      );
    }
    expect(horsePhase13ContractAdmissionRequires()?.length).toBeGreaterThan(0);
  });
});

describe('P13.3 admission refuses by name unless the variant qualifies and completes on the running policy', () => {
  const eacces = Object.assign(new Error('denied'), { code: 'EACCES' });
  const objectives = p13QualificationObject(V).objectives;
  const withoutKey = (key: string) => {
    const value: Record<string, unknown> = p13QualificationObject(V);
    delete value[key];
    return value;
  };
  it.each([
    ['no selection', () => admit(V, null), 'unselected'],
    [
      'a path outside docs/evidence/phase13/',
      () => admit(V, p13Selection(V, undefined, undefined, { qualificationPath: 'docs/x.json' })),
      'invalid_selection',
    ],
    [
      'a Phase 12 evidence path',
      () =>
        admit(
          V,
          p13Selection(V, undefined, undefined, {
            qualificationPath: 'docs/evidence/phase12/q.json',
          })
        ),
      'invalid_selection',
    ],
    [
      'path traversal in the completion path',
      () =>
        admit(
          V,
          p13Selection(V, undefined, undefined, {
            completionPath: 'docs/evidence/phase13/../phase12/x.json',
          })
        ),
      'invalid_selection',
    ],
    [
      'a completion path without its sha256',
      () => admit(V, p13Selection(V, undefined, undefined, { completionSha256: null })),
      'invalid_selection',
    ],
    [
      'a completion path equal to the qualification path',
      () =>
        admit(
          V,
          p13Selection(V, undefined, undefined, { completionPath: p13QualificationPath(V) })
        ),
      'invalid_selection',
    ],
    [
      'a Phase 12 selection',
      () => admit(V, p13Selection(V, undefined, undefined, { phase: 'phase12' as 'phase13' })),
      'invalid_selection',
    ],
    [
      'a selection for a variant that is not a joint variant',
      () => admit(V, p13Selection(V, undefined, undefined, { variant: 'stud' as JointVariant })),
      'invalid_selection',
    ],
    [
      'an NLH selection admitted as PLO4',
      () => admit(V, p13Selection('nlh')),
      'continuation_mismatch',
    ],
    [
      'another receipt version',
      () =>
        admit(
          V,
          p13Selection(V, undefined, undefined, { packVersion: 'joint-multiway-round1-v3' })
        ),
      'continuation_mismatch',
    ],
    [
      'a tournament domain',
      () => admit(V, p13Selection(V, undefined, undefined, { domain: 'plo4-tournament-prize' })),
      'continuation_mismatch',
    ],
    [
      'no running contract digest',
      () => admit(V, p13Selection(V), undefined, undefined, null),
      'contract_unavailable',
    ],
    [
      'a selection for a different contract digest than the running one',
      () => admit(V, p13Selection(V), undefined, undefined, 'e'.repeat(64)),
      'contract_digest_mismatch',
    ],
    [
      'a file for a different contract digest',
      () => withQualification({ contractDigest: 'e'.repeat(64) }),
      'contract_digest_mismatch',
    ],
    [
      'running policy code whose digest cannot be computed',
      () => admit(V, p13Selection(V), undefined, undefined, undefined, null),
      'policy_digest_unavailable',
    ],
    [
      'an expired selection',
      () =>
        admit(
          V,
          p13Selection(V, undefined, undefined, {
            expiresAt: new Date(P13_TEST_NOW - 1).toISOString(),
          })
        ),
      'expired',
    ],
    [
      'no qualification file',
      () =>
        admitHorsePhase13QualifiedAuthority(
          V,
          p13Selection(V),
          memoryReader({}),
          P13_TEST_NOW,
          P13_TEST_CONTRACT_DIGEST
        ),
      'missing_evidence',
    ],
    [
      'qualification bytes that differ from the selected sha256',
      () => admit(V, p13Selection(V), p13QualificationBytes(V, { reasons: ['edited'] })),
      'hash_mismatch',
    ],
    [
      'a file that is not JSON',
      () => {
        const q = Buffer.from('not json');
        return admit(V, p13Selection(V, q), q);
      },
      'evidence_mismatch',
    ],
    [
      'a Phase 12 qualification schema',
      () => withQualification({ schema: 'horse-phase12-qualification-v1' }),
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
      'a file under the Phase 12 policy digest definition',
      () => withQualification({ policyDigestDefinition: 'horse-phase12-policy-digest-v1' }),
      'policy_digest_mismatch',
    ],
    [
      'running code that differs from the measured code',
      () => admit(V, p13Selection(V), undefined, undefined, undefined, 'e'.repeat(64)),
      'policy_digest_mismatch',
    ],
    [
      'an NLH qualification file under a PLO4 selection',
      () => {
        const q = p13QualificationBytes('nlh');
        return admit(V, p13Selection(V, q), q);
      },
      'policy_digest_mismatch',
    ],
    [
      'a file for a different source SHA',
      () => withQualification({ sourceSha: 'c'.repeat(40) }),
      'source_mismatch',
    ],
    [
      'a file whose variant is another',
      () => withQualification({ variant: 'plo5' }),
      'continuation_mismatch',
    ],
    [
      'a file whose receipt version is another',
      () => withQualification({ packVersion: 'joint-multiway-round1-v3' }),
      'continuation_mismatch',
    ],
    [
      'a file whose domain is not the cash domain',
      () => withQualification({ domain: 'plo4-tournament-prize' }),
      'continuation_mismatch',
    ],
    [
      'a file under another contract version',
      () => withQualification({ contractVersion: 'joint-strength-contract-v0' }),
      'evidence_mismatch',
    ],
    [
      'a cash margin other than the contract margin for the variant',
      () =>
        withQualification({
          objectives: { ...objectives, cash: { ...objectives.cash, regressionMarginBbPer100: -4 } },
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
      'a strength record outside docs/evidence/phase13/',
      () => withQualification({ evidencePath: 'docs/evidence/phase12/strength.json' }),
      'evidence_mismatch',
    ],
    [
      'a missing strength record',
      () =>
        admitHorsePhase13QualifiedAuthority(
          V,
          p13Selection(V),
          memoryReader({
            [p13QualificationPath(V)]: p13QualificationBytes(V),
            [p13CompletionPath(V)]: p13CompletionBytes(V),
          }),
          P13_TEST_NOW,
          P13_TEST_CONTRACT_DIGEST
        ),
      'missing_evidence',
    ],
    [
      'a strength record that is not the hashed one',
      () =>
        admitHorsePhase13QualifiedAuthority(
          V,
          p13Selection(V),
          memoryReader({
            [p13QualificationPath(V)]: p13QualificationBytes(V),
            [p13StrengthPath(V)]: Buffer.concat([p13TestStrength(V), Buffer.from(' ')]),
            [p13CompletionPath(V)]: p13CompletionBytes(V),
          }),
          P13_TEST_NOW,
          P13_TEST_CONTRACT_DIGEST
        ),
      'hash_mismatch',
    ],
    [
      'a selection that names no completion record',
      () => admit(V, p13Selection(V, undefined, null), undefined, null),
      'completion_evidence_missing',
    ],
    [
      'a named completion record that is not committed',
      () => admit(V, p13Selection(V), undefined, null),
      'completion_evidence_missing',
    ],
    [
      'completion bytes that differ from the selected sha256',
      () =>
        admit(V, p13Selection(V), undefined, p13CompletionBytes(V, { releaseSha: 'd'.repeat(40) })),
      'completion_hash_mismatch',
    ],
    [
      'a completion record that is not JSON',
      () => withCompletionBytes(Buffer.from('[]')),
      'completion_evidence_mismatch',
    ],
    [
      'another completion schema (Phase 12)',
      () => withCompletion({ schema: 'horse-phase12-completion-v1' }),
      'completion_evidence_mismatch',
    ],
    [
      'another completion definition',
      () => withCompletion({ definition: 'horse-phase12-completion-definition-v1' }),
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
      'a street without the response-branch count (the Phase 12 shape)',
      () =>
        withCompletion({
          streets: {
            ...p13CompletionObject(V).streets,
            river: {
              eligible: 200,
              completed: 200,
              workBudget: 0,
              samplerBudgetExhausted: 0,
              sampleUnavailable: 0,
              governorReduced: 0,
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
            ...p13CompletionObject(V).streets,
            river: { ...p13Street(), responseBranchUnavailable: 1 },
          },
        }),
      'completion_evidence_mismatch',
    ],
    [
      'a missing street',
      () =>
        withCompletion({
          streets: { preflop: p13Street(), flop: p13Street(), turn: p13Street() },
        }),
      'completion_evidence_mismatch',
    ],
    [
      'a negative count',
      () =>
        withCompletion({
          streets: {
            ...p13CompletionObject(V).streets,
            flop: { ...p13Street(), completed: 201, responseBranchUnavailable: -1 },
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
      'completion measured under the Phase 12 digest definition',
      () => withCompletion({ policyDigestDefinition: 'horse-phase12-policy-digest-v1' }),
      'completion_release_mismatch',
    ],
    [
      'completion of another variant',
      () => withCompletion({ variant: 'nlh', policyDigest: horsePhase13PolicyDigest('nlh') }),
      'completion_release_mismatch',
    ],
    [
      'completion of another receipt version',
      () => withCompletion({ packVersion: 'joint-multiway-round1-v3' }),
      'completion_release_mismatch',
    ],
    [
      'a reversed window',
      () =>
        withCompletion({
          window: { ...p13CompletionObject(V).window, from: '2026-10-19T00:00:00.000Z' },
        }),
      'completion_window_invalid',
    ],
    [
      'a window during which the release changed',
      () =>
        withCompletion({ window: { ...p13CompletionObject(V).window, releaseUnchanged: false } }),
      'completion_window_invalid',
    ],
    [
      'a window that ends after the selection was issued',
      () =>
        withCompletion({
          window: { ...p13CompletionObject(V).window, to: '2026-10-20T00:00:00.001Z' },
        }),
      'completion_window_invalid',
    ],
    [
      'a window that is not an exact ISO timestamp',
      () => withCompletion({ window: { ...p13CompletionObject(V).window, from: '2026-10-12' } }),
      'completion_window_invalid',
    ],
    [
      'a river that falls back to the baseline on 15 of 200 decisions',
      () =>
        withCompletion({
          streets: { ...p13CompletionObject(V).streets, river: p13Street(200, 15) },
        }),
      'completion_below_floor',
    ],
    [
      'a turn whose samples were cut short on 15 of 200 decisions',
      () =>
        withCompletion({
          streets: { ...p13CompletionObject(V).streets, turn: p13Street(200, 0, 15) },
        }),
      'completion_below_floor',
    ],
    [
      'a flop with no complete population on 15 of 200 decisions',
      () =>
        withCompletion({
          streets: { ...p13CompletionObject(V).streets, flop: p13Street(200, 0, 0, 15) },
        }),
      'completion_below_floor',
    ],
    [
      'a preflop whose samples the governor reduced on 15 of 200 decisions',
      () =>
        withCompletion({
          streets: { ...p13CompletionObject(V).streets, preflop: p13Street(200, 0, 0, 0, 15) },
        }),
      'completion_below_floor',
    ],
    [
      'a river whose response model refused on 15 of 200 decisions',
      () =>
        withCompletion({
          streets: { ...p13CompletionObject(V).streets, river: p13Street(200, 0, 0, 0, 0, 15) },
        }),
      'completion_below_floor',
    ],
    [
      'a street with no eligible decisions',
      () => withCompletion({ streets: { ...p13CompletionObject(V).streets, flop: p13Street(0) } }),
      'completion_below_floor',
    ],
    [
      'an all-complete street too small to bound the share (126 decisions)',
      () =>
        withCompletion({ streets: { ...p13CompletionObject(V).streets, preflop: p13Street(126) } }),
      'completion_below_floor',
    ],
    [
      'no three-board decision at all, every street clearing the floor',
      () =>
        withCompletion({
          boardCounts: { '1': p13Street(600), '2': p13Street(200), '3': p13Street(0) },
        }),
      'completion_below_floor',
    ],
    [
      'two-board hands whose response model refused on 32 of 400, every street clearing the floor',
      () =>
        withCompletion({
          streets: {
            preflop: p13Street(1000, 0, 0, 0, 0, 8),
            flop: p13Street(1000, 0, 0, 0, 0, 8),
            turn: p13Street(1000, 0, 0, 0, 0, 8),
            river: p13Street(1000, 0, 0, 0, 0, 8),
          },
          boardCounts: {
            '1': p13Street(3200),
            '2': p13Street(400, 0, 0, 0, 0, 32),
            '3': p13Street(400),
          },
        }),
      'completion_below_floor',
    ],
    [
      'board counts that do not total the streets',
      () =>
        withCompletion({
          boardCounts: { '1': p13Street(400), '2': p13Street(200), '3': p13Street(201) },
        }),
      'completion_evidence_mismatch',
    ],
    [
      'board counts that total the streets but not field by field',
      () =>
        withCompletion({
          boardCounts: { '1': p13Street(400, 1), '2': p13Street(200), '3': p13Street(200) },
        }),
      'completion_evidence_mismatch',
    ],
    [
      'a record without board counts (per street only)',
      () =>
        withCompletionBytes(
          Buffer.from(JSON.stringify({ ...p13CompletionObject(V), boardCounts: undefined }))
        ),
      'completion_evidence_mismatch',
    ],
    [
      'a fourth board count',
      () =>
        withCompletion({
          boardCounts: { ...p13CompletionObject(V).boardCounts, '4': p13Street(0) },
        }),
      'completion_evidence_mismatch',
    ],
  ] as const)('%s', (_name, run, reason) => {
    const admission = run();
    expect(admission).toEqual({ status: 'refused', reason, transient: false });
    expect(selectedHorsePhase13Authority(V, admission)).toBeNull();
  });

  it.each([
    ['the qualification file', p13QualificationPath(V)],
    ['the strength record', p13StrengthPath(V)],
    ['the completion record', p13CompletionPath(V)],
  ])('an I/O failure reading %s is a transient refusal, never a withdrawal', (_name, path) => {
    const files: Record<string, Buffer | Error> = {
      [p13QualificationPath(V)]: p13QualificationBytes(V),
      [p13StrengthPath(V)]: p13TestStrength(V),
      [p13CompletionPath(V)]: p13CompletionBytes(V),
      [path]: eacces,
    };
    expect(
      admitHorsePhase13QualifiedAuthority(
        V,
        p13Selection(V),
        memoryReader(files),
        P13_TEST_NOW,
        P13_TEST_CONTRACT_DIGEST
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
      admitHorsePhase13ReleaseAuthority(V, P13_TEST_NOW, p13Selection(V), exploding)
    ).toMatchObject({ status: 'refused', reason: 'unreadable_evidence', transient: true });
  });

  it('a committed withdrawal is a withdrawal, not a selection', () => {
    const admission = admit(
      V,
      p13Selection(V, undefined, undefined, {
        withdrawn: { at: '2026-10-20T00:30:00.000Z', reason: 'owner' },
      })
    );
    expect(admission).toEqual({
      status: 'withdrawn',
      approvalGeneration: 1,
      reason: 'release_owner',
    });
    expect(selectedHorsePhase13Authority(V, admission)).toBeNull();
  });

  it('the fixture writes exactly the sixteen agreed keys (the Phase 12 qualification keys), and the P13.2 assembler too once it exists', () => {
    expect([...HORSE_PHASE13_QUALIFICATION_KEYS]).toEqual([...HORSE_PHASE12_QUALIFICATION_KEYS]);
    expect(HORSE_PHASE13_QUALIFICATION_KEYS).toHaveLength(16);
    expect(Object.keys(p13QualificationObject(V)).sort()).toEqual(
      [...HORSE_PHASE13_QUALIFICATION_KEYS].sort()
    );
    const assemblerPath = fileURLToPath(
      new URL('../../scripts/phase13-strength-assemble.mjs', import.meta.url)
    );
    if (!existsSync(assemblerPath)) return;
    const assembler = readFileSync(assemblerPath, 'utf8');
    for (const key of HORSE_PHASE13_QUALIFICATION_KEYS)
      expect(assembler, key).toMatch(new RegExp(`\\b${key}\\b`));
  });

  it.each(HORSE_PHASE13_VARIANTS)(
    'a valid %s qualification and completion record (test fixture only) select an immutable record bound to both',
    (variant) => {
      const q = p13QualificationBytes(variant);
      const c = p13CompletionBytes(variant);
      const authority = selectedHorsePhase13Authority(
        variant,
        admit(variant, p13Selection(variant, q, c), q, c)
      );
      expect(authority).not.toBeNull();
      expect(Object.isFrozen(authority)).toBe(true);
      const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
      const identity = {
        schema: 'horse-qualified-authority-v1',
        phase: 'phase13',
        variant,
        sourceSha: P13_TEST_SOURCE_SHA,
        continuationVersion: `${JOINT_LIVE_DOMAIN.version}/${variant}`,
        policyDigest: horsePhase13PolicyDigest(variant),
        packId: HORSE_PHASE13_PACK_VERSION,
        domain: jointStrengthDomain(variant),
        evidencePath: p13QualificationPath(variant),
        evidenceSha256: sha(q),
        completionPath: p13CompletionPath(variant),
        completionSha256: sha(c),
        approvalGeneration: 1,
        issuedAt: P13_TEST_ISSUED_AT,
        expiresAt: null,
        contractDigest: P13_TEST_CONTRACT_DIGEST,
      };
      expect(authority).toEqual({
        ...identity,
        authorityKey: expectedKey({
          ...identity,
          completionDefinition: HORSE_PHASE13_COMPLETION_DEFINITION,
          completionFloor: HORSE_PHASE13_COMPLETION_FLOOR,
        }),
      });
      const c2 = p13CompletionBytes(variant, { releaseSha: 'd'.repeat(40) });
      const other = selectedHorsePhase13Authority(
        variant,
        admit(variant, p13Selection(variant, q, c2), q, c2)
      );
      expect(other?.authorityKey).toMatch(/^[0-9a-f]{64}$/);
      expect(other?.authorityKey).not.toBe(authority!.authorityKey);
    }
  );

  it('an all-complete street of exactly the minimum size passes; one decision fewer does not', () => {
    expect(HORSE_PHASE13_COMPLETION_MIN_ELIGIBLE_PER_STREET).toBe(127);
    const n = HORSE_PHASE13_COMPLETION_MIN_ELIGIBLE_PER_STREET;
    const at = (river: ReturnType<typeof p13Street>) =>
      withCompletion({ streets: { ...p13CompletionObject(V).streets, river } });
    expect(at(p13Street(n)).status).toBe('admitted');
    expect(at(p13Street(n - 1))).toMatchObject({ reason: 'completion_below_floor' });
    expect(at(p13Street(2000, 100))).toMatchObject({ reason: 'completion_below_floor' });
    expect(at(p13Street(2000, 0, 0, 0, 0, 100))).toMatchObject({
      reason: 'completion_below_floor',
    });
    expect(at(p13Street(2000, 50)).status).toBe('admitted');
    expect(at(p13Street(2000, 10, 10, 10, 10, 10)).status).toBe('admitted');
  });
});

describe('P13.3 one variant never admits another', () => {
  it('a qualified NLH selection and its evidence admit NLH only', () => {
    const nlh = qualifiedPhase13TestAdmission('nlh');
    expect(selectedHorsePhase13Authority('nlh', nlh)).not.toBeNull();
    for (const other of JOINT_VARIANTS.filter((v) => v !== 'nlh')) {
      expect(selectedHorsePhase13Authority(other, nlh)).toBeNull();
      expect(
        admitHorsePhase13QualifiedAuthority(
          other,
          p13Selection('nlh'),
          p13Reader('nlh'),
          P13_TEST_NOW,
          P13_TEST_CONTRACT_DIGEST
        )
      ).toMatchObject({ status: 'refused', reason: 'continuation_mismatch' });
      expect(admitHorsePhase13ReleaseAuthority(other, P13_TEST_NOW)).toMatchObject({
        reason: 'unselected',
      });
    }
    // A Phase 12 authority is never a Phase 13 one, for its own variant either.
    expect(selectedHorsePhase13Authority('flo8', qualifiedPhase12TestAdmission('flo8'))).toBeNull();
  });

  it('each variant holder is usable only for its own variant; Phase 12 and the variants never stand in for each other', () => {
    for (const variant of JOINT_VARIANTS) {
      const own = new HorseQualifiedAuthorityHolder(
        'p133-own',
        horsePhase13ContinuationVersion(variant)
      );
      own.apply(qualifiedPhase13TestAdmission(variant));
      expect(own.verdict(own.receipt(), P13_TEST_NOW), variant).toBe('usable');
      for (const other of JOINT_VARIANTS.filter((v) => v !== variant)) {
        const crossed = new HorseQualifiedAuthorityHolder(
          'p133-crossed',
          horsePhase13ContinuationVersion(other)
        );
        crossed.apply(qualifiedPhase13TestAdmission(variant));
        expect(crossed.verdict(crossed.receipt(), P13_TEST_NOW), `${variant}->${other}`).toBe(
          'mismatched'
        );
      }
      const fromPhase12 = new HorseQualifiedAuthorityHolder(
        'p133-p12',
        horsePhase13ContinuationVersion(variant)
      );
      fromPhase12.apply(qualifiedPhase12TestAdmission('flh'));
      expect(fromPhase12.verdict(fromPhase12.receipt(), P13_TEST_NOW)).toBe('mismatched');
    }
    // And a Phase 13 admission in a Phase 12 holder.
    const phase12 = new HorseQualifiedAuthorityHolder(
      'p133-in-p12',
      REMAINING_VARIANT_PACKS.flh.version
    );
    phase12.apply(qualifiedPhase13TestAdmission('flh'));
    expect(phase12.verdict(phase12.receipt(), P13_TEST_NOW)).toBe('mismatched');
  });

  it('a withdrawal, refresh failure or restart of one variant gate never touches another', () => {
    const gates = Object.fromEntries(
      JOINT_VARIANTS.map((variant) => {
        let admission = qualifiedPhase13TestAdmission(variant, 5);
        const gate = new HorsePhase8AuthorityGate(
          () => admission,
          `p133-main-${variant}`,
          horsePhase13ContinuationVersion(variant)
        );
        gate.refresh();
        const worker = new HorseQualifiedAuthorityHolder(
          'p133-worker',
          horsePhase13ContinuationVersion(variant)
        );
        worker.apply(qualifiedPhase13TestAdmission(variant, 5));
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
      JointVariant,
      { gate: HorsePhase8AuthorityGate; worker: HorseQualifiedAuthorityHolder; fail: () => void }
    >;
    const check = (v: JointVariant) =>
      gates[v].gate.check(gates[v].gate.stamp(gates[v].worker.receipt()), P13_TEST_NOW);
    for (const v of JOINT_VARIANTS) expect(check(v)).toBe('usable');
    gates.nlh.gate.withdraw('controller_fallback_candidate');
    gates.plo4.fail();
    gates.plo4.gate.refresh();
    gates.flh.gate.forgetWorker('p133-worker');
    expect([check('nlh'), check('plo4'), check('flh')]).toEqual([
      'withdrawn',
      'refresh_failed',
      'restarted',
    ]);
    for (const v of JOINT_VARIANTS.filter((x) => !['nlh', 'plo4', 'flh'].includes(x)))
      expect(check(v), v).toBe('usable');
    // A usable NLH worker receipt is mismatched at the PLO5 gate.
    expect(
      gates.plo5.gate.check(gates.plo5.gate.stamp(gates.nlh.worker.receipt()), P13_TEST_NOW)
    ).toBe('mismatched');
    gates.nlh.gate.refresh();
    expect(gates.nlh.gate.mainState()).toBe('withdrawn');
  });

  it.each([
    ['cash', 'nlh', 'nlh', 'usable', undefined, 'candidate'],
    ['cash', 'plo8', 'plo8', 'usable', 'shadow', 'candidate'],
    ['cash', 'flo8', 'flo8', 'usable', undefined, 'candidate'],
    ['cash', 'nlh', 'nlh', 'unselected', undefined, 'shadow'],
    ['cash', 'nlh', 'nlh', 'refused', undefined, 'shadow'],
    ['cash', 'nlh', 'nlh', 'withdrawn', undefined, 'shadow'],
    ['cash', 'nlh', 'nlh', 'stale_generation', undefined, 'shadow'],
    ['cash', 'nlh', 'nlh', 'missing_receipt', undefined, 'shadow'],
    ['cash', 'plo4', 'nlh', 'usable', undefined, 'shadow'],
    ['cash', 'stud', null, 'usable', undefined, 'shadow'],
    ['cash', 'nlh', 'nlh', 'usable', 'off', 'off'],
    ['cash', 'nlh', 'nlh', 'unselected', 'off', 'off'],
    ['tournament', 'nlh', 'nlh', 'usable', undefined, 'shadow'],
    ['tournament', 'plo4', 'plo4', 'usable', 'shadow', 'shadow'],
    [undefined, 'flh', 'flh', 'usable', undefined, 'shadow'],
  ] as const)(
    'a %s %s decision with a %s holder verdict %s and caller %s runs the joint owner in %s mode',
    (gameMode, variant, packVariant, verdict, callerMode, expected) => {
      expect(
        horsePhase13AdmittedMode({
          gameMode,
          variant,
          packVariant: packVariant as JointVariant | null,
          verdict,
          callerMode,
        })
      ).toBe(expected);
    }
  );
});

describe('P13.3 natural completion share: what a record counts', () => {
  afterEach(() => vi.restoreAllMocks());
  const receipt = (overrides: Record<string, unknown> = {}) => ({
    variant: 'plo4',
    version: JOINT_LIVE_DOMAIN.version,
    eligible: true,
    utilityOwner: 'cash',
    street: 'river',
    boardCount: 1,
    reason: 'joint_cash_action_distribution',
    dealtPlayers: 4,
    requestedSamples: 16,
    completedSamples: 16,
    sampleBudgetExhausted: false,
    inputs: { ranges: { status: 'consumed' } },
    ...overrides,
  });

  it.each([
    ['a complete full-sample eligible cash decision', receipt(), 'completed'],
    [
      'a protected fold kept by the continuation guard (the measured policy)',
      receipt({ reason: 'protected_fold_guard' }),
      'completed',
    ],
    [
      'a large table at its own full count (8)',
      receipt({ dealtPlayers: 6, requestedSamples: 8, completedSamples: 8 }),
      'completed',
    ],
    ['a work-budget fallback', receipt({ reason: 'work_budget' }), 'work_budget'],
    [
      'a work-budget fallback whose sampler was also cut short',
      receipt({ reason: 'work_budget', sampleBudgetExhausted: true }),
      'work_budget',
    ],
    [
      'a population cut short at the sampler deadline',
      receipt({ completedSamples: 11, sampleBudgetExhausted: true }),
      'sampler_budget_exhausted',
    ],
    [
      'a cut-short population too small to use',
      receipt({
        reason: 'insufficient_joint_samples',
        completedSamples: 5,
        sampleBudgetExhausted: true,
        inputs: { ranges: { status: 'unavailable' } },
      }),
      'sampler_budget_exhausted',
    ],
    [
      'a response tree over its branch limit',
      receipt({ reason: 'joint_response_branch_unavailable' }),
      'response_branch_unavailable',
    ],
    [
      'a response street the model does not cover',
      receipt({ reason: 'joint_response_street_not_modeled' }),
      'response_branch_unavailable',
    ],
    [
      'no population at all (deadline before the first sample)',
      receipt({
        reason: 'joint_samples_unavailable',
        completedSamples: 0,
        inputs: { ranges: { status: 'unavailable' } },
      }),
      'sample_unavailable',
    ],
    [
      'insufficient samples without a deadline',
      receipt({ reason: 'insufficient_joint_samples', completedSamples: 6 }),
      'sample_unavailable',
    ],
    ['an eligible receipt with no binding', receipt({ inputs: null }), 'sample_unavailable'],
    [
      'a shortfall without the deadline flag',
      receipt({ completedSamples: 15 }),
      'sample_unavailable',
    ],
    [
      'a governor-reduced complete population',
      receipt({ requestedSamples: 8, completedSamples: 8 }),
      'governor_reduced',
    ],
    [
      'a governor-reduced population that was also cut short',
      receipt({ requestedSamples: 8, completedSamples: 6, sampleBudgetExhausted: true }),
      'sampler_budget_exhausted',
    ],
    ['a two-board bomb decision', receipt({ boardCount: 2 }), 'completed'],
    ['a three-board bomb decision', receipt({ boardCount: 3 }), 'completed'],
    ['a receipt without a board count', receipt({ boardCount: undefined }), 'not_counted'],
    ['a board count the controller never deals', receipt({ boardCount: 4 }), 'not_counted'],
    ['a board count that is a string', receipt({ boardCount: '2' }), 'not_counted'],
    ['an ineligible decision', receipt({ eligible: false }), 'not_counted'],
    ['a tournament decision', receipt({ utilityOwner: 'phase7_evaluated' }), 'not_counted'],
    ['a pending tournament decision', receipt({ utilityOwner: 'phase7_pending' }), 'not_counted'],
    ['a Pineapple discard street', receipt({ street: 'pineapple_discard' }), 'not_counted'],
    ['another variant', receipt({ variant: 'nlh' }), 'not_counted'],
    ['another receipt version', receipt({ version: 'joint-multiway-round1-v3' }), 'not_counted'],
    [
      'a Phase 12 receipt',
      receipt({ variant: 'flo8', version: REMAINING_VARIANT_PACKS.flo8.version }),
      'not_counted',
    ],
    ['a receipt that is not an object', null, 'not_counted'],
  ] as const)('%s counts as %s', (_name, value, expected) => {
    expect(horsePhase13CompletionOutcome('plo4', value)).toBe(expected);
  });

  it('the full sample count is the governor-off request of the live acquisition', () => {
    for (const dealt of [3, 4]) {
      expect(jointFullSamples(dealt)).toBe(JOINT_LIVE_DOMAIN.defaultSamples);
      expect(jointRequestedSamples(dealt, 1)).toBe(jointFullSamples(dealt));
      expect(jointRequestedSamples(dealt, 0.999)).toBeLessThan(jointFullSamples(dealt));
      expect(jointRequestedSamples(dealt, 0.5)).toBe(8);
    }
    for (const dealt of [5, 9]) {
      expect(jointFullSamples(dealt)).toBe(JOINT_LIVE_DOMAIN.largeTableSamples);
      expect(jointRequestedSamples(dealt, 1)).toBe(jointFullSamples(dealt));
      // The minimum equals the large-table count: the governor cannot reduce it.
      expect(jointRequestedSamples(dealt, 0)).toBe(JOINT_LIVE_DOMAIN.minSamples);
    }
  });

  /** A real joint receipt from the live policy at one spot under one clock, as journaled. */
  const live = (
    variant: JointVariant,
    street: 'preflop' | 'flop' | 'turn' | 'river',
    clock: () => number,
    boards = 1,
    mode: 'cash' | 'tournament' = 'cash'
  ) => {
    const { hero, state, baseline } = jointPolicyFixture(variant, boards, mode, street);
    const r = evaluateJointLivePolicy(hero, state, baseline, 'shadow', clock);
    return JSON.parse(JSON.stringify(r.receipt)) as Record<string, any>;
  };
  const stepClock = (calls: number, after: number) => {
    let n = 0;
    return () => (n++ < calls ? 0 : after);
  };

  it.each(JOINT_VARIANTS)(
    'counts real %s joint receipts by street, every live outcome included',
    (variant) => {
      const seen: unknown[] = [];
      for (const street of ['preflop', 'flop', 'turn', 'river'] as const) {
        const ok = live(variant, street, () => 0);
        expect(ok.eligible, street).toBe(true);
        expect(ok.dealtPlayers, street).toBeLessThanOrEqual(4);
        expect(horsePhase13CompletionOutcome(variant, ok), `${street} ${ok.reason}`).toBe(
          'completed'
        );
        let t = 0;
        const slow = live(variant, street, () => (t += 5));
        expect(slow).toMatchObject({ eligible: true, reason: 'work_budget' });
        expect(horsePhase13CompletionOutcome(variant, slow)).toBe('work_budget');
        // The sampler's deadline is spent before its first sample: no
        // population, and the policy stays inside its own budget.
        // (Reads: the wrapper's start, the acquisition's start, then the
        // sampler's deadline checks.)
        const none = live(variant, street, stepClock(2, 3));
        expect(none.reason, street).toBe('joint_samples_unavailable');
        expect(horsePhase13CompletionOutcome(variant, none), street).toBe('sample_unavailable');
        // The deadline arrives after a few samples: cut short.
        let cut: Record<string, any> = none;
        for (let reads = 3; reads < 400 && !(cut.completedSamples > 0); reads++)
          cut = live(variant, street, stepClock(reads, 3));
        expect(cut.sampleBudgetExhausted, street).toBe(true);
        expect(cut.completedSamples, street).toBeGreaterThan(0);
        expect(horsePhase13CompletionOutcome(variant, cut), street).toBe(
          'sampler_budget_exhausted'
        );
        // Under load the governor halves the request; every requested sample
        // completes, and it is still not the measured policy.
        vi.spyOn(equityGovernor, 'current').mockReturnValue(0.5);
        const reduced = live(variant, street, () => 0);
        vi.restoreAllMocks();
        expect(reduced).toMatchObject({ requestedSamples: 8, completedSamples: 8 });
        expect(horsePhase13CompletionOutcome(variant, reduced), street).toBe('governor_reduced');
        // The response model's named refusal (forged reason on a real receipt;
        // the live sample cap keeps the branch limit out of natural reach).
        const response = { ...ok, reason: 'joint_response_branch_unavailable', fired: false };
        expect(horsePhase13CompletionOutcome(variant, response)).toBe(
          'response_branch_unavailable'
        );
        seen.push(ok, slow, none, cut, reduced, response);
      }
      // A multi-board hand is counted on its betting streets; it has no
      // eligible preflop decision.
      const bombPreflop = live(variant, 'preflop', () => 0, 2);
      expect(bombPreflop).toMatchObject({
        eligible: false,
        reason: 'bomb_hand_has_no_preflop_decision',
      });
      expect(horsePhase13CompletionOutcome(variant, bombPreflop)).toBe('not_counted');
      const bombTurn = live(variant, 'turn', () => 0, 2);
      expect(horsePhase13CompletionOutcome(variant, bombTurn)).toBe('completed');
      const threeRiver = live(variant, 'river', () => 0, 3);
      expect(threeRiver.boardCount).toBe(3);
      expect(horsePhase13CompletionOutcome(variant, threeRiver)).toBe('completed');
      let late = 0;
      const threeSlow = live(variant, 'flop', () => (late += 5), 3);
      expect(horsePhase13CompletionOutcome(variant, threeSlow)).toBe('work_budget');
      seen.push(bombPreflop, bombTurn, threeRiver, threeSlow);
      // A tournament decision is never counted (Pineapple is refused before it
      // is eligible).
      const tournament = live(variant, 'river', () => 0, 1, 'tournament');
      expect(horsePhase13CompletionOutcome(variant, tournament)).toBe('not_counted');
      seen.push(tournament);
      const counts = horsePhase13CompletionCounts(variant, seen);
      const row = (completed: number) => ({
        eligible: completed + 5,
        completed,
        workBudget: 1,
        samplerBudgetExhausted: 1,
        sampleUnavailable: 1,
        governorReduced: 1,
        responseBranchUnavailable: 1,
      });
      expect(counts.preflop).toEqual(row(1));
      expect(counts.flop).toEqual({ ...row(1), eligible: 7, workBudget: 2 });
      expect(counts.turn).toEqual(row(2));
      expect(counts.river).toEqual(row(2));
      // The same decisions by board count: every ordinary decision on one board,
      // the two bomb decisions on theirs; both tallies total the same.
      const boards = horsePhase13CompletionBoardCounts(variant, seen);
      expect(boards['1']).toEqual({
        ...row(4),
        eligible: 24,
        workBudget: 4,
        samplerBudgetExhausted: 4,
        sampleUnavailable: 4,
        governorReduced: 4,
        responseBranchUnavailable: 4,
      });
      expect(boards['2']).toEqual({
        ...row(1),
        eligible: 1,
        workBudget: 0,
        samplerBudgetExhausted: 0,
        sampleUnavailable: 0,
        governorReduced: 0,
        responseBranchUnavailable: 0,
      });
      expect(boards['3']).toEqual({
        ...row(1),
        eligible: 2,
        workBudget: 1,
        samplerBudgetExhausted: 0,
        sampleUnavailable: 0,
        governorReduced: 0,
        responseBranchUnavailable: 0,
      });
      for (const key of HORSE_PHASE13_COMPLETION_STREET_KEYS)
        expect(
          Object.values(boards).reduce((n, cell) => n + cell[key], 0),
          key
        ).toBe(Object.values(counts).reduce((n, cell) => n + cell[key], 0));
      for (const street of ['preflop', 'flop', 'turn', 'river'] as const)
        expect(Object.keys(counts[street]).sort()).toEqual(
          [...HORSE_PHASE13_COMPLETION_STREET_KEYS].sort()
        );
      const other = JOINT_VARIANTS.find((v) => v !== variant)!;
      expect(horsePhase13CompletionCounts(other, seen).river.eligible).toBe(0);
    }
  );

  it('the floor is judged on the Wilson lower bound at the contract z', () => {
    const z = JOINT_STRENGTH_Z99;
    expect(z).toBeCloseTo(2.5758293035489004, 15);
    expect(HORSE_PHASE13_COMPLETION_FLOOR).toBe(0.95);
    expect(horsePhase13CompletionLowerBound(200, 200)).toBeCloseTo(200 / (200 + z * z), 12);
    const n = 1000;
    const p = 0.97;
    const wilson =
      (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) /
      (1 + (z * z) / n);
    expect(horsePhase13CompletionLowerBound(970, 1000)).toBeCloseTo(wilson, 12);
    expect(horsePhase13CompletionLowerBound(0, 0)).toBe(0);
    expect(horsePhase13CompletionLowerBound(126, 126)).toBeLessThan(0.95);
    expect(horsePhase13CompletionLowerBound(127, 127)).toBeGreaterThanOrEqual(0.95);
    const streets = p13CompletionObject(V).streets as Parameters<
      typeof horsePhase13CompletionMeetsFloor
    >[0];
    expect(horsePhase13CompletionMeetsFloor(streets)).toBe(true);
    expect(
      horsePhase13CompletionMeetsFloor({
        ...streets,
        river: p13Street(1000, 0, 0, 0, 0, 30),
      } as never)
    ).toBe(true);
    expect(
      horsePhase13CompletionMeetsFloor({
        ...streets,
        river: p13Street(1000, 0, 0, 0, 0, 40),
      } as never)
    ).toBe(false);
    // No cell is no evidence.
    expect(horsePhase13CompletionMeetsFloor({})).toBe(false);
    const record = p13CompletionObject(V) as unknown as Parameters<
      typeof horsePhase13CompletionRecordMeetsFloor
    >[0];
    expect(horsePhase13CompletionRecordMeetsFloor(record)).toBe(true);
    expect(
      horsePhase13CompletionRecordMeetsFloor({
        ...record,
        boardCounts: { ...record.boardCounts, '3': p13Street(126) },
      })
    ).toBe(false);
  });

  it('the evidence directory and schema names are the agreed ones', () => {
    expect(HORSE_PHASE13_EVIDENCE_DIRECTORY).toBe('docs/evidence/phase13/');
    expect(HORSE_PHASE13_QUALIFICATION_SCHEMA).toBe('horse-phase13-qualification-v1');
    expect(HORSE_PHASE13_COMPLETION_SCHEMA).toBe('horse-phase13-completion-v1');
    expect(HORSE_PHASE13_COMPLETION_DEFINITION).toBe('horse-phase13-completion-definition-v1');
    expect(HORSE_PHASE13_PACK_VERSION).toBe(JOINT_LIVE_DOMAIN.version);
    expect(json(p13QualificationObject('nlh').admissionAlsoRequires).toString()).toBe(
      json(horsePhase13ContractAdmissionRequires()).toString()
    );
  });
});
