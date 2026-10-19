import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/*
 * 2026-10-19, launch-day phase 2B. Four per-table engine writers were refused
 * F06_RETRY_CANONICAL_LANE whenever their tournament's lane was held, or
 * merely queued, exclusively by a tournament authority: about 17,900 refusals
 * in 24 hours, and hands whose hole cards were never saved. They now take the
 * shared lane first and WAIT for it (bounded at 4 s), while both F06 hand
 * guards stay exactly as they were. The behaviour is executed on PostgreSQL 17
 * against the exact live bodies by the native harness pinned below; this file
 * pins the migration's shape and wiring so neither can drift unnoticed.
 */
const file = '20261019151125_tournament_table_writers_wait_for_their_shared_lane.sql';
const migration = readFileSync(`supabase/migrations/${file}`, 'utf8');
const fixtures: Array<{ signature: string; definition: string; definition_hash: string }> =
  JSON.parse(
    readFileSync('scripts/dev/fixtures/tournament-table-writers-lane-preimages.json', 'utf8')
  );
const harness = readFileSync(
  'scripts/dev/test-tournament-table-writers-wait-for-their-lane.py',
  'utf8'
);
const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const md5 = (s: string) => createHash('md5').update(s).digest('hex');

const POST_IMAGES: Record<string, string> = {
  'public.insert_hole_cards(uuid,integer,text)': '55b11b74f3dd6dbcd4185ee837d74849',
  'public.save_hand_state_snapshot(uuid,integer,jsonb,jsonb,integer,jsonb,text,jsonb,jsonb)':
    '5b5074c8d63c88a54ac4a81f313efc03',
  'public.fn_ca_process_hand_post_commit_obligations(uuid)': 'b831f02b0180e5e3df4da5f15d8cd338',
  'public.fn_project_hand_side_effects(uuid)': 'e1402cc728a46730f2c478ef2e397317',
};
const GUARDS: Record<string, string> = {
  'smarter_private.f06_aborted_hand_guard()': '49046cee6eb91ce98c44564e0590e452',
  'smarter_private.f06_cancelled_preparation_writer_guard()': '3219dd0db0c0de9e8f9c02f4609eaaf8',
};

/** The (old, new) pairs exactly as the migration's VALUES list carries them. */
function substitutions(): Array<{
  signature: string;
  pre: string;
  oldText: string;
  newText: string;
}> {
  const re =
    /\('(public\.[^']+)',\s*'([0-9a-f]{32})',\s*\$old\$([\s\S]*?)\$old\$,\s*\$new\$([\s\S]*?)\$new\$\)/g;
  return [...migration.matchAll(re)].map((m) => ({
    signature: m[1],
    pre: m[2],
    oldText: m[3],
    newText: m[4],
  }));
}

describe('Tournament table writers wait for their shared lane', () => {
  it('is one transaction with a bounded lock wait, a pinned helper and a live proof', () => {
    expect(migration).toMatch(
      /\nBEGIN;\nSET LOCAL lock_timeout = '3s';\nSET LOCAL statement_timeout = '60s';\n/
    );
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration).toContain(
      "-- @live-proof: (SELECT md5(pg_get_functiondef('smarter_private.f06_wait_table_lane(uuid)'::regprocedure)) = '4cd46ed5819cd9a91f87c93d4f112e45')"
    );
  });

  it('waits for exactly the two shared locks the guards try, bounded, with the same sentinel', () => {
    const helper = migration.slice(
      migration.indexOf('CREATE FUNCTION smarter_private.f06_wait_table_lane'),
      migration.indexOf('REVOKE ALL ON FUNCTION smarter_private.f06_wait_table_lane')
    );
    expect(helper).toContain("SET lock_timeout TO '4s'");
    expect(helper).toContain('SECURITY DEFINER');
    expect(helper).toContain(
      "pg_advisory_xact_lock_shared(\n      hashtextextended('ca:tournament-terminal-settlement:v1', 0))"
    );
    expect(helper).toContain(
      "pg_advisory_xact_lock_shared(\n      hashtextextended('ca:tournament-terminal-settlement:v1:' || t::text, 0))"
    );
    // A waiting lock, never a try, and never an exclusive one.
    expect(helper).not.toMatch(/pg_try_advisory/);
    expect(helper).not.toMatch(/pg_advisory_xact_lock\(/);
    expect(helper).toMatch(
      /EXCEPTION WHEN lock_not_available THEN\s+RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE = '55P03';/
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION smarter_private.f06_wait_table_lane(uuid) FROM PUBLIC, anon, authenticated;'
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION smarter_private.f06_wait_table_lane(uuid) TO service_role;'
    );
  });

  it('inserts the lane once, as the first lock, into each of the four exact live writers', () => {
    const subs = substitutions();
    expect(subs.map((s) => s.signature).sort()).toEqual(Object.keys(POST_IMAGES).sort());
    for (const s of subs) {
      const fixture = fixtures.find((f) => f.signature === s.signature)!;
      expect(md5(fixture.definition)).toBe(fixture.definition_hash);
      expect(s.pre).toBe(fixture.definition_hash);
      expect(fixture.definition.split(s.oldText)).toHaveLength(2);
      const post = fixture.definition.replace(s.oldText, s.newText);
      expect(md5(post)).toBe(POST_IMAGES[s.signature]);
      expect(post.replace(s.newText, s.oldText)).toBe(fixture.definition);
      // Nothing in the body before the inserted call takes a lock.
      const before = post.slice(0, post.indexOf('f06_wait_table_lane('));
      expect(before).not.toMatch(
        /pg_advisory|FOR UPDATE|FOR SHARE|FOR KEY SHARE|INSERT |UPDATE |DELETE /
      );
      expect(post.match(/f06_wait_table_lane\(/g)).toHaveLength(1);
    }
  });

  it('leaves both F06 hand guards byte-for-byte as they are', () => {
    for (const [sig, hash] of Object.entries(GUARDS)) {
      const fixture = fixtures.find((f) => f.signature === sig)!;
      expect(md5(fixture.definition)).toBe(hash);
      expect(fixture.definition).toMatch(/pg_try_advisory_xact_lock_shared/);
      expect(migration).toContain(`'${hash}'`);
    }
    expect(migration).not.toMatch(
      /CREATE OR REPLACE FUNCTION smarter_private\.f06_(aborted_hand|cancelled_preparation)/
    );
  });

  it('pins its exact bytes to the native PostgreSQL 17 qualification in the required accounting shard', () => {
    const hash = createHash('sha256').update(migration).digest('hex');
    expect(harness).toContain(`require_hash = '${hash}'`);
    expect(workflow).toMatch(
      /if: matrix.shard == 1\n {8}env:\n {10}PG_BIN: \/usr\/lib\/postgresql\/17\/bin\n {8}run: python3 scripts\/dev\/test-tournament-table-writers-wait-for-their-lane.py --output/
    );
    for (const witness of [
      'before-',
      'exclusive-refuses-',
      'queued-exclusive-refuses-cards',
      'exclusive-waits-then-',
      'waits-holding-no-lock-',
      'wait-is-bounded-at-4s',
      'sibling-table-concurrent-',
      'authority-cannot-overlap-open-writer',
      'waiting-writer-obeys-committed-fence-',
      'direct-write-still-refused-by-guard',
      'preimage-drift-refused',
      'metadata-preserved',
      'all-probes-rolled-back',
    ]) {
      expect(harness).toContain(witness);
    }
  });
});
