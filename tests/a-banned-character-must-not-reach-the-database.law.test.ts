/**
 * ===========================================================================
 *  LAW: A BANNED CHARACTER MUST NOT REACH THE DATABASE
 * ===========================================================================
 *
 * Dan banned the m bar on 2026-08-20 and repeated it on 2026-08-31: "remove
 * any and all m bars as they are banned from use." By 2026-08-31 five gates
 * enforced it and every one of them walked `src/`. A Postgres function hands
 * its RAISE message, and its jsonb {'message': ...}, straight to the client,
 * which toasts it verbatim, so 120 public functions were serving a banned
 * character while all five gates reported OK. Migration 20260831202752 rewrote
 * them and left `fn_ca_banned_copy_characters()` behind;
 * `scripts/ci/check-db-copy.mjs` reads it and Cron Health fails on a finding.
 *
 * THAT GATE THEN STAYED RED FOR NINE DAYS. Measured 2026-09-19: one finding,
 * `fn_spin_draw_and_settle_atomic`, a comment inside the body reading "and
 * would be refused there <banned> a separate, rare (0.01%) defect". It
 * arrived on 2026-09-10 with
 * 20260910034412_spin_draw_gate_reads_zero_as_undrawn_and_stamps_the_row.sql
 * and nothing stopped it, because the source gates walk `src/`, `public/` and
 * `server/src`, and NOTHING walks `supabase/migrations`. A migration is the
 * one way copy reaches a function body. It was the one door with no lock.
 *
 * No player read it: the character is in a comment, not in a message. What it
 * cost was nine days of a red gate, and this estate's own words for that are
 * already written down elsewhere in the tree: "a chronic alarm that never
 * clears is the same blind spot as no alarm."
 *
 * So there are two locks now, and this law pins both. The live database is
 * cleaned by 20260919145853 and re-asked by the gate in the same transaction.
 * The source door is this file: from 20260911 onward, no migration may carry
 * one of the four characters at all. It binds forward because 609 of the 3,169
 * migrations written before it do carry one, and a rule that fails on history
 * gets switched off.
 */
import { describe, it, expect } from 'vitest';
import { classifyMigration } from '../scripts/ci/recording-only.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const FIX = 'supabase/migrations/20260919145853_a_banned_character_must_not_reach_the_database.sql';
const GATE = 'scripts/ci/check-db-copy.mjs';
const READER = '.github/workflows/cron-health.yml';

/**
 * Figure dash, en dash, m bar, horizontal bar. The same four
 * fn_ca_banned_copy_characters() matches and the same four 20260831202752
 * translated. Built from their code points, so this file holds none of them
 * either: the same move the migration it guards makes with chr(8212).
 */
const BANNED_CODE_POINTS = [0x2012, 0x2013, 0x2014, 0x2015];
const CLASS = '[' + BANNED_CODE_POINTS.map((c) => String.fromCodePoint(c)).join('') + ']';
const BANNED = new RegExp(CLASS);
const BANNED_G = new RegExp(CLASS, 'g');

/**
 * The law binds from here. Everything from this date is clean today, which is
 * what makes the rule landable; everything before it is history.
 */
const BINDS_FROM = '20260911';

/**
 * The one exemption that has to exist. A migration that DEFINES the checker
 * must hold the characters the checker looks for: 20260831202752 does, three
 * times over, and without that exemption the rewrite loop translates the
 * checker's own character class into a valid, meaningless range and the gate
 * silently disables itself. Line scoped, and it has to say why.
 */
const ESCAPE = /--\s*dash-ok:\s*\S/;

/**
 * AND A RECORDING OF AN ALREADY-APPLIED MIGRATION IS HISTORY TOO (2026-09-23).
 *
 * This law's cutoff exists because history cannot be edited. A file recovered
 * byte-exact from `supabase_migrations.schema_migrations.statements` is history
 * with a later commit date: production executed that text days ago, and editing
 * a character of it is precisely what stops it being a record of what ran.
 *
 * So a VERIFIED recording is skipped here for the same reason a pre-cutoff
 * migration is - and only a verified one. `classifyMigration` accepts a file
 * only when scripts/ci/recorded-migrations.manifest.json holds a row for its
 * version and the file on disk hashes to the md5 that row records, which
 * scripts/ci/check-recorded-migrations-evidence.mjs then checks against
 * production's own md5. A new migration cannot hash to a version production
 * already has, so this cannot be used to smuggle the character in.
 *
 * The runtime half is untouched and is what actually protects production copy:
 * `fn_ca_banned_copy_characters()` reads the live database and returned 0 rows
 * on 2026-09-23, with all ten recordings applied. The one recorded file that
 * carries a banned character carries it in a `--` comment on line 16555 of
 * 20260917181100, which is never copy anybody reads.
 */
const isVerifiedRecording = (file: string): boolean =>
  classifyMigration(`supabase/migrations/${file}`, { repo: ROOT }).state === 'recorded';

const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SQL = read(FIX);

function migrations(): string[] {
  return fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/** Every line of a migration that carries a banned character and no exemption. */
function offendingLines(file: string): string[] {
  const src = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
  if (!BANNED.test(src)) return [];
  return (
    src
      .split('\n')
      .filter((line) => BANNED.test(line) && !ESCAPE.test(line))
      // Reported whole. A fixed cut into source text is what
      // tests/unit/noFixedSizeSourceWindows.test.ts exists to stop, and it
      // caught this line on its first run; a migration line is human written
      // SQL, so there is nothing to truncate anyway.
      .map((line) => line.trim())
  );
}

describe('a banned character must not reach the database', () => {
  it('the file that cleans the database holds none of what it bans', () => {
    // A migration that carries the character it bans cannot be covered by the
    // rule it installs, and would be the first thing the guard below trips on.
    expect(SQL.match(BANNED_G)).toBeNull();
    // Which is only possible because it names them by code point instead.
    expect(SQL).toContain('chr(8210) || chr(8211) || chr(8212) || chr(8213)');
  });

  it('it rewrites what it finds rather than what somebody typed', () => {
    // The 2026-09-10 finding was noticed by reading the gate's output. A
    // migration that hard-codes that one function is correct for exactly as
    // long as nothing else arrives before it runs.
    //
    // Asserted line by line rather than over the whole file, because the
    // @live-proof legitimately names the function it expects to find rewritten
    // - that is what a proof IS - and a bare not.toContain fails on it. Which
    // it did, on the first run of this law.
    const naming = SQL.split('\n').filter((l) => l.includes("'fn_spin_draw_and_settle_atomic'"));
    expect(naming.length, 'the header should still say which function it found').toBeGreaterThan(0);
    expect(
      naming.filter((l) => !l.trim().startsWith('-- @live-proof:')),
      'the function may be named in a proof about it, never in the code that chooses what to rewrite'
    ).toEqual([]);
    expect(SQL).toMatch(/FROM pg_proc p[\s\S]{0,800}p\.prosrc ~ \('\[' \|\| v_banned \|\| '\]'\)/);
    expect(SQL).toContain("translate(v_def, v_banned, '----')");
    // And the checker keeps its own exemption, or the gate disables itself.
    expect(SQL).toContain("p.proname <> 'fn_ca_banned_copy_characters'");
  });

  it('the gate, not the migration, decides whether it worked', () => {
    // A rewrite that asserts against its own predicate proves only that the
    // predicate agrees with itself.
    expect(SQL).toMatch(
      /SELECT string_agg\(f\.object_name, ', '\) INTO v_left[\s\S]{0,200}fn_ca_banned_copy_characters\(\) f[\s\S]{0,120}f\.kind = 'dash'/
    );
    expect(SQL).toMatch(/RAISE EXCEPTION 'failed: a public function still carries a banned dash/);
  });

  it('a blunt tool aimed at live function bodies has a cap on it', () => {
    // 20260831202752 rewrote 120 function bodies with a textual translate, on
    // purpose, in a migration written for it. This one expects one. A run that
    // matches dozens means something upstream changed that nobody looked at.
    expect(SQL).toMatch(/ELSIF v_n > 5 THEN/);
    expect(SQL).toMatch(/RAISE EXCEPTION 'refused: % public functions carry a banned dash/);
  });

  it('it declares a proof, so something can tell whether it is live', () => {
    // The sibling law: a migration that creates no persistent object has to say
    // what a reader would run to see the change is there. This one creates
    // nothing at all - it rewrites bodies in place.
    const proofs = [...SQL.matchAll(/^--\s*@live-proof:\s*(.+)$/gm)].map((m) => m[1].trim());
    expect(proofs.length).toBeGreaterThanOrEqual(1);
    expect(proofs.join('\n')).toContain('fn_ca_banned_copy_characters');
  });

  it('the runtime half still has a reader, or the source half is on its own', () => {
    // This law is a source gate. It cannot see a function body somebody
    // rewrote by hand in the SQL editor, which is the whole reason
    // check-db-copy.mjs exists. Both halves, or neither is worth much.
    expect(read(GATE)).toContain('fn_ca_banned_copy_characters');
    const reader = read(READER);
    expect(reader).toContain('node scripts/ci/check-db-copy.mjs');
    expect(reader).toContain("steps.dbcopy.outputs.status != '0'");
  });

  it('binds forward, and says out loud how much history it is not binding', () => {
    // The justification for the cutoff, asserted rather than claimed. If this
    // number ever collapses, somebody rewrote history and the cutoff should
    // move with it.
    const old = migrations().filter((f) => f.slice(0, 8) < BINDS_FROM);
    const carrying = old.filter((f) =>
      BANNED.test(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'))
    );
    expect(old.length).toBeGreaterThan(2000);
    expect(
      carrying.length,
      'the cutoff exists because hundreds of historical migrations carry one'
    ).toBeGreaterThan(100);
  }, 120_000);

  /**
   * THE ONE THAT MATTERS LATER. Everything above is about one character in one
   * comment. This is the door.
   */
  it('no migration written after the cutoff carries one', () => {
    const offenders: Record<string, string[]> = {};
    const recordings: string[] = [];
    for (const file of migrations()) {
      if (file.slice(0, 8) < BINDS_FROM) continue;
      const lines = offendingLines(file);
      if (lines.length === 0) continue;
      if (isVerifiedRecording(file)) {
        recordings.push(file);
        continue;
      }
      offenders[file] = lines;
    }
    // The exemption is visible, never silent. Each one is a file whose bytes
    // production already executed, proved by md5 against its manifest row.
    for (const file of recordings) {
      expect(
        classifyMigration(`supabase/migrations/${file}`, { repo: ROOT }).state,
        `${file} was skipped here, so it has to be a verified recording`
      ).toBe('recorded');
    }
    expect(
      offenders,
      'these migrations carry a dash character Dan banned on 2026-08-20 and again on ' +
        '2026-08-31. Inside a function body it reaches production copy directly, and the ' +
        'only thing that notices is check-db-copy.mjs, AFTER the migration is applied - ' +
        'which is how Cron Health sat red for nine days. Write the character as chr(8212) ' +
        'if the migration genuinely needs to name it, the way ' +
        '20260919145853_a_banned_character_must_not_reach_the_database.sql does, or use a ' +
        'plain hyphen. A migration that DEFINES the checker is the one real exception and ' +
        'marks the line `-- dash-ok: <why>`.'
    ).toEqual({});
  });
});
