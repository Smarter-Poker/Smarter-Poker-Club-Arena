import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  admitHorsePhase10QualifiedAuthority,
  admitHorsePhase10ReleaseAuthority,
  HORSE_PHASE10_DOMAIN,
  HORSE_PHASE10_POLICY_DIGEST_DEFINITION,
  HORSE_PHASE10_POLICY_SOURCE_FILES,
  horsePhase10AdmittedMode,
  horsePhase10PolicyDigest,
  horsePhase10PolicyDigestOf,
  runningPolicySourceReader,
  liveHorsePhase10Authority,
  PHASE10_PROTECTED_RELEASE_SELECTION,
  PHASE10_RUNNING_CONTRACT_DIGEST,
  selectedHorsePhase10Authority,
  type HorsePhase10AuthoritySelection,
} from './HorsePhase10Authority.js';
import {
  HorsePhase8AuthorityGate,
  HorseQualifiedAuthorityHolder,
  type HorseAuthorityAdmission,
} from './HorseQualifiedAuthority.js';
import { qualifiedTestAdmission } from './HorseQualifiedAuthority.test-support.js';
import { memoryReader } from './HorseQualifiedAuthority.test-support.js';
import {
  P10_TEST_CONTRACT_DIGEST,
  P10_TEST_NOW,
  P10_TEST_POLICY_DIGEST,
  P10_TEST_QUALIFICATION_PATH,
  P10_TEST_SOURCE_SHA,
  P10_TEST_STRENGTH_PATH,
  p10QualificationBytes,
  p10Reader,
  p10Selection,
  p10TestStrength,
  qualifiedPhase10TestAdmission,
} from './HorsePhase10Authority.test-support.js';
import { PLO4_POLICY_PACK } from './plo4/Plo4PolicyPack.js';
import { plo4StrengthContractDigest } from '../benchmark/Plo4StrengthContract.js';

const admit = (
  selection: HorsePhase10AuthoritySelection | null,
  qualification: Buffer = p10QualificationBytes(),
  runningDigest: string | null = P10_TEST_CONTRACT_DIGEST
): HorseAuthorityAdmission =>
  admitHorsePhase10QualifiedAuthority(
    selection,
    p10Reader(qualification),
    P10_TEST_NOW,
    runningDigest
  );

/** Independent recomputation of the authority key from the stated identity. */
function expectedKey(identity: Record<string, unknown>): string {
  const sorted = Object.fromEntries(
    Object.keys(identity)
      .sort()
      .map((k) => [k, identity[k]])
  );
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

describe('P10.3 committed selection: the round-3 PLO4 pack, qualified on condition (a)', () => {
  const committed = PHASE10_PROTECTED_RELEASE_SELECTION;

  it('the committed selection names the c8bfc617 matrix and the running digest is the P10.2 contract digest', () => {
    expect(committed).not.toBeNull();
    expect(Object.isFrozen(committed)).toBe(true);
    expect(committed).toMatchObject({
      schema: 'horse-qualified-authority-selection-v1',
      phase: 'phase10',
      sourceSha: 'c8bfc6171ddfabdfa8d8ca55f4e13fc7e2466400',
      packVersion: PLO4_POLICY_PACK.version,
      contractDigest: PHASE10_RUNNING_CONTRACT_DIGEST,
      domain: HORSE_PHASE10_DOMAIN,
      qualificationPath: 'docs/evidence/phase10/phase10-qualification-2026-10-09.json',
      approvalGeneration: 1,
      expiresAt: null,
      withdrawn: null,
    });
    expect(PHASE10_RUNNING_CONTRACT_DIGEST).toBe(plo4StrengthContractDigest());
    expect(PHASE10_RUNNING_CONTRACT_DIGEST).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the running code admits it: the committed file qualifies for this digest, source and policy', () => {
    const release = admitHorsePhase10ReleaseAuthority();
    expect(release.status).toBe('admitted');
    expect(selectedHorsePhase10Authority(release)).toMatchObject({
      phase: 'phase10',
      sourceSha: committed!.sourceSha,
      continuationVersion: PLO4_POLICY_PACK.version,
      policyDigest: horsePhase10PolicyDigest(),
      domain: HORSE_PHASE10_DOMAIN,
      evidencePath: committed!.qualificationPath,
      evidenceSha256: committed!.qualificationSha256,
      approvalGeneration: 1,
    });
    const file = JSON.parse(
      readFileSync(
        fileURLToPath(new URL(`../../../${committed!.qualificationPath}`, import.meta.url)),
        'utf8'
      )
    ) as Record<string, unknown>;
    expect(file).toMatchObject({
      qualified: true,
      mode: 'contract',
      policyDigest: horsePhase10PolicyDigest(),
      policyDigestDefinition: HORSE_PHASE10_POLICY_DIGEST_DEFINITION,
    });
  });

  it('the running code refuses a well-formed qualified selection made under another contract', () => {
    const other = 'e'.repeat(64);
    const qualification = p10QualificationBytes({ contractDigest: other });
    const release = admitHorsePhase10ReleaseAuthority(
      P10_TEST_NOW,
      p10Selection(qualification, { contractDigest: other }),
      p10Reader(qualification)
    );
    expect(release).toEqual({
      status: 'refused',
      reason: 'contract_digest_mismatch',
      transient: false,
    });
    expect(selectedHorsePhase10Authority(release)).toBeNull();
    // Without a running digest nothing can be admitted at all.
    const unwired = admitHorsePhase10ReleaseAuthority(
      P10_TEST_NOW,
      p10Selection(),
      p10Reader(),
      null
    );
    expect(unwired).toMatchObject({ status: 'refused', reason: 'contract_unavailable' });
  });

  it('the live main-scheduler gate is usable under the committed selection', () => {
    liveHorsePhase10Authority.refresh();
    expect(liveHorsePhase10Authority.mainState()).toBe('usable');
  });

  it('withdrawal is a committed record: the same selection with withdrawn set is a withdrawal, never a selection', () => {
    const withdrawn = {
      ...committed!,
      withdrawn: { at: '2026-10-10T00:00:00.000Z', reason: 'condition_b_lost_after_rake' },
    };
    const release = admitHorsePhase10ReleaseAuthority(Date.now(), withdrawn);
    expect(release).toEqual({
      status: 'withdrawn',
      approvalGeneration: 1,
      reason: 'release_condition_b_lost_after_rake',
    });
    expect(selectedHorsePhase10Authority(release)).toBeNull();
    const gate = new HorsePhase8AuthorityGate(
      () => admitHorsePhase10ReleaseAuthority(Date.now(), withdrawn),
      undefined,
      PLO4_POLICY_PACK.version
    );
    gate.refresh();
    expect(gate.mainState()).toBe('withdrawn');
  });

  it('the only committed Phase 10 qualification file that says qualified:true is the selected one', () => {
    const dir = fileURLToPath(new URL('../../../docs/evidence/phase10/', import.meta.url));
    const files = existsSync(dir)
      ? readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.json'))
      : [];
    for (const file of files) {
      const parsed = JSON.parse(readFileSync(`${dir}${file}`, 'utf8')) as Record<string, unknown>;
      if (parsed.schema === 'horse-phase10-qualification-v1' && parsed.qualified === true)
        expect(`docs/evidence/phase10/${file}`).toBe(committed!.qualificationPath);
    }
  });
});

describe('P10.3 selection is null unless the P10.2 file qualifies for the exact digest and source', () => {
  const strengthless = memoryReader({});
  it.each([
    ['no selection', () => admit(null), 'unselected'],
    [
      'no qualification file',
      () =>
        admitHorsePhase10QualifiedAuthority(
          p10Selection(),
          strengthless,
          P10_TEST_NOW,
          P10_TEST_CONTRACT_DIGEST
        ),
      'missing_evidence',
    ],
    [
      'qualified:false',
      () => {
        const q = p10QualificationBytes({ qualified: false });
        return admit(p10Selection(q), q);
      },
      'not_qualified',
    ],
    [
      'a development-mode assembly',
      () => {
        const q = p10QualificationBytes({ mode: 'development' });
        return admit(p10Selection(q), q);
      },
      'not_qualified',
    ],
    [
      'a top-level qualified:true whose cash objective is not qualified',
      () => {
        const base = JSON.parse(p10QualificationBytes().toString('utf8'));
        const q = p10QualificationBytes({
          objectives: { ...base.objectives, cash: { qualified: false, status: 'measured' } },
        });
        return admit(p10Selection(q), q);
      },
      'not_qualified',
    ],
    [
      'a file for a different contract digest',
      () => {
        const q = p10QualificationBytes({ contractDigest: 'e'.repeat(64) });
        return admit(p10Selection(q), q);
      },
      'contract_digest_mismatch',
    ],
    [
      'a selection for a different contract digest than the running one',
      () => admit(p10Selection(), p10QualificationBytes(), 'e'.repeat(64)),
      'contract_digest_mismatch',
    ],
    [
      'a file for a different source SHA',
      () => {
        const q = p10QualificationBytes({ sourceSha: 'c'.repeat(40) });
        return admit(p10Selection(q), q);
      },
      'source_mismatch',
    ],
    [
      'qualification bytes that differ from the selected sha256',
      () => admit(p10Selection(), p10QualificationBytes({ reasons: ['edited'] })),
      'hash_mismatch',
    ],
    [
      'a strength record that is not the hashed one',
      () =>
        admitHorsePhase10QualifiedAuthority(
          p10Selection(),
          memoryReader({
            [P10_TEST_QUALIFICATION_PATH]: p10QualificationBytes(),
            [P10_TEST_STRENGTH_PATH]: Buffer.concat([p10TestStrength, Buffer.from(' ')]),
          }),
          P10_TEST_NOW,
          P10_TEST_CONTRACT_DIGEST
        ),
      'hash_mismatch',
    ],
    [
      'a missing strength record',
      () =>
        admitHorsePhase10QualifiedAuthority(
          p10Selection(),
          memoryReader({ [P10_TEST_QUALIFICATION_PATH]: p10QualificationBytes() }),
          P10_TEST_NOW,
          P10_TEST_CONTRACT_DIGEST
        ),
      'missing_evidence',
    ],
    [
      'a Phase 8 qualification schema',
      () => {
        const q = p10QualificationBytes({ schema: 'horse-phase8-qualification-v1' });
        return admit(p10Selection(q), q);
      },
      'evidence_mismatch',
    ],
    [
      'another PLO4 pack version',
      () => {
        const q = p10QualificationBytes({ packVersion: 'plo4-policy-round1-v2' });
        return admit(p10Selection(q), q);
      },
      'continuation_mismatch',
    ],
    [
      'a tournament domain',
      () => admit(p10Selection(undefined, { domain: 'plo4-tournament-prize-bounty' })),
      'continuation_mismatch',
    ],
    [
      'a path outside docs/evidence/phase10/',
      () =>
        admit(p10Selection(undefined, { qualificationPath: 'docs/evidence/phase10/../x.json' })),
      'invalid_selection',
    ],
    [
      'an expired selection',
      () => admit(p10Selection(undefined, { expiresAt: new Date(P10_TEST_NOW - 1).toISOString() })),
      'expired',
    ],
  ] as const)('%s', (_name, run, reason) => {
    const admission = run();
    expect(admission).toMatchObject({ status: 'refused', reason });
    expect(selectedHorsePhase10Authority(admission)).toBeNull();
  });

  it('a committed withdrawal is a withdrawal, not a selection', () => {
    const admission = admit(
      p10Selection(undefined, { withdrawn: { at: '2026-10-10T00:30:00.000Z', reason: 'owner' } })
    );
    expect(admission).toEqual({
      status: 'withdrawn',
      approvalGeneration: 1,
      reason: 'release_owner',
    });
    expect(selectedHorsePhase10Authority(admission)).toBeNull();
  });

  it('a valid qualified file (test fixture only) selects an immutable record bound to its digest and source', () => {
    const qualification = p10QualificationBytes();
    const selection = p10Selection(qualification);
    const authority = selectedHorsePhase10Authority(admit(selection, qualification));
    expect(authority).not.toBeNull();
    expect(Object.isFrozen(authority)).toBe(true);
    const identity = {
      schema: 'horse-qualified-authority-v1',
      phase: 'phase10',
      sourceSha: P10_TEST_SOURCE_SHA,
      continuationVersion: 'plo4-policy-round3-v2',
      policyDigest: P10_TEST_POLICY_DIGEST,
      packId: 'plo4-policy-round3-v2',
      domain: HORSE_PHASE10_DOMAIN,
      evidencePath: P10_TEST_QUALIFICATION_PATH,
      evidenceSha256: createHash('sha256').update(qualification).digest('hex'),
      approvalGeneration: 1,
      issuedAt: '2026-10-10T00:00:00.000Z',
      expiresAt: null,
      contractDigest: P10_TEST_CONTRACT_DIGEST,
    };
    expect(authority).toEqual({ ...identity, authorityKey: expectedKey(identity) });
    // The key binds the contract digest: another contract is another authority.
    const other = admitHorsePhase10QualifiedAuthority(
      p10Selection(p10QualificationBytes({ contractDigest: 'f'.repeat(64) }), {
        contractDigest: 'f'.repeat(64),
      }),
      p10Reader(p10QualificationBytes({ contractDigest: 'f'.repeat(64) })),
      P10_TEST_NOW,
      'f'.repeat(64)
    );
    expect(selectedHorsePhase10Authority(other)?.authorityKey).not.toBe(authority!.authorityKey);
  });
});

describe('P10.3 reuses the Phase 8 holder, gate and verdicts', () => {
  it('a Phase 10 holder is usable only for the running PLO4 pack and never accepts Phase 8 authority', () => {
    const plo4 = new HorseQualifiedAuthorityHolder('p103-holder', PLO4_POLICY_PACK.version);
    plo4.apply(qualifiedPhase10TestAdmission(1));
    const receipt = plo4.receipt();
    expect(receipt).toMatchObject({
      state: 'usable',
      continuationVersion: 'plo4-policy-round3-v2',
      approvalGeneration: 1,
    });
    expect(plo4.verdict(receipt, P10_TEST_NOW)).toBe('usable');
    // A Phase 8 holder (NLH continuation) refuses a PLO4 receipt and vice versa.
    const nlh = new HorseQualifiedAuthorityHolder('p103-holder');
    nlh.apply(qualifiedPhase10TestAdmission(1));
    expect(nlh.verdict(nlh.receipt(), P10_TEST_NOW)).toBe('mismatched');
    const crossed = new HorseQualifiedAuthorityHolder('p103-crossed', PLO4_POLICY_PACK.version);
    crossed.apply(qualifiedTestAdmission(1));
    expect(crossed.verdict(crossed.receipt(), P10_TEST_NOW)).toBe('mismatched');
  });

  it('the gate reports withdrawal, stale generation, restart and refresh failure by the Phase 8 law', () => {
    let admission = qualifiedPhase10TestAdmission(5);
    const gate = new HorsePhase8AuthorityGate(
      () => admission,
      'p103-main',
      PLO4_POLICY_PACK.version
    );
    gate.refresh();
    const worker = new HorseQualifiedAuthorityHolder('p103-worker', PLO4_POLICY_PACK.version);
    worker.apply(qualifiedPhase10TestAdmission(5));
    gate.observeWorker(worker.receipt());
    const stamped = gate.stamp(worker.receipt());
    expect(gate.check(stamped, P10_TEST_NOW)).toBe('usable');
    admission = { status: 'refused', reason: 'unreadable_evidence', transient: true };
    gate.refresh();
    expect(gate.check(stamped, P10_TEST_NOW)).toBe('refresh_failed');
    admission = qualifiedPhase10TestAdmission(5);
    gate.refresh();
    expect(gate.check(stamped, P10_TEST_NOW)).toBe('stale_generation');
    const fresh = gate.stamp(worker.receipt());
    expect(gate.check(fresh, P10_TEST_NOW)).toBe('usable');
    gate.forgetWorker(worker.epoch);
    expect(gate.check(fresh, P10_TEST_NOW)).toBe('restarted');
    gate.observeWorker(worker.receipt());
    gate.withdraw('controller_fallback_candidate');
    expect(gate.check(gate.stamp(worker.receipt()), P10_TEST_NOW)).toBe('withdrawn');
    // Re-admitting the withdrawn approval is not a renewal.
    gate.refresh();
    expect(gate.mainState()).toBe('withdrawn');
  });

  it.each([
    ['cash', 'usable', undefined, 'candidate'],
    ['cash', 'unselected', undefined, 'shadow'],
    ['cash', 'refused', undefined, 'shadow'],
    ['cash', 'withdrawn', undefined, 'shadow'],
    ['cash', 'usable', 'off', 'off'],
    ['tournament', 'usable', undefined, 'shadow'],
    ['tournament', 'usable', 'shadow', 'shadow'],
    [undefined, 'usable', undefined, 'shadow'],
  ] as const)(
    'a %s decision with %s authority and caller %s runs the pack in %s mode',
    (gameMode, verdict, callerMode, expected) => {
      expect(horsePhase10AdmittedMode({ gameMode, verdict, callerMode })).toBe(expected);
    }
  );
});

describe('P10 audit F1: Phase 10 authority is bound to the running code', () => {
  const serverFile = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

  it('the running policy digest is the versioned hash of exactly the PLO4 candidate code', () => {
    expect(HORSE_PHASE10_POLICY_DIGEST_DEFINITION).toBe('horse-phase10-policy-digest-v2');
    expect(HORSE_PHASE10_POLICY_SOURCE_FILES).toEqual([
      'src/engine/plo4/Plo4PolicyPack.ts',
      'src/engine/plo4/Plo4LivePolicy.ts',
      'src/engine/HorseLogic.ts',
      'src/engine/HorsePolicyRegistry.ts',
      'src/engine/HorseEval.ts',
      'src/engine/omaha/OmahaCardFacts.ts',
      'src/engine/PokerEngine.ts',
      'src/engine/multiway/DealtSeatCensus.ts',
      'src/engine/HorseObservationWindow.ts',
      'src/engine/HorseTournamentUtilityEvidence.ts',
      'src/engine/HorseMind.ts',
    ]);
    // Independent recomputation from the files on disk.
    const hash = createHash('sha256').update(
      `horse-phase10-policy-digest-v2\0${PLO4_POLICY_PACK.version}\0`
    );
    for (const file of HORSE_PHASE10_POLICY_SOURCE_FILES)
      hash
        .update(`${file}\0`)
        .update(readFileSync(serverFile(file)))
        .update('\0');
    expect(horsePhase10PolicyDigest()).toBe(hash.digest('hex'));
    expect(horsePhase10PolicyDigestOf(runningPolicySourceReader)).toBe(horsePhase10PolicyDigest());
  });

  it('any byte change in any hashed file is another digest; an unreadable file is none', () => {
    const running = horsePhase10PolicyDigest();
    const seen = new Set([running]);
    for (const changed of HORSE_PHASE10_POLICY_SOURCE_FILES) {
      const digest = horsePhase10PolicyDigestOf((path) =>
        path === changed
          ? Buffer.concat([runningPolicySourceReader(path), Buffer.from(' ')])
          : runningPolicySourceReader(path)
      );
      expect(digest, changed).toMatch(/^[0-9a-f]{64}$/);
      seen.add(digest);
    }
    expect(seen.size).toBe(HORSE_PHASE10_POLICY_SOURCE_FILES.length + 1);
    expect(
      horsePhase10PolicyDigestOf((path) => {
        if (path.endsWith('HorseLogic.ts')) throw Object.assign(Error('gone'), { code: 'ENOENT' });
        return runningPolicySourceReader(path);
      })
    ).toBeNull();
  });

  it('the release path admits a qualified file only for the running policy digest, refusing others by name', () => {
    const q = p10QualificationBytes();
    const release = (bytes: Buffer, runningPolicyDigest?: string | null): HorseAuthorityAdmission =>
      admitHorsePhase10ReleaseAuthority(
        P10_TEST_NOW,
        p10Selection(bytes),
        p10Reader(bytes),
        P10_TEST_CONTRACT_DIGEST,
        runningPolicyDigest
      );
    const admitted = selectedHorsePhase10Authority(release(q));
    expect(admitted?.policyDigest).toBe(horsePhase10PolicyDigest());
    for (const [label, bytes] of [
      ['another policy digest', p10QualificationBytes({ policyDigest: 'd'.repeat(64) })],
      ['no digest definition', p10QualificationBytes({ policyDigestDefinition: undefined })],
      [
        'the v1 digest definition',
        p10QualificationBytes({ policyDigestDefinition: 'horse-phase10-policy-digest-v1' }),
      ],
    ] as const)
      expect(release(bytes), label).toEqual({
        status: 'refused',
        reason: 'policy_digest_mismatch',
        transient: false,
      });
    // Running code that differs from the measured code: refused, not admitted.
    expect(release(q, 'e'.repeat(64))).toMatchObject({ reason: 'policy_digest_mismatch' });
    expect(release(q, null)).toMatchObject({ reason: 'policy_digest_unavailable' });
    expect(release(q, 'not-a-digest')).toMatchObject({ reason: 'policy_digest_unavailable' });
  });

  it('the 2026-10-03 strength qualification stays historical: refused as committed and refused by digest if relabelled', () => {
    const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
    const qualificationPath = 'docs/evidence/phase10/phase10-qualification-2026-10-03.json';
    const committed = readFileSync(repo(qualificationPath));
    const file = JSON.parse(committed.toString('utf8'));
    // Measured under the round 1 contract digest; round 3 moved the digest
    // through the pack version, so the file is historical twice over.
    expect(file).toMatchObject({
      qualified: false,
      contractDigest: 'ebdbdbb48336c0425df735fa073a4a28ef4884c199a69006e27909a6bc2b6384',
    });
    expect(file.contractDigest).not.toBe(P10_TEST_CONTRACT_DIGEST);
    expect(file).not.toHaveProperty('policyDigestDefinition');
    const strength = readFileSync(repo(file.evidencePath));
    const selectionFor = (bytes: Buffer) =>
      p10Selection(bytes, {
        sourceSha: file.sourceSha,
        qualificationPath,
        issuedAt: '2026-10-03T12:00:00.000Z',
      });
    const admitOver = (bytes: Buffer) =>
      admitHorsePhase10ReleaseAuthority(
        P10_TEST_NOW,
        selectionFor(bytes),
        memoryReader({ [qualificationPath]: bytes, [file.evidencePath]: strength })
      );
    expect(admitOver(committed)).toMatchObject({ status: 'refused', reason: 'not_qualified' });
    // Shape-only relabel, in memory: its contract and policy are not the
    // running code's.
    const relabelled = Buffer.from(
      JSON.stringify({
        ...file,
        qualified: true,
        objectives: { ...file.objectives, cash: { qualified: true, status: 'measured' } },
      })
    );
    expect(admitOver(relabelled)).toEqual({
      status: 'refused',
      reason: 'contract_digest_mismatch',
      transient: false,
    });
  });
});
