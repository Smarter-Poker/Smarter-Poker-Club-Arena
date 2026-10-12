import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  admitHorsePhase14QualifiedAuthority,
  admitHorsePhase14ReleaseAuthority,
  HORSE_PHASE14_CATALOG_VERSION,
  HORSE_PHASE14_DOMAINS,
  HORSE_PHASE14_QUALIFICATION_SCHEMA,
  horsePhase14ContinuationVersion,
  horsePhase14CorrectiveMode,
  liveHorsePhase14Authorities,
  PHASE14_PROTECTED_RELEASE_SELECTIONS,
  selectedHorsePhase14Authority,
} from './HorsePhase14Authority.js';
import {
  HorsePhase8AuthorityGate,
  HorseQualifiedAuthorityHolder,
  type HorseAuthorityAdmission,
  type HorseAuthorityEvidenceReader,
  type HorseAuthorityVerdict,
} from './HorseQualifiedAuthority.js';
import { memoryReader } from './HorseQualifiedAuthority.test-support.js';
import {
  P14_TEST_CATALOG_DIGEST,
  P14_TEST_HOLDOUT_DIGEST,
  P14_TEST_NOW,
  p14QualificationBytes,
  p14QualificationPath,
  p14Reader,
  p14Selection,
  qualifiedPhase14TestAdmission,
} from './HorsePhase14Authority.test-support.js';
import { CORRECTIVE_CATALOG_VERSION } from '../services/horseCorrectiveReview/candidateCatalog.js';
import {
  CORRECTIVE_DOMAINS,
  correctiveDomainKey,
} from '../services/horseCorrectiveReview/domain.js';
import { KNOWN_VARIANTS } from './VariantRules.js';

const D = 'nlh-cash';
const OTHER = 'plo4-mtt';
const NOW = P14_TEST_NOW;

describe('P14.4 null proof: no corrective candidate can be admitted today', () => {
  it('names exactly the 45 corrective domains and every committed selection is null', () => {
    expect(HORSE_PHASE14_DOMAINS).toHaveLength(KNOWN_VARIANTS.length * 5);
    expect([...HORSE_PHASE14_DOMAINS]).toEqual(CORRECTIVE_DOMAINS.map(correctiveDomainKey));
    expect(HORSE_PHASE14_CATALOG_VERSION).toBe(CORRECTIVE_CATALOG_VERSION);
    expect(Object.keys(PHASE14_PROTECTED_RELEASE_SELECTIONS).sort()).toEqual(
      [...HORSE_PHASE14_DOMAINS].sort()
    );
    expect(Object.values(PHASE14_PROTECTED_RELEASE_SELECTIONS).every((s) => s === null)).toBe(true);
    expect(Object.isFrozen(PHASE14_PROTECTED_RELEASE_SELECTIONS)).toBe(true);
    for (const domain of HORSE_PHASE14_DOMAINS) {
      const release = admitHorsePhase14ReleaseAuthority(domain, NOW);
      expect(release, domain).toEqual({
        status: 'refused',
        reason: 'unselected',
        transient: false,
      });
      expect(selectedHorsePhase14Authority(domain, release)).toBeNull();
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
    for (const domain of HORSE_PHASE14_DOMAINS) {
      expect(admitHorsePhase14ReleaseAuthority(domain, NOW, undefined, tripwire)).toEqual({
        status: 'refused',
        reason: 'unselected',
        transient: false,
      });
      expect(admitHorsePhase14QualifiedAuthority(domain, null, tripwire, NOW)).toEqual({
        status: 'refused',
        reason: 'unselected',
        transient: false,
      });
    }
    // An unknown domain has no selection either, and reads nothing.
    expect(admitHorsePhase14ReleaseAuthority('razz-cash', NOW, undefined, tripwire)).toEqual({
      status: 'refused',
      reason: 'unselected',
      transient: false,
    });
    expect(reads).toEqual([]);
  });

  it('every live main-scheduler gate is unselected and accepts no receipt, even from a usable worker', () => {
    for (const domain of HORSE_PHASE14_DOMAINS) {
      const gate = liveHorsePhase14Authorities[domain]!;
      gate.refresh();
      expect(gate.mainState(), domain).toBe('unselected');
      const worker = new HorseQualifiedAuthorityHolder(
        `p144-null-${domain}`,
        horsePhase14ContinuationVersion(domain)
      );
      worker.apply(qualifiedPhase14TestAdmission(domain));
      expect(worker.currentState()).toBe('usable');
      gate.observeWorker(worker.receipt());
      expect(gate.check(gate.stamp(worker.receipt()), NOW), domain).toBe('unselected');
      gate.forgetWorker(worker.epoch);
    }
  });

  it('no Phase 14 qualification is committed, so none can say qualified:true', () => {
    const dir = fileURLToPath(new URL('../../../docs/evidence/phase14/', import.meta.url));
    const files = existsSync(dir)
      ? readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.json'))
      : [];
    for (const file of files) {
      const parsed = JSON.parse(readFileSync(`${dir}${file}`, 'utf8')) as Record<string, unknown>;
      if (parsed.schema === HORSE_PHASE14_QUALIFICATION_SCHEMA)
        expect(parsed.qualified, file).not.toBe(true);
    }
  });

  it('no live engine path imports the Phase 14 authority (there is no corrective applier)', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const importers = (readdirSync(root, { recursive: true, encoding: 'utf8' }) as string[])
      .filter((f) => f.endsWith('.ts') && !f.includes('.test') && !f.includes('test-support'))
      .filter((f) =>
        /\bfrom\s+['"][^'"]*HorsePhase14Authority(\.js)?['"]|import\(\s*['"][^'"]*HorsePhase14Authority/.test(
          readFileSync(`${root}${f}`, 'utf8')
        )
      );
    expect(importers).toEqual([]);
  });
});

describe('P14.4 admission refuses by name', () => {
  const bytes = p14QualificationBytes(D);
  const reader = p14Reader(D, bytes);

  it('admits an exact qualified selection as an immutable record bound to the catalog and holdout', () => {
    const admission = admitHorsePhase14QualifiedAuthority(D, p14Selection(D, bytes), reader, NOW);
    expect(admission.status).toBe('admitted');
    if (admission.status !== 'admitted') return;
    const a = admission.authority;
    expect(Object.isFrozen(a)).toBe(true);
    expect(a).toMatchObject({
      phase: 'phase14',
      domain: D,
      continuationVersion: horsePhase14ContinuationVersion(D),
      catalogDigest: P14_TEST_CATALOG_DIGEST,
      holdoutDigest: P14_TEST_HOLDOUT_DIGEST,
      policyDigest: P14_TEST_CATALOG_DIGEST,
    });
    expect(a.authorityKey).toMatch(/^[0-9a-f]{64}$/);
    expect(selectedHorsePhase14Authority(D, admission)).toBe(a);
    expect(selectedHorsePhase14Authority(OTHER, admission)).toBeNull();
    // A new generation, or another holdout, is another identity.
    const renewed = qualifiedPhase14TestAdmission(D, 2);
    expect(renewed.status === 'admitted' && renewed.authority.authorityKey).not.toBe(
      a.authorityKey
    );
  });

  it.each([
    ['an unknown domain', (s: any): void => void (s.domain = 'razz-cash'), 'invalid_selection'],
    ['another phase', (s: any): void => void (s.phase = 'phase13'), 'invalid_selection'],
    [
      'a path outside docs/evidence/phase14',
      (s: any): void => void (s.qualificationPath = 'docs/evidence/phase13/x.json'),
      'invalid_selection',
    ],
    [
      'a traversing path',
      (s: any): void => void (s.qualificationPath = 'docs/evidence/phase14/../phase13/x.json'),
      'invalid_selection',
    ],
    [
      'a malformed catalog digest',
      (s: any): void => void (s.catalogDigest = 'abc'),
      'invalid_selection',
    ],
    [
      'a malformed holdout digest',
      (s: any): void => void (s.holdoutDigest = 'abc'),
      'invalid_selection',
    ],
    ['generation zero', (s: any): void => void (s.approvalGeneration = 0), 'invalid_selection'],
    [
      'a fractional generation',
      (s: any): void => void (s.approvalGeneration = 1.5),
      'invalid_selection',
    ],
    [
      'an expiry before issue',
      (s: any): void => void (s.expiresAt = '2026-10-19T00:00:00.000Z'),
      'invalid_selection',
    ],
    [
      'another domain than the holder',
      (s: any): void => void (s.domain = OTHER),
      'continuation_mismatch',
    ],
    [
      'another catalog version',
      (s: any): void => void (s.catalogVersion = 'horse-corrective-candidate-catalog-v0'),
      'continuation_mismatch',
    ],
    [
      'an expired selection',
      (s: any): void => void (s.expiresAt = '2026-10-20T01:00:00.000Z'),
      'expired',
    ],
    [
      'a missing qualification',
      (s: any): void => void (s.qualificationPath = 'docs/evidence/phase14/absent.json'),
      'missing_evidence',
    ],
    [
      'a differently hashed file',
      (s: any): void => void (s.qualificationSha256 = 'f'.repeat(64)),
      'hash_mismatch',
    ],
  ] as const)('refuses %s', (_label, mutate, reason) => {
    const selection = p14Selection(D, bytes) as any;
    mutate(selection);
    expect(admitHorsePhase14QualifiedAuthority(D, selection, reader, NOW)).toEqual({
      status: 'refused',
      reason,
      transient: false,
    });
  });

  it.each([
    ['an unqualified file', { qualified: false }, 'not_qualified'],
    ['a file with recorded reasons', { reasons: ['holdout_leakage'] }, 'not_qualified'],
    ['another schema', { schema: 'horse-phase13-qualification-v1' }, 'evidence_mismatch'],
    ['an extra key', { approvedBy: 'agent' }, 'evidence_mismatch'],
    ['another source', { sourceSha: 'e'.repeat(40) }, 'source_mismatch'],
    ['another domain', { domain: OTHER }, 'continuation_mismatch'],
    ['another catalog version', { catalogVersion: 'v0' }, 'continuation_mismatch'],
    ['another catalog', { catalogDigest: 'a'.repeat(64) }, 'catalog_digest_mismatch'],
    ['another holdout', { holdoutDigest: 'a'.repeat(64) }, 'holdout_digest_mismatch'],
  ] as const)('refuses %s even when the declared hash matches', (_label, overrides, reason) => {
    const file = p14QualificationBytes(D, overrides);
    expect(
      admitHorsePhase14QualifiedAuthority(D, p14Selection(D, file), p14Reader(D, file), NOW)
    ).toMatchObject({ status: 'refused', reason, transient: false });
  });

  it('refuses a file that is not JSON as evidence_mismatch', () => {
    const file = Buffer.from('not json');
    expect(
      admitHorsePhase14QualifiedAuthority(D, p14Selection(D, file), p14Reader(D, file), NOW)
    ).toMatchObject({ status: 'refused', reason: 'evidence_mismatch' });
  });

  it('separates an unreadable file (transient) from a missing one', () => {
    const eio = Object.assign(new Error('EIO'), { code: 'EIO' });
    expect(
      admitHorsePhase14QualifiedAuthority(
        D,
        p14Selection(D, bytes),
        memoryReader({ [p14QualificationPath(D)]: eio }),
        NOW
      )
    ).toEqual({ status: 'refused', reason: 'unreadable_evidence', transient: true });
  });

  it('a committed withdrawal is an explicit withdrawal, never a selection', () => {
    expect(
      admitHorsePhase14QualifiedAuthority(
        D,
        p14Selection(D, bytes, {
          approvalGeneration: 3,
          withdrawn: { at: '2026-10-20T00:30:00.000Z', reason: 'holdout_regression' },
        }),
        reader,
        NOW
      )
    ).toEqual({ status: 'withdrawn', approvalGeneration: 3, reason: 'release_holdout_regression' });
  });
});

describe('P14.4 local holder and gate laws (Phase 8 classes, one per domain)', () => {
  const holder = (epoch = 'worker') =>
    new HorseQualifiedAuthorityHolder(epoch, horsePhase14ContinuationVersion(D));

  it('null selection: the holder stays unselected and every verdict is shadow', () => {
    const h = holder();
    h.apply(admitHorsePhase14ReleaseAuthority(D, NOW));
    expect(h.currentState()).toBe('unselected');
    expect(h.current()).toBeNull();
    expect(h.verdict(h.receipt(), NOW)).toBe('unselected');
    expect(
      horsePhase14CorrectiveMode({
        callerMode: undefined,
        domain: D,
        packDomain: D,
        verdict: h.verdict(h.receipt(), NOW),
      })
    ).toEqual({
      mode: 'shadow',
      authorityUsable: false,
      activationAllowed: false,
      reason: 'unselected',
    });
  });

  it('work issued under an earlier generation is stale', () => {
    const h = holder();
    h.apply(qualifiedPhase14TestAdmission(D, 1));
    const first = h.receipt();
    expect(h.verdict(first, NOW)).toBe('usable');
    h.apply(qualifiedPhase14TestAdmission(D, 2));
    expect(h.receipt()).toMatchObject({ reason: 'renewed', approvalGeneration: 2 });
    expect(h.verdict(first, NOW)).toBe('stale_generation');
    expect(h.verdict(h.receipt(), NOW)).toBe('usable');
  });

  it('a withdrawal is sticky: the same approval is never re-admitted, from a cache or a refresh', () => {
    const h = holder();
    const cached = qualifiedPhase14TestAdmission(D, 1);
    h.apply(cached);
    const issued = h.receipt();
    h.withdraw('holdout_regression');
    expect(h.verdict(issued, NOW)).toBe('withdrawn');
    // A cached admission of the withdrawn approval is not a renewal.
    h.apply(cached);
    expect(h.currentState()).toBe('withdrawn');
    h.apply(qualifiedPhase14TestAdmission(D, 1));
    expect(h.currentState()).toBe('withdrawn');
    // A transient failure does not unstick it either.
    h.apply({ status: 'refused', reason: 'unreadable_evidence', transient: true });
    expect(h.currentState()).toBe('withdrawn');
    // A release that commits a withdrawal is withdrawn at that generation.
    const r = holder('worker-2');
    r.apply(qualifiedPhase14TestAdmission(D, 4));
    r.apply({ status: 'withdrawn', approvalGeneration: 4, reason: 'release_rollback' });
    r.apply(qualifiedPhase14TestAdmission(D, 4));
    r.apply(qualifiedPhase14TestAdmission(D, 3));
    expect(r.currentState()).toBe('withdrawn');
  });

  it('a rollback is a higher generation naming the earlier catalog, and it renews', () => {
    const earlier = 'b'.repeat(64);
    const h = holder();
    h.apply(qualifiedPhase14TestAdmission(D, 1, earlier));
    h.apply(qualifiedPhase14TestAdmission(D, 2));
    const mid = h.receipt();
    h.withdraw('candidate_regressed');
    const rollback = qualifiedPhase14TestAdmission(D, 3, earlier);
    h.apply(rollback);
    expect(h.currentState()).toBe('usable');
    expect(h.receipt()).toMatchObject({ reason: 'renewed', approvalGeneration: 3 });
    expect(h.current()?.catalogDigest).toBe(earlier);
    // The rolled-back authority is a new identity; nothing issued before is usable.
    expect(h.verdict(mid, NOW)).toBe('stale_generation');
    // Re-admitting the rollback's own generation after it too is withdrawn is refused.
    h.withdraw('second_withdrawal');
    h.apply(rollback);
    expect(h.currentState()).toBe('withdrawn');
  });

  it('a refresh failure is not a withdrawal: the same approval restores under a new generation', () => {
    const h = holder();
    h.apply(qualifiedPhase14TestAdmission(D, 1));
    const issued = h.receipt();
    h.apply({ status: 'refused', reason: 'unreadable_evidence', transient: true });
    expect(h.currentState()).toBe('refresh_failed');
    expect(h.verdict(issued, NOW)).toBe('refresh_failed');
    h.apply(qualifiedPhase14TestAdmission(D, 1));
    expect(h.receipt()).toMatchObject({ state: 'usable', reason: 'refresh_restored' });
    expect(h.verdict(issued, NOW)).toBe('stale_generation');
    // Whereas a non-transient refusal removes it.
    h.apply({ status: 'refused', reason: 'catalog_digest_mismatch', transient: false });
    expect(h.receipt()).toMatchObject({ state: 'refused', authorityKey: null });
  });

  it('expiry turns a usable authority into expired at the stated instant', () => {
    const bytes = p14QualificationBytes(D);
    const h = holder();
    h.apply(
      admitHorsePhase14QualifiedAuthority(
        D,
        p14Selection(D, bytes, { expiresAt: '2026-10-20T02:00:00.000Z' }),
        p14Reader(D, bytes),
        NOW
      )
    );
    expect(h.verdict(h.receipt(), NOW)).toBe('usable');
    expect(h.verdict(h.receipt(), Date.parse('2026-10-20T02:00:00.000Z'))).toBe('expired');
  });

  it("one domain's holder never backs another domain", () => {
    const h = holder();
    h.apply(qualifiedPhase14TestAdmission(OTHER, 1));
    // The admission is for plo4-mtt; the nlh-cash holder sees another continuation.
    expect(h.verdict(h.receipt(), NOW)).toBe('mismatched');
  });

  it('the main gate mirrors a worker withdrawal so a replacement worker cannot re-promote it', () => {
    let next: HorseAuthorityAdmission = qualifiedPhase14TestAdmission(D, 1);
    const gate = new HorsePhase8AuthorityGate(
      () => next,
      'main',
      horsePhase14ContinuationVersion(D)
    );
    gate.refresh();
    const worker = holder('worker-a');
    worker.apply(next);
    gate.observeWorker(worker.receipt());
    const receipt = gate.stamp(worker.receipt());
    expect(gate.check(receipt, NOW)).toBe('usable');
    worker.withdraw('holdout_regression');
    gate.observeWorker(worker.receipt());
    expect(gate.check(receipt, NOW)).toBe('withdrawn');
    const replacement = holder('worker-b');
    replacement.apply(qualifiedPhase14TestAdmission(D, 1));
    gate.observeWorker(replacement.receipt());
    gate.refresh();
    expect(gate.check(gate.stamp(replacement.receipt()), NOW)).toBe('withdrawn');
    // Only a renewed generation committed at release makes main usable again.
    next = qualifiedPhase14TestAdmission(D, 2);
    gate.refresh();
    expect(gate.mainState()).toBe('usable');
  });
});

describe('P14.4 a caller cannot supply candidate control', () => {
  const verdicts: HorseAuthorityVerdict[] = [
    'usable',
    'unselected',
    'refused',
    'refresh_failed',
    'withdrawn',
    'restarted',
    'stale_generation',
    'mismatched',
    'expired',
    'missing_receipt',
  ];
  it.each(['candidate', 'active', 'on', true, 1, { mode: 'candidate' }, undefined, 'shadow'])(
    'caller mode %j never yields an active mode under any verdict',
    (callerMode) => {
      for (const verdict of verdicts)
        for (const packDomain of [D, OTHER, null]) {
          const m = horsePhase14CorrectiveMode({ callerMode, domain: D, packDomain, verdict });
          expect(['shadow']).toContain(m.mode);
          expect(m.activationAllowed).toBe(false);
          expect(m.authorityUsable).toBe(verdict === 'usable' && packDomain === D);
        }
    }
  );

  it('usable authority for the deciding domain still names the missing applier', () => {
    expect(
      horsePhase14CorrectiveMode({
        callerMode: undefined,
        domain: D,
        packDomain: D,
        verdict: 'usable',
      })
    ).toEqual({
      mode: 'shadow',
      authorityUsable: true,
      activationAllowed: false,
      reason: 'corrective_applier_unavailable',
    });
  });

  it("the caller's only choice is off", () => {
    for (const verdict of verdicts)
      expect(
        horsePhase14CorrectiveMode({ callerMode: 'off', domain: D, packDomain: D, verdict })
      ).toMatchObject({ mode: 'off', authorityUsable: false, activationAllowed: false });
  });

  it('admission takes no caller input: its only inputs are the domain, the committed selection, the reader and the clock', () => {
    expect(admitHorsePhase14QualifiedAuthority.length).toBe(4);
    expect(admitHorsePhase14ReleaseAuthority.length).toBe(1);
    // A caller-built selection is still only a selection; with the committed
    // null it cannot reach the release path.
    const forged = p14Selection(D);
    expect(PHASE14_PROTECTED_RELEASE_SELECTIONS[D]).toBeNull();
    expect(admitHorsePhase14ReleaseAuthority(D, NOW)).toMatchObject({ reason: 'unselected' });
    expect(forged.domain).toBe(D);
  });
});
