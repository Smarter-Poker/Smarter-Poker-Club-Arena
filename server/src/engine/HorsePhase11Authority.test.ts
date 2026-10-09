import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  admitHorsePhase11QualifiedAuthority,
  admitHorsePhase11ReleaseAuthority,
  HORSE_PHASE11_COMPLETION_DEFINITION,
  HORSE_PHASE11_COMPLETION_FLOOR,
  HORSE_PHASE11_COMPLETION_MIN_ELIGIBLE_PER_STREET,
  HORSE_PHASE11_COMPLETION_SCHEMA,
  HORSE_PHASE11_EVIDENCE_DIRECTORY,
  HORSE_PHASE11_QUALIFICATION_SCHEMA,
  HORSE_PHASE11_VARIANTS,
  horsePhase11AdmittedMode,
  horsePhase11CompletionCounts,
  horsePhase11CompletionLowerBound,
  horsePhase11CompletionMeetsFloor,
  horsePhase11CompletionOutcome,
  liveHorsePhase11Authorities,
  PHASE11_PROTECTED_RELEASE_SELECTIONS,
  PHASE11_RUNNING_CONTRACT_DIGEST,
  selectedHorsePhase11Authority,
  type HorsePhase11AuthoritySelection,
} from './HorsePhase11Authority.js';
import {
  HorsePhase8AuthorityGate,
  HorseQualifiedAuthorityHolder,
  type HorseAuthorityAdmission,
} from './HorseQualifiedAuthority.js';
import { memoryReader } from './HorseQualifiedAuthority.test-support.js';
import { qualifiedPhase10TestAdmission } from './HorsePhase10Authority.test-support.js';
import {
  P11_TEST_CONTRACT_DIGEST,
  P11_TEST_ISSUED_AT,
  P11_TEST_NOW,
  P11_TEST_SOURCE_SHA,
  p11CompletionBytes,
  p11CompletionObject,
  p11CompletionPath,
  p11QualificationBytes,
  p11QualificationObject,
  p11QualificationPath,
  p11Reader,
  p11Selection,
  p11Street,
  p11StrengthPath,
  p11TestStrength,
  qualifiedPhase11TestAdmission,
} from './HorsePhase11Authority.test-support.js';
import {
  OMAHA_VARIANT_STRENGTH_CONTRACT,
  omahaVariantStrengthContractDigest,
  omahaVariantStrengthDomain,
} from '../benchmark/OmahaVariantStrengthContract.js';
import { horsePhase11PolicyDigest } from './HorsePhase11PolicyDigest.js';
import { OMAHA_VARIANT_PACKS, type OmahaPolicyVariant } from './omaha/OmahaVariantPolicyPack.js';
import { PLO4_POLICY_PACK } from './plo4/Plo4PolicyPack.js';
import { evaluateOmahaVariantPolicy } from './omaha/OmahaVariantLivePolicy.js';
import { equityGovernor } from './EquityLoadGovernor.js';
import { omahaVariantSpot } from '../benchmark/OmahaVariantPolicyEvidence.js';

const V: OmahaPolicyVariant = 'plo6';
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');

/** Admit `variant` from a selection over in-memory files. */
function admit(
  variant: OmahaPolicyVariant,
  selection: HorsePhase11AuthoritySelection | null,
  qualification: Buffer = p11QualificationBytes(variant),
  completion: Buffer | null = p11CompletionBytes(variant),
  runningDigest: string | null = P11_TEST_CONTRACT_DIGEST,
  runningPolicyDigest?: string | null
): HorseAuthorityAdmission {
  return admitHorsePhase11QualifiedAuthority(
    variant,
    selection,
    p11Reader(variant, qualification, completion),
    P11_TEST_NOW,
    runningDigest,
    runningPolicyDigest
  );
}
/** One pack's evidence with one file replaced, the selection binding the replacement. */
const withQualification = (overrides: Record<string, unknown>, variant = V) => {
  const q = p11QualificationBytes(variant, overrides);
  return admit(variant, p11Selection(variant, q), q);
};
const withCompletion = (overrides: Record<string, unknown>, variant = V) => {
  const c = p11CompletionBytes(variant, overrides);
  return admit(variant, p11Selection(variant, undefined, c), undefined, c);
};
const withCompletionBytes = (c: Buffer, variant = V) =>
  admit(variant, p11Selection(variant, undefined, c), undefined, c);

/** Independent recomputation of the authority key from the stated identity. */
function expectedKey(identity: Record<string, unknown>): string {
  const sorted = Object.fromEntries(
    Object.keys(identity)
      .sort()
      .map((k) => [k, identity[k]])
  );
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

describe('P11.3 committed selections: every pack qualified on condition (a) whose completion record meets the floor', () => {
  const selected = HORSE_PHASE11_VARIANTS.filter(
    (v) => PHASE11_PROTECTED_RELEASE_SELECTIONS[v] !== null
  );

  it('the committed selections name their c8bfc617-or-later matrices and the running digest is the P11.2 contract digest', () => {
    expect(Object.isFrozen(PHASE11_PROTECTED_RELEASE_SELECTIONS)).toBe(true);
    expect(selected.length).toBeGreaterThan(0);
    expect(PHASE11_RUNNING_CONTRACT_DIGEST).toBe(omahaVariantStrengthContractDigest());
    expect(PHASE11_RUNNING_CONTRACT_DIGEST).toMatch(/^[0-9a-f]{64}$/);
    for (const variant of HORSE_PHASE11_VARIANTS) {
      const selection = PHASE11_PROTECTED_RELEASE_SELECTIONS[variant];
      const release = admitHorsePhase11ReleaseAuthority(variant);
      if (selection === null) {
        expect(release, variant).toEqual({
          status: 'refused',
          reason: 'unselected',
          transient: false,
        });
        expect(selectedHorsePhase11Authority(variant, release)).toBeNull();
        continue;
      }
      expect(selection, variant).toMatchObject({
        schema: 'horse-qualified-authority-selection-v1',
        phase: 'phase11',
        variant,
        packVersion: OMAHA_VARIANT_PACKS[variant].version,
        contractDigest: PHASE11_RUNNING_CONTRACT_DIGEST,
        approvalGeneration: 1,
        expiresAt: null,
        withdrawn: null,
      });
      expect(release.status, variant).toBe('admitted');
      expect(selectedHorsePhase11Authority(variant, release), variant).toMatchObject({
        phase: 'phase11',
        sourceSha: selection.sourceSha,
        continuationVersion: OMAHA_VARIANT_PACKS[variant].version,
        policyDigest: horsePhase11PolicyDigest(variant),
        evidenceSha256: selection.qualificationSha256,
        approvalGeneration: 1,
      });
    }
  });

  it('the running code refuses a well-formed qualified selection made under another contract', () => {
    const other = 'e'.repeat(64);
    const q = p11QualificationBytes(V, { contractDigest: other });
    const release = admitHorsePhase11ReleaseAuthority(
      V,
      P11_TEST_NOW,
      p11Selection(V, q, undefined, { contractDigest: other }),
      p11Reader(V, q)
    );
    expect(release).toEqual({
      status: 'refused',
      reason: 'contract_digest_mismatch',
      transient: false,
    });
    expect(
      admitHorsePhase11ReleaseAuthority(V, P11_TEST_NOW, p11Selection(V), p11Reader(V), null)
    ).toMatchObject({ status: 'refused', reason: 'contract_unavailable' });
  });

  it('each live main-scheduler gate is usable exactly when its pack is selected', () => {
    for (const variant of HORSE_PHASE11_VARIANTS) {
      const gate = liveHorsePhase11Authorities[variant];
      gate.refresh();
      expect(gate.mainState(), variant).toBe(
        PHASE11_PROTECTED_RELEASE_SELECTIONS[variant] === null ? 'unselected' : 'usable'
      );
    }
  });

  it('withdrawal is a committed record: a selection with withdrawn set is a withdrawal, never a selection', () => {
    for (const variant of selected) {
      const withdrawn = {
        ...PHASE11_PROTECTED_RELEASE_SELECTIONS[variant]!,
        withdrawn: { at: '2026-10-10T00:00:00.000Z', reason: 'condition_b_lost_after_rake' },
      };
      const release = admitHorsePhase11ReleaseAuthority(variant, Date.now(), withdrawn);
      expect(release, variant).toEqual({
        status: 'withdrawn',
        approvalGeneration: 1,
        reason: 'release_condition_b_lost_after_rake',
      });
      expect(selectedHorsePhase11Authority(variant, release)).toBeNull();
    }
  });

  // A MEASURED PACK IS NOT A PROMOTED PACK (2026-10-05), kept since the
  // selections (2026-10-09): a committed qualification that says
  // qualified:true is exactly the one its pack's selection names, and a
  // completion record exists for a selected pack or an unpromoted one.
  it('the only qualified:true qualification of each pack is the one its selection names', () => {
    const dir = fileURLToPath(new URL('../../../docs/evidence/phase11/', import.meta.url));
    const files = existsSync(dir)
      ? readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.json'))
      : [];
    for (const file of files) {
      const parsed = JSON.parse(readFileSync(`${dir}${file}`, 'utf8')) as Record<string, unknown>;
      if (parsed.schema === HORSE_PHASE11_QUALIFICATION_SCHEMA && parsed.qualified === true) {
        const variant = parsed.variant as OmahaPolicyVariant;
        expect(PHASE11_PROTECTED_RELEASE_SELECTIONS[variant]?.qualificationPath, file).toBe(
          `docs/evidence/phase11/${file}`
        );
      }
      if (parsed.schema === HORSE_PHASE11_COMPLETION_SCHEMA)
        expect(HORSE_PHASE11_VARIANTS as readonly string[], file).toContain(parsed.variant);
    }
  });
});

describe('P11.3 admission refuses by name unless the pack qualifies and completes on the running policy', () => {
  const eacces = Object.assign(new Error('denied'), { code: 'EACCES' });
  it.each([
    ['no selection', () => admit(V, null), 'unselected'],
    [
      'a path outside docs/evidence/phase11/',
      () => admit(V, p11Selection(V, undefined, undefined, { qualificationPath: 'docs/x.json' })),
      'invalid_selection',
    ],
    [
      'path traversal in the completion path',
      () =>
        admit(
          V,
          p11Selection(V, undefined, undefined, {
            completionPath: 'docs/evidence/phase11/../phase10/x.json',
          })
        ),
      'invalid_selection',
    ],
    [
      'a completion path without its sha256',
      () => admit(V, p11Selection(V, undefined, undefined, { completionSha256: null })),
      'invalid_selection',
    ],
    [
      'a selection for a variant that is not a Phase 11 pack',
      () =>
        admit(V, p11Selection(V, undefined, undefined, { variant: 'plo4' as OmahaPolicyVariant })),
      'invalid_selection',
    ],
    [
      'a PLO5 selection admitted as the PLO6 pack',
      () => admit(V, p11Selection('plo5')),
      'continuation_mismatch',
    ],
    [
      'another pack version',
      () => admit(V, p11Selection(V, undefined, undefined, { packVersion: 'plo6-high-round1-v1' })),
      'continuation_mismatch',
    ],
    [
      'a tournament domain',
      () => admit(V, p11Selection(V, undefined, undefined, { domain: 'plo6-tournament-prize' })),
      'continuation_mismatch',
    ],
    [
      'no running contract digest',
      () => admit(V, p11Selection(V), undefined, undefined, null),
      'contract_unavailable',
    ],
    [
      'a selection for a different contract digest than the running one',
      () => admit(V, p11Selection(V), undefined, undefined, 'e'.repeat(64)),
      'contract_digest_mismatch',
    ],
    [
      'a file for a different contract digest',
      () => withQualification({ contractDigest: 'e'.repeat(64) }),
      'contract_digest_mismatch',
    ],
    [
      'running policy code whose digest cannot be computed',
      () => admit(V, p11Selection(V), undefined, undefined, undefined, null),
      'policy_digest_unavailable',
    ],
    [
      'an expired selection',
      () =>
        admit(
          V,
          p11Selection(V, undefined, undefined, {
            expiresAt: new Date(P11_TEST_NOW - 1).toISOString(),
          })
        ),
      'expired',
    ],
    [
      'no qualification file',
      () =>
        admitHorsePhase11QualifiedAuthority(
          V,
          p11Selection(V),
          memoryReader({}),
          P11_TEST_NOW,
          P11_TEST_CONTRACT_DIGEST
        ),
      'missing_evidence',
    ],
    [
      'qualification bytes that differ from the selected sha256',
      () => admit(V, p11Selection(V), p11QualificationBytes(V, { reasons: ['edited'] })),
      'hash_mismatch',
    ],
    [
      'a file that is not JSON',
      () => {
        const q = Buffer.from('not json');
        return admit(V, p11Selection(V, q), q);
      },
      'evidence_mismatch',
    ],
    [
      'a Phase 10 qualification schema',
      () => withQualification({ schema: 'horse-phase10-qualification-v1' }),
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
          objectives: {
            ...p11QualificationObject(V).objectives,
            cash: { qualified: false, status: 'measured' },
          },
        }),
      'not_qualified',
    ],
    [
      'a file measured on other policy code',
      () => withQualification({ policyDigest: 'd'.repeat(64) }),
      'policy_digest_mismatch',
    ],
    [
      'a file under another policy digest definition',
      () => withQualification({ policyDigestDefinition: 'horse-phase10-policy-digest-v2' }),
      'policy_digest_mismatch',
    ],
    [
      'running code that differs from the measured code',
      () => admit(V, p11Selection(V), undefined, undefined, undefined, 'e'.repeat(64)),
      'policy_digest_mismatch',
    ],
    [
      'a PLO5 qualification file under a PLO6 selection',
      () => {
        const q = p11QualificationBytes('plo5');
        return admit(V, p11Selection(V, q), q);
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
      () => withQualification({ variant: 'plo5' }),
      'continuation_mismatch',
    ],
    [
      'a file whose domain is not the cash domain',
      () => withQualification({ domain: 'plo6-tournament-prize' }),
      'continuation_mismatch',
    ],
    [
      'a file under another contract version',
      () => withQualification({ contractVersion: 'omaha-variant-strength-contract-v0' }),
      'evidence_mismatch',
    ],
    [
      'a file that drops the admission requirement',
      () => withQualification({ admissionAlsoRequires: [] }),
      'evidence_mismatch',
    ],
    [
      'a strength record outside docs/evidence/phase11/',
      () => withQualification({ evidencePath: 'docs/evidence/phase10/strength.json' }),
      'evidence_mismatch',
    ],
    [
      'a missing strength record',
      () =>
        admitHorsePhase11QualifiedAuthority(
          V,
          p11Selection(V),
          memoryReader({
            [p11QualificationPath(V)]: p11QualificationBytes(V),
            [p11CompletionPath(V)]: p11CompletionBytes(V),
          }),
          P11_TEST_NOW,
          P11_TEST_CONTRACT_DIGEST
        ),
      'missing_evidence',
    ],
    [
      'a strength record that is not the hashed one',
      () =>
        admitHorsePhase11QualifiedAuthority(
          V,
          p11Selection(V),
          memoryReader({
            [p11QualificationPath(V)]: p11QualificationBytes(V),
            [p11StrengthPath(V)]: Buffer.concat([p11TestStrength(V), Buffer.from(' ')]),
            [p11CompletionPath(V)]: p11CompletionBytes(V),
          }),
          P11_TEST_NOW,
          P11_TEST_CONTRACT_DIGEST
        ),
      'hash_mismatch',
    ],
    [
      'a selection that names no completion record',
      () => admit(V, p11Selection(V, undefined, null), undefined, null),
      'completion_evidence_missing',
    ],
    [
      'a named completion record that is not committed',
      () => admit(V, p11Selection(V), undefined, null),
      'completion_evidence_missing',
    ],
    [
      'completion bytes that differ from the selected sha256',
      () =>
        admit(V, p11Selection(V), undefined, p11CompletionBytes(V, { releaseSha: 'd'.repeat(40) })),
      'completion_hash_mismatch',
    ],
    [
      'a completion record that is not JSON',
      () => withCompletionBytes(Buffer.from('[]')),
      'completion_evidence_mismatch',
    ],
    [
      'another completion schema',
      () => withCompletion({ schema: 'horse-phase11-completion-v0' }),
      'completion_evidence_mismatch',
    ],
    [
      'another completion definition',
      () => withCompletion({ definition: 'horse-phase11-completion-definition-v0' }),
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
      'street counts that do not add up',
      () =>
        withCompletion({
          streets: {
            ...p11CompletionObject(V).streets,
            river: {
              eligible: 200,
              completed: 200,
              workBudget: 1,
              samplerBudgetExhausted: 0,
              sampleUnavailable: 0,
              governorReduced: 0,
            },
          },
        }),
      'completion_evidence_mismatch',
    ],
    [
      'a missing street',
      () =>
        withCompletion({
          streets: { preflop: p11Street(), flop: p11Street(), turn: p11Street() },
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
      () => withCompletion({ policyDigestDefinition: 'horse-phase11-policy-digest-v0' }),
      'completion_release_mismatch',
    ],
    [
      'completion of another pack',
      () => withCompletion({ variant: 'plo5', policyDigest: horsePhase11PolicyDigest('plo5') }),
      'completion_release_mismatch',
    ],
    [
      'completion of another pack version',
      () => withCompletion({ packVersion: 'plo6-high-round1-v1' }),
      'completion_release_mismatch',
    ],
    [
      'a reversed window',
      () =>
        withCompletion({
          window: { ...p11CompletionObject(V).window, from: '2026-10-19T00:00:00.000Z' },
        }),
      'completion_window_invalid',
    ],
    [
      'a window during which the release changed',
      () =>
        withCompletion({ window: { ...p11CompletionObject(V).window, releaseUnchanged: false } }),
      'completion_window_invalid',
    ],
    [
      'a window that ends after the selection was issued',
      () =>
        withCompletion({
          window: { ...p11CompletionObject(V).window, to: '2026-10-20T00:00:00.001Z' },
        }),
      'completion_window_invalid',
    ],
    [
      'a window that is not an exact ISO timestamp',
      () => withCompletion({ window: { ...p11CompletionObject(V).window, from: '2026-10-12' } }),
      'completion_window_invalid',
    ],
    [
      'a river that falls back to the baseline on 15 of 200 decisions',
      () =>
        withCompletion({
          streets: { ...p11CompletionObject(V).streets, river: p11Street(200, 15) },
        }),
      'completion_below_floor',
    ],
    [
      'a turn whose live samples were cut short on 15 of 200 decisions',
      () =>
        withCompletion({
          streets: { ...p11CompletionObject(V).streets, turn: p11Street(200, 0, 15) },
        }),
      'completion_below_floor',
    ],
    [
      'a street with no eligible decisions',
      () => withCompletion({ streets: { ...p11CompletionObject(V).streets, flop: p11Street(0) } }),
      'completion_below_floor',
    ],
    [
      'an all-complete street too small to bound the share (126 decisions)',
      () =>
        withCompletion({ streets: { ...p11CompletionObject(V).streets, preflop: p11Street(126) } }),
      'completion_below_floor',
    ],
  ] as const)('%s', (_name, run, reason) => {
    const admission = run();
    expect(admission).toEqual({ status: 'refused', reason, transient: false });
    expect(selectedHorsePhase11Authority(V, admission)).toBeNull();
  });

  it.each([
    ['the qualification file', p11QualificationPath(V)],
    ['the strength record', p11StrengthPath(V)],
    ['the completion record', p11CompletionPath(V)],
  ])('an I/O failure reading %s is a transient refusal, never a withdrawal', (_name, path) => {
    const files: Record<string, Buffer | Error> = {
      [p11QualificationPath(V)]: p11QualificationBytes(V),
      [p11StrengthPath(V)]: p11TestStrength(V),
      [p11CompletionPath(V)]: p11CompletionBytes(V),
      [path]: eacces,
    };
    expect(
      admitHorsePhase11QualifiedAuthority(
        V,
        p11Selection(V),
        memoryReader(files),
        P11_TEST_NOW,
        P11_TEST_CONTRACT_DIGEST
      )
    ).toEqual({ status: 'refused', reason: 'unreadable_evidence', transient: true });
  });

  it('a committed withdrawal is a withdrawal, not a selection', () => {
    const admission = admit(
      V,
      p11Selection(V, undefined, undefined, {
        withdrawn: { at: '2026-10-20T00:30:00.000Z', reason: 'owner' },
      })
    );
    expect(admission).toEqual({
      status: 'withdrawn',
      approvalGeneration: 1,
      reason: 'release_owner',
    });
    expect(selectedHorsePhase11Authority(V, admission)).toBeNull();
  });

  it.each(HORSE_PHASE11_VARIANTS)(
    'a valid %s qualification and completion record (test fixture only) select an immutable record bound to both',
    (variant) => {
      const q = p11QualificationBytes(variant);
      const c = p11CompletionBytes(variant);
      const authority = selectedHorsePhase11Authority(
        variant,
        admit(variant, p11Selection(variant, q, c), q, c)
      );
      expect(authority).not.toBeNull();
      expect(Object.isFrozen(authority)).toBe(true);
      const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
      const identity = {
        schema: 'horse-qualified-authority-v1',
        phase: 'phase11',
        variant,
        sourceSha: P11_TEST_SOURCE_SHA,
        continuationVersion: OMAHA_VARIANT_PACKS[variant].version,
        policyDigest: horsePhase11PolicyDigest(variant),
        packId: OMAHA_VARIANT_PACKS[variant].version,
        domain: omahaVariantStrengthDomain(variant),
        evidencePath: p11QualificationPath(variant),
        evidenceSha256: sha(q),
        completionPath: p11CompletionPath(variant),
        completionSha256: sha(c),
        approvalGeneration: 1,
        issuedAt: P11_TEST_ISSUED_AT,
        expiresAt: null,
        contractDigest: P11_TEST_CONTRACT_DIGEST,
      };
      expect(authority).toEqual({
        ...identity,
        authorityKey: expectedKey({
          ...identity,
          completionDefinition: HORSE_PHASE11_COMPLETION_DEFINITION,
          completionFloor: HORSE_PHASE11_COMPLETION_FLOOR,
        }),
      });
      // Another completion record is another authority.
      const c2 = p11CompletionBytes(variant, { releaseSha: 'd'.repeat(40) });
      const other = selectedHorsePhase11Authority(
        variant,
        admit(variant, p11Selection(variant, q, c2), q, c2)
      );
      expect(other?.authorityKey).toMatch(/^[0-9a-f]{64}$/);
      expect(other?.authorityKey).not.toBe(authority!.authorityKey);
    }
  );

  it('an all-complete street of exactly the minimum size passes; one decision fewer does not', () => {
    expect(HORSE_PHASE11_COMPLETION_MIN_ELIGIBLE_PER_STREET).toBe(127);
    const n = HORSE_PHASE11_COMPLETION_MIN_ELIGIBLE_PER_STREET;
    const at = (preflop: ReturnType<typeof p11Street>) =>
      withCompletion({ streets: { ...p11CompletionObject(V).streets, preflop } });
    expect(at(p11Street(n)).status).toBe('admitted');
    expect(at(p11Street(n - 1))).toMatchObject({ reason: 'completion_below_floor' });
    // 5% of 2000 river decisions falling back is a point share of exactly the
    // floor, which the lower bound refuses; 2.5% clears it.
    expect(at(p11Street(2000, 100))).toMatchObject({ reason: 'completion_below_floor' });
    expect(at(p11Street(2000, 50)).status).toBe('admitted');
  });
});

describe('P11.3 one pack never admits another', () => {
  it('a qualified PLO5 selection and its evidence admit PLO5 only', () => {
    const plo5 = qualifiedPhase11TestAdmission('plo5');
    expect(selectedHorsePhase11Authority('plo5', plo5)).not.toBeNull();
    expect(selectedHorsePhase11Authority('plo6', plo5)).toBeNull();
    expect(selectedHorsePhase11Authority('plo8', plo5)).toBeNull();
    // The same selection and files, admitted as either other pack.
    for (const other of ['plo6', 'plo8'] as const)
      expect(
        admitHorsePhase11QualifiedAuthority(
          other,
          p11Selection('plo5'),
          p11Reader('plo5'),
          P11_TEST_NOW,
          P11_TEST_CONTRACT_DIGEST
        )
      ).toMatchObject({ status: 'refused', reason: 'continuation_mismatch' });
    // The release path for another pack reads only its own selection: with
    // that selection null, the PLO5 files do not admit it.
    expect(
      admitHorsePhase11ReleaseAuthority('plo6', P11_TEST_NOW, null, p11Reader('plo5'))
    ).toMatchObject({
      reason: 'unselected',
    });
  });

  it('each pack holder is usable only for its own pack; PLO4 and the packs never stand in for each other', () => {
    for (const variant of HORSE_PHASE11_VARIANTS) {
      const own = new HorseQualifiedAuthorityHolder(
        'p113-own',
        OMAHA_VARIANT_PACKS[variant].version
      );
      own.apply(qualifiedPhase11TestAdmission(variant));
      expect(own.verdict(own.receipt(), P11_TEST_NOW), variant).toBe('usable');
      for (const other of HORSE_PHASE11_VARIANTS.filter((v) => v !== variant)) {
        const crossed = new HorseQualifiedAuthorityHolder(
          'p113-crossed',
          OMAHA_VARIANT_PACKS[other].version
        );
        crossed.apply(qualifiedPhase11TestAdmission(variant));
        expect(crossed.verdict(crossed.receipt(), P11_TEST_NOW), `${variant}->${other}`).toBe(
          'mismatched'
        );
      }
      const plo4 = new HorseQualifiedAuthorityHolder('p113-plo4', PLO4_POLICY_PACK.version);
      plo4.apply(qualifiedPhase11TestAdmission(variant));
      expect(plo4.verdict(plo4.receipt(), P11_TEST_NOW)).toBe('mismatched');
      const fromPhase10 = new HorseQualifiedAuthorityHolder(
        'p113-p10',
        OMAHA_VARIANT_PACKS[variant].version
      );
      fromPhase10.apply(qualifiedPhase10TestAdmission(1));
      expect(fromPhase10.verdict(fromPhase10.receipt(), P11_TEST_NOW)).toBe('mismatched');
    }
  });

  it('a withdrawal, refresh failure or restart of one pack gate never touches another', () => {
    const gates = Object.fromEntries(
      HORSE_PHASE11_VARIANTS.map((variant) => {
        let admission = qualifiedPhase11TestAdmission(variant, 5);
        const gate = new HorsePhase8AuthorityGate(
          () => admission,
          `p113-main-${variant}`,
          OMAHA_VARIANT_PACKS[variant].version
        );
        gate.refresh();
        const worker = new HorseQualifiedAuthorityHolder(
          'p113-worker',
          OMAHA_VARIANT_PACKS[variant].version
        );
        worker.apply(qualifiedPhase11TestAdmission(variant, 5));
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
      OmahaPolicyVariant,
      { gate: HorsePhase8AuthorityGate; worker: HorseQualifiedAuthorityHolder; fail: () => void }
    >;
    const check = (v: OmahaPolicyVariant) =>
      gates[v].gate.check(gates[v].gate.stamp(gates[v].worker.receipt()), P11_TEST_NOW);
    for (const v of HORSE_PHASE11_VARIANTS) expect(check(v)).toBe('usable');
    gates.plo5.gate.withdraw('controller_fallback_candidate');
    gates.plo6.fail();
    gates.plo6.gate.refresh();
    gates.plo8.gate.forgetWorker('p113-worker');
    expect([check('plo5'), check('plo6'), check('plo8')]).toEqual([
      'withdrawn',
      'refresh_failed',
      'restarted',
    ]);
    // Re-admitting the withdrawn approval is not a renewal.
    gates.plo5.gate.refresh();
    expect(gates.plo5.gate.mainState()).toBe('withdrawn');
  });

  it.each([
    ['cash', 'plo5', 'plo5', 'usable', undefined, 'candidate'],
    ['cash', 'plo6', 'plo6', 'usable', 'shadow', 'candidate'],
    ['cash', 'plo8', 'plo8', 'unselected', undefined, 'shadow'],
    ['cash', 'plo8', 'plo8', 'refused', undefined, 'shadow'],
    ['cash', 'plo8', 'plo8', 'withdrawn', undefined, 'shadow'],
    ['cash', 'plo8', 'plo8', 'stale_generation', undefined, 'shadow'],
    ['cash', 'plo6', 'plo5', 'usable', undefined, 'shadow'],
    ['cash', 'plo4', null, 'usable', undefined, 'shadow'],
    ['cash', 'plo5', 'plo5', 'usable', 'off', 'off'],
    ['tournament', 'plo5', 'plo5', 'usable', undefined, 'shadow'],
    ['tournament', 'plo8', 'plo8', 'usable', 'shadow', 'shadow'],
    [undefined, 'plo6', 'plo6', 'usable', undefined, 'shadow'],
  ] as const)(
    'a %s %s decision with a %s holder verdict %s and caller %s runs the pack in %s mode',
    (gameMode, variant, packVariant, verdict, callerMode, expected) => {
      expect(
        horsePhase11AdmittedMode({ gameMode, variant, packVariant, verdict, callerMode })
      ).toBe(expected);
    }
  );
});

describe('P11.3 natural completion share: what a record counts', () => {
  const receipt = (overrides: Record<string, unknown> = {}) => ({
    variant: 'plo8',
    version: OMAHA_VARIANT_PACKS.plo8.version,
    eligible: true,
    utilityOwner: 'cash',
    street: 'river',
    reason: 'split_price_call',
    inputs: {
      range: {
        status: 'consumed',
        provenance: { work: { budgetExhausted: false, requestedSamples: 32 } },
      },
    },
    ...overrides,
  });

  it.each([
    ['a complete eligible cash decision', receipt(), 'completed'],
    ['a work-budget fallback', receipt({ reason: 'work_budget' }), 'work_budget'],
    [
      'a consumed live sample cut short',
      receipt({
        inputs: { range: { status: 'consumed', provenance: { work: { budgetExhausted: true } } } },
      }),
      'sampler_budget_exhausted',
    ],
    [
      'a complete sample the governor reduced',
      receipt({
        inputs: {
          range: {
            status: 'consumed',
            provenance: { work: { budgetExhausted: false, requestedSamples: 16 } },
          },
        },
      }),
      'governor_reduced',
    ],
    ['a preflop decision (no sample)', receipt({ street: 'preflop', inputs: null }), 'completed'],
    ['an ineligible decision', receipt({ eligible: false }), 'not_counted'],
    ['a tournament decision', receipt({ utilityOwner: 'phase7_evaluated' }), 'not_counted'],
    ['another pack', receipt({ variant: 'plo5' }), 'not_counted'],
    ['another pack version', receipt({ version: 'plo8-split-round1-v1' }), 'not_counted'],
    ['a receipt that is not an object', null, 'not_counted'],
  ] as const)('%s counts as %s', (_name, value, expected) => {
    expect(horsePhase11CompletionOutcome('plo8', value)).toBe(expected);
  });

  it('counts real policy receipts, a work-budget fallback included, by street', () => {
    const seen: unknown[] = [];
    for (const street of ['preflop', 'flop', 'turn', 'river'] as const) {
      const input = omahaVariantSpot('plo5', street, 2, 'cash');
      const baseline = { action: 'call' as const, amount: 20, thinkTime: 0 };
      if (street === 'preflop') baseline.amount = 1;
      const ok = evaluateOmahaVariantPolicy(
        input.hero,
        input.state,
        baseline,
        null,
        'shadow',
        () => 0
      );
      let t = 0;
      const slow = evaluateOmahaVariantPolicy(
        input.hero,
        input.state,
        baseline,
        null,
        'shadow',
        () => (t += 5)
      );
      expect(ok.receipt.eligible, street).toBe(true);
      expect(slow.receipt).toMatchObject({ eligible: true, reason: 'work_budget' });
      seen.push(ok.receipt, slow.receipt);
    }
    const counts = horsePhase11CompletionCounts('plo5', seen);
    for (const street of ['preflop', 'flop', 'turn', 'river'] as const)
      expect(counts[street], street).toEqual({
        eligible: 2,
        completed: 1,
        workBudget: 1,
        samplerBudgetExhausted: 0,
        sampleUnavailable: 0,
        governorReduced: 0,
      });
    // Another pack's counting reads none of them.
    expect(horsePhase11CompletionCounts('plo6', seen).river.eligible).toBe(0);
  });

  it('v3: a complete sample the load governor reduced is not completed', () => {
    const input = omahaVariantSpot('plo5', 'river', 3);
    const decide = () =>
      evaluateOmahaVariantPolicy(
        input.hero,
        input.state,
        { action: 'call', amount: input.state.toCall, thinkTime: 0 },
        null,
        'shadow',
        () => 0
      ).receipt;
    try {
      // Since 2026-10-09 the live sampler prices the measured policy's full
      // sample whatever the governor says, so a loaded engine no longer makes
      // a decision governor-reduced.
      equityGovernor.__setScaleForTest(0.5);
      const loaded = decide();
      const loadedWork = (
        loaded.inputs?.range as unknown as { provenance: { work: Record<string, unknown> } }
      ).provenance.work;
      expect(loadedWork).toMatchObject({ requestedSamples: 32, completedSamples: 32 });
      expect(horsePhase11CompletionOutcome('plo5', loaded)).toBe('completed');
      // A journaled receipt from an earlier release that did request fewer is
      // still counted as governor-reduced, never as completed.
      const reduced = structuredClone(loaded);
      const work = (
        reduced.inputs?.range as unknown as { provenance: { work: Record<string, unknown> } }
      ).provenance.work;
      work.requestedSamples = 16;
      work.completedSamples = 16;
      expect(work.budgetExhausted).toBe(false);
      expect(horsePhase11CompletionOutcome('plo5', reduced)).toBe('governor_reduced');
      expect(horsePhase11CompletionCounts('plo5', [reduced]).river).toEqual({
        eligible: 1,
        completed: 0,
        workBudget: 0,
        samplerBudgetExhausted: 0,
        sampleUnavailable: 0,
        governorReduced: 1,
      });
      equityGovernor.__setScaleForTest(1);
      expect(horsePhase11CompletionOutcome('plo5', decide())).toBe('completed');
    } finally {
      equityGovernor.__setScaleForTest(null);
    }
  });

  it('v2: a postflop decision priced with no complete live sample is not completed', () => {
    const counted: unknown[] = [];
    for (const street of ['flop', 'turn', 'river'] as const) {
      const input = omahaVariantSpot('plo5', street, 3);
      // The sampler's 3 ms budget is spent before the first sample; the
      // policy itself stays inside its 4 ms budget.
      let calls = 0;
      const clock = () => (calls++ === 0 ? 0 : 3.5);
      const r = evaluateOmahaVariantPolicy(
        input.hero,
        input.state,
        { action: 'call', amount: input.state.toCall, thinkTime: 0 },
        null,
        'shadow',
        clock
      );
      expect(r.receipt.inputs?.range.status, street).toBe('unavailable');
      expect(r.receipt.reason, street).not.toBe('work_budget');
      expect(horsePhase11CompletionOutcome('plo5', r.receipt), street).toBe('sample_unavailable');
      counted.push(r.receipt);
    }
    expect(horsePhase11CompletionCounts('plo5', counted).river).toEqual({
      eligible: 1,
      completed: 0,
      workBudget: 0,
      samplerBudgetExhausted: 0,
      sampleUnavailable: 1,
      governorReduced: 0,
    });
    // Preflop never samples: an eligible preflop proposal inside the budget
    // is the measured policy.
    const pre = omahaVariantSpot('plo5', 'preflop', 3);
    const p = evaluateOmahaVariantPolicy(
      pre.hero,
      pre.state,
      pre.baseline,
      null,
      'shadow',
      () => 0
    );
    expect(horsePhase11CompletionOutcome('plo5', p.receipt)).toBe('completed');
  });

  it('the floor is judged on the Wilson lower bound at the contract interval z', () => {
    const z = OMAHA_VARIANT_STRENGTH_CONTRACT.interval.z;
    expect(z).toBeCloseTo(2.5758293035489004, 15);
    expect(HORSE_PHASE11_COMPLETION_FLOOR).toBe(0.95);
    // All complete: n / (n + z^2).
    expect(horsePhase11CompletionLowerBound(200, 200)).toBeCloseTo(200 / (200 + z * z), 12);
    // An independent closed form for a mixed share.
    const n = 1000;
    const p = 0.97;
    const wilson =
      (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) /
      (1 + (z * z) / n);
    expect(horsePhase11CompletionLowerBound(970, 1000)).toBeCloseTo(wilson, 12);
    expect(horsePhase11CompletionLowerBound(0, 0)).toBe(0);
    const streets = p11CompletionObject(V).streets as Parameters<
      typeof horsePhase11CompletionMeetsFloor
    >[0];
    expect(horsePhase11CompletionMeetsFloor(streets)).toBe(true);
    expect(
      horsePhase11CompletionMeetsFloor({ ...streets, river: p11Street(1000, 30) } as never)
    ).toBe(true);
    expect(
      horsePhase11CompletionMeetsFloor({ ...streets, river: p11Street(1000, 40) } as never)
    ).toBe(false);
  });

  it('the evidence directory, schema names and admission requirement are the P11.2 ones', () => {
    expect(HORSE_PHASE11_EVIDENCE_DIRECTORY).toBe('docs/evidence/phase11/');
    expect(HORSE_PHASE11_QUALIFICATION_SCHEMA).toBe('horse-phase11-qualification-v1');
    expect(HORSE_PHASE11_COMPLETION_SCHEMA).toBe('horse-phase11-completion-v1');
    expect(OMAHA_VARIANT_STRENGTH_CONTRACT.liveConditions.admissionAlsoRequires[0]).toContain(
      'P11.3 must state and meet its own floor'
    );
    // The fixture binds the contract's own requirement, verbatim.
    expect(json(p11QualificationObject('plo5').admissionAlsoRequires).toString()).toBe(
      json([...OMAHA_VARIANT_STRENGTH_CONTRACT.liveConditions.admissionAlsoRequires]).toString()
    );
  });
});
