import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readFileSync,
  statSync,
  symlinkSync,
  readdirSync,
  chmodSync,
  linkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HorseDecisionJournalStore } from '../horseDecisionJournal/store.js';
import { runHorseCorrectiveReview } from '../../scripts/horseCorrectiveReview.js';
import {
  correctiveFixture,
  authorize,
  HAND_KEY,
  TRUSTED_KEY_DIGEST,
} from './fixture.test-support.js';
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'horse-corrective-'));
  dirs.push(dir);
  const f = correctiveFixture(),
    journal = join(dir, 'journal'),
    source = join(dir, 'input.json'),
    authority = join(dir, 'authority.json'),
    output = join(dir, 'review.json');
  const store = new HorseDecisionJournalStore(journal);
  store.appendBatch(f.records);
  store.close();
  writeFileSync(
    source,
    JSON.stringify({ version: 1, commitments: f.commitments, references: [f.reference] }),
    { mode: 0o600 }
  );
  writeFileSync(authority, JSON.stringify(authorize(f.commitments, [f.reference]).envelope), {
    mode: 0o600,
  });
  return {
    dir,
    journal,
    source,
    authority,
    output,
    args: [journal, HAND_KEY, source, output, authority],
    f,
  };
}
describe('explicit private corrective review CLI', () => {
  it('reads the real private retained store, validates independent authority and publishes a complete private inactive report', () => {
    const s = setup(),
      before = readFileSync(s.source);
    vi.stubEnv('HORSE_CORRECTIVE_REVIEW_TRUSTED_KEY_SHA256', TRUSTED_KEY_DIGEST);
    const response = runHorseCorrectiveReview(s.args);
    expect(response.code).toBe(0);
    expect(JSON.parse(response.output)).toMatchObject({
      status: 'reviewed',
      outputWritten: true,
      gtoVerified: false,
      activationAllowed: false,
    });
    const report = JSON.parse(readFileSync(s.output, 'utf8'));
    expect(report.actors[0].decisions[0]).toMatchObject({
      disposition: 'finding',
      candidate: { status: 'proposed_inactive' },
    });
    expect(statSync(s.output).mode & 0o777).toBe(0o600);
    expect(statSync(s.output).nlink).toBe(1);
    expect(readFileSync(s.source)).toEqual(before);
    for (const privatePart of ['spades', s.f.hero.user_id, 'payloadText', 'publicKeyPem'])
      expect(response.output).not.toContain(privatePart);
    const store = new HorseDecisionJournalStore(s.journal, { readOnly: true });
    expect(store.readHand(HAND_KEY)).toEqual(s.f.records);
    store.close();
    expect(readdirSync(s.dir).some((name) => name.endsWith('.tmp'))).toBe(false);
  });
  it('writes an honest pending report when the independent production authority is absent', () => {
    const s = setup();
    vi.stubEnv('HORSE_CORRECTIVE_REVIEW_TRUSTED_KEY_SHA256', '');
    expect(runHorseCorrectiveReview(s.args).code).toBe(2);
    const result = JSON.parse(readFileSync(s.output, 'utf8'));
    expect(result.reasons).toContain('trusted_source_authority_missing');
    expect(result.actors[0].eligibility).toBe('unknown');
    expect(result.gtoVerified).toBe(false);
  });
  it('never overwrites a prior report on retry', () => {
    const s = setup();
    vi.stubEnv('HORSE_CORRECTIVE_REVIEW_TRUSTED_KEY_SHA256', TRUSTED_KEY_DIGEST);
    expect(runHorseCorrectiveReview(s.args).code).toBe(0);
    const bytes = readFileSync(s.output);
    expect(runHorseCorrectiveReview(s.args).code).toBe(3);
    expect(readFileSync(s.output)).toEqual(bytes);
    expect(readdirSync(s.dir).some((name) => name.endsWith('.tmp'))).toBe(false);
  });
  it.each([
    'shared_input',
    'linked_input',
    'symlink_input',
    'symlink_output',
    'shared_output_parent',
  ])('rejects unsafe private artifact paths: %s', (fault) => {
    const s = setup();
    vi.stubEnv('HORSE_CORRECTIVE_REVIEW_TRUSTED_KEY_SHA256', TRUSTED_KEY_DIGEST);
    if (fault === 'shared_input') chmodSync(s.source, 0o644);
    if (fault === 'linked_input') linkSync(s.source, join(s.dir, 'linked.json'));
    if (fault === 'symlink_input') {
      const linked = join(s.dir, 'alias.json');
      symlinkSync(s.source, linked);
      s.args[2] = linked;
    }
    if (fault === 'symlink_output') symlinkSync(s.source, s.output);
    if (fault === 'shared_output_parent') chmodSync(s.dir, 0o755);
    const original = readFileSync(s.source);
    expect(runHorseCorrectiveReview(s.args).code).toBe(3);
    expect(readFileSync(s.source)).toEqual(original);
  });
  it('requires explicit local paths and never defaults to live storage', () => {
    expect(runHorseCorrectiveReview([]).code).toBe(64);
    expect(runHorseCorrectiveReview(['relative', HAND_KEY, 'input', 'output']).code).toBe(64);
  });
});
