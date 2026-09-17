/** PREPARED, UNEXECUTED synthetic integration laws; no production source/key. */
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  authoritySigningBytes,
  verifyCorrectiveAuthority,
} from '../../../services/horseCorrectiveReview/authority.js';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rosterFixture, sync, syntheticAuthority, HAND_KEY } from './fixture.test-support.mjs';
import { createUnsignedAcceptedCommitmentExport } from '../../../services/horseAcceptedRoster/exporter.js';
import type {
  AcceptedSourceRequest,
  UnsignedAcceptedExport,
} from '../../../services/horseAcceptedRoster/contract.js';
import { reviewHorseCorrectiveHand as candidate } from '../../../services/horseCorrectiveReview/review.js';
import { runHorseCorrectiveReview } from '../../../scripts/horseCorrectiveReview.js';
import {
  correctiveFixture,
  authorize,
  TRUSTED_KEY_DIGEST,
} from '../../../services/horseCorrectiveReview/fixture.test-support.js';
import { journalHash, horseJournalJson } from '../../../services/horseDecisionJournal/record.js';
import { HorseDecisionJournalStore } from '../../../services/horseDecisionJournal/store.js';
import type { CorrectiveHandReview } from '../../../services/horseCorrectiveReview/contract.js';
const safe = (r: CorrectiveHandReview) => {
  for (const k of [
    'completePopulation',
    'replayVerified',
    'gtoVerified',
    'activationAllowed',
  ] as const)
    expect(r[k]).toBe(false);
  for (const a of r.actors)
    for (const d of a.decisions) if (d.candidate) expect(d.candidate.activationAllowed).toBe(false);
};
function unsigned(input: AcceptedSourceRequest): UnsignedAcceptedExport {
  const exported = createUnsignedAcceptedCommitmentExport(input);
  expect(exported.sourceExport.status).toBe('unsigned_export');
  if (!('commitments' in exported)) throw new Error('synthetic export unavailable');
  return exported;
}
function prepare(change: (x: ReturnType<typeof rosterFixture>) => void = () => {}) {
  const x = rosterFixture();
  change(x);
  sync(x);
  x.input.records = [x.f.records[0]!, x.f.records[1]!, x.input.records[0]!];
  const exported = unsigned(x.input);
  const reference = structuredClone(x.f.reference);
  reference.binding.acceptedHandDigest = x.input.acceptedHandRecordDigest;
  const a = authorize(exported.commitments, [reference]);
  const roster = syntheticAuthority(exported);
  const input = {
    records: x.input.records,
    handKey: HAND_KEY,
    commitments: exported.commitments,
    references: [reference],
    authority: a.authority,
    rosterSource: { version: 1 as const, rows: x.input.rows, authorityEnvelope: roster.envelope },
  };
  return { x, exported, reference, a, roster, input, options: { rosterTrust: roster.trust } };
}
describe('prepared private roster v2 core integration', () => {
  it('joins v2 monetary evidence to the unchanged original qualified-menu finding', () => {
    const x = prepare(),
      r = candidate(x.input, x.options);
    expect(r.version).toBe('horse-corrective-review-v2-roster');
    expect(r.status).toBe('reviewed');
    expect(r.rosterAudit?.status).toBe('qualified_monetary_eligibility');
    expect(r.evidenceClass).toBe('synthetic_fixture');
    expect(r.actors[0]!.decisions[0]!.disposition).toBe('finding');
    expect(r.actors[0]!.decisions[0]!.candidate?.conservativeGain).toBe(1);
    expect(r.requestLifecycleVerified).toBe(false);
    safe(r);
  });
  for (const missing of [
    'source',
    'source_signature',
    'source_key',
    'source_producer',
    'reference_authority',
    'reference_pin',
  ])
    it(`keeps ${missing} pending without cross-authorizing domains`, () => {
      const x = prepare();
      if (missing === 'source') x.input.rosterSource = undefined as never;
      if (missing === 'source_signature')
        x.input.rosterSource.authorityEnvelope.signature = 'A'.repeat(88);
      if (missing === 'source_key') x.options.rosterTrust.publicKeyDigest = '0'.repeat(64);
      if (missing === 'source_producer')
        x.options.rosterTrust.producerSourceDigest = '0'.repeat(64);
      if (missing === 'reference_authority') x.input.authority = undefined as never;
      if (missing === 'reference_pin') x.input.authority = authorize(null, [x.reference]).authority;
      const r = candidate(x.input, x.options);
      expect(r.status).toBe('incomplete');
      expect(r.actors.flatMap((a) => a.decisions).every((d) => d.candidate === null)).toBe(true);
      safe(r);
    });
  it('records a qualified money census when reference evidence is absent', () => {
    const x = prepare();
    x.input.references = [];
    const r = candidate(x.input, x.options);
    expect(r.rosterAudit?.status).toBe('qualified_monetary_eligibility');
    expect(r.actors[0]!.eligibility).toBe('over_10bb');
    expect(r.status).toBe('incomplete');
    expect(r.actors[0]!.decisions[0]!.reason).toBe('matching_reference_missing');
    safe(r);
  });
  for (const flaw of ['noncausal', 'wrong_input', 'illegal_alternative', 'uncertainty'])
    it(`preserves original reference refusal ${flaw}`, () => {
      const x = prepare();
      if (flaw === 'noncausal') x.reference.causal = false as never;
      if (flaw === 'wrong_input') x.reference.binding.inputDigest = '0'.repeat(64);
      if (flaw === 'illegal_alternative') x.reference.alternatives[0]!.choice.amount = 5;
      if (flaw === 'uncertainty') x.reference.uncertainty.familyWiseConfidence = 0.5;
      x.input.authority = authorize(x.exported.commitments, [x.reference]).authority;
      const r = candidate(x.input, x.options);
      expect(r.status).toBe('incomplete');
      expect(r.actors[0]!.decisions[0]!.candidate).toBe(null);
      expect(r.rejectedReferences.length).toBe(1);
      safe(r);
    });
  for (const kind of ['post', null])
    it(`includes ${kind ?? 'silent'} >10BB actor but never manufactures a decision`, () => {
      const x = prepare((v) => {
        const other = v.roster.actors.find((a) => a.userId !== v.f.hero.user_id)!;
        other.classification = 'horse';
        v.hand.actions = v.hand.actions.filter((a) => a.userId !== other.userId);
        if (kind)
          v.hand.actions.push({
            seat: other.seat,
            userId: other.userId,
            action: kind,
            amount: 21,
            stage: 'preflop',
            timestamp: 1,
          });
      });
      const r = candidate(x.input, x.options),
        id = x.x.roster.actors.find((a) => a.userId !== x.x.f.hero.user_id)!.userId;
      const actor = r.actors.find((a) => a.actorRef === journalHash(id))!;
      expect(actor.eligibility).toBe('over_10bb');
      expect(actor.decisions).toEqual([]);
      expect(actor.retainedActivity).toContain(kind ? 'forced_only_observed' : 'silent_actor');
      expect(r.status).toBe('incomplete');
      expect(r.reasons).toContain('eligible_actor_decisions_missing');
      safe(r);
    });
  it('unknown roster identity keeps final review and discretionary comparisons pending', () => {
    const x = prepare((v) => {
      const a = v.roster.actors.find((a) => a.userId !== v.f.hero.user_id)!;
      a.classification = 'unknown';
      a.status = 'profile_missing';
    });
    const r = candidate(x.input, x.options);
    expect(r.rosterAudit?.status).toBe('partial_unknown');
    expect(r.status).toBe('incomplete');
    expect(r.rosterAudit?.unknownActorRefs).toHaveLength(1);
    expect(r.actors[0]!.eligibility).toBe('over_10bb');
    expect(r.actors[0]!.decisions[0]!.reason).toBe('accepted_roster_classification_partial');
    expect(r.actors[0]!.decisions[0]!.candidate).toBeNull();
    safe(r);
  });
  it('does not accept caller-modified v2 actor set even with a valid source envelope', () => {
    const x = prepare();
    x.input.commitments = structuredClone(x.input.commitments);
    x.input.commitments.horseActorIds = [];
    const r = candidate(x.input, x.options);
    expect(r.status).toBe('incomplete');
    expect(r.reasons).toContain('accepted_roster_export_mismatch');
    safe(r);
  });
  it('requires exact accepted-hand pin and retains reference rejection identity', () => {
    const x = prepare();
    x.input.commitments = structuredClone(x.input.commitments);
    x.input.commitments.acceptedHandRecordDigest = '0'.repeat(64);
    const r = candidate(x.input, x.options);
    expect(r.status).toBe('incomplete');
    expect(r.rejectedReferences[0]!.referenceId).toHaveLength(64);
    safe(r);
  });
  it('missing execution never produces a finding despite qualified monetary/source/reference signatures', () => {
    const x = prepare();
    x.input.records = x.input.records.filter((r) => r.kind !== 'execution');
    const exported = unsigned({ ...x.x.input, records: x.input.records });
    x.input.commitments = exported.commitments;
    const signed = syntheticAuthority(exported);
    x.input.rosterSource.authorityEnvelope = signed.envelope;
    x.options.rosterTrust = signed.trust;
    x.input.authority = authorize(exported.commitments, [x.reference]).authority;
    const r = candidate(x.input, x.options);
    expect(r.status).toBe('incomplete');
    expect(r.actors[0]!.decisions[0]!.candidate).toBeNull();
    safe(r);
  });
  for (const pair of [
    'synthetic_source_real_labelled_reference',
    'real_labelled_source_synthetic_reference',
  ])
    it(`rejects mixed authority class ${pair}`, () => {
      const x = prepare();
      if (pair === 'synthetic_source_real_labelled_reference') {
        // Still wholly synthetic keys/input. The real-labelled metadata is an
        // intentional negative fixture and must not result in real-history claims.
        const keys = generateKeyPairSync('ed25519');
        const authority = { ...x.input.authority, evidenceClass: 'reviewed_reference' as const };
        x.input.authority = verifyCorrectiveAuthority(
          {
            authority,
            publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
            signature: sign(null, authoritySigningBytes(authority), keys.privateKey).toString(
              'base64'
            ),
          },
          journalHash(keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'))
        )!;
      } else {
        const signed = syntheticAuthority(x.exported, (a) => {
          a.evidenceClass = 'reviewed_source';
        });
        x.input.rosterSource.authorityEnvelope = signed.envelope;
        x.options.rosterTrust = signed.trust;
      }
      const r = candidate(x.input, x.options);
      expect(r.status).toBe('incomplete');
      expect(r.evidenceClass).toBe('synthetic_fixture');
      expect(r.reasons).toContain('roster_reference_evidence_class_mismatch');
      expect(r.actors.flatMap((a) => a.decisions).every((d) => d.candidate === null)).toBe(true);
      safe(r);
    });
  it('review identity binds v2 roster authority changes', () => {
    const x = prepare(),
      first = candidate(x.input, x.options);
    x.input.rosterSource.authorityEnvelope.signature = 'A'.repeat(88);
    const second = candidate(x.input, x.options);
    expect(first.reviewId).not.toBe(second.reviewId);
    expect(second.status).toBe('incomplete');
  });
  it('private actual-store CLI reaches v2 census path but cannot self-qualify from files', () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'horse-core-roster-synthetic-')));
    try {
      chmodSync(directory, 0o700);
      const journal = join(directory, 'journal');
      mkdirSync(journal, { mode: 0o700 });
      const x = prepare();
      const store = new HorseDecisionJournalStore(journal);
      store.appendBatch(x.input.records);
      store.close();
      const path = join(directory, 'input.json'),
        output = join(directory, 'output.json');
      writeFileSync(
        path,
        JSON.stringify({
          version: 2,
          commitments: x.input.commitments,
          references: x.input.references,
          rosterSource: x.input.rosterSource,
        }),
        { mode: 0o600 }
      );
      const r = runHorseCorrectiveReview([journal, HAND_KEY, path, output]);
      expect(r.code).toBe(2);
      expect(r.output).not.toMatch(/payloadText|20000000|SYNTHETIC_PRIVATE_NAME/);
      expect(statSync(output).mode & 0o077).toBe(0);
      const persisted = JSON.parse(readFileSync(output, 'utf8'));
      expect(persisted.version).toBe('horse-corrective-review-v2-roster');
      expect(persisted.rosterAudit.status).toBe('pending');
      expect(runHorseCorrectiveReview([journal, HAND_KEY, path, output]).code).toBe(3);
      safe(persisted);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
