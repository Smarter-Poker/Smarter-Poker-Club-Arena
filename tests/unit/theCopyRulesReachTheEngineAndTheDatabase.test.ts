/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  TWO SURFACES THE COPY GATES COULD NOT SEE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-31: "make sure the first letter of every word on every single
 * page and sub page is capitalized and remove any and all m bars as they are
 * banned from use."
 *
 * By that morning the product had five gates for those two rules, and every
 * one of them walked `src/`. So the sweep asked the only question worth
 * asking: what is NOT src/, and does a player read it?
 *
 * 1. THE ENGINE.  check-ui-text had already made this move - "A list of the
 *    files somebody happened to check is a cleanup. The directory is the
 *    gate." - and walks server/src. check-title-case had not, so the
 *    capitalisation rule stopped at the client. Pointing it at server/src
 *    found thirteen live strings, and the interesting part is WHICH:
 *    RakeConfig's twelve BBJ qualifying rules, which the client renders in
 *    the Bad Beat Jackpot panel from ITS OWN copy of the same table. The two
 *    files are meant to mirror each other. The client's had been Title Cased
 *    by the gate months ago; the server's had not, because nothing looked.
 *    They had silently drifted apart, and the drift was invisible precisely
 *    because a gate was passing.
 *
 * 2. THE DATABASE.  Every gate reads FILES. A Postgres function hands its
 *    RAISE message, and its jsonb {'message': ...}, straight to the client,
 *    which toasts it verbatim. 120 public functions were serving banned dash
 *    characters - the signup validator, the tournament rebuy path, the
 *    cashout cancel note, the referral reward line, six push notification
 *    bodies - while all five gates reported OK. Migration 20260831202752
 *    rewrote them and left fn_ca_banned_copy_characters() behind so CI can
 *    ask production the question directly.
 *
 * Both blind spots are the same mistake as the Phase 3 insurance finding: a
 * green gate is evidence about the gate, not about the product.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const TITLE_CASE_SRC = readFileSync(join(ROOT, 'scripts/ci/check-title-case.mjs'), 'utf8');
const UI_TEXT_SRC = readFileSync(join(ROOT, 'scripts/ci/check-ui-text.mjs'), 'utf8');
const DB_COPY_SRC = readFileSync(join(ROOT, 'scripts/ci/check-db-copy.mjs'), 'utf8');
const CRON_WORKFLOW = readFileSync(join(ROOT, '.github/workflows/cron-health.yml'), 'utf8');
const CLIENT_RAKE = readFileSync(join(ROOT, 'src/config/RakeConfig.ts'), 'utf8');
const SERVER_RAKE = readFileSync(join(ROOT, 'server/src/config/RakeConfig.ts'), 'utf8');

/** Every `description: '...'` in a file, in source order. */
const descriptions = (src: string): string[] =>
  [...src.matchAll(/description: '([^']*)'/g)].map((m) => m[1]);

describe('the title case gate reaches the engine, not just the client', () => {
  it('walks server/src as well as src', () => {
    expect(TITLE_CASE_SRC).toContain("const SERVER_SRC = join(ROOT, 'server/src');");
    expect(TITLE_CASE_SRC).toContain('...(SCAN_SERVER ? walk(SERVER_SRC) : [])');
  });

  it('covers the same ground as the em dash gate, which got there first', () => {
    // If one gate walks the engine and the other does not, the next drift is
    // already scheduled. Both must name server/src.
    expect(UI_TEXT_SRC).toContain("join(ROOT, 'server/src')");
    expect(TITLE_CASE_SRC).toContain("join(ROOT, 'server/src')");
  });

  it('leaves the fixture-only source dir alone, so the harness still works', () => {
    // houseCopyRulesReachEveryPage runs this gate against a temp directory via
    // TITLE_CASE_SOURCE_DIR. Walking server/src on top of that would drag the
    // whole engine into every fixture assertion.
    expect(TITLE_CASE_SRC).toContain('const SCAN_SERVER = !process.env.TITLE_CASE_SOURCE_DIR;');
  });

  it('does not read test fixtures as if they were copy', () => {
    // `__tests__` was skipped as a DIRECTORY, but this codebase keeps tests
    // beside their source as `*.test.ts`, so the walk was reporting fixture
    // labels ('test', '$5 -> 1 seat') as page copy.
    expect(TITLE_CASE_SRC).toContain('const isTestFile =');
    expect(TITLE_CASE_SRC).toContain('!isTestFile(entry)');
  });
});

describe('the two RakeConfigs agree on the copy a player reads', () => {
  it('every BBJ description in the engine exists verbatim in the client', () => {
    const client = new Set(descriptions(CLIENT_RAKE));
    const bbjish = (s: string) => /LOSE|BBJ|Straight Flush|Kind|Full House/.test(s);
    const drifted = descriptions(SERVER_RAKE)
      .filter(bbjish)
      .filter((d) => !client.has(d));
    expect(drifted, 'server BBJ copy has drifted from the client the panel renders').toEqual([]);
  });

  it('the engine copy is Title Cased, which is what closed the drift', () => {
    expect(SERVER_RAKE).toContain(
      "description: 'Full House (Aces Full Of Jacks) Or Better Must LOSE To Quads Or Straight Flush'"
    );
    expect(SERVER_RAKE).toContain("description: 'Four Of A Kind (Kings) Or Better Must LOSE'");
    expect(SERVER_RAKE).toContain("label: 'PLO8 (Hi-Lo 8 Or Better)'");
    // The old lowercase forms must not come back AS COPY. Scoped to the
    // `description:` literal on purpose: the file's own doc comment above
    // getBBJQualifyingHand still spells the rules out in prose ("AAAJJ (Full
    // House, Aces full of Jacks) or better must LOSE"), and it should - that
    // is a decision record for a reader, not a string a player sees. A bare
    // substring assertion fails on it, which is how this test first went red.
    const serverDescriptions = descriptions(SERVER_RAKE);
    expect(serverDescriptions.filter((d) => /or better must LOSE/.test(d))).toEqual([]);
    expect(serverDescriptions.filter((d) => /BBJ not available for/.test(d))).toEqual([]);
  });
});

describe('a gate exists for the copy only the database knows', () => {
  it('the CI script reads the database rather than the source tree', () => {
    expect(DB_COPY_SRC).toContain('fn_ca_banned_copy_characters');
    expect(DB_COPY_SRC).toContain('SUPABASE_SERVICE_ROLE_KEY');
    // It must FAIL the build, not merely report.
    expect(DB_COPY_SRC).toContain('process.exit(1)');
  });

  it('it names the migration that installs the function it depends on', () => {
    // A gate whose RPC is missing must say what to apply, or the next agent
    // reads a 404 and deletes the gate.
    expect(DB_COPY_SRC).toContain('20260831202752_the_em_dash_ban_reaches_the_database');
  });

  it('something actually runs it, with credentials, and fails on a finding', () => {
    expect(CRON_WORKFLOW).toContain('node scripts/ci/check-db-copy.mjs');
    expect(CRON_WORKFLOW).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(CRON_WORKFLOW).toContain("steps.dbcopy.outputs.status != '0'");
  });

  it('the migration exempts the checker from its own rule', () => {
    // The checker HOLDS the banned characters on purpose. Without the
    // exemption the rewrite loop translates its character class into `[----]`
    // - a valid, meaningless range - and the gate silently disables itself.
    // That is not hypothetical; it is how check-ui-text's own stripper broke.
    const migration = readFileSync(
      join(ROOT, 'supabase/migrations/20260831202752_the_em_dash_ban_reaches_the_database.sql'),
      'utf8'
    );
    const exemptions = migration.split("proname <> 'fn_ca_banned_copy_characters'").length - 1;
    expect(exemptions, 'the pre-flight, the rewrite loop and the checker each need it').toBe(3);
    expect(migration).toContain('pg_get_functiondef');
    expect(migration).toContain("translate(v_def, '‒–—―', '----')");
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.fn_ca_banned_copy_characters()');
  });
});

describe('the live source still obeys both rules after the widening', () => {
  const run = (script: string) => {
    try {
      execFileSync(process.execPath, [join(ROOT, script)], { stdio: 'pipe' });
      return 0;
    } catch (err) {
      return (err as { status?: number }).status ?? -1;
    }
  };

  it('check-title-case passes over src AND server/src', () => {
    expect(run('scripts/ci/check-title-case.mjs')).toBe(0);
  });

  it('check-ui-text still passes', () => {
    expect(run('scripts/ci/check-ui-text.mjs')).toBe(0);
  });
});
