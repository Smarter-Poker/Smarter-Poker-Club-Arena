/**
 * ===========================================================================
 *  A RECORDING IS VERIFIED, NOT ASSERTED
 * ===========================================================================
 *
 * WHY THIS EXISTS (2026-09-23, issue #5008)
 *
 * Four rules across three guards refused ten migration files that only RECORD
 * SQL production applied between 2026-09-16 and 2026-09-22. Every one of those
 * rules asks "is this branch introducing something unreviewed", which for a
 * file recording SQL that ran six days ago has already been answered by the
 * database. The repo could therefore not be made to match its own database,
 * and `Applied Migrations Are Recorded` stayed red at 34 unrecorded versions.
 *
 * The fix is a NAMED category, not a bypass flag, and this law is what keeps it
 * that way. The category that already existed - `-- BACKFILLED` on line one -
 * was a bypass flag: any file carrying that comment skipped all four definer
 * rules with nothing checking that it recorded anything at all.
 * check-migrations-applied's own header named that hazard as a dishonest escape
 * it did not want to leave open, and it was open the whole time.
 *
 * So: a recording is a row in scripts/ci/recorded-migrations.manifest.json
 * whose md5 must equal the file on disk AND what production's
 * supabase_migrations.schema_migrations holds for that version. The first half
 * is pinned here; the second is asked of production by
 * scripts/ci/check-recorded-migrations-evidence.mjs inside the `Applied
 * Migrations Are Recorded` workflow, which is where a finding reaches a person.
 *
 * The point of the whole design, in one sentence: a genuinely new migration
 * cannot be made to hash to a version production already has, so it cannot wear
 * this marker. The last describe() block in this file proves exactly that.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RECORDING_BINDS_FROM,
  MANIFEST_PATH,
  carriesLegacyMarker,
  classifyMigration,
  loadManifest,
  partitionMigrations,
} from '../scripts/ci/recording-only.mjs';
import {
  unauthorisedWriters,
  anonReadableDefiners,
} from '../scripts/ci/check-definer-authorization.mjs';
import { offenders as moneyTriggerOffenders } from '../scripts/ci/check-money-trigger-declared.mjs';
import { offenders as bandAidOffenders } from '../scripts/ci/check-no-new-band-aids.mjs';

const REPO = join(__dirname, '..');
const MIGRATIONS = 'supabase/migrations';

/** A throwaway repo with one migration in it, so classification can be driven
 *  end to end without touching this tree. */
function fixture(files: Record<string, string>, manifest?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'recording-law-'));
  mkdirSync(join(root, MIGRATIONS), { recursive: true });
  mkdirSync(join(root, 'scripts', 'ci'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(root, MIGRATIONS, name), body);
  }
  if (manifest !== undefined) {
    writeFileSync(join(root, MANIFEST_PATH), JSON.stringify(manifest, null, 2));
  }
  return root;
}

const md5 = (s: string) => createHash('md5').update(Buffer.from(s, 'utf8')).digest('hex');

const RECORDED_SQL = 'CREATE OR REPLACE FUNCTION public.fn_x() RETURNS void AS $$ BEGIN END $$;\n';

describe('the freeze on the old first-line marker', () => {
  it('is at or after every file on disk that still uses it', () => {
    const marked = readdirSync(join(REPO, MIGRATIONS))
      .filter((f) => f.endsWith('.sql'))
      .filter((f) => carriesLegacyMarker(readFileSync(join(REPO, MIGRATIONS, f), 'utf8').split('\n', 1)[0]));

    // The point of the cutoff is that it refuses nothing that already exists
    // and covers everything written from here on. If a file at or after it
    // carries the marker, either that file is claiming an exemption it has not
    // earned, or somebody moved the cutoff forward to let it - and moving the
    // cutoff forward re-opens the blanket bypass for a whole range of versions.
    const offenders = marked.filter((f) => f.slice(0, 14) >= RECORDING_BINDS_FROM);
    expect(offenders).toEqual([]);
    expect(marked.length).toBeGreaterThan(0); // the frozen set is real history
  });

  it('still honours the marker below itself, because those files are history', () => {
    const root = fixture({
      '20260901000000_old.sql': '-- BACKFILLED 2026-09-01 from statements.\n' + RECORDED_SQL,
    });
    const verdict = classifyMigration(`${MIGRATIONS}/20260901000000_old.sql`, { repo: root });
    expect(verdict.state).toBe('recorded');
  });

  it('refuses the marker at or after itself, with no manifest row', () => {
    const root = fixture({
      '20260916111614_claimed.sql': '-- BACKFILLED 2026-09-23 from statements.\n' + RECORDED_SQL,
    });
    const verdict = classifyMigration(`${MIGRATIONS}/20260916111614_claimed.sql`, { repo: root });
    expect(verdict.state).toBe('new');
    expect(verdict.reason).toMatch(/frozen/i);
  });
});

describe('a manifest row is a claim that has to hold', () => {
  const file = `${MIGRATIONS}/20260916111614_recorded.sql`;

  it('is accepted when the file hashes to the md5 it records', () => {
    const root = fixture({ '20260916111614_recorded.sql': RECORDED_SQL }, {
      recordings: [{ version: '20260916111614', file, md5: md5(RECORDED_SQL) }],
    });
    expect(classifyMigration(file, { repo: root }).state).toBe('recorded');
  });

  it('is refused the moment the file is edited', () => {
    const root = fixture({ '20260916111614_recorded.sql': RECORDED_SQL + '-- one more line\n' }, {
      recordings: [{ version: '20260916111614', file, md5: md5(RECORDED_SQL) }],
    });
    const verdict = classifyMigration(file, { repo: root });
    expect(verdict.state).toBe('new');
    expect(verdict.reason).toMatch(/hashes to/);
  });

  it('is refused when the row points at a different path', () => {
    const root = fixture({ '20260916111614_recorded.sql': RECORDED_SQL }, {
      recordings: [
        { version: '20260916111614', file: `${MIGRATIONS}/20260916111614_elsewhere.sql`, md5: md5(RECORDED_SQL) },
      ],
    });
    expect(classifyMigration(file, { repo: root }).state).toBe('new');
  });

  it('is ignored when it is malformed, rather than believed', () => {
    const root = fixture({ '20260916111614_recorded.sql': RECORDED_SQL }, {
      recordings: [{ version: 'not-a-version', file, md5: 'not-an-md5' }],
    });
    expect(classifyMigration(file, { repo: root }).state).toBe('new');
  });
});

describe('could not tell is its own outcome (CLAUDE.md 10.86 rule 1)', () => {
  it('never reads as recorded, and the file is judged anyway', () => {
    const root = fixture({ '20260916111614_recorded.sql': RECORDED_SQL });
    // No manifest at all: the file claims nothing, so it is ordinary new work.
    const { judge, recorded } = partitionMigrations([`${MIGRATIONS}/20260916111614_recorded.sql`], {
      repo: root,
    });
    expect(recorded).toEqual([]);
    expect(judge).toHaveLength(1);
  });

  it('reports the manifest as unreadable instead of as empty', () => {
    const root = fixture({ '20260916111614_recorded.sql': RECORDED_SQL });
    writeFileSync(join(root, MANIFEST_PATH), '{ this is not json');
    const loaded = loadManifest(root);
    expect(loaded.error).toBeTruthy();
    expect(loaded.rows.size).toBe(0);
  });
});

describe('this repository is its own fixture', () => {
  it('has every manifest row present on disk and byte-identical to its md5', () => {
    const { rows, error } = loadManifest(REPO);
    expect(error).toBeNull();
    expect(rows.size).toBeGreaterThan(0);
    for (const [version, row] of rows) {
      const path = join(REPO, (row as { file: string }).file);
      expect(existsSync(path), `${version}: ${(row as { file: string }).file} is missing`).toBe(true);
      const actual = createHash('md5').update(readFileSync(path)).digest('hex');
      expect(actual, `${version} no longer matches the md5 the manifest records`).toBe(
        (row as { md5: string }).md5
      );
    }
  });

  it('is consulted by all three guards, or the exemption has no gatekeeper', () => {
    for (const guard of [
      'scripts/ci/check-definer-authorization.mjs',
      'scripts/ci/check-money-trigger-declared.mjs',
      'scripts/ci/check-no-new-band-aids.mjs',
      'scripts/ci/check-migrations-applied.mjs',
    ]) {
      expect(readFileSync(join(REPO, guard), 'utf8'), `${guard} stopped reading recording-only`).
        toContain('recording-only.mjs');
    }
  });

  it('has a live reader, and it is named', () => {
    const workflow = readFileSync(join(REPO, '.github/workflows/applied-migrations-recorded.yml'), 'utf8');
    expect(workflow).toContain('check-recorded-migrations-evidence.mjs');
  });
});

/**
 * THE NEGATIVE TEST. Everything above is about letting a recording through.
 * This is the half that matters more: the same rules, on a migration that
 * SHOULD be refused, still refuse it - and no amount of claiming changes that,
 * because the claim is a hash of SQL production already ran.
 */
describe('a genuinely dangerous migration is still refused', () => {
  const DANGEROUS =
    'CREATE FUNCTION public.fn_pay_everyone(p_user uuid) RETURNS void\n' +
    'LANGUAGE plpgsql SECURITY DEFINER AS $$\n' +
    'BEGIN\n' +
    '  UPDATE public.club_members SET chip_balance = chip_balance + 1000 WHERE user_id = p_user;\n' +
    'END $$;\n' +
    'CREATE TRIGGER pay_on_seat AFTER INSERT ON public.table_seats\n' +
    '  FOR EACH ROW EXECUTE FUNCTION public.fn_pay_everyone(NEW.user_id);\n' +
    'CREATE FUNCTION public.fn_backpay_everything() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;\n';

  it('trips the definer writer rule, the anon rule, the money-trigger rule and the band-aid rule', () => {
    expect(unauthorisedWriters(DANGEROUS)).toContain('fn_pay_everyone');
    expect(anonReadableDefiners(DANGEROUS)).toContain('fn_pay_everyone');
    expect(moneyTriggerOffenders(DANGEROUS).map((h: { trigger: string }) => h.trigger)).toContain(
      'pay_on_seat'
    );
    expect(bandAidOffenders(DANGEROUS).map((h: { name: string }) => h.name)).toContain(
      'fn_backpay_everything'
    );
  });

  it('cannot buy the exemption with a manifest row, because the hash is of the file', () => {
    const file = `${MIGRATIONS}/20260916111614_looks_innocent.sql`;
    const root = fixture({ '20260916111614_looks_innocent.sql': DANGEROUS }, {
      // A forged row: the version is one production really has, but the md5 is
      // the md5 of the SQL production actually ran, not of this file.
      recordings: [{ version: '20260916111614', file, md5: md5(RECORDED_SQL) }],
    });
    const verdict = classifyMigration(file, { repo: root });
    expect(verdict.state).toBe('new');

    const { judge, recorded } = partitionMigrations([file], { repo: root });
    expect(recorded).toEqual([]);
    expect(judge).toEqual([file]);
  });

  it('cannot buy it by hashing the row to itself either, because production is asked too', () => {
    // A row CAN be made to agree with a file - just hash the dangerous file.
    // Offline that is accepted, which is why it is not the whole mechanism:
    // check-recorded-migrations-evidence.mjs asks production whether that md5
    // is what schema_migrations holds for that version, and files an issue when
    // it is not. This test pins that the live half exists and is wired up.
    const evidence = readFileSync(
      join(REPO, 'scripts/ci/check-recorded-migrations-evidence.mjs'),
      'utf8'
    );
    expect(evidence).toContain('fn_ca_migration_text');
    expect(evidence).toContain('fn_definer_exposure_audit');
    expect(evidence).toContain('fn_undeclared_money_triggers');
    // and that it cannot answer green when it could not reach production
    expect(evidence).toContain('return 3');
  });
});
