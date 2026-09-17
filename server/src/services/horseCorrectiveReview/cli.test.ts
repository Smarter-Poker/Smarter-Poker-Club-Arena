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
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HorseDecisionJournalStore } from '../horseDecisionJournal/store.js';
import {
  readonlyHorseJournalStoreOptions,
  runtimeHorseJournalArchiveOptions,
} from '../horseDecisionJournal/config.js';
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
function setup(archive = false) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'horse-corrective-'));
  dirs.push(dir);
  const f = correctiveFixture(),
    journal = join(dir, 'journal'),
    source = join(dir, 'input.json'),
    authority = join(dir, 'authority.json'),
    output = join(dir, 'review.json');
  const store = new HorseDecisionJournalStore(
    journal,
    archive ? { archive: runtimeHorseJournalArchiveOptions(journal, {}) } : {}
  );
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
describe('private journal archive admission and read-only selection', () => {
  const configurationDirectory = join(tmpdir(), 'horse-journal-config');
  it.each(['', '0', '-1', '1.5', '1e9', '0x400', ' 10', '10 ', '9007199254740992'])(
    'refuses malformed resource allocation before starting a writer: %s',
    (value) => {
      expect(() =>
        runtimeHorseJournalArchiveOptions(configurationDirectory, {
          HORSE_DECISION_JOURNAL_ARCHIVE_MAX_BYTES: value,
        })
      ).toThrow('Invalid Horse archive resource allocation');
      expect(() =>
        runtimeHorseJournalArchiveOptions(configurationDirectory, {
          HORSE_DECISION_JOURNAL_ARCHIVE_MAX_SEGMENTS: value,
        })
      ).toThrow('Invalid Horse archive resource allocation');
    }
  );
  it('keeps allocation explicit and under the existing persistent journal directory', () => {
    expect(
      runtimeHorseJournalArchiveOptions(configurationDirectory, {
        HORSE_DECISION_JOURNAL_ARCHIVE_MAX_BYTES: '4096',
        HORSE_DECISION_JOURNAL_ARCHIVE_MAX_SEGMENTS: '2',
      })
    ).toEqual({
      directory: join(configurationDirectory, 'archive'),
      maxBytes: 4096,
      maxSegments: 2,
    });
    expect(() =>
      runtimeHorseJournalArchiveOptions(configurationDirectory, {
        HORSE_DECISION_JOURNAL_ARCHIVE_MAX_SEGMENTS: '500001',
      })
    ).toThrow();
    expect(() => runtimeHorseJournalArchiveOptions('relative/journal', {})).toThrow();
  });
  it('does not create an archive or hide a present incomplete archive from the real reader', () => {
    const s = setup();
    const before = readdirSync(s.journal);
    expect(readonlyHorseJournalStoreOptions(s.journal)).toEqual({ readOnly: true });
    expect(readdirSync(s.journal)).toEqual(before);
    mkdirSync(join(s.journal, 'archive'), { mode: 0o700 });
    expect(readonlyHorseJournalStoreOptions(s.journal)).toMatchObject({
      readOnly: true,
      archive: { directory: join(s.journal, 'archive') },
    });
    expect(runHorseCorrectiveReview(s.args).code).toBe(3);
    expect(readdirSync(join(s.journal, 'archive'))).toEqual([]);
    expect(readdirSync(s.dir)).not.toContain('review.json');
  });
  it('never downgrades a broken archive symlink to a successful legacy-only read', () => {
    const s = setup();
    symlinkSync(join(s.dir, 'missing-private-archive'), join(s.journal, 'archive'));
    expect(readonlyHorseJournalStoreOptions(s.journal).archive).toBeDefined();
    expect(runHorseCorrectiveReview(s.args).code).toBe(3);
    expect(readdirSync(s.dir)).not.toContain('review.json');
  });
});
describe('explicit private corrective review CLI', () => {
  it.each([false, true])(
    'reads the real private retained store (archive=%s), validates independent authority and publishes a complete private inactive report',
    (archive) => {
      const s = setup(archive),
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
      const store = new HorseDecisionJournalStore(
        s.journal,
        readonlyHorseJournalStoreOptions(s.journal)
      );
      expect(store.readHand(HAND_KEY)).toEqual(s.f.records);
      store.close();
      expect(readdirSync(s.dir).some((name) => name.endsWith('.tmp'))).toBe(false);
    }
  );
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
