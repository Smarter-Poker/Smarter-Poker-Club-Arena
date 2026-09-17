/** PREPARED / UNEXECUTED. All rows and keys below are SYNTHETIC.
 * The success fixture deliberately exercises the reviewed_source wire label
 * using a disposable, independently pinned test key. That label is NOT a claim
 * of real source evidence. Production allowSynthetic:false stays unchanged.
 * No database producer, live profile, network, scheduler or policy is used. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, statSync, readdirSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rosterFixture, sync, syntheticAuthority, HAND_KEY } from './fixture.test-support.mjs';
import { createUnsignedAcceptedCommitmentExport } from '../../../services/horseAcceptedRoster/exporter.ts';
import { runHorseCorrectiveReview } from '../../../scripts/horseCorrectiveReview.ts';
import { HorseDecisionJournalStore } from '../../../services/horseDecisionJournal/store.ts';
const dirs = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, {recursive:true, force:true});
});
function setup(change = () => {}, evidenceClass = 'reviewed_source', retainedHorseWork = false) {
  const x = rosterFixture();
  for (const actor of x.roster.actors) { actor.classification = 'human'; actor.status = 'canonical_boolean'; }
  x.hand.actions = x.hand.actions.map(a => ({...a, origin:'player'}));
  change(x); sync(x);
  if (retainedHorseWork) x.input.records = [x.f.records[0], ...x.input.records];
  const exported = createUnsignedAcceptedCommitmentExport(x.input);
  expect(exported.sourceExport.status).toBe('unsigned_export');
  const signed = syntheticAuthority(exported, authority => { authority.evidenceClass = evidenceClass; });
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'horse-synthetic-empty-cli-'));
  dirs.push(dir);
  const journal = join(dir, 'journal'), inputPath = join(dir, 'input.json'), outputPath = join(dir, 'review.json');
  const store = new HorseDecisionJournalStore(journal);
  try { store.appendBatch(x.input.records); } finally { store.close(); }
  const input = {version:2, commitments:exported.commitments, references:[],
    rosterSource:{version:1, rows:x.input.rows, authorityEnvelope:signed.envelope}};
  writeFileSync(inputPath, JSON.stringify(input), {mode:0o600});
  // Test owner configuration is deliberately separate from the untrusted JSON.
  vi.stubEnv('HORSE_ROSTER_REVIEW_TRUSTED_KEY_SHA256', signed.trust.publicKeyDigest);
  vi.stubEnv('HORSE_ROSTER_REVIEW_PRODUCER_SHA256', signed.trust.producerSourceDigest);
  vi.stubEnv('HORSE_CORRECTIVE_REVIEW_TRUSTED_KEY_SHA256', '');
  return {x, signed, dir, journal, input, inputPath, outputPath,
    args:[journal, HAND_KEY, inputPath, outputPath]};
}
function report(s) { return JSON.parse(readFileSync(s.outputPath, 'utf8')); }
function noClaims(r) {
  for (const k of ['completePopulation','replayVerified','gtoVerified','activationAllowed']) expect(r[k]).toBe(false);
  expect(r.requestLifecycleVerified).toBe(false);
  expect(r.actors.flatMap(a => a.decisions).every(d => d.candidate === null)).toBe(true);
  expect(r.rosterAudit.sourcePopulationVerified).toBe(false);
}
function rewrite(s) { writeFileSync(s.inputPath, JSON.stringify(s.input), {mode:0o600}); }
describe('prepared actual private-store known-empty CLI contract', () => {
  it('returns code0 and only the single-hand monetary census scope for independently pinned synthetic test authority', () => {
    const s = setup(), original = readFileSync(s.inputPath);
    const response = runHorseCorrectiveReview(s.args);
    expect(response.code).toBe(0);
    expect(JSON.parse(response.output)).toEqual({status:'known_empty_census',
      scope:'single_retained_hand_monetary_census', reviewId:report(s).reviewId,
      outputWritten:true, gtoVerified:false, activationAllowed:false});
    const r = report(s); expect(r.status).toBe('known_empty_census'); expect(r.actors).toEqual([]);
    expect(r.reasons).toContain('known_empty_horse_census');
    expect(r.reasons).not.toContain('horse_population_unavailable'); noClaims(r);
    expect(readFileSync(s.inputPath)).toEqual(original);
  });
  it('writes one private owned output and redacts cards, names, actors and authority from stdout', () => {
    const s = setup(), response = runHorseCorrectiveReview(s.args);
    expect(response.code).toBe(0); expect(statSync(s.outputPath).mode & 0o777).toBe(0o600);
    expect(statSync(s.outputPath).nlink).toBe(1);
    for (const secret of ['SYNTHETIC_PRIVATE_NAME', s.x.f.hero.user_id, 'payloadText', 'publicKeyPem', 'signature', 'spades', 'As', s.inputPath])
      expect(response.output).not.toContain(secret);
    expect(readdirSync(s.dir).some(name => name.endsWith('.tmp'))).toBe(false); noClaims(report(s));
  });
  it('does not alter the retained journal while reading a known empty census', () => {
    const s = setup(); expect(runHorseCorrectiveReview(s.args).code).toBe(0);
    const reader = new HorseDecisionJournalStore(s.journal, {readOnly:true});
    try { expect(reader.readHand(HAND_KEY)).toEqual(s.x.input.records); } finally { reader.close(); }
    noClaims(report(s));
  });
  it('refuses an existing known-empty report without replacing its bytes', () => {
    const s = setup(); expect(runHorseCorrectiveReview(s.args).code).toBe(0);
    const before = readFileSync(s.outputPath);
    expect(runHorseCorrectiveReview(s.args).code).toBe(3); expect(readFileSync(s.outputPath)).toEqual(before);
    expect(readdirSync(s.dir).some(name => name.endsWith('.tmp'))).toBe(false);
  });
  it('rejects a symlink output without modifying its private target', () => {
    const s = setup(), original = readFileSync(s.inputPath); symlinkSync(s.inputPath, s.outputPath);
    expect(runHorseCorrectiveReview(s.args).code).toBe(3); expect(readFileSync(s.inputPath)).toEqual(original);
  });
  it('rejects shared input permissions before producing a census', () => {
    const s = setup(); chmodSync(s.inputPath, 0o644);
    expect(runHorseCorrectiveReview(s.args).code).toBe(3); expect(readdirSync(s.dir)).not.toContain('review.json');
  });
  it('does not trust a public-key pin copied into the input when independent configuration is absent', () => {
    const s = setup(); s.input.trust = s.signed.trust; rewrite(s);
    vi.stubEnv('HORSE_ROSTER_REVIEW_TRUSTED_KEY_SHA256', '');
    expect(runHorseCorrectiveReview(s.args).code).toBe(2); expect(report(s).status).toBe('incomplete'); noClaims(report(s));
  });
  it('rejects an independently configured but different producer source', () => {
    const s = setup(); vi.stubEnv('HORSE_ROSTER_REVIEW_PRODUCER_SHA256', '0'.repeat(64));
    expect(runHorseCorrectiveReview(s.args).code).toBe(2); expect(report(s).status).toBe('incomplete'); noClaims(report(s));
  });
  it('keeps the production CLI synthetic_fixture admission disabled', () => {
    const s = setup(() => {}, 'synthetic_fixture');
    expect(runHorseCorrectiveReview(s.args).code).toBe(2); expect(report(s).status).toBe('incomplete'); noClaims(report(s));
  });
  it('distinguishes no known Horses plus an unknown accepted actor from a known empty census', () => {
    const s = setup(x => { x.roster.actors[0].classification = 'unknown'; x.roster.actors[0].status = 'profile_missing'; });
    expect(runHorseCorrectiveReview(s.args).code).toBe(2); const r = report(s);
    expect(r.status).toBe('incomplete'); expect(r.rosterAudit.status).toBe('partial_unknown');
    expect(r.rosterAudit.unknownActorRefs).toHaveLength(1); noClaims(r);
  });
  it('does not infer an empty census when the v2 source is missing', () => {
    const s = setup(); delete s.input.rosterSource; rewrite(s);
    expect(runHorseCorrectiveReview(s.args).code).toBe(2); expect(report(s).status).toBe('incomplete'); noClaims(report(s));
  });
  it('preserves a zero-commitment Horse as an actor instead of an empty census', () => {
    const s = setup(x => {
      x.roster.actors.find(a => a.userId === x.f.hero.user_id).classification = 'horse'; x.hand.actions = [];
      for (const id of Object.keys(x.payload.accepted_hand_facts.contributions)) x.payload.accepted_hand_facts.contributions[id] = 0;
      x.payload.accepted_hand_facts.returned_uncalled = {};
      for (const stack of x.stacks) { stack.stack = stack.stack_before; x.receipt.written[stack.user_id] = stack.stack; }
    });
    const response = runHorseCorrectiveReview(s.args); expect(response.code).toBe(0);
    const r = report(s); expect(r.status).toBe('reviewed'); expect(r.status).not.toBe('known_empty_census'); expect(r.actors).toHaveLength(1);
    expect(r.actors[0].grossCommittedBb).toBe(0); expect(r.actors[0].eligibility).toBe('not_over_10bb');
    expect(JSON.parse(response.output)).not.toHaveProperty('scope'); noClaims(r);
  });
  it('refuses a complete all-human label contradicted by retained Horse work', () => {
    const s = setup(() => {}, 'reviewed_source', true);
    expect(runHorseCorrectiveReview(s.args).code).toBe(2); const r = report(s);
    expect(r.reasons).toContain('known_empty_roster_conflicts_with_retained_horse_work');
    expect(r.status).toBe('incomplete'); noClaims(r);
  });
  it('reports an actionless all-human census while leaving request lifecycle unverified', () => {
    const s = setup(x => { x.hand.actions = []; });
    expect(runHorseCorrectiveReview(s.args).code).toBe(0); const r = report(s);
    expect(r.status).toBe('known_empty_census'); expect(r.requestLifecycleVerified).toBe(false);
    expect(r.reasons).toContain('discretionary_horse_review_not_applicable'); noClaims(r);
  });
});
