/**
 * LAW: a migration file that RECORDS an already-applied migration is judged as
 * history; a file that PROPOSES a change is judged in full, exactly as before.
 *
 * WHY (2026-09-21, issue #5008). This estate applies schema straight to
 * production and does not always commit the .sql file. Measured against
 * `supabase_migrations.schema_migrations` on 2026-09-21: 4,399 applied
 * migrations carry recordable statements and 2,460 of them have no file in
 * either estate repo. Closing that means adding files whose only purpose is to
 * write down what production already ran - and four checks refused to let that
 * happen, each for a reason that is correct about a proposal and meaningless
 * about a record:
 *
 *   check-definer-authorization    11 SECURITY DEFINER functions "a browser
 *                                  could call". Live ACLs are
 *                                  {postgres=X, service_role=X};
 *                                  has_function_privilege('anon', ...) is
 *                                  false for all 11.
 *   check-money-trigger-declared   2 "undeclared" triggers that are already
 *                                  rows in ca_declared_money_triggers, live
 *                                  and enabled. It reads the file, never the
 *                                  register.
 *   check-no-new-band-aids         refuses fn_tournament_payout_reconcile,
 *                                  which CLAUDE.md 10.9 names as the
 *                                  platform's own idempotent settlement path.
 *   a-declared-guard-change-is-    pardons only via a SUCCESSOR FILE, and the
 *   recorded-not-raised.law        plausible successors are themselves inside
 *                                  the gap.
 *
 * One defect with four faces: a check treating an added file as a prediction
 * about what production will become, when the file is a record of what
 * production already is.
 *
 * THE DISTINCTION IS A DIGEST AGAINST PRODUCTION, NOT A MARKER OR AN
 * ALLOWLIST. sha256 of the file (trailing newlines stripped) must equal
 * sha256 of the applied statements joined by newlines. To forge it for a
 * migration production has not run you would have to run it first, at which
 * point it IS a record. One byte different and it is a proposal again.
 *
 * These pin both halves for all four: a record passes, and a genuinely
 * dangerous NEW migration is still refused.
 */
import { describe, it, expect } from 'vitest';
import {
  readFileSync,
  existsSync,
  readdirSync,
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  classify,
  digestOf,
  normaliseForDigest,
  versionOf,
  partition,
  installedDigestsFromMain,
  claimsToBeABackfill,
  DIGEST_DIR,
} from '../scripts/ci/recorded-migration.mjs';

const root = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

/** A migration body that every one of the four checks refuses on sight. */
const DANGEROUS = [
  'BEGIN;',
  'CREATE OR REPLACE FUNCTION public.fn_tournament_payout_repair(p_id uuid)',
  'RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$',
  'BEGIN',
  '  UPDATE public.club_members SET chip_balance = chip_balance + 1 WHERE id = p_id;',
  'END $$;',
  'CREATE TRIGGER zz_new_money_guard BEFORE INSERT ON public.table_seats',
  '  FOR EACH ROW EXECUTE FUNCTION public.fn_tournament_payout_repair();',
  'COMMIT;',
].join('\n');

const asDigests = (entries: Array<[string, string]>) => new Map(entries);

describe('a migration file that records is not a proposal', () => {
  it('the digest is the applied statements, joined and rtrimmed', () => {
    // Mirrors rtrim(array_to_string(statements, E'\n'), E'\n') exactly, so a
    // file ending in one newline and the same file ending in three both match.
    expect(normaliseForDigest('a\nb\n')).toBe('a\nb');
    expect(normaliseForDigest('a\nb\n\n\n')).toBe('a\nb');
    expect(digestOf('a\nb\n')).toBe(digestOf('a\nb\n\n\n'));
    expect(digestOf('a\nb\n')).toBe(createHash('sha256').update('a\nb', 'utf8').digest('hex'));
  });

  it('a record passes and a single changed byte does not', () => {
    const sql = `${DANGEROUS}\n`;
    const file = 'supabase/migrations/20260912044158_whatever.sql';
    const digests = asDigests([['20260912044158', digestOf(sql)]]);
    expect(classify(file, sql, digests)).toBe('record');
    // one byte - a trailing space - and the claim is false
    expect(classify(file, `${DANGEROUS} \n`, digests)).toBe('proposal');
    // a version production never applied
    expect(classify('supabase/migrations/20260101000000_x.sql', sql, digests)).toBe('proposal');
    // could not tell
    expect(classify(file, sql, null)).toBe('proposal');
  });

  it('a marker is not proof - only production is', () => {
    // The old `-- BACKFILLED` exemption in check-definer-authorization was a
    // first line of text, so a genuinely new migration with that line pasted
    // on top walked straight through. It is a hint now, never a pardon.
    const forged = `-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.\n${DANGEROUS}\n`;
    expect(claimsToBeABackfill(forged)).toBe(true);
    expect(classify('supabase/migrations/20260912044158_x.sql', forged, asDigests([]))).toBe(
      'proposal'
    );
    expect(read('scripts/ci/check-definer-authorization.mjs')).not.toMatch(
      /\.filter\(\(f\) => \{[\s\S]{0,200}BACKFILLED/
    );
  });

  it('COULD NOT TELL is a proposal, and it says so out loud', () => {
    // 10.86 rule 1. The dangerous coercion is an unreadable manifest read as
    // an empty one, which would pardon nothing - fine - or as a wildcard,
    // which would pardon everything. It must be neither and must be visible.
    const { records, proposals, note } = partition(
      ['supabase/migrations/20260912044158_x.sql'],
      () => `${DANGEROUS}\n`,
      { ok: false, reason: 'test: pretend origin/main is unreachable' }
    );
    expect(records).toEqual([]);
    expect(proposals).toHaveLength(1);
    expect(note).toMatch(/COULD NOT TELL/);
  });

  it('an unreadable file is judged, never skipped', () => {
    const { records, proposals } = partition(
      ['supabase/migrations/20260912044158_x.sql'],
      () => null,
      {
        ok: true,
        digests: asDigests([['20260912044158', digestOf(`${DANGEROUS}\n`)]]),
      }
    );
    expect(records).toEqual([]);
    expect(proposals).toHaveLength(1);
  });

  it('the digests are read from origin/main, never from the working tree', () => {
    // This is the whole anti-forgery property: a pull request cannot pardon
    // itself, because the copy in its own diff is not the copy that is read.
    const src = read('scripts/ci/recorded-migration.mjs');
    expect(src).toContain("'origin/main'");
    expect(src).toContain('ls-tree');
    expect(src).not.toMatch(/readFileSync\([^)]*DIGEST_DIR/);
    // and behaviourally: a shard written into the working tree is not seen
    const dir = resolve(root, DIGEST_DIR);
    const probe = join(dir, 'zz-working-tree-probe.txt');
    const version = '29991231235959';
    const sha = digestOf('anything');
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, `${version} ${sha}\n`);
    try {
      const loaded = installedDigestsFromMain();
      if (loaded.ok) expect(loaded.digests.has(version)).toBe(false);
    } finally {
      rmSync(probe, { force: true });
    }
  });

  it('every shard on disk is generated, well formed, and hand-editable only by accident', () => {
    const dir = resolve(root, DIGEST_DIR);
    expect(existsSync(dir)).toBe(true);
    const shards = readdirSync(dir).filter((f) => f.endsWith('.txt'));
    expect(shards.length).toBeGreaterThan(0);
    let entries = 0;
    for (const f of shards) {
      expect(f).toMatch(/^\d{6}\.txt$/); // sharded by month so two months cannot conflict
      const body = readFileSync(join(dir, f), 'utf8');
      expect(body).toContain('GENERATED by scripts/ci/gen-installed-migration-digests.mjs');
      for (const line of body.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        expect(t).toMatch(/^\d{14} [0-9a-f]{64}$/);
        expect(t.slice(0, 6)).toBe(f.slice(0, 6));
        entries += 1;
      }
    }
    expect(entries).toBeGreaterThan(100);
  });

  // ── the four faces ───────────────────────────────────────────────────────
  // Each: the check still refuses the dangerous NEW migration, and the same
  // bytes classified as a record are taken out of its hands.

  const FACES: Array<[string, string]> = [
    ['check-definer-authorization.mjs', 'check-definer-authorization'],
    ['check-money-trigger-declared.mjs', 'check-money-trigger-declared'],
    ['check-no-new-band-aids.mjs', 'check-no-new-band-aids'],
  ];

  it('each check still refuses a genuinely dangerous NEW migration', async () => {
    // Its OWN judgment, unchanged. DANGEROUS is a SECURITY DEFINER writer with
    // default (so browser-reachable) grants that never asks who is calling, an
    // undeclared trigger on table_seats, and a repair-named function - one
    // offence per check. If any of these ever comes back empty, the record
    // distinction has become a hole rather than a distinction.
    const definer = await import('../scripts/ci/check-definer-authorization.mjs');
    expect(definer.unauthorisedWriters(DANGEROUS).length).toBeGreaterThan(0);

    const trigger = await import('../scripts/ci/check-money-trigger-declared.mjs');
    const hits = trigger.offenders(DANGEROUS);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].table).toBe('table_seats');

    const bandaid = await import('../scripts/ci/check-no-new-band-aids.mjs');
    expect(bandaid.isBandAidName('fn_tournament_payout_repair')).toBe(true);
    expect(bandaid.declaredFunctions(DANGEROUS)).toContain('fn_tournament_payout_repair');
  });

  it.each(FACES)('%s takes its hands off a byte-exact record', (script, label) => {
    // The decision is made once, in partition(), BEFORE the check's own
    // analysis ever sees the file. So the classification plus the wiring is
    // the behaviour: the same bytes the test above proves each check refuses
    // are removed from its input when production has already run them.
    const file = 'supabase/migrations/20260912044158_r.sql';
    const sql = `${DANGEROUS}\n`;
    const { records, proposals } = partition([file], () => sql, {
      ok: true,
      digests: asDigests([['20260912044158', digestOf(sql)]]),
    });
    expect(records).toEqual([file]);
    expect(proposals).toEqual([]);

    const src = read(`scripts/ci/${script}`);
    expect(src).toContain("from './recorded-migration.mjs'");
    expect(src).toContain(`splitOutRecords(allChangedFiles, '${label}'`);
    // the production call site must not inject its own digests
    expect(src).toMatch(/partition\(files, read\)/);
  });

  it('the guard law pardons a record and still refuses an undeclared new raise', () => {
    const law = read('tests/a-declared-guard-change-is-recorded-not-raised.law.test.ts');
    expect(law).toContain("from '../scripts/ci/recorded-migration.mjs'");
    expect(law).toContain('isRecordOfAnInstalledMigration(m)) continue;');
    // the pardon is the digest, not the presence of a marker or a name
    expect(law).toContain("classify(m.name, m.sql, installedDigests()) === 'record'");

    const redefines =
      'CREATE OR REPLACE FUNCTION public.fn_ca_autoledger()\nRETURNS trigger AS $$ BEGIN RETURN NEW; END $$;\n';
    const digests = asDigests([['20260912044158', digestOf(redefines)]]);
    expect(classify('20260912044158_r.sql', redefines, digests)).toBe('record');
    // a NEW migration redefining the same guard is not pardoned by anything
    expect(classify('29991231235959_new.sql', redefines, digests)).toBe('proposal');
    // nor is an edited record
    expect(classify('20260912044158_r.sql', `${redefines}-- tweak\n`, digests)).toBe('proposal');
  });

  it('a record pardon needs production, not a marker', () => {
    // The negative the guard law's own header points at: every way of
    // claiming record status that is not a digest must fail.
    const sql = `${DANGEROUS}\n`;
    const digests = asDigests([['20260912044158', digestOf('something else entirely')]]);
    expect(classify('20260912044158_x.sql', sql, digests)).toBe('proposal');
    expect(versionOf('supabase/migrations/20260912044158_x.sql')).toBe('20260912044158');
    expect(versionOf('supabase/migrations/no_version_here.sql')).toBe(null);
    expect(classify('supabase/migrations/no_version_here.sql', sql, digests)).toBe('proposal');
  });
});
