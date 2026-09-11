/**
 * THE RECORDER MUST NOT CRY WOLF ABOUT A FILE THAT IS SITTING RIGHT THERE.
 *
 * scripts/ci/check-applied-migrations-are-recorded.mjs asks production which
 * migrations ran and reports the ones this repo has no file for. Its key is the
 * NAME, deliberately: filenames in this repo carry every stamp format there is,
 * and 28 of them share a bare `20260831`, so matching on the stamp alone hid 47
 * of 49 real gaps.
 *
 * What it did not allow for is that the STAMP TURNS UP INSIDE THE NAME. An
 * author who types `20260825_perf_rakeback_stats_batch_set_based` as the
 * migration name and commits a file called exactly that gets reported as
 * missing, because the file's name was read as everything AFTER the stamp and
 * the applied name still had it on the front.
 *
 * Measured against production on 2026-09-01: 426 reported unrecorded, and 87 of
 * them had a file whose name contained the applied name exactly. After this
 * both sides are normalised and the report fell to 365 -- the ones underneath
 * are real, and now they are the only thing in the list.
 *
 * These run the two pure halves directly. The script's `main()` is guarded by
 * an entry-point check so importing it here does not reach for production.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

let indexFrom: (files: string[]) => { versions: Set<string>; names: Set<string> };
let recordedBy: (
  index: { versions: Set<string>; names: Set<string> },
  migration: { version: string; name: string }
) => boolean;
let siblingMigrationFiles: (repos?: string[], token?: string) => Promise<string[]>;

beforeAll(async () => {
  const href = pathToFileURL(
    resolve(__dirname, '..', 'scripts/ci/check-applied-migrations-are-recorded.mjs')
  ).href;
  const mod = await import(/* @vite-ignore */ href);
  indexFrom = mod.indexFrom;
  recordedBy = mod.recordedBy;
  siblingMigrationFiles = mod.siblingMigrationFiles;
});

describe('the shared migration ledger is never graded from one repository', () => {
  it('refuses to call the sibling index complete without an estate read token', async () => {
    await expect(
      siblingMigrationFiles(['Smarter-Poker/Smarter-Poker-World-Hub'], '')
    ).rejects.toThrow(/UNKNOWN: no estate read token/);
  });

  it('the scheduled workflow mints a short-lived read-only sibling token', () => {
    const workflow = readFileSync(
      resolve(__dirname, '..', '.github/workflows/applied-migrations-recorded.yml'),
      'utf8'
    );
    expect(workflow).toContain('actions/create-github-app-token@v3');
    expect(workflow).toContain('repositories: Smarter-Poker-World-Hub');
    expect(workflow).toContain('permission-contents: read');
    expect(workflow).toContain('GH_TOKEN: ${{ steps.estate-token.outputs.token }}');
    expect(workflow).not.toContain('indexing this repo only');
  });
});

describe('a file records a migration however the stamp is written', () => {
  it('matches when the applied name carries its own date and the file does too', () => {
    // The exact shape that produced 87 false reports.
    const idx = indexFrom(['20260825_perf_rakeback_stats_batch_set_based.sql']);
    expect(
      recordedBy(idx, {
        version: '20260825013028',
        name: '20260825_perf_rakeback_stats_batch_set_based',
      })
    ).toBe(true);
  });

  it('still matches the plain case the check was written for', () => {
    // A 14-digit file recording a bare applied name.
    const idx = indexFrom(['20260831144826_ca_leak_fixes.sql']);
    expect(recordedBy(idx, { version: '20260901000000', name: 'ca_leak_fixes' })).toBe(true);
  });

  it('matches an applied name with a stamp against a file without one', () => {
    const idx = indexFrom(['20260831144826_ca_leak_fixes.sql']);
    expect(recordedBy(idx, { version: '20260901000000', name: '20260831_ca_leak_fixes' })).toBe(
      true
    );
  });

  it('matches on the exact version stamp regardless of name', () => {
    const idx = indexFrom(['20260901120000_the_seat_club_clone_is_not_an_anon_reader.sql']);
    expect(recordedBy(idx, { version: '20260901120000', name: 'something_else_entirely' })).toBe(
      true
    );
  });

  it('still reports a migration this repo genuinely has no file for', () => {
    // The point of the check. Normalising the two sides must not turn it into
    // a check that passes everything.
    const idx = indexFrom(['20260825_perf_rakeback_stats_batch_set_based.sql']);
    expect(recordedBy(idx, { version: '20260825013344', name: 'rollup_forward_roll' })).toBe(false);
  });

  it('does not let a bare stamp file record every migration applied that day', () => {
    // 28 files share `20260831`. Prefix matching on the stamp is what hid 47 of
    // 49 real gaps, and it stays gone: a 14-digit applied version is not the
    // same string as an 8-digit file stamp.
    const idx = indexFrom(['20260831_ca_leak_fixes.sql']);
    expect(recordedBy(idx, { version: '20260831144826', name: 'a_different_migration' })).toBe(
      false
    );
  });

  it('ignores anything that is not a .sql file', () => {
    const idx = indexFrom(['README.md', '.template.sql']);
    expect(idx.names.has('readme')).toBe(false);
    expect(recordedBy(idx, { version: '1', name: 'readme' })).toBe(false);
  });
});
