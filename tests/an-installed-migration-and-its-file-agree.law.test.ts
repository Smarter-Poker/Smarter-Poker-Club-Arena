/**
 * ===========================================================================
 *  LAW: AN INSTALLED MIGRATION AND ITS FILE AGREE, AND A PULL REQUEST ASKS
 * ===========================================================================
 *
 * 2026-09-27. When the repository was reconciled against production, 1,270
 * installed migrations had no file here and 53 more were the same change
 * recorded under a different version and name on each side. Both gates only
 * ever ran on a schedule, so nothing stopped a gap at the moment it was made.
 *
 * This pins:
 *   - the apply-time alias table is a claim that has to hold in this tree;
 *   - the three shapes the installed-has-a-file check used to miss;
 *   - the grace that lets work in flight pass without letting a gap age;
 *   - the SUPERSEDED BY marker is honoured only when it names a real file;
 *   - the pull-request workflow runs both questions, from trusted code only,
 *     on events and never on a timer.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAliases, ALIASES_PATH } from '../scripts/ci/migration-aliases.mjs';
import {
  indexFrom,
  recordedBy,
  splitByGrace,
  appliedAt,
} from '../scripts/ci/check-applied-migrations-are-recorded.mjs';
import { supersededBy, stampedAt } from '../scripts/ci/check-migrations-are-live.mjs';

const REPO = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(REPO, 'supabase', 'migrations');
const WORKFLOW = path.join(REPO, '.github', 'workflows', 'migration-ledger-reconciled.yml');

function fixture(aliases: unknown, files: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aliases-'));
  fs.mkdirSync(path.join(dir, 'scripts', 'ci'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'supabase', 'migrations'), { recursive: true });
  if (aliases !== undefined) {
    fs.writeFileSync(
      path.join(dir, ALIASES_PATH),
      typeof aliases === 'string' ? aliases : JSON.stringify(aliases)
    );
  }
  for (const f of files)
    fs.writeFileSync(path.join(dir, 'supabase', 'migrations', f), 'select 1;\n');
  return dir;
}

const row = (appliedVersion: string, file: string) => ({
  appliedVersion,
  appliedName: 'x',
  appliedMd5: '0'.repeat(32),
  file: `supabase/migrations/${file}`,
});

describe('the apply-time alias table', () => {
  it('every row in this repository is honoured, and none is refused', () => {
    const loaded = loadAliases(REPO);
    expect(loaded.error).toBeNull();
    expect(loaded.rejected).toEqual([]);
    const raw = JSON.parse(fs.readFileSync(path.join(REPO, ALIASES_PATH), 'utf8'));
    expect(loaded.byVersion.size).toBe(raw.aliases.length);
    for (const r of raw.aliases) {
      expect(r.appliedMd5, `${r.appliedVersion} records what production ran`).toMatch(
        /^[0-9a-f]{32}$/
      );
      expect(String(r.basis || '').length, `${r.appliedVersion} says why`).toBeGreaterThan(20);
    }
  });

  it('refuses a row whose file is not in the tree', () => {
    const dir = fixture({ aliases: [row('20260101000000', '20260101000001_a.sql')] }, []);
    const loaded = loadAliases(dir);
    expect(loaded.byVersion.size).toBe(0);
    expect(loaded.rejected[0]).toMatch(/not in this tree/);
  });

  it('refuses a row for a version that already has its own file', () => {
    const dir = fixture({ aliases: [row('20260101000000', '20260101000001_a.sql')] }, [
      '20260101000001_a.sql',
      '20260101000000_b.sql',
    ]);
    expect(loadAliases(dir).rejected[0]).toMatch(/already has a file/);
  });

  it('refuses a malformed or duplicated row rather than believing it', () => {
    const dir = fixture(
      {
        aliases: [
          row('2026', '20260101000001_a.sql'),
          row('20260101000000', '20260101000001_a.sql'),
          row('20260101000000', '20260101000001_a.sql'),
        ],
      },
      ['20260101000001_a.sql']
    );
    const loaded = loadAliases(dir);
    expect(loaded.byVersion.size).toBe(1);
    expect(loaded.rejected.join('\n')).toMatch(/malformed/);
    expect(loaded.rejected.join('\n')).toMatch(/aliased twice/);
  });

  it('an unreadable table is COULD NOT TELL, never an empty success', () => {
    expect(loadAliases(fixture(undefined, [])).error).toMatch(/not found/);
    expect(loadAliases(fixture('{not json', [])).error).toMatch(/not valid JSON/);
    expect(loadAliases(fixture({ nope: [] }, [])).error).toMatch(/no `aliases` array/);
  });
});

describe('an installed migration has a file', () => {
  const index = indexFrom([
    '20260428000001_audit_trail.sql',
    '20260819_ca_player_stats_full_rpc.sql',
    '20260311_bbj_player_id_column.sql',
  ]);

  it('is recorded through an alias, and only through a real one', () => {
    const aliases = { byVersion: new Map([['20260428204959', {}]]) };
    expect(
      recordedBy(index, { version: '20260428204959', name: 'x2_001_audit_trail' }, aliases)
    ).toBe(true);
    expect(recordedBy(index, { version: '20260428204959', name: 'x2_001_audit_trail' })).toBe(
      false
    );
  });

  it('reads a name stored with its extension, and a version that is the whole stem', () => {
    expect(
      recordedBy(index, { version: '20260311', name: '20260311_bbj_player_id_column.sql' })
    ).toBe(true);
    expect(recordedBy(index, { version: '20260819_ca_player_stats_full_rpc', name: '' })).toBe(
      true
    );
  });

  it('still reports a migration nothing records', () => {
    expect(recordedBy(index, { version: '20260927153827', name: 'nothing_has_this' })).toBe(false);
  });

  it('gives work in flight a grace and an aged gap none', () => {
    const now = Date.UTC(2026, 8, 27, 16, 0, 0);
    const gaps = [
      { version: '20260927150000', name: 'an_hour_old' },
      { version: '20260925150000', name: 'two_days_old' },
      { version: 'manual', name: 'not_a_stamp' },
    ];
    const { inFlight, overdue } = splitByGrace(gaps, 24, now);
    expect(inFlight.map((g) => g.name)).toEqual(['an_hour_old']);
    expect(overdue.map((g) => g.name)).toEqual(['two_days_old', 'not_a_stamp']);
    expect(splitByGrace(gaps, 0, now).overdue).toHaveLength(3);
    expect(appliedAt('20260927153827')?.toISOString()).toBe('2026-09-27T15:38:27.000Z');
    expect(appliedAt('2026')).toBeNull();
  });
});

describe('a merged migration is installed, or says what replaced it', () => {
  it('honours SUPERSEDED BY only when the named file exists', () => {
    const files = ['20260918023630_mtt_activate_unlimited_with_satellite_entry_club.sql'];
    expect(supersededBy('-- SUPERSEDED BY 20260918023630\nupdate x set y=1 where z;', files)).toBe(
      '20260918023630'
    );
    expect(supersededBy('-- SUPERSEDED BY 20990101000000\nselect 1;', files)).toBeNull();
    expect(supersededBy('select 1;\n', files)).toBeNull();
    expect(stampedAt('20260918023630_x.sql')).toBe(Date.UTC(2026, 8, 18, 2, 36, 30));
  });

  it('the two MTT activations that never ran are marked, without touching their pinned bytes', () => {
    const loaded = loadAliases(REPO);
    for (const f of [
      '20260917232311_mtt_activate_unlimited_admission.sql',
      '20260918005913_mtt_activate_unlimited_with_original_funding.sql',
    ]) {
      expect(loaded.superseded.get(f)?.by, f).toBe('20260918023630');
    }
  });

  it('a registry mark is refused when the superseding version has no file', () => {
    const dir = fixture(
      {
        aliases: [],
        superseded: [
          {
            file: 'supabase/migrations/20260101000001_a.sql',
            by: '20990101000000',
            reason: 'a reason long enough to count as a sentence of explanation',
          },
        ],
      },
      ['20260101000001_a.sql']
    );
    const loaded = loadAliases(dir);
    expect(loaded.superseded.size).toBe(0);
    expect(loaded.rejected[0]).toMatch(/no file carries/);
  });
});

describe('the pull-request workflow', () => {
  const yml = fs.readFileSync(WORKFLOW, 'utf8');
  const code = yml
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');

  it('runs on events only - never a schedule, a dispatch loop or another workflow', () => {
    expect(code).toMatch(/pull_request_target:/);
    expect(code).toMatch(/push:\s*\n\s*branches: \[main\]/);
    expect(code).not.toMatch(/schedule:|cron:|workflow_run:|repository_dispatch:/);
  });

  it('executes trusted code only: the default branch, never the pull request head', () => {
    expect(code).toMatch(/ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
    expect(code).not.toMatch(/pull_request\.head\.(sha|ref)/);
    expect(code).toMatch(/persist-credentials: false/);
  });

  it('asks both questions, with a grace, and fails past it', () => {
    expect(code).toMatch(/check-applied-migrations-are-recorded\.mjs --fail --grace-hours 24/);
    expect(code).toMatch(/check-migrations-are-live\.mjs --min-age-hours 24/);
    expect(code).not.toMatch(/continue-on-error/);
  });
});
